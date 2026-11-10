// ==========================================
// SmartLift - Integrated Controller & Motor
// Board: ESP32 Dev Module (30-pin)
// ==========================================

#include <SPI.h>
#include <MFRC522.h>

// --- Floor Limit Sensors (from 1.ino) ---
#define FLOOR_G    32   // Ground Floor limit switch / sensor (INPUT_PULLUP)
#define FLOOR_1    14   // Floor 1 limit switch / sensor (INPUT_PULLUP)
#define FLOOR_2    21   // Floor 2 limit switch / sensor (INPUT_PULLUP)
#define FLOOR_3    13   // Floor 3 limit switch / sensor (INPUT_PULLUP)

// --- RFID RC522 & Indicators (from 2.ino) ---
// Note: Hardware SPI uses SCK -> GPIO 18, MISO -> GPIO 19, MOSI -> GPIO 23
#define SS_PIN      5   // RC522 SDA / SS (Chip Select)
#define RST_PIN    22   // RC522 Reset
#define BUZZER_PIN  4   // Buzzer (+)
#define LED_PIN     2   // Built-in LED / Indicator

// Put your card/keychain UIDs here (uppercase, no spaces)
const char* AUTHORIZED_UIDS[] = {
  "69BDF306",
  "3EAF1AAA",
  "6E9818AA",
  "12D56B06",
  "11223344"
};
const int NUM_AUTH = sizeof(AUTHORIZED_UIDS) / sizeof(AUTHORIZED_UIDS[0]);

MFRC522 rfid(SS_PIN, RST_PIN);
unsigned long lastScan = 0;

// --- L293D Motor Driver (from 3.ino) ---
#define EN_A       25   // Motor A Speed (PWM)
#define IN1        26   // Motor A Direction 1
#define IN2        27   // Motor A Direction 2

// Motor Speed (0 - 255)
const uint8_t SPEED = 200;

// Lift State Tracking
enum LiftState { IDLE, MOVING_FORWARD, MOVING_BACKWARD };
LiftState liftState = IDLE;

int targetFloor = -1;       // -1 = No target (idle), 0 = G, 1 = 1, 2 = 2, 3 = 3
int lastKnownFloor = 0;     // Remembers position if between floors

// --- RFID Helper Functions ---
bool isAuthorized(const String& uid) {
  for (int i = 0; i < NUM_AUTH; i++) {
    if (uid.equals(AUTHORIZED_UIDS[i])) return true;
  }
  return false;
}

void beepDenied() {
  for (int i = 0; i < 2; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);
    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}

// --- Motor Control Functions ---
void motorForward(uint8_t speed) {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(EN_A, speed);
}

void motorBackward(uint8_t speed) {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(EN_A, speed);
}

void stopMotor() {
  // Instant stop
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  analogWrite(EN_A, 0);
}

// Aliases for Up / Down
void motorUp(uint8_t speed)   { motorForward(speed); }
void motorDown(uint8_t speed) { motorBackward(speed); }

// --- Floor Position Detection (Top-sensor priority) ---
// Active LOW = sensor triggered
// Debounce confirmation: filters out motor PWM noise spikes on sensor lines
bool isSensorActive(uint8_t pin) {
  if (digitalRead(pin) == LOW) {
    delay(30); // Confirmation delay to filter out microsecond noise spikes
    return (digitalRead(pin) == LOW);
  }
  return false;
}

int getCurrentFloor() {
  if (isSensorActive(FLOOR_3)) {
    return 3;
  } else if (isSensorActive(FLOOR_2)) {
    return 2;
  } else if (isSensorActive(FLOOR_1)) {
    return 1;
  } else if (isSensorActive(FLOOR_G)) {
    return 0; // Ground floor
  }
  return -1; // Between floors (in transit)
}

