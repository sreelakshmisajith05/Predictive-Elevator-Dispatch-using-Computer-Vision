# SmartLift AI — Intelligent Single-Lift Elevator System
### 4 Floors (G, 1, 2, 3) | AI Classification | Dynamic Weight Threshold | Ghost-Call Cancellation | RFID Security | Physical Hardware Prototype

SmartLift AI is an intelligent elevator system that operates in two environments:
1. **Software Simulation Mode**: Virtual 4-floor elevator with passenger drag-and-drop, category classification, dynamic operational threshold management, predictive load safety evaluation, elderly & wheelchair priority routing, and ghost-call departure detection.
2. **Hardware Prototype Mode**: Direct integration with physical elevator hardware: ESP32 microcontroller, 4 active-LOW infrared limit sensors (Floors G, 1, 2, 3), L293 motor driver with DC motor & pulley, RC522 RFID reader, buzzer, and computer webcam running real-time YOLOv8 person detection.

---

## 🏗️ Single-Lift Architecture & Floors

The entire system operates strictly with **ONE lift** serving **FOUR floors**:
- **Floor G** (Ground Floor, index `0`)
- **Floor 1** (First Floor, index `1`)
- **Floor 2** (Second Floor, index `2`)
- **Floor 3** (Third Floor, index `3`)

```
SmartLift AI Architecture
│
├── Frontend (Vite + Vanilla JS + 3D Isometric View)
│   ├── Mode Switcher: Software Simulation ⟷ Hardware Prototype
│   ├── 3D Elevator Shaft & Glass Cabin (Floors G, 1, 2, 3)
│   ├── Passenger Management (Drag-and-Drop & Active Cards)
│   ├── Live Camera Panel (YOLOv8 Real-Time Stream & Waiting Area)
│   ├── Hardware Controller Panel (COM7, IR Sensor Pins, Motor Direction)
│   ├── Predictive Safety Panel (Dynamic Threshold & Load Margin)
│   ├── Intelligent Route Optimization Panel (Explainable Decision Trace)
│   ├── RC522 RFID Security Panel (Authorized Tag Auto-Destination & Snapshot)
│   └── System Event Log & Reasoning Trace
│
├── Python Backend (FastAPI + YOLOv8 + ESP32 Bridge)
│   ├── ESP32Bridge: Serial communication on COM7 @ 115200 baud
│   ├── /hardware/status: Live floor sensors, motor state, target floor
│   ├── /hardware/command: Validated floor dispatch commands ('G', '1', '2', '3')
│   ├── /security/rfid-event: Backend UID authorization & image capture
│   └── /ws/detect: Real-time YOLOv8n object detection WebSocket
│
└── Physical Prototype (ESP32 Firmware)
    ├── Limit Sensors: FLOOR_G (32), FLOOR_1 (14), FLOOR_2 (21), FLOOR_3 (13)
    ├── L293D Motor Driver: EN_A (25), IN1 (26), IN2 (27)
    ├── RC522 RFID: SS (5), RST (22), SPI Hardware (18, 19, 23)
    └── Indicators: Buzzer (4), Indicator LED (2)
```

---

## ⚡ Quick Start

### 1. Start the Backend & Hardware Bridge
```powershell
cd SmartLift-AI-Windows\server
.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000
```
- Automatically auto-detects and connects to **COM7** (`Silicon Labs CP210x USB to UART Bridge`).
- Health check: `http://localhost:8000/health`
- Hardware status: `http://localhost:8000/hardware/status`

### 2. Start the Frontend Dashboard
```powershell
cd SmartLift-AI-Windows
npm run dev
```
Open **`http://localhost:5173`** in your browser.

---

## 🕹️ Operating Environments

### Environment 1: Software Simulation Mode
- Switch to **Software Simulation** from the top header switcher.
- **Passenger Creation**: Drag any passenger category from the left palette to a floor (G, 1, 2, 3).
- **Categories & Dynamic Threshold Deductions**:
  - 👨 Adult: Base standard weight (75 kg)
  - 👦 Child: -35 kg threshold deduction
  - 👴 Senior Citizen: -55 kg deduction + Elevated Pickup Priority
  - ♿ Wheelchair User: -110 kg deduction + High Scheduling Priority
  - 🧳 Luggage: -30 kg operational threshold deduction
