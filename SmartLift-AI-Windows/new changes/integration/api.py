"""
FastAPI Router and Integration Hooks for SmartLift AI Face Recognition & Database System.
Seamlessly connects to existing backend without altering existing logic.
"""

import base64
import os
import sys
import time
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, FastAPI, File, UploadFile, Form, HTTPException, Query, Header
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from valid_invalid_database import db, seed_initial_records_once
from face_recognition import face_service
from person_management import person_manager
from security_alerts import alert_service

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_CHANGES_DIR = os.path.abspath(os.path.join(MODULE_DIR, ".."))
IMAGES_DIR = os.path.join(NEW_CHANGES_DIR, "data", "face_images")
CROPS_DIR = os.path.join(NEW_CHANGES_DIR, "data", "face_crops")

router = APIRouter(prefix="/api/face-db", tags=["Face Recognition & Databases"])

# In-memory storage of the latest face detection for UI polling & unknown flagging
_latest_live_face = {
    "detected": False,
    "face_status": "NONE",
    "confidence": 0.0,
    "person": None,
    "crop_b64": None,
    "crop_bytes": None,
    "at": 0.0,
    "floor": 0
}
_latest_live_faces = []


# ----------------- Request Schemas -----------------
class PersonCreateRequest(BaseModel):
    name: str
    classification: str  # VALID or INVALID
    rfid_uid: Optional[str] = None


class PersonUpdateRequest(BaseModel):
    name: Optional[str] = None
    classification: Optional[str] = None
    rfid_uid: Optional[str] = None


class FlagUnknownRequest(BaseModel):
    name: str
    crop_b64: Optional[str] = None
    rfid_uid: Optional[str] = None


class VerifyFaceRequest(BaseModel):
    name: str
    classification: Optional[str] = "VALID"  # VALID or INVALID
    crop_b64: Optional[str] = None
    rfid_uid: Optional[str] = None


class SimulateDetectionRequest(BaseModel):
    face_status: str  # MATCH_VALID, MATCH_INVALID, UNKNOWN, NONE
    person: Optional[Dict[str, Any]] = None
    crop_b64: Optional[str] = None
    confidence: Optional[float] = 0.95


# ----------------- API Endpoints -----------------
@router.get("/status")
def get_service_status():
    """Returns database counts and face recognition engine status."""
    valid_count = len(db.get_all_persons(classification="VALID"))
    invalid_count = len(db.get_all_persons(classification="INVALID"))
    enrolled_count = len(db.get_all_enrolled_encodings())
    return {
        "ok": True,
        "valid_persons_count": valid_count,
        "invalid_persons_count": invalid_count,
        "enrolled_faces_count": enrolled_count,
        "face_detector_ready": face_service.detector_net is not None or face_service.haar_cascade is not None,
        "feature_extractor_ready": face_service.feature_extractor is not None,
        "latest_face_detected": _latest_live_face["detected"] and (time.time() - _latest_live_face["at"] < 4.0),
        "latest_face_status": _latest_live_face["face_status"] if (time.time() - _latest_live_face["at"] < 4.0) else "NONE"
    }


@router.get("/persons")
def list_persons(classification: Optional[str] = Query(None, description="VALID or INVALID")):
    """Lists persons from Valid, Invalid, or both databases."""
    persons = db.get_all_persons(classification=classification)
    return {"ok": True, "count": len(persons), "persons": persons}


@router.get("/persons/{person_id}")
def get_person(person_id: int):
    """Retrieves a single person record."""
    person = db.get_person_by_id(person_id)
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    return {"ok": True, "person": person}


@router.post("/persons")
def create_person(req: PersonCreateRequest):
    """Creates a new person in either the Valid or Invalid database."""
    if req.classification.upper() not in ("VALID", "INVALID"):
        raise HTTPException(status_code=400, detail="Classification must be VALID or INVALID")
    try:
        created = db.create_person(
            name=req.name,
            classification=req.classification.upper(),
            rfid_uid=req.rfid_uid
        )
        try:
            import main as srv_main
            rfid_cfg = getattr(srv_main, "rfid_config", None)
            save_fn = getattr(srv_main, "_save_rfid_config", None)
            if rfid_cfg is not None and created.get("rfid_uid"):
                c_uid = created["rfid_uid"].strip().upper()
                is_auth = (created.get("classification") == "VALID")
                rfid_cfg[c_uid] = {
                    "name": created.get("name"),
                    "authorized": is_auth,
                    "access_floor": 0,
                    "fixed_destination": 2 if is_auth else None
                }
                if callable(save_fn):
                    save_fn()
        except Exception:
            pass
        return {"ok": True, "person": created}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/persons/{person_id}")
