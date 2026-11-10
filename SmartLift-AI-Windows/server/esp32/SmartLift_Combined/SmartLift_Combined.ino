/*
  SmartLift AI - COMBINED firmware
  RFID security + buzzer + LED + lift motor driven by 4 IR floor sensors

  Board: 30-pin ESP32 DevKit V1 (DOIT)
  Libraries: MFRC522, WiFi, HTTPClient

  ---------------------------------------------------------------------------
  PIN MAP (no collisions anywhere)
  ---------------------------------------------------------------------------
  RC522:   SDA/SS -> GPIO 5    SCK  -> GPIO 18   MOSI -> GPIO 23
           MISO   -> GPIO 19   RST  -> GPIO 22   3.3V -> 3V3   GND -> GND
  Buzzer:  + -> GPIO 4,  - -> GND
  LED:     GPIO 14 (external LED, optional). The onboard LED sits on GPIO 2,
           which now reads floor 2, so it can no longer be driven.
  L293D:   EN1 -> GPIO 25 (PWM), IN1 -> GPIO 26, IN2 -> GPIO 27
           MOTOR A terminals -> lift motor
           Motor supply 6-12V from its OWN supply, ground tied to ESP32 GND
  IR floor sensors (4, one per physical floor, BOTTOM to TOP) - as wired:
           floor 1 -> GPIO 15     floor 2 -> GPIO 2
           floor 3 -> GPIO 21     floor 4 -> GPIO 13
           VCC -> 3.3V (NOT 5V), GND -> GND

  TWO PINS TO WATCH:
    GPIO 2  - also drives the onboard blue LED, which pulls the line toward
              GND. That sensor can read "cabin here" when nothing is there.
              Moving that single wire to GPIO 14 is strongly recommended.
              (No internal pull-up is used on this pin for that reason.)
    GPIO 15 - a boot strapping pin. If the board will not boot, or the serial
              output goes silent while the cabin rests at floor 1, move that
              wire to GPIO 16.
    Clean alternative set if you rewire: {16, 14, 21, 13}

  !! Keep the IR signal at 3.3V. GPIO 32/33/34/35 are not 5V tolerant.
     If your modules only run on 5V, add a divider on each OUT pin.

  ---------------------------------------------------------------------------
  WHAT THIS DOES
  ---------------------------------------------------------------------------
  Security (unchanged):
    - UID 69BDF306 -> ACCESS GRANTED, LED blinks, event sent. No movement.
    - Any other UID -> 2 beeps, ACCESS DENIED event sent, backend captures a
      frame from the existing camera.
    - RFID NEVER moves the lift, creates passengers, or assigns floors.

  Mirror (the hardware/software link):
    - The dashboard POSTs the simulated Lift A floor to the backend.
    - This board polls it, maps the 9 simulated levels onto the 4 physical
      floors, and drives the motor until the matching IR sensor triggers.

  Position:
    - The 4 sensors give true position. Movement stops when the TARGET
      sensor triggers, so travel never drifts.
    - On boot the cabin is driven down to floor 1 (bottom sensor) to home.

  CALIBRATION (do this once):
    1. Set SENSOR_CHECK to 1, flash, open Serial Monitor at 115200.
    2. Slide the cabin by hand through all four positions.
    3. Note which GPIO changes when the cabin sits at each floor.
    4. If the readings are inverted, set SENSOR_ACTIVE_LOW to 0.
    5. Put the real order into FLOOR_SENSOR_PINS, set SENSOR_CHECK back to 0,
       and flash again.
*/

#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ---------------- PIN CONFIGURATION ----------------

#define SS_PIN       5
#define RST_PIN      22
#define BUZZER_PIN   4
#define LED_PIN      14   // external LED, optional. GPIO 2 is a sensor now.
#define GRANT_BEEP   1    // 1 = one short beep granted, two beeps denied

const uint8_t EN_A = 25;   // L293D EN1  (PWM speed)
const uint8_t IN1  = 26;   // L293D IN1  (direction)
const uint8_t IN2  = 27;   // L293D IN2  (direction)

// ---------------- IR FLOOR SENSORS ----------------

const uint8_t PHYSICAL_FLOORS = 4;
// BOTTOM -> TOP, exactly as wired on your model.
const uint8_t FLOOR_SENSOR_PINS[PHYSICAL_FLOORS] = {15, 2, 21, 13};
// Clean alternative set if you rewire: {16, 14, 21, 13}

#define SENSOR_ACTIVE_LOW 1   // 1 = pin reads LOW when the cabin is at that floor
#define SENSOR_CHECK      0   // 1 = print sensor states only (motor disabled)

// ---------------- WI-FI CONFIGURATION ----------------
// Fill these in locally. Never commit real credentials.

const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Laptop 2's LAN IP (NOT localhost), backend port, and routes.
const char* EVENT_URL  = "http://LAPTOP2_IP:8001/security/rfid-event";
const char* MIRROR_URL = "http://LAPTOP2_IP:8001/mirror/lift";

// ---------------- CONFIGURATION ----------------