- **Predictive Safety Evaluation**:
  - `Projected Load = Current Load + Boarding Weight - Exiting Weight`
  - `Safety Margin = Dynamic Operational Threshold (380 - 750 kg) - Projected Load`
  - Decisions: **SAFE**, **DEFERRED** (postponed until load drops), or **UNSAFE**.
- **Ghost-Call Departure**:
  - Click `×` on a waiting passenger to simulate them walking away before lift arrival.
  - The outside pickup is immediately invalidated and the route is recalculated.
  - If an inside passenger has a destination on that floor, the lift **still stops** for the inside passenger.

### Environment 2: Hardware Prototype Mode
- Switch to **Hardware Prototype** from the top header switcher.
- Elevator cabin in the 3D dashboard visualizes the **exact real-time physical floor** confirmed by ESP32 IR sensors.
- Floor buttons and dispatch buttons send validated target commands to the L293 motor driver.
- Closed-loop control: motor moves forward (up) or backward (down) and stops when the target IR sensor triggers (active LOW).

---

## 🔐 RC522 RFID Security Architecture

- **Authorized Tag (`69BDF306`)**:
  - Validated by the backend.
  - **Scenario A (Fixed Destination)**: Scanned at Floor G → automatically resolves configured destination **Floor 2** and commands the lift to travel to Floor 2.
  - Displays green `ACCESS GRANTED` confirmation badge and triggers authorized LED/buzzer pattern.
- **Unauthorized Tag**:
  - ESP32 immediately sounds two short warning beeps locally on buzzer (Pin 4).
  - Backend verifies and rejects the tag with `ACCESS_DENIED`.
  - Instantly captures the latest frame from the webcam buffer into `server/security_images/SEC-....jpg`.
  - Prominent red security alert displayed in the RFID Security Panel with the captured snapshot image.
  - **No passenger request is created and the motor never moves.**

---

## 👁️ Real-Time Camera & YOLOv8 Detection
- Toggle camera on/off via the **Enable Camera** button.
- Runs YOLOv8n object detection on webcam frames streamed via WebSocket.
- Tracks `person`, `backpack`, `handbag`, `suitcase`.
- When a person remains steady in the configured waiting area for 5 consecutive frames, they join as a waiting passenger.
- If a person leaves the camera waiting area, departure confirmation cancels the pickup request (camera ghost-call cancellation).

---

## 🧪 Verification Scenarios (Demos A–G)

Run any scenario directly from the **Test Scenarios** panel on the dashboard:
- **A: Predictive Load**: Adult with luggage (75 + 15 kg).
- **B: Child vs Adult**: Demonstrates differing dynamic thresholds.
- **C: Ghost Call**: Waiting passenger departs; lift skips floor.
- **D: Ghost + Inside**: Outside passenger departs, but inside passenger needs floor 2; lift still stops at floor 2!
- **E: Inside Dest**: Destination served directly without waiting outside calls.
- **F: Double-Press**: Double-clicking a cabin button cancels that destination.
- **G: Deferred Pickup**: Wheelchair user pickup deferred when cabin approaches load limit.

---

## 🛠️ Hardware Wiring Reference

| Component | Pin Function | ESP32 GPIO | Logic |
| :--- | :--- | :--- | :--- |
| **IR Sensor G** | Ground Floor Limit | GPIO 32 | Active LOW (`INPUT_PULLUP`) |
| **IR Sensor 1** | Floor 1 Limit | GPIO 14 | Active LOW (`INPUT_PULLUP`) |
| **IR Sensor 2** | Floor 2 Limit | GPIO 21 | Active LOW (`INPUT_PULLUP`) |
| **IR Sensor 3** | Floor 3 Limit | GPIO 13 | Active LOW (`INPUT_PULLUP`) |
| **L293D Motor** | Enable (PWM Speed) | GPIO 25 | Speed: 200 (0 - 255) |
| **L293D Motor** | Direction IN1 | GPIO 26 | HIGH = Forward (Up) |
| **L293D Motor** | Direction IN2 | GPIO 27 | HIGH = Backward (Down) |
| **RC522 RFID** | Chip Select (SDA) | GPIO 5 | SPI SS |
| **RC522 RFID** | Reset (RST) | GPIO 22 | Hardware Reset |
| **RC522 RFID** | SPI SCK / MISO / MOSI | GPIO 18, 19, 23 | Hardware VSPI |
| **Buzzer** | Warning / Pattern | GPIO 4 | Active HIGH |
| **Indicator LED** | Auth LED | GPIO 2 | Active HIGH |
