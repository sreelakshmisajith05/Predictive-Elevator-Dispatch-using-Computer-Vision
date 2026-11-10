"""
SmartLift camera backend — YOLO detection + tracking.

Input:  JPEG frames over WebSocket (browser webcam, ~5 fps).
Output: stable track list per frame:
        person boxes with provisional passenger_type,
        luggage linked to the nearest person.

Type mapping v1 (skeleton):
  - child vs adult: relative box height heuristic
    (tune CHILD_HEIGHT_RATIO on site; age estimator plugs in next).
  - wheelchair: seated-posture hint (wide + short box) for UI confirm.
  - senior: needs the age estimator (next step); defaults to adult.

Weight is NEVER guessed by the camera — the UI confirms it per
detection, because SmartLift Core needs real weight numbers.
"""
import time

import cv2
import numpy as np
from ultralytics import YOLO

# COCO class ids used
PERSON = 0
BACKPACK = 24
HANDBAG = 26
SUITCASE = 28
LUGGAGE_CLASSES = {BACKPACK, HANDBAG, SUITCASE}

# Provisional heuristics (tunable on site)
CHILD_HEIGHT_RATIO = 0.45   # person box < 45% of frame height -> child
SEATED_ASPECT_MIN = 1.05    # width/height above this + short box -> seated hint
SEATED_HEIGHT_RATIO = 0.55
DEFAULT_LUGGAGE_WEIGHT = 15  # kg, confirmed in UI (camera cannot weigh)

MODEL_NAME = "yolov8n.pt"


class Detector:
    def __init__(self, model_name=MODEL_NAME, conf=0.45, imgsz=640):
        self.model = YOLO(model_name)  # downloads on first run
        self.conf = conf
        self.imgsz = imgsz
        self.frames = 0
        self.started = time.time()
        # Age estimator plugs in here (step 3): object with
        # .estimate(face_bgr) -> int | None. None = not installed.
        self.age_estimator = None
        try:
            from age import FaceAgeEstimator
            self.age_estimator = FaceAgeEstimator()
        except Exception as exc:  # no models / no network: heuristic stands
            print(f"[detector] age estimator unavailable ({exc}); using height heuristic")

    @property
    def fps(self):
        dt = time.time() - self.started
        return self.frames / dt if dt > 0 else 0.0

    def detect_jpeg(self, jpeg_bytes):
        arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return {"tracks": [], "fps": round(self.fps, 1), "error": "bad_frame"}
        return self.detect_frame(frame)

    def detect_frame(self, frame):
        h, w = frame.shape[:2]
        # persist=True keeps stable track ids (ByteTrack) across frames,
        # which is what makes walk-out-of-frame ghost calls real.
        results = self.model.track(
            frame, persist=True, conf=self.conf,
            imgsz=self.imgsz, classes=[PERSON, BACKPACK, HANDBAG, SUITCASE],
            verbose=False,
        )
        self.frames += 1
        if not results or results[0].boxes is None:
            return {"tracks": [], "fps": round(self.fps, 1)}

        boxes = results[0].boxes
        persons, luggages = [], []
        for i in range(len(boxes)):
            cls = int(boxes.cls[i])
            conf = float(boxes.conf[i])
            x1, y1, x2, y2 = (float(v) for v in boxes.xyxy[i])
            track_id = int(boxes.id[i]) if boxes.id is not None else -1
            item = {
                "track_id": track_id, "confidence": round(conf, 2),
                "box": [x1 / w, y1 / h, x2 / w, y2 / h],  # normalized
                "pixels": [x1, y1, x2, y2],
            }
            if cls == PERSON:
                persons.append(item)
            else:
                luggages.append(item)

        tracks = []
        for p in persons:
            x1, y1, x2, y2 = p["pixels"]
            bw, bh = (x2 - x1) / w, (y2 - y1) / h
            aspect = bw / bh if bh > 0 else 0.0

            # --- provisional type mapping (age estimator refines next) ---
            passenger_type, type_conf = "adult", 0.60
            if bh < CHILD_HEIGHT_RATIO:
                passenger_type, type_conf = "child", 0.55
            age_years = None
            if self.age_estimator is not None:
                try:
                    age_years = self.age_estimator.estimate(frame, p["pixels"])
                except Exception:
                    age_years = None
            if age_years is not None:
                if age_years < 14:
                    passenger_type, type_conf = "child", 0.80
                elif age_years >= 65:
                    passenger_type, type_conf = "senior", 0.70
                else:
                    passenger_type, type_conf = "adult", 0.80

            seated_hint = aspect >= SEATED_ASPECT_MIN and bh < SEATED_HEIGHT_RATIO

            # --- link luggage to nearest person by box-center distance ---
            cx, cy = (x1 + x2) / 2 / w, (y1 + y2) / 2 / h
            has_lug = False
            for lug in luggages:
                lx1, ly1, lx2, ly2 = lug["pixels"]
                lcx, lcy = (lx1 + lx2) / 2 / w, (ly1 + ly2) / 2 / h
                if abs(lcx - cx) < 0.25 and abs(lcy - cy) < 0.45:
                    has_lug = True
                    break

            p.update({
                "label": "person",
                "passenger_type": passenger_type,
                "type_confidence": type_conf,
                "age_years": age_years,
                "seated_hint": seated_hint,
                "luggage_detected": has_lug,
                "luggage_weight": DEFAULT_LUGGAGE_WEIGHT if has_lug else 0,
            })
            del p["pixels"]
            tracks.append(p)

        return {"tracks": tracks, "fps": round(self.fps, 1)}