const char* AUTHORIZED_UIDS[] = {"69BDF306", "3EAF1AAA", "6E9818AA", "12D56B06", "11223344"};
const int NUM_AUTH = sizeof(AUTHORIZED_UIDS) / sizeof(AUTHORIZED_UIDS[0]);

const bool  MIRROR_SIM_LIFT = true;      // false = security-only device
const uint8_t SPEED         = 200;       // 0..255 motor PWM
const int   SIM_MAX_FLOOR   = 8;         // simulation levels: G..8 (9 levels)
const unsigned long MOVE_TIMEOUT_MS = 12000;  // fail-safe if a sensor misses
const unsigned long HOME_TIMEOUT_MS = 15000;
const unsigned long POLL_MS         = 600;    // mirror poll interval
const unsigned long SCAN_COOLDOWN   = 1500;   // duplicate-read protection

MFRC522 rfid(SS_PIN, RST_PIN);

// ---------------- POSITION / MOTOR STATE ----------------

int  curPhysical    = -1;     // 0..3, -1 = unknown (between floors)
int  targetPhysical = -1;
bool moving         = false;
bool moveRequested  = false;
unsigned long moveDeadline = 0;

// ---------------- ALERT STATE (non-blocking) ----------------

unsigned long ledUntil = 0;
int  beepsLeft = 0;          // beeps still to sound
bool beepOn = false;
unsigned long beepNext = 0;

// ---------------- TIMERS ----------------

unsigned long lastScan = 0;
unsigned long lastPoll = 0;
unsigned long lastWifiTry = 0;

// ---------------- SENSORS ----------------

bool sensorAt(int i) {
  int v = digitalRead(FLOOR_SENSOR_PINS[i]);
  return SENSOR_ACTIVE_LOW ? (v == LOW) : (v == HIGH);
}

// Any triggered sensor IS the cabin's current floor.
void updateFloorSensors() {
  for (int i = 0; i < PHYSICAL_FLOORS; i++) {
    if (sensorAt(i)) { curPhysical = i; return; }
  }
}

// Simulation level (0..8) -> physical floor (0..3), proportional and rounded.
// 0,1 -> floor 1 | 2,3 -> floor 2 | 4,5,6 -> floor 3 | 7,8 -> floor 4
int simFloorToPhysical(int f) {
  if (f < 0) f = 0;
  if (f > SIM_MAX_FLOOR) f = SIM_MAX_FLOOR;
  return (f * (PHYSICAL_FLOORS - 1) + 4) / SIM_MAX_FLOOR;
}

// ---------------- MOTOR ----------------

void motorUp(uint8_t speed) {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(EN_A, speed);
}

void motorDown(uint8_t speed) {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(EN_A, speed);
}

void stopMotor() {                 // both LOW = coast to a stop
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  analogWrite(EN_A, 0);
}

// Drive down until the bottom sensor triggers, then zero the position.
// Blocking, but only runs at boot or if position was lost.
bool homeLift() {
  Serial.println("Homing: driving down to floor 1...");
  motorDown(SPEED);
  unsigned long start = millis();
  bool found = false;
  while (millis() - start < HOME_TIMEOUT_MS) {
    if (sensorAt(0)) { found = true; break; }
    delay(10);
  }
  stopMotor();
  if (found) {
    curPhysical = 0;
    Serial.println("Homed at floor 1.");
  } else {
    Serial.println("Bottom sensor never triggered - check wiring 1.");
  }
  return found;
}

void setTargetPhysical(int p) {
  if (p < 0 || p >= PHYSICAL_FLOORS) return;
  targetPhysical = p;
  moveRequested = true;
}

// Sensor-terminated movement: run until the TARGET sensor triggers.
void updateMotor() {
  updateFloorSensors();

  if (moving) {
    if (curPhysical == targetPhysical) {
      stopMotor();
      moving = false;
      moveRequested = false;
      Serial.print("Arrived at physical floor ");
      Serial.println(curPhysical + 1);
    } else if ((long)(millis() - moveDeadline) >= 0) {
      stopMotor();
      moving = false;
      moveRequested = false;
      Serial.println("Move timed out - sensor not seen.");
    }
    return;
  }

  if (!moveRequested) return;
  if (curPhysical < 0) {
    if (!homeLift()) return;         // position unknown: find the bottom first
  }
  if (curPhysical == targetPhysical) { moveRequested = false; return; }

  moving = true;
  moveDeadline = millis() + MOVE_TIMEOUT_MS;
  if (targetPhysical > curPhysical) motorUp(SPEED);
  else motorDown(SPEED);
}

// ---------------- BUZZER + LED (non-blocking) ----------------

const unsigned long BEEP_MS = 150;   // length of each beep

void requestBeeps(int n) {
  beepsLeft = n;
  beepOn = true;
  digitalWrite(BUZZER_PIN, HIGH);
  beepNext = millis() + BEEP_MS;
}

