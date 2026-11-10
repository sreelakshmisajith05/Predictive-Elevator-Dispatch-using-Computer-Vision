"""
SmartLift AI — Unified Backend & Hardware Bridge
Single-Lift Architecture: Floors G, 1, 2, 3

Integrated directly with:
- C:\\Users\\sreel\\OneDrive\\Documents\\Project\\lift_interface.py (UNCHANGED)
- C:\\Users\\sreel\\OneDrive\\Documents\\Project\\main.ino (UNCHANGED)
"""

import json
import os
import re
import sys
import threading
import time
from threading import Lock

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import serial
import serial.tools.list_ports

from detector import Detector

app = FastAPI(title="SmartLift AI Unified Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

detector = Detector()

# ----------------- Import Unchanged lift_interface.py -----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

try:
    import lift_interface
    HAS_LIFT_INTERFACE = True
except Exception as e:
    HAS_LIFT_INTERFACE = False
    print(f"Notice: Could not import lift_interface directly ({e}); using internal parser fallback.")

SECURITY_DIR = os.path.join(BASE_DIR, "security_images")
EVENTS_FILE = os.path.join(BASE_DIR, "security_events.json")
RFID_CONFIG_FILE = os.path.join(BASE_DIR, "rfid_config.json")
DUP_WINDOW_S = 6.0
MAX_EVENTS = 300

os.makedirs(SECURITY_DIR, exist_ok=True)
_security_lock = Lock()

# Matches AUTHORIZED_UIDS in main.ino: "69BDF306", "3EAF1AAA", "6E9818AA", "12D56B06", "11223344"
AUTOTRAVEL_FLOORS = {
    "12D56B06": 3,
    "6E9818AA": 1,
    "3EAF1AAA": 2,
    "69BDF306": 2,
}

DEFAULT_RFID_CONFIG = {
    "69BDF306": {
        "name": "Abhishek Sri Saai",
        "authorized": True,
        "access_floor": 0,  # Floor G
        "fixed_destination": 2  # Automatically dispatches to Floor 2
    },
    "3EAF1AAA": {
        "name": "Jianna Maria Joseph",
        "authorized": True,
        "access_floor": 0,
        "fixed_destination": 2  # Automatically dispatches to Floor 2
    },
    "6E9818AA": {
        "name": "Sreelakshmi Sajith",
        "authorized": True,
        "access_floor": 0,
        "fixed_destination": 1  # Automatically dispatches to Floor 1
    },
    "12D56B06": {
        "name": "Authorized Staff Tag",
        "authorized": True,
        "access_floor": 0,
        "fixed_destination": 3  # Automatically dispatches to Floor 3
    },
    "11223344": {
        "name": "Authorized Staff Tag",
        "authorized": True,
        "access_floor": 0,
        "fixed_destination": 3
    }
}

try:
    if os.path.exists(RFID_CONFIG_FILE):
        with open(RFID_CONFIG_FILE, "r") as f:
            rfid_config = json.load(f)
    else:
        rfid_config = DEFAULT_RFID_CONFIG
except Exception:
    rfid_config = DEFAULT_RFID_CONFIG

try:
    with open(EVENTS_FILE, "r") as f:
        security_events = json.load(f)
        if not isinstance(security_events, list):
            security_events = []
except Exception:
    security_events = []


def _save_events():
    try:
        with open(EVENTS_FILE, "w") as f:
            json.dump(security_events[-MAX_EVENTS:], f)
    except OSError:
        pass


def _save_rfid_config():
    try:
        with open(RFID_CONFIG_FILE, "w") as f:
            json.dump(rfid_config, f, indent=2)
    except OSError:
        pass


def _uid_ok(uid):
    return isinstance(uid, str) and 1 <= len(uid) <= 32 and re.fullmatch(r"[0-9A-Fa-f]+", uid) is not None


# Buffer for latest frame from webcam for instant security snapshot capture
latest_frame = {"jpeg": None, "at": 0.0}


# ----------------- ESP32 Hardware Bridge -----------------
class ESP32Bridge:
    def __init__(self):
        self.ser = None
        self.port = None
        self.baud = lift_interface.BAUD_RATE if HAS_LIFT_INTERFACE else 115200
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = Lock()

        self.connected = False
        self.current_floor = 0  # 0=G, 1=1, 2=2, 3=3, -1=In Transit
        self.current_floor_name = "G"
        self.target_floor = None
        self.sensors = {"G": False, "1": False, "2": False, "3": False}
        self.motor_state = "IDLE"  # IDLE, MOVING_UP, MOVING_DOWN
        self.last_line = ""
        self.last_rfid_event = None
        self.connection_error = None

    def auto_detect_port(self):
        ports = serial.tools.list_ports.comports()
        for p in ports:
            desc = p.description.lower()
            if "cp210" in desc or "uart" in desc or "ch340" in desc or "usb-serial" in desc or p.device == "COM7":
                return p.device
        if ports:
            return ports[0].device
        return "COM7"

    def connect(self, port=None):
        with self.lock:
            if self.connected and self.ser and self.ser.is_open:
                return True
            target_port = port or self.auto_detect_port()
            try:
                self.ser = serial.Serial(target_port, self.baud, timeout=1, dsrdtr=False, rtscts=False)
                self.ser.dtr = False
                self.ser.rts = False
                time.sleep(1.0)
                self.ser.reset_input_buffer()
                self.port = target_port
                self.connected = True
                self.connection_error = None
                self.stop_event.clear()
                self.thread = threading.Thread(target=self._reader_loop, daemon=True)
                self.thread.start()
                return True
            except Exception as e:
                self.connected = False
                err_str = str(e)
                if "PermissionError" in err_str or "Access is denied" in err_str:
                    self.connection_error = f"Port {target_port} is currently in use (e.g. by lift_interface.py in terminal). Close lift_interface.py or click Connect when ready."
                else:
                    self.connection_error = err_str
                return False

    def disconnect(self):
        with self.lock:
            self.stop_event.set()
            if self.ser and self.ser.is_open:
                try:
                    self.ser.close()
                except Exception:
                    pass
            self.connected = False
            self.connection_error = "Port released. You can now run python lift_interface.py in terminal."

    def _parse_sensor_line(self, line: str):
        # Uses lift_interface.py's parse_sensor_line directly!
        if HAS_LIFT_INTERFACE:
            return lift_interface.parse_sensor_line(line)

        patterns = {
            "G": re.search(r"\bG\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
            "1": re.search(r"\b1\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
            "2": re.search(r"\b2\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
            "3": re.search(r"\b3\s*[:=]\s*(LOW|HIGH|0|1)\b", line, re.IGNORECASE),
        }
        if not any(patterns.values()):
            return None

        def is_trig(m):
            return m is not None and m.group(1).upper() in ("LOW", "0")

        return {
            "G": is_trig(patterns["G"]),
            "1": is_trig(patterns["1"]),
            "2": is_trig(patterns["2"]),
            "3": is_trig(patterns["3"]),
        }

    def _determine_floor(self, sensors: dict) -> tuple[int, str]:
        # Uses lift_interface.py's determine_floor directly!
        if HAS_LIFT_INTERFACE:
            desc = lift_interface.determine_floor(sensors)
            if "3" in desc:
                return 3, "3"
            elif "2" in desc:
                return 2, "2"
            elif "1" in desc:
                return 1, "1"
            elif "G" in desc or "Ground" in desc:
                return 0, "G"
            else:
                return -1, "In Transit"

        if sensors.get("3", False):
            return 3, "3"
        elif sensors.get("2", False):
            return 2, "2"
        elif sensors.get("1", False):
            return 1, "1"
        elif sensors.get("G", False):
            return 0, "G"
        else:
            return -1, "In Transit"

    def _handle_rfid_scan(self, uid: str):
        uid = uid.upper().strip()

        # 1. ALWAYS consult the database first as the ground truth!
        p_db = None
        try:
            from valid_invalid_database import db
            p_db = db.get_person_by_uid(uid)
        except Exception:
            p_db = None

        conf = rfid_config.get(uid)

        if p_db is not None:
            # Database classification is the absolute ground truth
            classification = (p_db.get("classification") or "INVALID").upper()
            is_auth = (classification == "VALID")
            person_name = p_db.get("name") or (conf.get("name") if conf else f"Tag {uid}")
            if is_auth:
                if uid in AUTOTRAVEL_FLOORS:
                    fixed_dest = AUTOTRAVEL_FLOORS[uid]
                elif conf and conf.get("fixed_destination") is not None:
                    fixed_dest = conf.get("fixed_destination")
                else:
                    fixed_dest = 2
            else:
                fixed_dest = None

            # Keep rfid_config in memory & on disk synchronized
            if conf:
                conf["authorized"] = is_auth
                conf["name"] = person_name
                conf["fixed_destination"] = fixed_dest
            else:
                rfid_config[uid] = {
                    "name": person_name,
                    "authorized": is_auth,
                    "access_floor": 0,
                    "fixed_destination": fixed_dest
                }
            _save_rfid_config()
        else:
            # Fallback to rfid_config or AUTOTRAVEL_FLOORS if not in database
            is_auth = conf.get("authorized", False) if conf else (uid in AUTOTRAVEL_FLOORS)
            person_name = conf.get("name") if (conf and conf.get("name")) else (
                "Abhishek Sri Saai" if uid == "69BDF306" else
                "Jianna Maria Joseph" if uid == "3EAF1AAA" else
                "Sreelakshmi Sajith" if uid == "6E9818AA" else
                "Authorized Staff Tag" if uid == "12D56B06" else "Unregistered Tag"
            )
            if is_auth:
                if uid in AUTOTRAVEL_FLOORS:
                    fixed_dest = AUTOTRAVEL_FLOORS[uid]
                elif conf and conf.get("fixed_destination") is not None:
                    fixed_dest = conf.get("fixed_destination")
                else:
                    fixed_dest = 2
            else:
                fixed_dest = None

        now = time.time()
        event_id = "SEC-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        image_status = "NOT_APPLICABLE"
        image_file = None

        if not is_auth:
            if not p_db:
                try:
                    from valid_invalid_database import db
                    from face_recognition import face_service
                    db.create_person(
                        name=f"Unauthorized Tag ({uid})",
                        classification="INVALID",
                        rfid_uid=uid,
                        image_filename=None
                    )
                    face_service.refresh_enrolled_cache()
                except Exception:
                    pass

            # Only attach photo if camera is actively streaming fresh frames (within last 3.0 seconds)
            is_camera_active = (now - latest_frame.get("at", 0.0)) < 3.0
            frame = latest_frame["jpeg"] if is_camera_active else None
            if frame:
                image_file = f"{event_id}.jpg"
                try:
                    with open(os.path.join(SECURITY_DIR, image_file), "wb") as f:
                        f.write(frame)
                    image_status = "IMAGE_CAPTURED"
                except Exception:
                    image_status = "IMAGE_CAPTURE_FAILED"
            else:
                image_status = "NOT_AVAILABLE"

        event_data = {
            "event_id": event_id,
            "uid": uid,
            "name": person_name,
            "status": "ACCESS_GRANTED" if is_auth else "ACCESS_DENIED",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "fixed_destination": fixed_dest,
            "image_status": image_status,
            "image_file": image_file,
            "source": "ESP32_RC522"
        }

        with _security_lock:
            if not security_events or security_events[-1].get("uid") != uid or (now - security_events[-1].get("at", 0) > DUP_WINDOW_S):
                security_events.append(event_data)
                _save_events()

        self.last_rfid_event = event_data

        if is_auth and fixed_dest is not None:
            time.sleep(0.4)
            self.send_command(fixed_dest)

    def _reader_loop(self):
        while not self.stop_event.is_set():
            try:
                if self.ser and self.ser.in_waiting > 0:
                    raw = self.ser.readline()
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    self.last_line = line

                    sensors = self._parse_sensor_line(line)
                    if sensors:
                        floor_num, floor_name = self._determine_floor(sensors)
                        self.sensors = sensors
                        if floor_num != -1:
                            self.current_floor = floor_num
                            self.current_floor_name = floor_name

                    uid_match = re.search(r"Card\s+UID:\s*([0-9A-Fa-f]+)", line)
                    if uid_match:
                        uid = uid_match.group(1).upper()
                        self._handle_rfid_scan(uid)

                    if "Motor moving FORWARD" in line:
                        self.motor_state = "MOVING_UP"
                    elif "Motor moving BACKWARD" in line:
                        self.motor_state = "MOVING_DOWN"
                    elif "TARGET REACHED" in line or "Already at target floor" in line or "Stopped." in line:
                        self.motor_state = "IDLE"
                        self.target_floor = None

                else:
                    time.sleep(0.03)
            except Exception as e:
                if not self.stop_event.is_set():
                    self.connection_error = str(e)
                    self.connected = False
                break

    def send_command(self, floor: int) -> bool:
        """Sends target floor command ('G', '1', '2', '3') matching lift_interface.py & main.ino."""
        if not (0 <= floor <= 3):
            return False
        cmd_char = "G" if floor == 0 else str(floor)
        self.target_floor = floor
        if self.ser and self.ser.is_open:
            try:
                # Matches lift_interface.py line 186-188: message = f"{cmd}\n"; ser.write(); ser.flush()
                msg = f"{cmd_char}\n"
                self.ser.write(msg.encode("utf-8"))
                self.ser.flush()
                return True
            except Exception as e:
                self.connection_error = str(e)
                return False
        return False

    def get_status(self) -> dict:
        return {
            "connected": self.connected,
            "port": self.port,
            "current_floor": self.current_floor,
            "current_floor_name": self.current_floor_name,
            "target_floor": self.target_floor,
            "sensors": self.sensors,
            "motor_state": self.motor_state,
            "last_line": self.last_line,
            "last_rfid": self.last_rfid_event,
            "lift_interface_integrated": HAS_LIFT_INTERFACE,
            "error": self.connection_error
        }


esp32_bridge = ESP32Bridge()

# Auto-connect bridge on startup
threading.Thread(target=lambda: esp32_bridge.connect(), daemon=True).start()


# ----------------- Hardware Endpoints -----------------
@app.get("/hardware/status")
def get_hardware_status():
    return esp32_bridge.get_status()


@app.post("/hardware/command")
def send_hardware_command(payload: dict):
    floor = payload.get("floor")
    if not isinstance(floor, int) or not (0 <= floor <= 3):
        return {"ok": False, "error": "Invalid floor. Must be 0, 1, 2, or 3."}
    success = esp32_bridge.send_command(floor)
    return {
        "ok": success,
        "floor": floor,
        "floor_name": "G" if floor == 0 else str(floor),
        "connected": esp32_bridge.connected,
        "error": esp32_bridge.connection_error
    }


@app.post("/hardware/connect")
def connect_hardware(payload: dict = None):
    port = payload.get("port") if payload else None
    ok = esp32_bridge.connect(port)
    return {"ok": ok, "status": esp32_bridge.get_status()}


@app.post("/hardware/disconnect")
def disconnect_hardware():
    esp32_bridge.disconnect()
    return {"ok": True, "status": esp32_bridge.get_status()}


@app.get("/hardware/rfid-config")
def get_rfid_config():
    return rfid_config


@app.post("/hardware/rfid-config")
def set_rfid_config(payload: dict):
    global rfid_config
    if not isinstance(payload, dict):
        return {"ok": False, "error": "Payload must be a dict of UID configs"}
    rfid_config.update(payload)
    _save_rfid_config()
    return {"ok": True, "config": rfid_config}


# ----------------- Simulation Mirror -----------------
lift_mirror = {
    "lift": "SmartLift",
    "floor": 0,
    "door": "closed",
    "moving": False,
    "direction": "idle",
    "at": 0.0
}
VALID_DOORS = {"closed", "opening", "open", "closing"}
VALID_DIRECTIONS = {"idle", "up", "down"}


@app.post("/mirror/lift")
def set_lift_mirror(payload: dict):
    if not isinstance(payload, dict):
        return {"ok": False, "error": "malformed_event"}
    floor = payload.get("floor")
    if not isinstance(floor, int) or isinstance(floor, bool) or not (0 <= floor <= 3):
        return {"ok": False, "error": "bad_floor"}
    door = payload.get("door", "closed")
    direction = payload.get("direction", "idle")
    lift_mirror.update({
        "lift": "SmartLift",
        "floor": floor,
        "door": door if door in VALID_DOORS else "closed",
        "moving": bool(payload.get("moving", False)),
        "direction": direction if direction in VALID_DIRECTIONS else "idle",
        "at": time.time(),
    })
    return {"ok": True, "floor": floor}


@app.get("/mirror/lift")
def get_lift_mirror():
    return lift_mirror


# ----------------- System Health & Config -----------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "system": "SmartLift AI Single-Lift",
        "floors": ["G", "1", "2", "3"],
        "model": "yolov8n",
        "fps": round(detector.fps, 1),
        "hardware_connected": esp32_bridge.connected,
        "hardware_port": esp32_bridge.port,
        "lift_interface_integrated": HAS_LIFT_INTERFACE
    }


@app.get("/config")
def config():
    from detector import CHILD_HEIGHT_RATIO, DEFAULT_LUGGAGE_WEIGHT
    return {
        "system": "SmartLift AI",
        "floors": 4,
        "floor_labels": ["G", "1", "2", "3"],
        "model": "yolov8n",
        "tracked_classes": ["person", "backpack", "handbag", "suitcase"],
        "child_height_ratio": CHILD_HEIGHT_RATIO,
        "default_luggage_weight_kg": DEFAULT_LUGGAGE_WEIGHT,
        "age_estimator": detector.age_estimator is not None,
        "hardware_port": esp32_bridge.port,
        "hardware_connected": esp32_bridge.connected,
        "lift_interface_integrated": HAS_LIFT_INTERFACE
    }


# ----------------- RFID Security Endpoints -----------------
@app.post("/security/rfid-event")
def rfid_event(payload: dict):
    uid = payload.get("uid") if isinstance(payload, dict) else None
    if not _uid_ok(uid):
        return {"ok": False, "error": "malformed_event"}
    uid = uid.upper()
    esp32_bridge._handle_rfid_scan(uid)
    return {"ok": True, "last_event": esp32_bridge.last_rfid_event}


@app.get("/security/events")
def list_events(limit: int = 25):
    lim = max(1, min(limit, 100))
    with _security_lock:
        return {"events": list(reversed(security_events[-lim:]))}


@app.post("/security/events/clear")
def clear_events():
    global security_events
    with _security_lock:
        security_events.clear()
        _save_events()
    return {"ok": True}


@app.get("/security/image/{event_id}")
def get_image(event_id: str):
    with _security_lock:
        ev = next((e for e in security_events if e["event_id"] == event_id), None)
    if not ev:
        return {"ok": False, "error": "no_image"}
    img_file = ev.get("image_file") or ev.get("crop_file")
    if not img_file:
        return {"ok": False, "error": "no_image"}
    path = os.path.join(SECURITY_DIR, img_file)
    if not os.path.isfile(path):
        return {"ok": False, "error": "no_image"}
    return FileResponse(path, media_type="image/jpeg", filename=img_file)


# ----------------- Camera Detection WebSocket -----------------
@app.websocket("/ws/detect")
async def ws_detect(ws: WebSocket):
    await ws.accept()
    floor = 0
    try:
        while True:
            msg = await ws.receive()
            if "text" in msg and msg["text"]:
                try:
                    data = json.loads(msg["text"])
                    if "floor" in data:
                        floor = int(data["floor"])
                        await ws.send_json({"floor": floor, "tracks": [], "fps": 0.0, "ack": True})
                except (ValueError, TypeError):
                    pass
                continue
            data = msg.get("bytes")
            if not data:
                continue
            latest_frame["jpeg"] = bytes(data)
            latest_frame["at"] = time.time()
            try:
                result = detector.detect_jpeg(data)
            except Exception as exc:
                result = {"tracks": [], "fps": 0.0, "error": str(exc)[:120]}
            result["floor"] = floor
            await ws.send_json(result)
    except (WebSocketDisconnect, RuntimeError):
        pass


@app.post("/detect")
async def post_detect(payload: dict):
    image_b64 = payload.get("image", "")
    floor = payload.get("floor", 0)
    if not image_b64:
        return {"ok": False, "detections": []}
    try:
        import base64
        if "," in image_b64:
            image_b64 = image_b64.split(",", 1)[1]
        raw_bytes = base64.b64decode(image_b64)
        latest_frame["jpeg"] = raw_bytes
        latest_frame["at"] = time.time()
        result = detector.detect_jpeg(raw_bytes)
        return {"ok": True, "detections": result.get("tracks", []), "fps": result.get("fps", 0.0), "floor": floor}
    except Exception as e:
        return {"ok": False, "error": str(e), "detections": []}


@app.post("/camera/stop")
def post_camera_stop():
    latest_frame["jpeg"] = None
    latest_frame["at"] = 0.0
    return {"ok": True}


# ----------------- Integration: Face Recognition & Valid/Invalid Databases -----------------
try:
    _new_changes_path = os.path.abspath(os.path.join(BASE_DIR, "..", "new changes"))
    if _new_changes_path not in sys.path:
        sys.path.insert(0, _new_changes_path)
    from integration.api import register_new_changes
    register_new_changes(app, detector, esp32_bridge, latest_frame, security_events, _security_lock)
    print("[SmartLift] Face Recognition & Valid/Invalid Database integration active.")
except Exception as _e:
    print(f"[SmartLift] Notice: new changes integration inactive ({_e}).")