void setup() {
  Serial.begin(115200);

  // Initialize Floor Sensor Pins
  pinMode(FLOOR_G, INPUT_PULLUP);
  pinMode(FLOOR_1, INPUT_PULLUP);
  pinMode(FLOOR_2, INPUT_PULLUP);
  pinMode(FLOOR_3, INPUT_PULLUP);

  // Initialize Buzzer & LED Pins
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  // Initialize RFID Reader (RC522)
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("RFID Ready. Tap a card...");

  // Initialize Motor Driver Pins
  pinMode(EN_A, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  stopMotor();

  // Detect starting position
  int start = getCurrentFloor();
  if (start != -1) {
    lastKnownFloor = start;
  }
}

void loop() {
  int current = getCurrentFloor();
  if (current != -1) {
    lastKnownFloor = current;
  }

  // 1. Stop when Target Floor is Reached (runs motor for extra delay after detection)
  if (targetFloor != -1 && current == targetFloor) {
    delay(500); // Overrun delay
    stopMotor();
    liftState = IDLE;
    Serial.print("TARGET REACHED: ");
    if (targetFloor == 0) Serial.println("G (Ground Floor)");
    else { Serial.print("Floor "); Serial.println(targetFloor); }
    targetFloor = -1;
  }

  // Safety Boundary Protection: Don't drive past physical top/bottom limits
  if (liftState == MOVING_FORWARD && current == 3 && targetFloor != 3) {
    stopMotor();
    liftState = IDLE;
    targetFloor = -1;
    Serial.println("WARNING: Hit top floor limit switch (Floor 3). Stopped.");
  }
  if (liftState == MOVING_BACKWARD && current == 0 && targetFloor != 0) {
    stopMotor();
    liftState = IDLE;
    targetFloor = -1;
    Serial.println("WARNING: Hit bottom floor limit switch (Floor G). Stopped.");
  }

  // 2. Periodically stream floor sensor states (every 500ms)
  static unsigned long lastStreamTime = 0;
  if (millis() - lastStreamTime >= 500) {
    lastStreamTime = millis();

    Serial.print("G: ");
    Serial.print(digitalRead(FLOOR_G) == HIGH ? "HIGH" : "LOW");
    Serial.print(" | 1: ");
    Serial.print(digitalRead(FLOOR_1) == HIGH ? "HIGH" : "LOW");
    Serial.print(" | 2: ");
    Serial.print(digitalRead(FLOOR_2) == HIGH ? "HIGH" : "LOW");
    Serial.print(" | 3: ");
    Serial.println(digitalRead(FLOOR_3) == HIGH ? "HIGH" : "LOW");
  }

  // 3. Listen for incoming target floor commands over Serial (from Python)
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    // Ignore whitespace / newline characters
    if (cmd == '\r' || cmd == '\n' || cmd == ' ') {
      return;
    }

    if (cmd == 'G' || cmd == 'g' || cmd == '0' ||
        cmd == '1' || cmd == '2' || cmd == '3') {
      
      int target = (cmd == 'G' || cmd == 'g' || cmd == '0') ? 0 : (cmd - '0');
      
      Serial.print("COMMAND_RECEIVED: Move to Floor ");
      if (target == 0) Serial.println("G");
      else Serial.println(target);

      // Evaluate movement direction
      int referencePos = (current != -1) ? current : lastKnownFloor;

      if (current != -1 && current == target) {
        stopMotor();
        liftState = IDLE;
        targetFloor = -1;
        Serial.println("Already at target floor.");
      } else if (target > referencePos) {
        targetFloor = target;
        liftState = MOVING_FORWARD;
        motorForward(SPEED);
        Serial.println("Motor moving FORWARD (Up)...");
      } else {
        targetFloor = target;
        liftState = MOVING_BACKWARD;
        motorBackward(SPEED);
        Serial.println("Motor moving BACKWARD (Down)...");
      }
    }
  }

  // 4. RFID Card Reading & Buzzer (as is from 2.ino, no motor logic)
  if (millis() - lastScan >= 1500) {
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
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
        digitalWrite(LED_PIN, HIGH);
        delay(1000);
        digitalWrite(LED_PIN, LOW);
      } else {
        Serial.println("ACCESS DENIED");
        beepDenied();
      }

      rfid.PICC_HaltA();
      rfid.PCD_StopCrypto1();
    }
  }
}
