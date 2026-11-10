# SmartLift AI — Predictive Elevator Dispatch & Biometric Security System

[![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688?style=flat&logo=fastapi)](https://fastapi.tiangolo.com/)
[![YOLOv8](https://img.shields.io/badge/AI-YOLOv8%20%7C%20OpenCV-00FFFF?style=flat&logo=opencv)](https://ultralytics.com)
[![ESP32](https://img.shields.io/badge/Hardware-ESP32%20DevKit-E7352C?style=flat&logo=espressif)](https://www.espressif.com/)
[![Vite](https://img.shields.io/badge/Frontend-Vite%20%7C%20Vanilla%20JS-646CFF?style=flat&logo=vite)](https://vitejs.dev/)
[![Python](https://img.shields.io/badge/Language-Python%203.10+-3776AB?style=flat&logo=python)](https://www.python.org/)
[![C++](https://img.shields.io/badge/Firmware-C%2B%2B%20%2F%20Arduino-00599C?style=flat&logo=c%2B%2B)](https://www.arduino.cc/)

> An end-to-end intelligent vertical transportation platform combining **edge computer vision (YOLOv8)**, **dynamic load & safety threshold evaluation**, **ghost-call cancellation**, **multi-factor biometric authentication (SFace + 13.56 MHz RFID)**, and a **physical ESP32 prototype hardware bridge**.

---

## 📌 Table of Contents
- [System Architecture](#-system-architecture)
- [Key Features](#-key-features)
- [Hardware Prototype & Pinout](#-hardware-prototype--pinout)
- [Autotravel & Multi-Factor Security](#-autotravel--multi-factor-security)
- [Project Structure](#-project-structure)
- [Quick Start Guide](#-quick-start-guide)
  - [1. Backend Server Setup](#1-backend-server-setup)
  - [2. Frontend Simulation Dashboard](#2-frontend-simulation-dashboard)
  - [3. Hardware Prototype / ESP32 Bridge](#3-hardware-prototype--esp32-bridge)
- [API & WebSocket Endpoints](#-api--websocket-endpoints)
- [Tech Stack](#-tech-stack)

---

## 🏗 System Architecture

The project operates under a unified single-lift, 4-level architecture (**Floors G, 1, 2, and 3**) with a real-time bridge connecting digital simulation to physical hardware:

```
SmartLift AI Architecture
│
├── 🌐 Frontend (Vite + Vanilla JS + 3D Isometric View)
│   ├── Mode Switcher: Software Simulation ⟷ Hardware Prototype
│   ├── 3D Elevator Hoistway & Real-Time Glass Cabin
│   ├── Passenger Demographic Cards & Category Drag-and-Drop
│   ├── Live Camera HUD (YOLOv8 Real-Time Stream & Waiting Area)
│   ├── Hardware Controller Panel (Serial COM Bridge, IR Sensor State, Motor Control)
│   ├── Dynamic Operational Threshold & Predictive Load Safety Margin
│   ├── RFID Security & Multi-Factor Biometric Verification Monitor
│   └── System Event Log & Explainable Decision Trace
│
├── ⚙️ Python Backend (FastAPI + YOLOv8 + OpenCV + ESP32 Bridge)
│   ├── ESP32Bridge: Bi-directional serial telemetry @ 115200 baud
│   ├── YOLOv8n Pipeline: Real-time person detection & demographic estimation
│   ├── Dynamic Safety Engine: Safety margin & dynamic threshold calculation
│   ├── Biometric Correlator: SFace 128-d / ResNet 512-d embeddings vs. RFID UID
│   ├── Person Management: SQLite Valid & Invalid Persons database
│   └── WebSocket Stream: Real-time low-latency video & detection telemetry
│
└── 🔌 Physical Prototype (ESP32 Dev Module C++ Firmware)
    ├── Optical Limit Sensors: 4 active-LOW IR switches (Floors G, 1, 2, 3)
    ├── L293D Dual H-Bridge: Bidirectional PWM motor & hoist pulley drive
    ├── RC522 RFID Reader: 13.56 MHz SPI badge scanner
    └── Alert Indicators: Active piezoelectric buzzer & status LEDs
```

---

## 🚀 Key Features

### 1. Computer Vision & Predictive Dispatching
- **Real-Time YOLOv8 Person Detection:** Continuously detects waiting passengers in the landing lobby with bounding-box tracking.
- **Demographic Classification:** Classifies passengers into distinct categories:
  - 👨 **Adult:** Standard baseline weight (75 kg).
  - 👦 **Child:** -35 kg deduction.
  - 👴 **Senior Citizen:** -55 kg deduction with elevated priority pickup routing.
  - ♿ **Wheelchair User:** -110 kg deduction with highest scheduling priority.
  - 🧳 **Luggage:** -30 kg operational threshold deduction.
- **Dynamic Operational Threshold:** Rather than fixed limits, the system dynamically scales the cabin threshold between **380 kg and 750 kg** depending on detected demographics and luggage density.
- **Ghost-Call Cancellation:** If a passenger steps away from the waiting area before cabin arrival, the outside hall call is canceled automatically, saving energy and cycle times.

### 2. Multi-Factor Biometric & RFID Security
- **Dual-Factor Authentication:** Requires both a valid **13.56 MHz RFID badge** and facial verification via **SFace / ResNet embeddings**.
- **Anti-Tailgating & Credential Mismatch:** If an authorized card (e.g., VIP UID `69BDF306`) is presented by an unrecognized face, access is denied immediately, a warning sound is triggered, and the intruder's face crop is automatically enrolled into the **Invalid Persons Database**.
- **Restricted Subject Detection:** Flags individuals enrolled in the Invalid Database in real-time even before an RFID scan occurs.

### 3. VIP Autotravel Destination Routing
Presenting an authorized badge at Ground Floor (**G**) automatically dispatches the elevator to the passenger's pre-assigned floor without requiring manual in-cabin button presses:

| Name / User | RFID UID | Destination Floor | Multi-Factor Face Verification |
| :--- | :--- | :--- | :--- |
| **Abhishek Sri Saai** | `69BDF306` | **Floor 2** | Enforced (Biometric Correlated) |
| **Jianna Maria Joseph**| `3EAF1AAA` | **Floor 2** | Enforced (Biometric Correlated) |
| **Sreelakshmi Sajith** | `6E9818AA` | **Floor 1** | Enforced (Biometric Correlated) |
| **Pournami M / Staff** | `12D56B06` | **Floor 3** | Enforced (Biometric Correlated) |

---

## 🔌 Hardware Prototype & Pinout

The physical prototype is powered by an **ESP32 Dev Module (30-pin)** running [`main.ino`](file:///c:/Users/sreel/OneDrive/Documents/Project/main.ino).

```
                      ESP32 Dev Module (30-Pin)
                 ┌─────────────────────────────────┐
                 │ 3V3 ─── RC522 3.3V (VCC)        │
                 │ GND ─── Common GND              │
                 │ D32 ─── Ground Floor (G) Sensor │
                 │ D14 ─── 1st Floor (1) Sensor    │
                 │ D21 ─── 2nd Floor (2) Sensor    │
                 │ D13 ─── 3rd Floor (3) Sensor    │
                 │ D25 ─── Motor EN_A (PWM Speed)  │
                 │ D26 ─── Motor IN1 (Direction 1) │
                 │ D27 ─── Motor IN2 (Direction 2) │
                 │ D22 ─── RC522 RST               │
                 │ D5  ─── RC522 SDA / SS          │
                 │ D18 ─── RC522 SCK               │
                 │ D23 ─── RC522 MOSI              │
                 │ D19 ─── RC522 MISO              │
                 │ D4  ─── Active Buzzer (+)       │
                 │ D2  ─── Status LED              │
                 └─────────────────────────────────┘
```

### Pin Assignment Table

| Subsystem | Peripheral Pin | ESP32 GPIO | Logic / Mode |
| :--- | :--- | :--- | :--- |
| **Floor Sensors** | Ground Floor (G) | **GPIO 32** | `INPUT_PULLUP` (Active LOW) |
| | 1st Floor (1) | **GPIO 14** | `INPUT_PULLUP` (Active LOW) |
| | 2nd Floor (2) | **GPIO 21** | `INPUT_PULLUP` (Active LOW) |
| | 3rd Floor (3) | **GPIO 13** | `INPUT_PULLUP` (Active LOW) |
| **Motor Driver (L293D)** | EN_A (PWM Speed) | **GPIO 25** | PWM (0–255) |
| | IN1 (Forward / Up) | **GPIO 26** | Digital Output |
| | IN2 (Backward / Down) | **GPIO 27** | Digital Output |
| **RFID Reader (RC522)** | SDA / SS | **GPIO 5** | SPI Chip Select |
| | SCK | **GPIO 18** | SPI Clock |
| | MOSI | **GPIO 23** | SPI Master Out |
| | MISO | **GPIO 19** | SPI Master In |
| | RST | **GPIO 22** | Hardware Reset |
| **Indicators** | Buzzer (+) | **GPIO 4** | Digital Output |
| | Status Indicator LED | **GPIO 2** | Digital Output |

> ⚠️ **Important:** Connect IR sensors and RC522 to **3.3V (3V3)**. ESP32 GPIOs are **not 5V tolerant**. Always tie ESP32 ground and external motor power ground together.

---

## 📂 Project Structure

```text
├── main.ino                                # ESP32 microcontroller firmware (sensors, motor, RFID)
├── lift_interface.py                       # Python standalone interactive serial CLI bridge
├── .gitignore                              # Git exclusion rules
├── README.md                               # Project documentation
│
└── SmartLift-AI-Windows/                   # Full-stack application directory
    ├── index.html                          # Dashboard single-page application entry
    ├── package.json                        # Node.js dependencies & scripts
    ├── vite.config.js                      # Vite build configuration
    ├── start-backend.bat                   # 1-click backend launcher
    ├── start-frontend.bat                  # 1-click frontend launcher
    │
    ├── server/                             # FastAPI Backend & Edge AI Services
    │   ├── main.py                         # Unified FastAPI server & ESP32 hardware bridge
    │   ├── detector.py                     # YOLOv8 object detection & bounding box tracker
    │   ├── age.py                          # Caffe-based age & demographic estimation
    │   ├── requirements.txt                # Python dependencies
    │   ├── rfid_config.json                # Authorized RFID tags & autotravel mappings
    │   ├── yolov8n.pt                      # YOLOv8 neural network weights
    │   └── models/                         # Pre-trained deep learning models
    │       ├── face_detection_yunet_2023mar.onnx
    │       ├── face_recognition_sface_2021dec.onnx
    │       ├── age_net.caffemodel
    │       └── res10.caffemodel
    │
    ├── src/                                # Frontend Source Code
    │   ├── main.js                         # Core dashboard logic & hardware telemetry
    │   ├── styles.css                      # Glassmorphic dark UI stylesheet
    │   ├── core/                           # Elevator dispatch & state management
    │   ├── modules/                        # Dynamic threshold & safety engines
    │   └── simulation/                     # Passenger management & 3D shaft renderer
    │
    ├── new changes/                        # Face Recognition & Database Subsystems
    │   ├── face_recognition/               # Feature extraction & cosine similarity matcher
    │   ├── valid_invalid_database/         # SQLite models & initial record seeder
    │   ├── person_management/              # Face image registration & intruder flagging
    │   ├── security_alerts/                # Real-time multi-factor security alerts
    │   └── data/                           # SQLite database & face image store
    │
    └── tests/                              # Automated Test Suites
        ├── test_new_changes.py             # 20-step end-to-end security & dispatch test suite
        ├── test_db_rfid_sync.py            # Database to RFID config synchronization test
        └── verify_simulation.js            # Headless simulation verifier
```

---

## ⚡ Quick Start Guide

### Prerequisites
- **Python 3.10+** (64-bit) — ensure `Add python.exe to PATH` was selected.
- **Node.js 18+** & npm.
- **Arduino IDE 2.x** (if flashing ESP32 firmware).

---

### 1. Backend Server Setup

```powershell
# Navigate to the server folder
cd SmartLift-AI-Windows\server

# Create virtual environment (first time)
python -m venv .venv

# Activate virtual environment
.\.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the FastAPI backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

- **Health Check:** Open `http://localhost:8000/health` (returns `{"status":"ok","model":"yolov8n"}`).
- **Hardware Telemetry:** `http://localhost:8000/hardware/status`.

---

### 2. Frontend Simulation Dashboard

In a **second terminal window**:

```powershell
# Navigate to the project root
cd SmartLift-AI-Windows

# Install frontend dependencies
npm install

# Start the Vite development server
npm run dev
```

- Open **`http://localhost:5173`** in your browser.
- Open the **Camera Input** panel on the left, enable the webcam, and select the monitored floor.

---

### 3. Hardware Prototype / ESP32 Bridge

1. Open [`main.ino`](file:///c:/Users/sreel/OneDrive/Documents/Project/main.ino) in **Arduino IDE**.
2. Select your board (**ESP32 Dev Module**) and USB COM port.
3. Install the required Arduino libraries via Library Manager:
   - `MFRC522` by GithubCommunity
4. Click **Upload** ($\rightarrow$).
5. In the dashboard, click **Connect Hardware** to connect via Serial at 115200 baud.
6. Alternatively, test directly using the interactive terminal CLI:
   ```powershell
   python lift_interface.py
   ```

---

## 📡 API & WebSocket Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Server status, loaded AI model, and inference FPS |
| `GET` | `/hardware/status` | Real-time ESP32 IR sensor states, motor state, target floor |
| `POST`| `/hardware/command` | Dispatch elevator to a validated floor (`{"floor": 0|1|2|3}`) |
| `POST`| `/hardware/connect` | Connects serial bridge to ESP32 on detected COM port |
| `POST`| `/hardware/disconnect`| Releases COM port for external CLI tools |
| `POST`| `/detect` | Single-frame HTTP JPEG inference with bounding box output |
| `WS`  | `/ws/detect` | High-frequency binary WebSocket stream for live webcam YOLO detection |
| `GET` | `/security/events` | Retrieves recent security, access granted, and alert events |
| `GET` | `/security/image/{id}` | Fetches captured security snapshot for identity verification |
| `GET` | `/api/face-db/persons` | Lists registered subjects in Valid / Invalid databases |
| `POST`| `/api/face-db/persons` | Registers a new subject with optional RFID and facial embedding |

---

## 🛠 Tech Stack

- **Computer Vision & AI:** Ultralytics YOLOv8n, OpenCV DNN, SFace (Deep Facial Recognition), Caffe Net.
- **Backend Architecture:** Python, FastAPI, Uvicorn, WebSockets, PySerial, SQLite.
- **Frontend & Simulation:** Vanilla JavaScript (ES Modules), Vite, HTML5 Canvas / CSS3 3D Isometric View.
- **Embedded & IoT Hardware:** ESP32 Dev Module (Tensilica Xtensa Dual-Core 32-bit), C++ / Arduino Framework, L293D H-Bridge, RC522 RFID (SPI), Optical Infrared Proximity Switches.

---

## 👥 Authors & Acknowledgments

- **Jianna Maria Joseph** (23BLC1197)
- **K P Abhishek Sri Saai** (23BLC1292)
- **Sreelakshmi Sajith** (23BLC1299)

*Department of Electronics and Computer Engineering, Vellore Institute of Technology (VIT), Chennai.*
