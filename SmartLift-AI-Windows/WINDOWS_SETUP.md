# SmartLift AI — Windows setup

## What you need installed

| Software | Version | Where |
| --- | --- | --- |
| Python | 3.10 or newer, 64-bit | python.org — tick **Add python.exe to PATH** during install |
| Node.js | 18 or newer | nodejs.org |
| Arduino IDE | 2.x (only for the ESP32 board) | arduino.org |

## 1. Start the backend (camera + RFID + lift mirror)

Open PowerShell in this folder:

```
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Leave that window running. The first start takes a minute while YOLO loads.

Allow the Windows Firewall prompt for **Private networks** when it appears.

Check it works: open <http://localhost:8000/health> — you should see
`{"status":"ok","model":"yolov8n","fps":0.0}`.

The AI models are already included, so nothing is downloaded at startup.

## 2. Start the simulation dashboard

Open a **second** PowerShell window in this folder:

```
npm install
npm run dev
```

Then open <http://localhost:5173>.

## 3. Connect the dashboard to the backend

In the dashboard, open the **CAMERA INPUT** panel on the left:

- Backend field: `ws://localhost:8000/ws/detect` (already the default)
- Floor: pick the floor the camera watches
- Click **Enable camera** and allow the browser webcam prompt

Detections appear as pending tracks, and a steady track joins as a waiting
passenger after 5 frames. Walking out of frame fires a ghost call.

## Quick start (no typing)

Double-click these instead of using the commands:

- `start-backend.bat` — creates the venv on first run, installs packages, starts the backend
- `start-frontend.bat` — installs npm packages on first run, starts the dashboard

## Ports

| Service | Port |
| --- | --- |
| Backend (camera, RFID, mirror) | 8000 |
| Dashboard | 5173 |

If 8000 is already used, start uvicorn on another port and paste that URL into
the dashboard's backend field, for example `ws://localhost:8001/ws/detect`.
Find what is using a port with `netstat -ano | findstr :8000`.

## ESP32 hardware (optional)

Sketch: `server/esp32/SmartLift_Combined/SmartLift_Combined.ino`

1. Fill in `WIFI_SSID`, `WIFI_PASSWORD`, and both URLs, using this PC's LAN IP
   from `ipconfig` (look for **IPv4 Address**), for example:
   `http://192.168.1.20:8000/security/rfid-event`
   Never use `localhost` in the sketch — the ESP32 is a different machine.
2. Board: **ESP32 Dev Module**. Library: **MFRC522**.
3. IR floor sensors are wired bottom to top on GPIO 15, 2, 21, 13.
   Flash once with `SENSOR_CHECK 1` to confirm the order and polarity,
   then set it back to 0.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `No module named uvicorn` | The venv is not active. Run `.venv\Scripts\activate` first |
| Camera never starts | Browser blocked it. Allow camera access for localhost |
| Dashboard shows no detections | Backend not running, or the backend URL field is wrong |
| `npm install` errors | Delete the `node_modules` folder and run `npm install` again |
| Port in use | `netstat -ano | findstr :8000`, then change the port |
| ESP32 not reaching the backend | Same Wi-Fi network, and the IP in the sketch must match `ipconfig` |
