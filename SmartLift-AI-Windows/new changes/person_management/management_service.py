"""
Person Management Service for SmartLift AI.
Handles CRUD operations, face image uploads, replacements, deletions, and unknown-face flagging.
"""

import os
import time
from typing import Optional, Dict, Any

import cv2
import numpy as np

from valid_invalid_database import db
from face_recognition import face_service

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_CHANGES_DIR = os.path.abspath(os.path.join(MODULE_DIR, ".."))
DATA_DIR = os.path.join(NEW_CHANGES_DIR, "data")
IMAGES_DIR = os.path.join(DATA_DIR, "face_images")

os.makedirs(IMAGES_DIR, exist_ok=True)

MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class PersonManagementService:
    def upload_face_image(self, person_id: int, image_bytes: bytes, original_filename: str = "upload.jpg") -> Dict[str, Any]:
        """
        Validates, saves, extracts facial embedding, and associates an image with a person.
        Replaces any existing image file.
        """
        if not image_bytes:
            raise ValueError("Empty image data provided.")

        if len(image_bytes) > MAX_IMAGE_SIZE_BYTES:
            raise ValueError(f"Image file exceeds maximum allowed size of 5 MB ({len(image_bytes)} bytes).")

        # Decode image using OpenCV
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None or img.size == 0:
            raise ValueError("Invalid image format or corrupt image file.")

        person = db.get_person_by_id(person_id)
        if not person:
            raise ValueError(f"Person with ID {person_id} does not exist.")

        # Delete old image if one was already attached
        old_file = person.get("image_filename")
        if old_file:
            old_path = os.path.join(IMAGES_DIR, old_file)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        # Detect face and extract embedding for enrollment
        faces = face_service.detect_faces(img)
        if faces:
            # Use largest detected face in reference photo
            faces.sort(key=lambda f: (f[2] - f[0]) * (f[3] - f[1]), reverse=True)
            fx1, fy1, fx2, fy2 = faces[0][:4]
            raw_det = faces[0][5] if len(faces[0]) > 5 else None
            embedding = None
            if raw_det is not None and getattr(face_service, "sface_recognizer", None) is not None:
                embedding = face_service.extract_embedding(img, raw_det=raw_det)
            if embedding is None:
                face_crop = img[fy1:fy2, fx1:fx2]
                embedding = face_service.extract_embedding(face_crop)
        else:
            # If no localized face detected, extract embedding from centered image
            embedding = face_service.extract_embedding(img)

        # Save new image file
        timestamp = int(time.time() * 1000)
        safe_filename = f"person_{person_id}_{timestamp}.jpg"
        target_path = os.path.join(IMAGES_DIR, safe_filename)

        # Re-encode as clean JPEG
        cv2.imwrite(target_path, img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])

        # Store encoding in database
        if embedding is not None:
            db.save_encoding(person_id, embedding.tobytes(), len(embedding))

        # Update person record
        updated = db.update_person(person_id, image_filename=safe_filename)

        # Refresh recognition cache so the newly uploaded face is immediately recognized
        face_service.refresh_enrolled_cache()

        return updated

    def remove_face_image(self, person_id: int) -> Dict[str, Any]:
        """Removes the face image and face encoding for a person."""
        person = db.get_person_by_id(person_id)
        if not person:
            raise ValueError(f"Person with ID {person_id} does not exist.")

        old_file = person.get("image_filename")
        if old_file:
            old_path = os.path.join(IMAGES_DIR, old_file)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        db.delete_encoding(person_id)
        updated = db.update_person(person_id, clear_image=True)
        face_service.refresh_enrolled_cache()
        return updated

    def delete_person(self, person_id: int) -> bool:
        """Deletes a person, their face image, and their face encodings."""
        person = db.get_person_by_id(person_id)
        if not person:
            return False

        old_file = person.get("image_filename")
        if old_file:
            old_path = os.path.join(IMAGES_DIR, old_file)
            if os.path.isfile(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        success = db.delete_person(person_id)
        face_service.refresh_enrolled_cache()
        return success

    def flag_unknown_face(self, name: str, crop_bytes: bytes, rfid_uid: Optional[str] = None) -> Dict[str, Any]:
        """
        Administrator workflow to flag a detected unknown face as an Invalid Person.
        Maintains backward compatibility by delegating to enroll_unknown_face.
        """
        return self.enroll_unknown_face(name=name, classification="INVALID", crop_bytes=crop_bytes, rfid_uid=rfid_uid)

    def enroll_unknown_face(self, name: str, classification: str, crop_bytes: bytes, rfid_uid: Optional[str] = None) -> Dict[str, Any]:
        """
        Administrator workflow to verify and enroll a detected unknown face as either
        a VALID (authorized) or INVALID (restricted) person.
        Saves the face crop, registers in the corresponding database, extracts and enrolls embedding.
        """
        name = (name or "").strip()
        classification = (classification or "VALID").upper()
        if classification not in ("VALID", "INVALID"):
            classification = "VALID"

        if not name:
            default_tag = "Verified Person" if classification == "VALID" else "Restricted Subject"
            name = f"{default_tag} {time.strftime('%Y-%m-%d %H:%M')}"

        if not crop_bytes:
            raise ValueError("No face crop image data provided for enrollment.")

        # Decode face crop
        arr = np.frombuffer(crop_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None or img.size == 0:
            raise ValueError("Invalid face crop image data.")

        # 1. Create person record in the specified Database (VALID or INVALID)
        new_person = db.create_person(
            name=name,
            classification=classification,
            rfid_uid=rfid_uid,
            image_filename=None
        )
        person_id = new_person["id"]

        # 2. Save face crop image
        timestamp = int(time.time() * 1000)
        prefix = "enrolled_valid" if classification == "VALID" else "flagged_invalid"
        image_filename = f"{prefix}_{person_id}_{timestamp}.jpg"
        target_path = os.path.join(IMAGES_DIR, image_filename)
        cv2.imwrite(target_path, img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])

        # 3. Extract and save face embedding
        embedding = face_service.extract_embedding(img)
        if embedding is not None:
            db.save_encoding(person_id, embedding.tobytes(), len(embedding))

        # 4. Update person with image filename
        updated = db.update_person(person_id, image_filename=image_filename)

        # 5. Refresh recognition cache for immediate recognition in future frames
        face_service.refresh_enrolled_cache()

        return updated


person_manager = PersonManagementService()
