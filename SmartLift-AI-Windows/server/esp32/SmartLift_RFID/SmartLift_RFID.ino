/*
  SmartLift AI - RFID Security + Buzzer + Wi-Fi

  Board: ESP32 Dev Module
  Libraries:
    - MFRC522
    - WiFi (ESP32 built-in)
    - HTTPClient (ESP32 built-in)

  RC522:
    SDA/SS -> GPIO 5
    SCK    -> GPIO 18
    MOSI   -> GPIO 23
    MISO   -> GPIO 19
    RST    -> GPIO 22
    GND    -> GND
    3.3V   -> 3V3

  Buzzer:
    + -> GPIO 4
    - -> GND

  LED:
    GPIO 2 (built-in LED on most ESP32 boards)

  Authorized UID:
    69BDF306

  Authorized scan:
    - Access granted
    - LED turns on briefly
    - Sends ACCESS_GRANTED event to backend

  Unauthorized scan:
    - Access denied
    - Buzzer beeps twice locally
    - Sends ACCESS_DENIED event to backend
    - Backend triggers existing camera capture

  LOCAL SETUP (fill on Laptop 1, never commit real values):
    1. Set WIFI_SSID / WIFI_PASSWORD to the hotspot both laptops join.
    2. Set SERVER_URL to Laptop 2's LAN IP, e.g.
       http://192.168.43.10:8001/security/rfid-event
       (NOT localhost — the ESP32 is a different machine.)
*/

#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ---------------- PIN CONFIGURATION ----------------

#define SS_PIN       5
#define RST_PIN      22
#define BUZZER_PIN   4
#define LED_PIN      2

// ---------------- WI-FI CONFIGURATION ----------------

// Enter the Wi-Fi/hotspot details shared by both laptops
// and the ESP32.

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Laptop 2's LAN IP + backend port + RFID event route.
// Find Laptop 2's IP with `ipconfig` (Windows) or
// `ipconfig getifaddr en0` (macOS) while on the shared network.

const char* SERVER_URL =
  "http://LAPTOP2_IP:8001/security/rfid-event";

// ---------------- RFID CONFIGURATION ----------------

// Only this UID is authorized.

const char* AUTHORIZED_UIDS[] = {"69BDF306", "3EAF1AAA", "6E9818AA", "12D56B06", "11223344"};
const int NUM_AUTH = sizeof(AUTHORIZED_UIDS) / sizeof(AUTHORIZED_UIDS[0]);

MFRC522 rfid(SS_PIN, RST_PIN);

unsigned long lastScan = 0;
const unsigned long SCAN_COOLDOWN = 1500;

// ---------------- RFID AUTHORIZATION ----------------

bool isAuthorized(const String& uid) {
  for (int i = 0; i < NUM_AUTH; i++) {
    if (uid.equals(AUTHORIZED_UIDS[i])) return true;
  }
  return false;
}

// ---------------- BUZZER ----------------

// For an active buzzer.
// If you have a passive buzzer, use the tone()
// alternative noted below.

void beepDenied() {
  for (int i = 0; i < 2; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);

    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}

// Passive buzzer alternative:
// void beepDenied() {
//   for (int i = 0; i < 2; i++) {
//     tone(BUZZER_PIN, 1000, 150);
//     delay(300);
//   }
//   noTone(BUZZER_PIN);
// }

// ---------------- WI-FI CONNECTION ----------------

bool connectWiFi(unsigned long timeoutMs = 8000) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  Serial.println("Connecting to Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startTime = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - startTime < timeoutMs) {
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("Wi-Fi connected.");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println();
  Serial.println("Wi-Fi connection failed.");
  return false;
}

// ---------------- SEND EVENT TO BACKEND ----------------

// The backend independently validates the UID before acting.
// Payload: {"uid", "event_type", "device_millis"}.

void sendSecurityEvent(const String& uid,
                       const char* eventType) {
  if (!connectWiFi(5000)) {
    Serial.println("Event not sent: Wi-Fi unavailable.");
    return;
  }

  WiFiClient client;
  HTTPClient http;

  http.setTimeout(2500);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("Could not initialize HTTP request.");
    return;
  }

  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"uid\":\"" + uid + "\",";
  payload += "\"event_type\":\"" + String(eventType) + "\",";
  payload += "\"device_millis\":" + String(millis());
  payload += "}";

  Serial.print("Sending event: ");
  Serial.println(payload);

  int responseCode = http.POST(payload);

  if (responseCode > 0) {
    Serial.print("Backend response: ");
    Serial.println(responseCode);

    String response = http.getString();
    if (response.length() > 0) {
      Serial.println(response);
    }
  } else {
    Serial.print("HTTP request failed: ");
    Serial.println(http.errorToString(responseCode));
  }

  http.end();
}

// ---------------- SETUP ----------------

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  SPI.begin();
  rfid.PCD_Init();

  Serial.println();
  Serial.println("SmartLift RFID Security Ready.");
  Serial.println("Tap an RFID card...");

  // Attempt Wi-Fi connection, but do not stop RFID
  // operation if the network is unavailable.
  connectWiFi();
}

// ---------------- MAIN LOOP ----------------

void loop() {
  // Avoid repeated reads from a card held on the reader.
  if (millis() - lastScan < SCAN_COOLDOWN) {
    return;
  }

  if (!rfid.PICC_IsNewCardPresent() ||
      !rfid.PICC_ReadCardSerial()) {
    return;
  }

  lastScan = millis();

  // Read UID as uppercase hexadecimal.
  String uid = "";

  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }

    uid += String(rfid.uid.uidByte[i], HEX);
  }

  uid.toUpperCase();

  Serial.print("Card UID: ");
  Serial.println(uid);

  if (isAuthorized(uid)) {
    Serial.println("ACCESS GRANTED");

    digitalWrite(LED_PIN, HIGH);

    // Send authorization event to the backend.
    sendSecurityEvent(uid, "ACCESS_GRANTED");

    digitalWrite(LED_PIN, LOW);
  } else {
    Serial.println("ACCESS DENIED");

    // Sound the local buzzer immediately.
    // This works even if Wi-Fi is unavailable.
    beepDenied();

    // Request the backend to log the denial and
    // trigger the existing camera capture process.
    sendSecurityEvent(uid, "ACCESS_DENIED");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
