"""
Face-Based Security Alert Integration Service for SmartLift AI.
Extends the existing security alert system with face matches, identity mismatch warnings,
dual (Face + RFID) threat detection, and continuous encounter cooldown throttling.
"""

import os
import time
from typing import Optional, Dict, Any, List

import cv2
import numpy as np

from face_recognition import config
from valid_invalid_database import db

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_CHANGES_DIR = os.path.abspath(os.path.join(MODULE_DIR, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(NEW_CHANGES_DIR, ".."))
SERVER_DIR = os.path.join(PROJECT_ROOT, "server")
SECURITY_DIR = os.path.join(SERVER_DIR, "security_images")
CROPS_DIR = os.path.join(NEW_CHANGES_DIR, "data", "face_crops")

os.makedirs(SECURITY_DIR, exist_ok=True)
os.makedirs(CROPS_DIR, exist_ok=True)


class SecurityAlertService:
    def __init__(self):
        self.security_events: Optional[List[Dict[str, Any]]] = None
        self.security_lock = None
        self.save_events_callback = None
        self._last_alert_times: Dict[str, float] = {}  # key -> timestamp for cooldown
        self.latest_face_detection: Optional[Dict[str, Any]] = None  # Cached for RFID correlation

    def bind_existing_alert_system(self, security_events_list: list, lock, save_fn):
        """Binds to the existing security alert list, lock, and persistence function."""
        self.security_events = security_events_list
        self.security_lock = lock
        self.save_events_callback = save_fn

    def set_latest_face_detection(self, detection: Dict[str, Any]):
        """Caches the latest detection from camera stream for RFID correlation."""
        self.latest_face_detection = {
            "detection": detection,
            "at": time.time()
        }

    def _is_cooling_down(self, key: str, custom_cooldown: Optional[float] = None) -> bool:
        now = time.time()
        last = self._last_alert_times.get(key, 0.0)
        cooldown = custom_cooldown if custom_cooldown is not None else config.ALERT_COOLDOWN_SECONDS
        if (now - last) < cooldown:
            return True
        self._last_alert_times[key] = now
        return False

    def handle_invalid_face_detected(self, person: Dict[str, Any], confidence: float,
                                     full_frame_bytes: Optional[bytes],
                                     crop_bytes: Optional[bytes],
                                     floor: int = 0) -> Optional[Dict[str, Any]]:
        """
        Triggers a security alert when an enrolled Invalid Person is recognized on camera,
        even if no RFID card has been scanned. Throttles duplicate alerts during one continuous encounter (60s).
        """
        person_id = person.get("id") or person.get("person_id")
        name = person.get("name", "Restricted Subject")
        cooldown_key = f"invalid_face_{person_id}"

        # 60-second encounter throttling so same face does not keep re-alerting continuously
        if self._is_cooling_down(cooldown_key, custom_cooldown=60.0):
            return None

        now = time.time()
        event_id = "SEC-FACE-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        image_file = None
        crop_file = None
        image_status = "NOT_CAPTURED"

        # Save captured camera frame
        if full_frame_bytes:
            image_file = f"{event_id}.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, image_file), "wb") as f:
                    f.write(full_frame_bytes)
                image_status = "IMAGE_CAPTURED"
            except Exception:
                image_status = "CAPTURE_FAILED"

        # Save face crop
        if crop_bytes:
            crop_file = f"{event_id}_crop.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
                with open(os.path.join(CROPS_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
            except Exception:
                pass

        event_data = {
            "event_id": event_id,
            "uid": person.get("rfid_uid") or "N/A",
            "name": name,
            "classification": "INVALID",
            "status": "ACCESS_DENIED",
            "reason": "Invalid Face Match",
            "message": f"Security Alert: Invalid Person Detected — {name}",
            "face_match_confidence": confidence,
            "face_status": "MATCH_INVALID",
            "rfid_status": "NO_SCAN",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "floor": floor,
            "image_status": image_status,
            "image_file": image_file,
            "crop_file": crop_file,
            "source": "FACE_RECOGNITION"
        }

        self._record_event(event_data)
        return event_data

    def handle_identity_mismatch(self, face_person: Dict[str, Any], scanned_uid: str,
                                 rfid_card_name: str, confidence: float,
                                 full_frame_bytes: Optional[bytes],
                                 crop_bytes: Optional[bytes],
                                 floor: int = 0,
                                 ignore_cooldown: bool = False) -> Dict[str, Any]:
        """
        Triggers an Identity Mismatch / Security Alert when detected face does not match
        the presented RFID card credentials (e.g. Invalid person using valid card or Valid person with wrong card).
        """
        cooldown_key = f"mismatch_{face_person.get('id')}_{scanned_uid}"
        if not ignore_cooldown and self._is_cooling_down(cooldown_key):
            return None

        now = time.time()
        event_id = "SEC-MISMATCH-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        image_file = None
        crop_file = None

        if full_frame_bytes:
            image_file = f"{event_id}.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, image_file), "wb") as f:
                    f.write(full_frame_bytes)
            except Exception:
                pass

        if crop_bytes:
            crop_file = f"{event_id}_crop.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
                with open(os.path.join(CROPS_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
            except Exception:
                pass

        registered_uid = (face_person.get("rfid_uid") or "").upper()
        person_name = face_person.get("name", "Unknown Subject")
        is_invalid_person = face_person.get("classification") == "INVALID"

        if is_invalid_person:
            mismatch_msg = f"Security Alert: Invalid Person Detected — {person_name} (Unauthorized Card Attempt: {scanned_uid})"
            reason = "Invalid Person Unauthorized Card Attempt"
        else:
            mismatch_msg = f"Identity Mismatch: {person_name} used wrong RFID ID {scanned_uid} (Expected: {registered_uid or 'assigned card'})"
            reason = "Identity Mismatch"

        event_data = {
            "event_id": event_id,
            "uid": scanned_uid,
            "expected_uid": registered_uid or "69BDF306",
            "name": person_name,
            "classification": face_person.get("classification", "UNKNOWN"),
            "status": "ACCESS_DENIED",
            "reason": reason,
            "message": mismatch_msg,
            "face_match_confidence": confidence,
            "face_status": f"MATCH_{face_person.get('classification', 'UNKNOWN')}",
            "rfid_status": "CREDENTIAL_MISMATCH",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "floor": floor,
            "image_status": "IMAGE_CAPTURED" if image_file else "NO_IMAGE",
            "image_file": image_file,
            "crop_file": crop_file,
            "source": "IDENTITY_VERIFICATION"
        }

        self._record_event(event_data)
        return event_data

    def handle_unregistered_with_auth_card(self, scanned_uid: str, card_owner_name: str,
                                          full_frame_bytes: Optional[bytes],
                                          crop_bytes: Optional[bytes],
                                          floor: int = 0) -> Dict[str, Any]:
        """
        Triggers an alert when an unregistered/unknown person presents an authorized card.
        Automatically enrolls the unauthorized intruder directly into the Invalid Persons Database.
        """
        now = time.time()
        time_str = time.strftime("%H:%M", time.localtime(now))
        event_id = "SEC-UNREG-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        image_file = None
        crop_file = None

        if full_frame_bytes:
            image_file = f"{event_id}.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, image_file), "wb") as f:
                    f.write(full_frame_bytes)
            except Exception:
                pass

        # If crop_bytes is not directly provided but full_frame_bytes is available, extract face crop
        if not crop_bytes and full_frame_bytes:
            try:
                from face_recognition import face_service
                arr = np.frombuffer(full_frame_bytes, dtype=np.uint8)
                f_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if f_img is not None and f_img.size > 0:
                    faces = face_service.detect_faces(f_img)
                    if faces:
                        fx1, fy1, fx2, fy2 = faces[0][:4]
                        f_crop = f_img[fy1:fy2, fx1:fx2]
                        if f_crop.size > 0:
                            _, buf = cv2.imencode(".jpg", f_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                            crop_bytes = buf.tobytes()
            except Exception:
                pass

        if crop_bytes:
            crop_file = f"{event_id}_crop.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
                with open(os.path.join(CROPS_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
            except Exception:
                pass

        # Automatically enroll the intruder into the Invalid Persons Database
        auto_name = f"Intruder ({time_str})"
        enrolled_person = None
        if crop_bytes:
            try:
                from person_management import person_manager
                enrolled_person = person_manager.flag_unknown_face(
                    name=auto_name,
                    crop_bytes=crop_bytes,
                    rfid_uid=scanned_uid
                )
            except Exception as e:
                print(f"[SecurityAlert] Auto-enrollment into Invalid DB failed: {e}")

        mismatch_msg = f"Identity Mismatch: Person is not {card_owner_name} (Card {scanned_uid} requires facial verification of {card_owner_name})"

        event_data = {
            "event_id": event_id,
            "uid": scanned_uid,
            "expected_uid": scanned_uid,
            "name": auto_name if enrolled_person else f"Unregistered (Used Card: {scanned_uid})",
            "classification": "INVALID",
            "status": "ACCESS_DENIED",
            "reason": "Identity Mismatch",
            "message": mismatch_msg,
            "face_match_confidence": 0.0,
            "face_status": "UNKNOWN",
            "rfid_status": "BIOMETRIC_FAILED",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "floor": floor,
            "image_status": "IMAGE_CAPTURED" if image_file else "NO_IMAGE",
            "image_file": image_file,
            "crop_file": crop_file,
            "source": "BIOMETRIC_ENFORCEMENT",
            "auto_enrolled_invalid": True if enrolled_person else False,
            "enrolled_person": enrolled_person
        }

        self._record_event(event_data)
        return event_data

    def handle_missing_face_with_auth_card(self, scanned_uid: str, card_owner_name: str,
                                          floor: int = 0) -> Dict[str, Any]:
        """
        Triggers an alert when an authorized card is tapped but no face is verified in camera.
        """
        now = time.time()
        event_id = "SEC-NOFACE-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        mismatch_msg = f"Identity Verification Required: Card {scanned_uid} requires facial verification of {card_owner_name}"

        event_data = {
            "event_id": event_id,
            "uid": scanned_uid,
            "expected_uid": scanned_uid,
            "name": f"Unverified Subject ({scanned_uid})",
            "classification": "UNKNOWN",
            "status": "ACCESS_DENIED",
            "reason": "Facial Verification Required",
            "message": mismatch_msg,
            "face_match_confidence": 0.0,
            "face_status": "NONE",
            "rfid_status": "NO_FACE_DETECTED",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "floor": floor,
            "image_status": "NO_IMAGE",
            "image_file": None,
            "crop_file": None,
            "source": "BIOMETRIC_ENFORCEMENT"
        }

        self._record_event(event_data)
        return event_data

    def handle_dual_threat(self, person: Dict[str, Any], scanned_uid: str,
                           confidence: float, full_frame_bytes: Optional[bytes],
                           crop_bytes: Optional[bytes], floor: int = 0,
                           ignore_cooldown: bool = False) -> Dict[str, Any]:
        """
        Triggers a combined alert when BOTH face matches an invalid record AND scanned RFID is invalid.
        """
        cooldown_key = f"dual_{person.get('id')}_{scanned_uid}"
        if not ignore_cooldown and self._is_cooling_down(cooldown_key):
            return None

        now = time.time()
        event_id = "SEC-DUAL-%s-%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)), int((now % 1) * 1000))
        image_file = None
        crop_file = None

        if full_frame_bytes:
            image_file = f"{event_id}.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, image_file), "wb") as f:
                    f.write(full_frame_bytes)
            except Exception:
                pass

        if crop_bytes:
            crop_file = f"{event_id}_crop.jpg"
            try:
                with open(os.path.join(SECURITY_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
                with open(os.path.join(CROPS_DIR, crop_file), "wb") as f:
                    f.write(crop_bytes)
            except Exception:
                pass

        person_name = person.get("name", "Invalid Person")
        event_data = {
            "event_id": event_id,
            "uid": scanned_uid,
            "name": person_name,
            "classification": "INVALID",
            "status": "ACCESS_DENIED",
            "reason": "Invalid Person + RFID",
            "message": f"Security Alert: Invalid Person Detected — {person_name} (Used RFID: {scanned_uid})",
            "face_match_confidence": confidence,
            "face_status": "MATCH_INVALID",
            "rfid_status": "ACCESS_DENIED",
            "at": now,
            "time": time.strftime("%H:%M:%S", time.localtime(now)),
            "floor": floor,
            "image_status": "IMAGE_CAPTURED" if image_file else "NO_IMAGE",
            "image_file": image_file,
            "crop_file": crop_file,
            "source": "COMBINED_SECURITY"
        }

        self._record_event(event_data)
        return event_data

    def _record_event(self, event_data: Dict[str, Any]):
        """Thread-safe injection of new security alert into the existing system list and file."""
        if self.security_events is not None and self.security_lock is not None:
            with self.security_lock:
                self.security_events.append(event_data)
                if self.save_events_callback is not None:
                    try:
                        self.save_events_callback()
                    except Exception:
                        pass


alert_service = SecurityAlertService()