def update_person(person_id: int, req: PersonUpdateRequest):
    """Updates a person's name, RFID UID, or classification."""
    try:
        old_person = db.get_person_by_id(person_id)
        updated = db.update_person(
            person_id=person_id,
            name=req.name,
            classification=req.classification,
            rfid_uid=req.rfid_uid
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Person not found")
        face_service.refresh_enrolled_cache()

        # Synchronize rfid_config in server/main.py so RFID scans immediately reflect new status
        try:
            import main as srv_main
            rfid_cfg = getattr(srv_main, "rfid_config", None)
            save_fn = getattr(srv_main, "_save_rfid_config", None)
            if rfid_cfg is not None:
                # If old RFID was different, remove or update it
                if old_person and old_person.get("rfid_uid"):
                    old_uid = old_person["rfid_uid"].strip().upper()
                    if old_uid != (updated.get("rfid_uid") or "").strip().upper() and old_uid in rfid_cfg:
                        rfid_cfg.pop(old_uid, None)

                new_uid = (updated.get("rfid_uid") or "").strip().upper()
                if new_uid:
                    is_auth = (updated.get("classification") == "VALID")
                    if new_uid in rfid_cfg:
                        rfid_cfg[new_uid]["authorized"] = is_auth
                        rfid_cfg[new_uid]["name"] = updated.get("name")
                    else:
                        rfid_cfg[new_uid] = {
                            "name": updated.get("name"),
                            "authorized": is_auth,
                            "access_floor": 0,
                            "fixed_destination": 2 if is_auth else None
                        }
                if callable(save_fn):
                    save_fn()
        except Exception:
            pass

        return {"ok": True, "person": updated}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@router.delete("/persons/{person_id}")
def delete_person(
    person_id: int,
    password: Optional[str] = Query(None),
    x_security_password: Optional[str] = Header(None, alias="X-Security-Password")
):
    """Deletes a person record, their image, and face encodings. Requires security password 'xyz123'."""
    provided_pw = password or x_security_password
    if provided_pw != "xyz123":
        raise HTTPException(
            status_code=403,
            detail="Unauthorized: Invalid security password. Deletion rejected."
        )
    person_to_del = db.get_person_by_id(person_id)
    success = person_manager.delete_person(person_id)
    if not success:
        raise HTTPException(status_code=404, detail="Person not found")

    try:
        import main as srv_main
        rfid_cfg = getattr(srv_main, "rfid_config", None)
        save_fn = getattr(srv_main, "_save_rfid_config", None)
        if rfid_cfg is not None and person_to_del and person_to_del.get("rfid_uid"):
            del_uid = person_to_del["rfid_uid"].strip().upper()
            if del_uid in rfid_cfg:
                rfid_cfg.pop(del_uid, None)
            if callable(save_fn):
                save_fn()
    except Exception:
        pass

    return {"ok": True, "deleted_id": person_id}


@router.post("/persons/{person_id}/image")
async def upload_person_image(person_id: int, file: UploadFile = File(...)):
    """Uploads or replaces a person's reference face image."""
    try:
        contents = await file.read()
        updated = person_manager.upload_face_image(
            person_id=person_id,
            image_bytes=contents,
            original_filename=file.filename or "upload.jpg"
        )
        return {"ok": True, "person": updated, "message": "Face image uploaded and registered for recognition."}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image upload failed: {str(e)}")


class ImageBase64UploadRequest(BaseModel):
    image_b64: str
    filename: Optional[str] = "upload.jpg"


@router.post("/persons/{person_id}/image-base64")
def upload_person_image_base64(person_id: int, req: ImageBase64UploadRequest):
    """Uploads or replaces a person's reference face image using base64 encoded data."""
    try:
        raw_b64 = req.image_b64
        if "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]
        contents = base64.b64decode(raw_b64)
        updated = person_manager.upload_face_image(
            person_id=person_id,
            image_bytes=contents,
            original_filename=req.filename or "upload.jpg"
        )
        return {"ok": True, "person": updated, "message": "Face image uploaded and registered for recognition."}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image upload failed: {str(e)}")


@router.delete("/persons/{person_id}/image")
def delete_person_image(
    person_id: int,
    password: Optional[str] = None,
    x_security_password: Optional[str] = Header(None, alias="X-Security-Password")
):
    """Removes a person's face image and references."""
    provided_pw = password or x_security_password
    if provided_pw and provided_pw != "xyz123":
        raise HTTPException(
            status_code=403,
            detail="Unauthorized: Invalid security password. Image deletion rejected."
        )
    try:
        updated = person_manager.remove_face_image(person_id)
        return {"ok": True, "person": updated}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@router.get("/images/{filename}")
def serve_face_image(filename: str):
    """Securely serves a reference face image."""
    clean_name = os.path.basename(filename)
    path = os.path.join(IMAGES_DIR, clean_name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path, media_type="image/jpeg", filename=clean_name)


@router.get("/latest-face")
def get_latest_face():
    """Returns the most recently detected live camera faces for UI verification and status."""
    is_recent = (time.time() - _latest_live_face["at"]) < 5.0
    faces_list = []
    if is_recent and _latest_live_faces:
        for f in _latest_live_faces:
            faces_list.append({
                "face_status": f.get("face_status", "NONE"),
                "confidence": f.get("confidence", 0.0),
                "person": f.get("person"),
                "crop_b64": f.get("crop_b64"),
                "floor": f.get("floor", 0),
                "box": f.get("box")
            })

    return {
        "ok": True,
        "has_recent_face": is_recent and _latest_live_face["detected"],
        "face_status": _latest_live_face["face_status"] if is_recent else "NONE",
        "confidence": _latest_live_face["confidence"] if is_recent else 0.0,
        "person": _latest_live_face["person"] if is_recent else None,
        "crop_b64": _latest_live_face["crop_b64"] if is_recent else None,
        "floor": _latest_live_face["floor"] if is_recent else 0,
        "at": _latest_live_face["at"],
        "faces": faces_list,
        "count": len(faces_list)
    }


@router.post("/verify-face")
def verify_face(req: VerifyFaceRequest):
    """
    Administrator action to verify a detected new face and enroll them into
    either the Valid Persons Database or the Invalid Persons Database.
    """
    crop_bytes = None
    if req.crop_b64:
        try:
            b64_str = req.crop_b64
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            crop_bytes = base64.b64decode(b64_str)
        except Exception:
            crop_bytes = None

    if not crop_bytes and _latest_live_face.get("crop_bytes"):
        crop_bytes = _latest_live_face["crop_bytes"]

    if not crop_bytes:
        raise HTTPException(status_code=400, detail="No face crop available to verify.")

    try:
        classification = (req.classification or "VALID").upper()
        if classification not in ("VALID", "INVALID"):
            classification = "VALID"
        created = person_manager.enroll_unknown_face(
            name=req.name,
            classification=classification,
            crop_bytes=crop_bytes,
            rfid_uid=req.rfid_uid
        )
        return {
            "ok": True,
            "person": created,
            "message": f"Successfully enrolled '{created['name']}' into {classification} Persons Database."
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/flag-unknown")
def flag_unknown_face(req: FlagUnknownRequest):
    """
    Administrator action to flag a detected unknown face as an Invalid Person.
    Persists to Invalid database and activates future facial recognition.
    """
    crop_bytes = None
    if req.crop_b64:
        try:
            b64_str = req.crop_b64
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            crop_bytes = base64.b64decode(b64_str)
        except Exception:
            crop_bytes = None

    if not crop_bytes and _latest_live_face.get("crop_bytes"):
        crop_bytes = _latest_live_face["crop_bytes"]

    if not crop_bytes:
        raise HTTPException(status_code=400, detail="No face crop available to flag.")

    try:
        created = person_manager.flag_unknown_face(
            name=req.name,
            crop_bytes=crop_bytes,
            rfid_uid=req.rfid_uid
        )
        return {
            "ok": True,
            "person": created,
            "message": f"Successfully flagged '{created['name']}' as Invalid Person."
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


_simulation_override_until = 0.0


@router.post("/simulate-detection")
def simulate_detection(req: SimulateDetectionRequest):
    """Testing & simulation helper to trigger a specific face recognition state in backend."""
    global _simulation_override_until
    if req.face_status == "NONE":
        _simulation_override_until = 0.0
        _latest_live_face["detected"] = False
        _latest_live_face["face_status"] = "NONE"
        _latest_live_face["person"] = None
        _latest_live_face["crop_b64"] = None
        _latest_live_face["crop_bytes"] = None
    else:
        _simulation_override_until = time.time() + 10.0
        _latest_live_face["detected"] = True
        _latest_live_face["face_status"] = req.face_status
        _latest_live_face["confidence"] = req.confidence or 0.95
        _latest_live_face["person"] = req.person
        _latest_live_face["crop_b64"] = req.crop_b64
        if req.crop_b64:
            try:
                b64_str = req.crop_b64
                if "," in b64_str:
                    b64_str = b64_str.split(",", 1)[1]
                _latest_live_face["crop_bytes"] = base64.b64decode(b64_str)
            except Exception:
                _latest_live_face["crop_bytes"] = None
        else:
            _latest_live_face["crop_bytes"] = None
        _latest_live_face["at"] = time.time()
    safe_face = {k: v for k, v in _latest_live_face.items() if k != "crop_bytes"}
    return {"ok": True, "latest_face": safe_face}


# ----------------- Integration Hook -----------------
def register_new_changes(app: FastAPI, detector, esp32_bridge, latest_frame: dict, security_events: list, security_lock):
    """
    Connects face recognition, person management, and extended alerts to the existing backend.
    Preserves all existing logic while augmenting camera frame analysis and RFID scans.
    """
    # 1. Initialize DB and seed required initial records idempotently
    seed_initial_records_once()

    # 2. Bind alert service to existing security events list and lock
    def _save_events():
        try:
            import json
            base_dir = os.path.dirname(os.path.abspath(__file__))
            srv_dir = os.path.abspath(os.path.join(base_dir, "..", "..", "server"))
            ev_file = os.path.join(srv_dir, "security_events.json")
            with open(ev_file, "w") as f:
                json.dump(security_events[-300:], f)
        except Exception:
            pass

    alert_service.bind_existing_alert_system(security_events, security_lock, _save_events)

    # 3. Mount API Router on FastAPI app
    app.include_router(router)

    # 4. Wrap detector.detect_frame to attach real face recognition without modifying detector.py
    original_detect_frame = detector.detect_frame

    def detect_frame_with_face_recognition(frame):
        # Run original YOLO detection first (preserving all original logic)
        res = original_detect_frame(frame)

        try:
            # Run deep face recognition on frame
            face_res = face_service.analyze_frame_faces(frame)
            res["face_recognition"] = {
                "count": face_res["count"],
                "faces": [
                    {
                        "box": f["box"],
                        "face_status": f["face_status"],
                        "confidence": f["confidence"],
                        "person": f["person"]
                    } for f in face_res["faces"]
                ]
            }

            if time.time() >= _simulation_override_until:
                if face_res["faces"]:
                    _latest_live_faces.clear()
                    for f in face_res["faces"]:
                        _latest_live_faces.append({
                            "face_status": f["face_status"],
                            "confidence": f["confidence"],
                            "person": f["person"],
                            "crop_b64": f["crop_b64"],
                            "crop_bytes": f["crop_bytes"],
                            "floor": res.get("floor", 0),
                            "box": f["box"]
                        })

                    # Cache top face for UI unknown flagging and RFID correlation
                    top_face = face_res["faces"][0]
                    _latest_live_face["detected"] = True
                    _latest_live_face["face_status"] = top_face["face_status"]
                    _latest_live_face["confidence"] = top_face["confidence"]
                    _latest_live_face["person"] = top_face["person"]
                    _latest_live_face["crop_b64"] = top_face["crop_b64"]
                    _latest_live_face["crop_bytes"] = top_face["crop_bytes"]
                    _latest_live_face["at"] = time.time()
                    _latest_live_face["floor"] = res.get("floor", 0)
                    alert_service.set_latest_face_detection(top_face)

                    # Attach face recognition attributes directly to YOLO person tracks
                    person_tracks = [t for t in res.get("tracks", []) if t.get("label") == "person"]
                    for idx, t in enumerate(person_tracks):
                        f = face_res["faces"][idx] if idx < len(face_res["faces"]) else top_face
                        t["face_status"] = f["face_status"]
                        t["face_person"] = f["person"]
                        t["face_confidence"] = f["confidence"]
                        t["face_crop_b64"] = f["crop_b64"]

                    # TRIGGER FACE SECURITY ALERT IF ANY INVALID FACE IS MATCHED (even without RFID)
                    for f in face_res["faces"]:
                        if f["face_status"] == "MATCH_INVALID" and f["person"]:
                            jpeg_bytes = latest_frame.get("jpeg")
                            alert_service.handle_invalid_face_detected(
                                person=f["person"],
                                confidence=f["confidence"],
                                full_frame_bytes=jpeg_bytes,
                                crop_bytes=f["crop_bytes"],
                                floor=res.get("floor", 0)
                            )
                else:
                    # No face detected in current camera frame
                    if time.time() - _latest_live_face["at"] > 2.0:
                        _latest_live_faces.clear()
                        _latest_live_face["detected"] = False
                        _latest_live_face["face_status"] = "NONE"
                        _latest_live_face["person"] = None
                        _latest_live_face["crop_b64"] = None
        except Exception as e:
            # Face recognition exception never disrupts YOLO detection
            res["face_recognition_error"] = str(e)

        return res

    detector.detect_frame = detect_frame_with_face_recognition

    # 5. Wrap esp32_bridge._handle_rfid_scan for multi-factor security correlation
    if hasattr(esp32_bridge, "_handle_rfid_scan"):
        original_handle_rfid_scan = esp32_bridge._handle_rfid_scan

        def handle_rfid_with_face_correlation(uid: str):
            clean_uid = (uid or "").upper().strip()

            try:
                now_t = time.time()
                is_sim = _simulation_override_until > now_t
                is_cam_fresh = ((now_t - latest_frame.get("at", 0.0)) < 3.0) or is_sim
                frame_bytes = latest_frame.get("jpeg") if is_cam_fresh else None
                recent_face = _latest_live_face if ((is_cam_fresh or is_sim) and (now_t - _latest_live_face["at"] < 3.0 or is_sim) and _latest_live_face.get("detected")) else None
                face_person = recent_face.get("person") if recent_face else None
                face_status = recent_face.get("face_status") if recent_face else "NONE"
                face_conf = recent_face.get("confidence", 0.0) if recent_face else 0.0
                crop_bytes = recent_face.get("crop_bytes") if recent_face else None
                curr_floor = getattr(esp32_bridge, "current_floor", 0)

                # ==============================================================
                # AUTO-ENROLL INVALID SCANNED RFIDS DIRECTLY INTO INVALID DATABASE
                # (WITH OR WITHOUT FACE) - CONSULT DATABASE AS GROUND TRUTH
                # ==============================================================
                p_rec = db.get_person_by_uid(clean_uid) if clean_uid else None
                is_auth = False
                if p_rec:
                    is_auth = (p_rec.get("classification") == "VALID")
                else:
                    try:
                        from server.main import rfid_config
                        if rfid_config.get(clean_uid, {}).get("authorized", False):
                            is_auth = True
                    except Exception:
                        pass

                if clean_uid and not is_auth:
                    # Scanned RFID is invalid / unauthorized!
                    if not p_rec:
                        inv_name = f"Unauthorized Tag ({clean_uid})"
                        enrolled = False
                        # If no crop_bytes but live frame_bytes available, attempt to detect and crop face
                        if not crop_bytes and frame_bytes:
                            try:
                                arr = np.frombuffer(frame_bytes, dtype=np.uint8)
                                f_img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                                if f_img is not None and f_img.size > 0:
                                    faces = face_service.detect_faces(f_img)
                                    if faces:
                                        faces.sort(key=lambda f: (f[2] - f[0]) * (f[3] - f[1]), reverse=True)
                                        fx1, fy1, fx2, fy2 = faces[0][:4]
                                        f_crop = f_img[fy1:fy2, fx1:fx2]
                                        if f_crop.size > 0:
                                            _, buf = cv2.imencode(".jpg", f_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                                            crop_bytes = buf.tobytes()
                            except Exception:
                                pass

                        if crop_bytes:
                            try:
                                person_manager.enroll_unknown_face(
                                    name=inv_name,
                                    classification="INVALID",
                                    crop_bytes=crop_bytes,
                                    rfid_uid=clean_uid
                                )
                                enrolled = True
                            except Exception:
                                pass

                        if not enrolled:
                            db.create_person(
                                name=inv_name,
                                classification="INVALID",
                                rfid_uid=clean_uid,
                                image_filename=None
                            )
                            face_service.refresh_enrolled_cache()
                    elif p_rec.get("classification") == "INVALID" and not p_rec.get("image_filename") and crop_bytes:
                        try:
                            person_manager.upload_face_image(p_rec["id"], crop_bytes)
                        except Exception:
                            pass

                # ==============================================================
                # 1. MULTI-FACTOR BIOMETRIC CORRELATION
                # Card UIDs requiring facial verification:
                # - 69BDF306: Abhishek Sri Saai -> Floor 2
                # - 3EAF1AAA: Jianna Maria Joseph -> Floor 2
                # - 6E9818AA: Sreelakshmi Sajith -> Floor 1
                # - 12D56B06: Pournami M / Staff -> Floor 3
                # ==============================================================
                AUTH_CARDS_MAP = {
                    "69BDF306": {
                        "name": "Abhishek Sri Saai",
                        "floor": 2,
                        "keywords": ["abhishek"]
                    },
                    "3EAF1AAA": {
                        "name": "Jianna Maria Joseph",
                        "floor": 2,
                        "keywords": ["jianna"]
                    },
                    "6E9818AA": {
                        "name": "Sreelakshmi Sajith",
                        "floor": 1,
                        "keywords": ["sreelakshmi"]
                    },
                    "12D56B06": {
                        "name": "Pournami M",
                        "floor": 3,
                        "keywords": ["pournami", "sreelakshmi"]
                    }
                }

                def is_card_face_match(card_uid, person_rec, face_p):
                    if not face_p:
                        return False
                    f_name = (face_p.get("name") or "").lower().strip()
                    f_uid = (face_p.get("rfid_uid") or "").upper().strip()

                    # 1. Direct RFID UID match on face profile
                    if f_uid and f_uid == card_uid:
                        return True

                    # 2. Database person ID match
                    if person_rec and person_rec.get("id") and person_rec.get("id") == face_p.get("id"):
                        return True

                    # 3. Keyword matching for known card owners
                    cfg = AUTH_CARDS_MAP.get(card_uid)
                    if cfg:
                        for kw in cfg.get("keywords", []):
                            if kw in f_name:
                                return True

                    # 4. Exact/substring person name match
                    if person_rec and person_rec.get("name"):
                        rec_name = person_rec["name"].lower().strip()
                        if rec_name in f_name or f_name in rec_name:
                            return True

                    return False

                if clean_uid in AUTH_CARDS_MAP or p_rec is not None:
                    card_owner_name = p_rec.get("name") if (p_rec and p_rec.get("name")) else AUTH_CARDS_MAP.get(clean_uid, {}).get("name", f"Card {clean_uid}")

                    # If this card was explicitly changed to INVALID in the database, deny access immediately
                    if p_rec and p_rec.get("classification") == "INVALID":
                        alert_ev = alert_service.handle_dual_threat(
                            person=p_rec,
                            scanned_uid=clean_uid,
                            confidence=face_conf,
                            full_frame_bytes=frame_bytes,
                            crop_bytes=crop_bytes,
                            floor=curr_floor,
                            ignore_cooldown=True
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

                    # Case 1A: Person in camera is an INVALID person (e.g. Sreelakshmi Sajith, Jianna, etc.)
                    if recent_face and face_status == "MATCH_INVALID" and face_person:
                        alert_ev = alert_service.handle_identity_mismatch(
                            face_person=face_person,
                            scanned_uid=clean_uid,
                            rfid_card_name=card_owner_name,
                            confidence=face_conf,
                            full_frame_bytes=frame_bytes,
                            crop_bytes=crop_bytes,
                            floor=curr_floor,
                            ignore_cooldown=True
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

                    # Case 1B: Person in camera is UNREGISTERED (Unknown face)
                    elif recent_face and face_status == "UNKNOWN":
                        alert_ev = alert_service.handle_unregistered_with_auth_card(
                            scanned_uid=clean_uid,
                            card_owner_name=card_owner_name,
                            full_frame_bytes=frame_bytes,
                            crop_bytes=crop_bytes,
                            floor=curr_floor
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

                    # Case 1C: No face detected in front of camera
                    elif not recent_face or face_status in ("NONE", None):
                        alert_ev = alert_service.handle_missing_face_with_auth_card(
                            scanned_uid=clean_uid,
                            card_owner_name=card_owner_name,
                            floor=curr_floor
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

                    # Case 1D: Face IS verified and MATCHES this card
                    elif recent_face and face_status == "MATCH_VALID" and face_person and is_card_face_match(clean_uid, p_rec, face_person):
                        # Biometrics verified! Proceed with original handler which moves lift to target floor
                        original_handle_rfid_scan(clean_uid)
                        return

                    # Case 1E: Face is another valid person trying to use someone else's card
                    elif recent_face and face_status == "MATCH_VALID" and face_person:
                        alert_ev = alert_service.handle_identity_mismatch(
                            face_person=face_person,
                            scanned_uid=clean_uid,
                            rfid_card_name=card_owner_name,
                            confidence=face_conf,
                            full_frame_bytes=frame_bytes,
                            crop_bytes=crop_bytes,
                            floor=curr_floor,
                            ignore_cooldown=True
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

                # ==============================================================
                # 2. GENERAL INVALID PERSON ENFORCEMENT:
                # If an invalid person is in front of camera, ANY RFID attempt is DENIED!
                # ==============================================================
                if recent_face and face_status == "MATCH_INVALID" and face_person:
                    alert_ev = alert_service.handle_dual_threat(
                        person=face_person,
                        scanned_uid=clean_uid,
                        confidence=face_conf,
                        full_frame_bytes=frame_bytes,
                        crop_bytes=crop_bytes,
                        floor=curr_floor,
                        ignore_cooldown=True
                    )
                    if alert_ev:
                        esp32_bridge.last_rfid_event = alert_ev
                    return  # NEVER DISPATCH LIFT!

                # ==============================================================
                # 3. GENERAL VALID PERSON CROSS-CHECK:
                # If a valid person scans a card, verify it matches their assigned RFID
                # ==============================================================
                if recent_face and face_status == "MATCH_VALID" and face_person:
                    reg_uid = (face_person.get("rfid_uid") or "").upper().strip()
                    if reg_uid and reg_uid != clean_uid:
                        alert_ev = alert_service.handle_identity_mismatch(
                            face_person=face_person,
                            scanned_uid=clean_uid,
                            rfid_card_name=f"Card {clean_uid}",
                            confidence=face_conf,
                            full_frame_bytes=frame_bytes,
                            crop_bytes=crop_bytes,
                            floor=curr_floor,
                            ignore_cooldown=True
                        )
                        if alert_ev:
                            esp32_bridge.last_rfid_event = alert_ev
                        return  # NEVER DISPATCH LIFT!

            except Exception:
                pass

            # In all other cases (e.g. valid person with own card or unknown card scans), run standard handler
            original_handle_rfid_scan(clean_uid)

        esp32_bridge._handle_rfid_scan = handle_rfid_with_face_correlation