void updateBuzzer() {
  if (!beepOn && beepsLeft == 0) return;
  if ((long)(millis() - beepNext) < 0) return;
  if (beepOn) {
    digitalWrite(BUZZER_PIN, LOW);
    beepOn = false;
    beepsLeft--;                     // one beep finished
    beepNext = millis() + BEEP_MS;   // gap before the next one
  } else if (beepsLeft > 0) {
    digitalWrite(BUZZER_PIN, HIGH);
    beepOn = true;
    beepNext = millis() + BEEP_MS;
  }
}

void flashLed(unsigned long ms) { ledUntil = millis() + ms; digitalWrite(LED_PIN, HIGH); }

void updateLed() {
  if (ledUntil && (long)(millis() - ledUntil) >= 0) {
    digitalWrite(LED_PIN, LOW);
    ledUntil = 0;
  }
}

// ---------------- WI-FI ----------------

bool connectWiFi(unsigned long timeoutMs = 8000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.println("Connecting to Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("Wi-Fi connected. ESP32 IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println();
  Serial.println("Wi-Fi connection failed.");
  return false;
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 15000) return;
  lastWifiTry = millis();
  connectWiFi(2500);
}

// ---------------- RFID ----------------

bool isAuthorized(const String& uid) {
  for (int i = 0; i < NUM_AUTH; i++) {
    if (uid.equals(AUTHORIZED_UIDS[i])) return true;
  }
  return false;
}

void sendSecurityEvent(const String& uid, const char* eventType) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Event not sent: Wi-Fi unavailable.");
    return;
  }
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(1500);             // short: keeps the loop responsive
  if (!http.begin(client, EVENT_URL)) {
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
  int code = http.POST(payload);
  if (code > 0) {
    Serial.print("Backend response: ");
    Serial.println(code);
  } else {
    Serial.print("HTTP request failed: ");
    Serial.println(http.errorToString(code));
  }
  http.end();
}

void handleRFID() {
  if (millis() - lastScan < SCAN_COOLDOWN) return;
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  lastScan = millis();

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  Serial.print("Card UID: ");
  Serial.println(uid);

  if (isAuthorized(uid)) {
    Serial.println("ACCESS GRANTED");
    flashLed(400);
#if GRANT_BEEP
    requestBeeps(1);                 // one short beep = granted
#endif
    sendSecurityEvent(uid, "ACCESS_GRANTED");
  } else {
    Serial.println("ACCESS DENIED");
    requestBeeps(2);                 // two beeps = denied, works offline
    sendSecurityEvent(uid, "ACCESS_DENIED");
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// ---------------- MIRROR ----------------

// Minimal parse: find "floor": in the JSON body. Avoids an extra library.
int parseMirrorFloor(const String& body) {
  int i = body.indexOf("\"floor\"");
  if (i < 0) return -1;
  i = body.indexOf(':', i);
  if (i < 0) return -1;
  int v = body.substring(i + 1).toInt();
  if (v < 0 || v > SIM_MAX_FLOOR) return -1;
  return v;
}

void pollMirror() {
  if (!MIRROR_SIM_LIFT) return;
  if (millis() - lastPoll < POLL_MS) return;
  lastPoll = millis();
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(800);
  if (!http.begin(client, MIRROR_URL)) return;
  int code = http.GET();
  if (code == 200) {
    int simFloor = parseMirrorFloor(http.getString());
    if (simFloor >= 0) setTargetPhysical(simFloorToPhysical(simFloor));
  }
  http.end();
}

// ---------------- SETUP ----------------

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(EN_A, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);
  stopMotor();

  for (int i = 0; i < PHYSICAL_FLOORS; i++) {
    // GPIO 2 also drives the onboard LED, so no pull-up there.
    pinMode(FLOOR_SENSOR_PINS[i], FLOOR_SENSOR_PINS[i] == 2 ? INPUT : INPUT_PULLUP);
  }

#if SENSOR_CHECK
  Serial.println();
  Serial.println("SENSOR CHECK MODE - motor and RFID disabled.");
  Serial.println("Slide the cabin by hand through all four floors.");
  Serial.println("Reading order is bottom -> top, as FLOOR_SENSOR_PINS:");
  return;                              // loop() only prints readings
#endif

  SPI.begin();
  rfid.PCD_Init();

  Serial.println();
  Serial.println("SmartLift Combined Firmware Ready.");
  Serial.println("RFID security active. Motor follows the simulation.");

  homeLift();
  connectWiFi();
}

// ---------------- MAIN LOOP ----------------

void loop() {
#if SENSOR_CHECK
  static unsigned long lastPrint = 0;
  if (millis() - lastPrint > 300) {
    lastPrint = millis();
    Serial.print("Sensors (bottom->top): ");
    for (int i = 0; i < PHYSICAL_FLOORS; i++) {
      Serial.print(sensorAt(i) ? "AT " : " .  ");
    }
    Serial.print(" | raw: ");
    for (int i = 0; i < PHYSICAL_FLOORS; i++) {
      Serial.print(digitalRead(FLOOR_SENSOR_PINS[i]));
      Serial.print(' ');
    }
    Serial.println();
  }
#else
  updateMotor();
  updateBuzzer();
  updateLed();
  handleRFID();
  pollMirror();
  maintainWiFi();
#endif
}
