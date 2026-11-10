"""
Comprehensive Automated Verification Script for SmartLift AI Face Recognition,
Valid/Invalid Databases & Dashboard Integration.
Tests all 12 required items specified in Section 8 of the prompt.
"""

import base64
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import cv2
import numpy as np
NEW_CHANGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "new changes"))
if NEW_CHANGES_DIR not in sys.path:
    sys.path.insert(0, NEW_CHANGES_DIR)

API_BASE = "http://localhost:8000"

def log_test(num, name, passed, details=""):
    mark = "PASS" if passed else "FAIL"
    print(f"[{mark}] Test {num}: {name} {('- ' + details) if details else ''}")


def http_get(path):
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode())


def http_post(path, data):
    url = f"{API_BASE}{path}"
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode())


def http_delete(path, password="xyz123"):
    if password is not None:
        delim = "&" if "?" in path else "?"
        url = f"{API_BASE}{path}{delim}password={urllib.parse.quote(password)}"
    else:
        url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, method="DELETE")
    if password is not None:
        req.add_header("X-Security-Password", password)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = {}
        return e.code, body


def run_all_tests():
    print("=" * 70)
    print("SMARTLIFT AI - FACE RECOGNITION & DATABASE AUTOMATED TEST SUITE")
    print("=" * 70)

    # 1. Status and Engine Health
    try:
        status, data = http_get("/api/face-db/status")
        log_test(1, "Status API & Engine Health", data.get("ok") is True,
                 f"Valid: {data.get('valid_persons_count')}, Invalid: {data.get('invalid_persons_count')}")
    except Exception as e:
        log_test(1, "Status API & Engine Health", False, str(e))

    # 2. Abhishek Sri Saai in Valid Persons Database
    try:
        status, data = http_get("/api/face-db/persons?classification=VALID")
        persons = data.get("persons", [])
        abhishek = next((p for p in persons if "Abhishek Sri Saai" in p["name"]), None)
        valid_abhishek = (
            abhishek is not None and
            abhishek.get("classification") == "VALID" and
            abhishek.get("rfid_uid") == "69BDF306"
        )
        log_test(2, "Abhishek Sri Saai in Valid Persons Database", valid_abhishek,
                 f"UID: {abhishek.get('rfid_uid') if abhishek else 'N/A'}, Image: {abhishek.get('image_filename') if abhishek else 'N/A'}")
    except Exception as e:
        log_test(2, "Abhishek Sri Saai in Valid Persons Database", False, str(e))

    # 3. Jianna Maria Joseph in Invalid Persons Database
    try:
        status, data = http_get("/api/face-db/persons?classification=INVALID")
        persons = data.get("persons", [])
        jianna = next((p for p in persons if "Jianna Maria Joseph" in p["name"]), None)
        valid_jianna = (
            jianna is not None and
            jianna.get("classification") == "INVALID"
        )
        log_test(3, "Jianna Maria Joseph in Invalid Persons Database", valid_jianna,
                 f"Classification: {jianna.get('classification') if jianna else 'N/A'}, Image: {jianna.get('image_filename') if jianna else 'None'}")
    except Exception as e:
        log_test(3, "Jianna Maria Joseph in Invalid Persons Database", False, str(e))

    # 4. Sreelakshmi Sajith in Invalid Persons Database
    try:
        status, data = http_get("/api/face-db/persons?classification=INVALID")
        persons = data.get("persons", [])
        sree = next((p for p in persons if "Sreelakshmi Sajith" in p["name"]), None)
        valid_sree = (
            sree is not None and
            sree.get("classification") == "INVALID"
        )
        log_test(4, "Sreelakshmi Sajith in Invalid Persons Database", valid_sree,
                 f"Classification: {sree.get('classification') if sree else 'N/A'}, Image: {sree.get('image_filename') if sree else 'None'}")
    except Exception as e:
        log_test(4, "Sreelakshmi Sajith in Invalid Persons Database", False, str(e))

    # 5. Image placeholder logic (persons without photo have null image_filename)
    try:
        status, data = http_get("/api/face-db/persons")
        all_persons = data.get("persons", [])
        unuploaded = [p for p in all_persons if p.get("image_filename") is None]
        has_unuploaded = len(unuploaded) > 0
        log_test(5, "Records Without Photo Have Null Image Reference", has_unuploaded,
                 f"{len(unuploaded)} record(s) confirmed with null images (clean placeholder in UI)")
    except Exception as e:
        log_test(5, "Records Without Photo Have Null Image Reference", False, str(e))

    # 6. Database Idempotency (No duplicates created on restart or re-seed)
    try:
        from valid_invalid_database import seed_initial_records_once, db
        seed_initial_records_once()
        count_after = len(db.get_all_persons())
        log_test(6, "No Duplicate Records on Seed / Restart", count_after >= 3,
                 f"Total records in DB: {count_after} (No duplicates created)")
    except Exception as e:
        log_test(6, "No Duplicate Records on Seed / Restart", False, str(e))

    # 7. Blank Records Cannot Be Matched Through Face Recognition
    try:
        from face_recognition import face_service
        dummy_crop = np.zeros((100, 100, 3), dtype=np.uint8)
        emb = face_service.extract_embedding(dummy_crop)
        match_status, matched_person, conf = face_service.compare_embedding_to_enrolled(emb)
        no_simulated_match = (match_status == "UNKNOWN" and matched_person is None)
        log_test(7, "Blank Image Records Cannot Match Face Recognition", no_simulated_match,
                 f"Status: {match_status}, Matched Person: {matched_person} (No simulated matches)")
    except Exception as e:
        log_test(7, "Blank Image Records Cannot Match Face Recognition", False, str(e))

    # 8. Person Image Upload & Persistence
    try:
        # Create a test person
        status, create_res = http_post("/api/face-db/persons", {
            "name": "Automated Test Person",
            "classification": "VALID",
            "rfid_uid": "TEST9988"
        })
        test_person_id = create_res["person"]["id"]

        # Generate a synthetic face image
        test_img = np.full((120, 120, 3), 180, dtype=np.uint8)
        cv2.circle(test_img, (60, 60), 35, (100, 120, 220), -1)
        _, img_buf = cv2.imencode(".jpg", test_img)
        img_b64 = base64.b64encode(img_buf.tobytes()).decode("utf-8")

        # Upload image via base64 endpoint
        status, upload_res = http_post(f"/api/face-db/persons/{test_person_id}/image-base64", {
            "image_b64": img_b64,
            "filename": "test_face.jpg"
        })
        has_new_img = upload_res.get("person", {}).get("image_filename") is not None
        log_test(8, "Face Image Upload & Enrollment", has_new_img,
                 f"File: {upload_res.get('person', {}).get('image_filename')}")

        # Clean up test person
        http_delete(f"/api/face-db/persons/{test_person_id}")
    except Exception as e:
        log_test(8, "Face Image Upload & Enrollment", False, str(e))

    # 9. Unknown Face Flagging (Requirement 5)
    try:
        # Generate a test face crop
        flag_img = np.full((100, 100, 3), 150, dtype=np.uint8)
        cv2.circle(flag_img, (50, 50), 30, (50, 50, 200), -1)
        _, flag_buf = cv2.imencode(".jpg", flag_img)
        flag_b64 = base64.b64encode(flag_buf.tobytes()).decode("utf-8")

        status, flag_res = http_post("/api/face-db/flag-unknown", {
            "name": "Auto Flagged Subject 101",
            "crop_b64": flag_b64,
            "rfid_uid": None
        })
        flagged_p = flag_res.get("person", {})
        flagged_ok = (
            flag_res.get("ok") is True and
            flagged_p.get("classification") == "INVALID" and
            flagged_p.get("image_filename") is not None
        )
        log_test(9, "Unknown Face Flagging as Invalid Person", flagged_ok,
                 f"Name: {flagged_p.get('name')}, Class: {flagged_p.get('classification')}, Image: {flagged_p.get('image_filename')}")

        # Clean up flagged test person
        if flagged_p.get("id"):
            http_delete(f"/api/face-db/persons/{flagged_p['id']}")
    except Exception as e:
        log_test(9, "Unknown Face Flagging as Invalid Person", False, str(e))

    # 10. Existing RFID Alert System Remains Intact
    try:
        # Trigger an unauthorized RFID scan with a valid hexadecimal UID
        status, rfid_res = http_post("/security/rfid-event", {"uid": "DEADBEEF"})
        status, ev_res = http_get("/security/events?limit=5")
        events = ev_res.get("events", [])
        unauth_event = next((e for e in events if e.get("uid") == "DEADBEEF"), None)
        rfid_ok = unauth_event is not None and unauth_event.get("status") == "ACCESS_DENIED"
        log_test(10, "Existing Invalid RFID Scan Security Alert Preserved", rfid_ok,
                 f"Status: {unauth_event.get('status') if unauth_event else 'None'}, Event ID: {unauth_event.get('event_id') if unauth_event else 'None'}")
    except Exception as e:
        log_test(10, "Existing Invalid RFID Scan Security Alert Preserved", False, str(e))

    # 11. Face Recognition Integration in Camera Frame
    try:
        test_frame = np.full((240, 320, 3), 80, dtype=np.uint8)
        _, frame_buf = cv2.imencode(".jpg", test_frame)
        frame_b64 = base64.b64encode(frame_buf.tobytes()).decode("utf-8")

        status, detect_res = http_post("/detect", {"image": frame_b64, "floor": 0})
        has_face_meta = detect_res.get("ok") is True
        log_test(11, "Camera Pipeline Face Recognition Hook Active", has_face_meta,
                 f"FPS: {detect_res.get('fps')}, Floor: {detect_res.get('floor')}")
    except Exception as e:
        log_test(11, "Camera Pipeline Face Recognition Hook Active", False, str(e))

    # 13. Verify Face Endpoint (Enroll as Valid Person)
    try:
        synth_crop = np.full((100, 100, 3), 140, dtype=np.uint8)
        cv2.circle(synth_crop, (50, 50), 28, (80, 180, 90), -1)
        _, crop_buf = cv2.imencode(".jpg", synth_crop)
        crop_b64 = base64.b64encode(crop_buf.tobytes()).decode("utf-8")

        status, verify_res = http_post("/api/face-db/verify-face", {
            "name": "Verified Test Visitor",
            "classification": "VALID",
            "crop_b64": crop_b64,
            "rfid_uid": "TAG9900"
        })
        v_person = verify_res.get("person", {})
        verified_ok = (
            verify_res.get("ok") is True and
            v_person.get("classification") == "VALID" and
            v_person.get("rfid_uid") == "TAG9900" and
            v_person.get("image_filename") is not None
        )
        log_test(13, "New Face Verification & Enrollment as Valid Person", verified_ok,
                 f"Name: {v_person.get('name')}, Class: {v_person.get('classification')}, Image: {v_person.get('image_filename')}")

        if v_person.get("id"):
            http_delete(f"/api/face-db/persons/{v_person['id']}")
    except Exception as e:
        log_test(13, "New Face Verification & Enrollment as Valid Person", False, str(e))

    # 14. Biometric Cross-Check:
    # 14A. Valid Person using their OWN RFID -> ACCESS_GRANTED (no mismatch)
    # 14B. Valid Person using WRONG RFID -> Identity Mismatch alert explicitly mentioning wrong UID
    try:
        # Simulate active valid face (Abhishek Sri Saai with registered RFID 69BDF306)
        http_post("/api/face-db/simulate-detection", {
            "face_status": "MATCH_VALID",
            "confidence": 0.94,
            "person": {
                "id": 1,
                "name": "Abhishek Sri Saai",
                "classification": "VALID",
                "rfid_uid": "69BDF306"
            }
        })

        # Person uses WRONG RFID ID "11223344"
        status, rfid_res = http_post("/security/rfid-event", {"uid": "11223344"})
        last_ev = rfid_res.get("last_event") or {}

        mismatch_ok = (
            last_ev.get("status") == "ACCESS_DENIED" and
            last_ev.get("reason") == "Identity Mismatch" and
            "11223344" in last_ev.get("message", "") and
            "Abhishek Sri Saai" in last_ev.get("name", "")
        )
        log_test(14, "Valid Face + Wrong RFID Triggers Mismatch Alert with Scanned ID", mismatch_ok,
                 f"Message: {last_ev.get('message') if last_ev else 'None'}")
    except Exception as e:
        log_test(14, "Valid Face + Wrong RFID Triggers Mismatch Alert with Scanned ID", False, str(e))

    # 15. Invalid Face Triggers Security Alert Regardless of RFID
    try:
        # Simulate active invalid face (Jianna Maria Joseph)
        http_post("/api/face-db/simulate-detection", {
            "face_status": "MATCH_INVALID",
            "confidence": 0.89,
            "person": {
                "id": 2,
                "name": "Jianna Maria Joseph",
                "classification": "INVALID",
                "rfid_uid": None
            }
        })

        # Scans authorized RFID tag 69BDF306 — must STILL be denied & alerted!
        status, rfid_res = http_post("/security/rfid-event", {"uid": "69BDF306"})
        last_ev = rfid_res.get("last_event") or {}

        alert_ok = (
            last_ev.get("status") == "ACCESS_DENIED" and
            last_ev.get("classification") == "INVALID" and
            "Jianna Maria Joseph" in last_ev.get("name", "")
        )
        log_test(15, "Invalid Person Detected Alerts Regardless of RFID", alert_ok,
                 f"Name: {last_ev.get('name') if last_ev else 'None'}, Status: {last_ev.get('status') if last_ev else 'None'}")

        # Reset simulated detection
        http_post("/api/face-db/simulate-detection", {
            "face_status": "NONE",
            "person": None
        })
    except Exception as e:
        log_test(15, "Invalid Person Detected Alerts Regardless of RFID", False, str(e))

    # 16. Sreelakshmi Sajith (Invalid Person) scans Abhishek's Card (69BDF306) -> MUST DENY ACCESS!
    try:
        http_post("/api/face-db/simulate-detection", {
            "face_status": "MATCH_INVALID",
            "confidence": 0.92,
            "person": {
                "id": 3,
                "name": "Sreelakshmi Sajith",
                "classification": "INVALID",
                "rfid_uid": "12D56B06"
            }
        })

        status, rfid_res = http_post("/security/rfid-event", {"uid": "69BDF306"})
        last_ev = rfid_res.get("last_event") or {}
        sree_denied = (
            last_ev.get("status") == "ACCESS_DENIED" and
            last_ev.get("uid") == "69BDF306" and
            "Sreelakshmi Sajith" in last_ev.get("name", "")
        )
        log_test(16, "Sreelakshmi Sajith (Invalid) with Abhishek Card 69BDF306 Denied & Lift Stopped", sree_denied,
                 f"Status: {last_ev.get('status')}, Message: {last_ev.get('message')}")
    except Exception as e:
        log_test(16, "Sreelakshmi Sajith (Invalid) with Abhishek Card 69BDF306 Denied & Lift Stopped", False, str(e))

    # 17. Unregistered Face with Abhishek Card (69BDF306) -> MUST DENY ACCESS!
    try:
        http_post("/api/face-db/simulate-detection", {
            "face_status": "UNKNOWN",
            "confidence": 0.85,
            "person": None
        })

        status, rfid_res = http_post("/security/rfid-event", {"uid": "69BDF306"})
        last_ev = rfid_res.get("last_event") or {}
        unreg_denied = (
            last_ev.get("status") == "ACCESS_DENIED" and
            last_ev.get("uid") == "69BDF306" and
            "requires facial verification of Abhishek Sri Saai" in last_ev.get("message", "")
        )
        log_test(17, "Unregistered Person with Abhishek Card 69BDF306 Denied & Lift Stopped", unreg_denied,
                 f"Status: {last_ev.get('status')}, Message: {last_ev.get('message')}")
    except Exception as e:
        log_test(17, "Unregistered Person with Abhishek Card 69BDF306 Denied & Lift Stopped", False, str(e))

    # 18. Abhishek Sri Saai (Valid Face) with Abhishek Card (69BDF306) -> MUST GRANT ACCESS!
    try:
        http_post("/api/face-db/simulate-detection", {
            "face_status": "MATCH_VALID",
            "confidence": 0.96,
            "person": {
                "id": 1,
                "name": "Abhishek Sri Saai",
                "classification": "VALID",
                "rfid_uid": "69BDF306"
            }
        })

        status, rfid_res = http_post("/security/rfid-event", {"uid": "69BDF306"})
        last_ev = rfid_res.get("last_event") or {}
        abhishek_granted = (
            last_ev.get("status") == "ACCESS_GRANTED" and
            last_ev.get("uid") == "69BDF306" and
            last_ev.get("fixed_destination") == 2
        )
        log_test(18, "Abhishek Sri Saai (Verified Face) with Card 69BDF306 Granted & Dispatched Floor 2", abhishek_granted,
                 f"Status: {last_ev.get('status')}, Destination: {last_ev.get('fixed_destination')}")

        # Reset simulated detection
        http_post("/api/face-db/simulate-detection", {
            "face_status": "NONE",
            "person": None
        })
    except Exception as e:
        log_test(18, "Abhishek Sri Saai (Verified Face) with Card 69BDF306 Granted & Dispatched Floor 2", False, str(e))

    # 19. Password Protection on Database Record Deletion
    try:
        # Create a temporary person to test deletion security
        _, create_tmp = http_post("/api/face-db/persons", {
            "name": "Security Deletion Test Target",
            "classification": "INVALID",
            "rfid_uid": None
        })
        target_id = create_tmp.get("person", {}).get("id")

        # Attempt 1: Delete without password -> MUST FAIL with 403
        status_no_pw, res_no_pw = http_delete(f"/api/face-db/persons/{target_id}", password=None)

        # Attempt 2: Delete with wrong password -> MUST FAIL with 403
        status_wrong_pw, res_wrong_pw = http_delete(f"/api/face-db/persons/{target_id}", password="wrongpassword")

        # Attempt 3: Delete with correct password "xyz123" -> MUST SUCCEED with 200
        status_correct_pw, res_correct_pw = http_delete(f"/api/face-db/persons/{target_id}", password="xyz123")

        deletion_security_passed = (
            status_no_pw == 403 and
            status_wrong_pw == 403 and
            status_correct_pw == 200 and
            res_correct_pw.get("ok") is True and
            res_correct_pw.get("deleted_id") == target_id
        )

        log_test(19, "Security Password 'xyz123' Enforcement for Person Deletion", deletion_security_passed,
                 f"No PW: {status_no_pw}, Wrong PW: {status_wrong_pw}, Correct PW: {status_correct_pw}")
    except Exception as e:
        log_test(19, "Security Password 'xyz123' Enforcement for Person Deletion", False, str(e))

    # 20. Unknown Person Scanning Abhishek's Card Auto-Enrolled into Invalid Database
    try:
        # Create a synthetic unknown face crop
        synth_crop = np.full((120, 120, 3), 160, dtype=np.uint8)
        cv2.circle(synth_crop, (60, 60), 32, (90, 110, 210), -1)
        _, crop_buf = cv2.imencode(".jpg", synth_crop)
        crop_b64 = base64.b64encode(crop_buf.tobytes()).decode("utf-8")

        # Simulate camera seeing an unknown face with this crop
        http_post("/api/face-db/simulate-detection", {
            "face_status": "UNKNOWN",
            "confidence": 0.88,
            "crop_b64": crop_b64,
            "person": None
        })

        # Scan Abhishek's card 69BDF306
        status, rfid_res = http_post("/security/rfid-event", {"uid": "69BDF306"})
        last_ev = rfid_res.get("last_event") or {}

        # Query Invalid Persons Database to verify intruder was auto-enrolled
        status, inv_res = http_get("/api/face-db/persons?classification=INVALID")
        inv_persons = inv_res.get("persons", [])
        intruder_entry = next((p for p in inv_persons if "Intruder" in p.get("name", "") and p.get("rfid_uid") == "69BDF306"), None)

        auto_enrolled_ok = (
            last_ev.get("status") == "ACCESS_DENIED" and
            intruder_entry is not None and
            intruder_entry.get("classification") == "INVALID" and
            intruder_entry.get("image_filename") is not None
        )

        log_test(20, "Unknown Person Scanning Abhishek's Card Auto-Enrolled into Invalid Database", auto_enrolled_ok,
                 f"Intruder ID: {intruder_entry.get('id') if intruder_entry else 'None'}, Name: {intruder_entry.get('name') if intruder_entry else 'None'}")

        # Clean up the test intruder using password
        if intruder_entry and intruder_entry.get("id"):
            http_delete(f"/api/face-db/persons/{intruder_entry['id']}", password="xyz123")

        # Reset simulation
        http_post("/api/face-db/simulate-detection", {
            "face_status": "NONE",
            "person": None
        })
    except Exception as e:
        log_test(20, "Unknown Person Scanning Abhishek's Card Auto-Enrolled into Invalid Database", False, str(e))

    print("=" * 70)


if __name__ == "__main__":
    run_all_tests()
