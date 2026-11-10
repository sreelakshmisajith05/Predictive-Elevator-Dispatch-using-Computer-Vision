"""
Real Face Recognition Service for SmartLift AI.
Upgraded to OpenCV Zoo YuNet (5-Point Facial Landmark Alignment) + SFace (SphereFace Deep Biometric Recognizer).
Includes graceful fallbacks to ResNet-10 SSD / Haar cascade and PyTorch ResNet-18.
Performs real cosine distance verification against enrolled Valid and Invalid Persons databases.
"""

import base64
import os
import threading
import time
from typing import List, Optional, Dict, Any, Tuple

import cv2
import numpy as np

try:
    import torch
    import torchvision.models as models
    import torchvision.transforms as transforms
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

from . import config
from valid_invalid_database import db

_lock = threading.Lock()


class FaceRecognitionService:
    def __init__(self):
        self.yunet_detector = None
        self.sface_recognizer = None
        self.detector_net = None
        self.haar_cascade = None
        self.feature_extractor = None
        self.transform = None
        self.enrolled_cache: List[Dict[str, Any]] = []
        self.cache_last_updated = 0.0

        # 1. Initialize State-of-the-Art YuNet + SFace models
        self._init_yunet_and_sface()

        # 2. Initialize fallbacks (SSD ResNet-10, Haar Cascade, PyTorch ResNet-18)
        self._init_fallback_detectors()
        self._init_fallback_feature_extractor()

        # 3. Refresh enrolled embeddings cache and migrate existing DB encodings if needed
        self.refresh_enrolled_cache()
        self.migrate_enrolled_images_if_needed()

    def _init_yunet_and_sface(self):
        """Loads OpenCV Zoo YuNet 5-point landmark detector and SFace deep recognizer."""
        try:
            if os.path.exists(config.YUNET_MODEL_PATH):
                self.yunet_detector = cv2.FaceDetectorYN_create(
                    config.YUNET_MODEL_PATH,
                    "",
                    (320, 320),
                    config.FACE_DETECTION_CONFIDENCE,
                    0.3,
                    5000
                )
        except Exception:
            self.yunet_detector = None

        try:
            if os.path.exists(config.SFACE_MODEL_PATH):
                self.sface_recognizer = cv2.FaceRecognizerSF_create(
                    config.SFACE_MODEL_PATH,
                    ""
                )
        except Exception:
            self.sface_recognizer = None

    def _init_fallback_detectors(self):
        """Loads ResNet-10 SSD Face Detector with Haar cascade fallback."""
        if os.path.exists(config.FACE_PROTO_PATH) and os.path.exists(config.FACE_MODEL_PATH):
            try:
                self.detector_net = cv2.dnn.readNetFromCaffe(config.FACE_PROTO_PATH, config.FACE_MODEL_PATH)
            except Exception:
                self.detector_net = None

        try:
            haar_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
            if os.path.exists(haar_path):
                self.haar_cascade = cv2.CascadeClassifier(haar_path)
        except Exception:
            self.haar_cascade = None

    def _init_fallback_feature_extractor(self):
        """Loads offline PyTorch ResNet18 as deep feature extractor fallback."""
        if not HAS_TORCH:
            return

        try:
            resnet = models.resnet18()
            if os.path.exists(config.TORCH_CHECKPOINT_PATH):
                state_dict = torch.load(config.TORCH_CHECKPOINT_PATH, map_location="cpu")
                resnet.load_state_dict(state_dict)

            self.feature_extractor = torch.nn.Sequential(*(list(resnet.children())[:-1]))
            self.feature_extractor.eval()

            self.transform = transforms.Compose([
                transforms.ToPILImage(),
                transforms.Resize((224, 224)),
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            ])
        except Exception:
            self.feature_extractor = None

    def migrate_enrolled_images_if_needed(self):
        """
        Automatically migrates existing database person images to SFace 128-dim embeddings.
        Ensures existing users immediately benefit from landmark-aligned face recognition.
        """
        if self.sface_recognizer is None:
            return

        with _lock:
            needs_migration = any(
                item.get("embedding") is None or len(item["embedding"]) != 128
                for item in self.enrolled_cache
            )

        if not needs_migration and len(self.enrolled_cache) > 0:
            return

        base_dir = os.path.dirname(os.path.abspath(__file__))
        images_dir = os.path.abspath(os.path.join(base_dir, "..", "data", "face_images"))
        persons = db.get_all_persons()

        migrated_any = False
        for p in persons:
            img_file = p.get("image_filename")
            if not img_file:
                continue

            img_path = os.path.join(images_dir, img_file)
            if not os.path.isfile(img_path):
                continue

            try:
                img = cv2.imread(img_path)
                if img is None or img.size == 0:
                    continue

                emb = self.extract_embedding(img)
                if emb is not None and len(emb) == 128:
                    db.save_encoding(p["id"], emb.tobytes(), len(emb))
                    migrated_any = True
            except Exception:
                continue

        if migrated_any:
            self.refresh_enrolled_cache()

    def refresh_enrolled_cache(self):
        """Loads all enrolled person encodings into fast in-memory cache."""
        with _lock:
            enrolled = db.get_all_enrolled_encodings()
            parsed = []
            for item in enrolled:
                try:
                    emb = np.frombuffer(item["encoding"], dtype=np.float32)
                    norm = float(np.linalg.norm(emb))
                    if norm > 1e-6:
                        emb = emb / norm
                    parsed.append({
                        "person_id": item["person_id"],
                        "name": item["name"],
                        "classification": item["classification"],
                        "rfid_uid": item["rfid_uid"],
                        "image_filename": item["image_filename"],
                        "embedding": emb,
                    })
                except Exception:
                    continue
            self.enrolled_cache = parsed
            self.cache_last_updated = time.time()

    def detect_faces(self, frame_bgr: np.ndarray) -> List[Tuple[int, int, int, int, float, Any]]:
        """
        Detects faces in frame_bgr.
        Returns list of (x1, y1, x2, y2, confidence, raw_detection_with_landmarks).
        """
        if frame_bgr is None or frame_bgr.size == 0:
            return []

        h, w = frame_bgr.shape[:2]
        faces = []

        # 1. State-of-the-Art YuNet with 5-Point Facial Landmarks
        if self.yunet_detector is not None:
            try:
                self.yunet_detector.setInputSize((w, h))
                _, detections = self.yunet_detector.detect(frame_bgr)
                if detections is not None:
                    for det in detections:
                        conf = float(det[-1])
                        if conf >= config.FACE_DETECTION_CONFIDENCE:
                            x1 = max(0, int(det[0]))
                            y1 = max(0, int(det[1]))
                            x2 = min(w, int(det[0] + det[2]))
                            y2 = min(h, int(det[1] + det[3]))
                            if (x2 - x1) >= 20 and (y2 - y1) >= 20:
                                faces.append((x1, y1, x2, y2, conf, det))
                    if faces:
                        return faces
            except Exception:
                pass

        # 2. Fallback to OpenCV SSD Caffe model
        if self.detector_net is not None:
            try:
                blob = cv2.dnn.blobFromImage(frame_bgr, 1.0, (300, 300), (104.0, 177.0, 123.0))
                self.detector_net.setInput(blob)
                detections = self.detector_net.forward()
                for i in range(detections.shape[2]):
                    conf = float(detections[0, 0, i, 2])
                    if conf >= config.FACE_DETECTION_CONFIDENCE:
                        x1 = max(0, int(detections[0, 0, i, 3] * w))
                        y1 = max(0, int(detections[0, 0, i, 4] * h))
                        x2 = min(w, int(detections[0, 0, i, 5] * w))
                        y2 = min(h, int(detections[0, 0, i, 6] * h))
                        if (x2 - x1) >= 24 and (y2 - y1) >= 24:
                            faces.append((x1, y1, x2, y2, conf, None))
            except Exception:
                pass

        # 3. Fallback to Haar Cascade
        if not faces and self.haar_cascade is not None:
            try:
                gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
                haar_faces = self.haar_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
                for (hx, hy, hw, hh) in haar_faces:
                    faces.append((hx, hy, hx + hw, hy + hh, 0.85, None))
            except Exception:
                pass

        return faces

    def extract_embedding(self, face_bgr: np.ndarray, raw_det: Any = None) -> Optional[np.ndarray]:
        """
        Extracts normalized biometric feature embedding from face image.
        Uses SFace with geometric landmark alignment (128-dim) when available.
        """
        if face_bgr is None or face_bgr.size == 0:
            return None

        # 1. SFace Biometric Recognizer with 5-Point Landmark Alignment
        if self.sface_recognizer is not None:
            try:
                if raw_det is not None:
                    aligned = self.sface_recognizer.alignCrop(face_bgr, raw_det)
                    feat = self.sface_recognizer.feature(aligned)
                else:
                    # Run YuNet on image to locate landmarks for canonical alignment
                    h, w = face_bgr.shape[:2]
                    detected_feat = None
                    if self.yunet_detector is not None:
                        try:
                            self.yunet_detector.setInputSize((w, h))
                            _, dets = self.yunet_detector.detect(face_bgr)
                            if dets is not None and len(dets) > 0:
                                aligned = self.sface_recognizer.alignCrop(face_bgr, dets[0])
                                detected_feat = self.sface_recognizer.feature(aligned)
                        except Exception:
                            detected_feat = None

                    if detected_feat is None:
                        # Direct resized alignment fallback
                        resized = cv2.resize(face_bgr, (112, 112))
                        detected_feat = self.sface_recognizer.feature(resized)

                    feat = detected_feat

                norm = float(np.linalg.norm(feat))
                if norm > 1e-6:
                    feat = feat / norm
                return feat.flatten().astype(np.float32)
            except Exception:
                pass

        # 2. PyTorch ResNet-18 Fallback (512-dim)
        if self.feature_extractor is not None and self.transform is not None:
            try:
                rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
                tensor = self.transform(rgb).unsqueeze(0)
                with torch.no_grad():
                    features = self.feature_extractor(tensor)
                    embedding = features.squeeze().numpy().flatten().astype(np.float32)
                norm = float(np.linalg.norm(embedding))
                if norm > 1e-6:
                    embedding = embedding / norm
                return embedding
            except Exception:
                pass

        # 3. Robust spatial & texture color descriptor fallback (512-dim)
        try:
            resized = cv2.resize(face_bgr, (64, 64))
            hsv = cv2.cvtColor(resized, cv2.COLOR_BGR2HSV)
            hist_h = cv2.calcHist([hsv], [0], None, [170], [0, 180]).flatten()
            hist_s = cv2.calcHist([hsv], [1], None, [171], [0, 256]).flatten()
            hist_v = cv2.calcHist([hsv], [2], None, [171], [0, 256]).flatten()
            desc = np.concatenate([hist_h, hist_s, hist_v]).astype(np.float32)
            norm = float(np.linalg.norm(desc))
            if norm > 1e-6:
                desc = desc / norm
            return desc
        except Exception:
            return None

    def compare_embedding_to_enrolled(self, embedding: np.ndarray) -> Tuple[str, Optional[Dict[str, Any]], float]:
        """
        Compares an embedding against all enrolled reference records.
        Returns (status, matched_person_dict, confidence_score).
        Statuses: 'MATCH_VALID' | 'MATCH_INVALID' | 'INCONCLUSIVE' | 'UNKNOWN'
        """
        if embedding is None:
            return "UNKNOWN", None, 0.0

        with _lock:
            enrolled = list(self.enrolled_cache)

        if not enrolled:
            return "UNKNOWN", None, 0.0

        best_match = None
        best_sim = -1.0

        for candidate in enrolled:
            cand_emb = candidate["embedding"]
            if cand_emb.shape != embedding.shape:
                continue

            # Cosine similarity between unit-normalized vectors
            sim = float(np.dot(embedding, cand_emb))
            if sim > best_sim:
                best_sim = sim
                best_match = candidate

        is_sface = (embedding.shape[0] == 128)

        if is_sface:
            # SFace (128-dim) Decision Logic:
            # OpenCV SFace standard threshold is >= 0.363 for genuine positive verification
            if best_match is not None and best_sim >= config.MATCH_THRESHOLD:
                classification = best_match["classification"]
                status = "MATCH_VALID" if classification == "VALID" else "MATCH_INVALID"
                # Map SFace cosine range (0.363 to 0.85) to intuitive 80% - 99% UI confidence
                confidence = min(0.99, round(0.80 + (best_sim - config.MATCH_THRESHOLD) * 0.42, 3))
                return status, best_match, confidence

            elif best_match is not None and best_sim >= config.INCONCLUSIVE_THRESHOLD:
                confidence = round(0.55 + (best_sim - config.INCONCLUSIVE_THRESHOLD) * 2.5, 3)
                return "INCONCLUSIVE", best_match, confidence

            else:
                raw_conf = round(max(0.0, best_sim * 1.5), 3)
                return "UNKNOWN", None, raw_conf

        else:
            # Fallback (512-dim) Decision Logic:
            score = max(0.0, min(1.0, (best_sim + 1.0) / 2.0 if best_sim < 0 else best_sim))
            if best_match is not None and score >= 0.70:
                classification = best_match["classification"]
                status = "MATCH_VALID" if classification == "VALID" else "MATCH_INVALID"
                return status, best_match, round(score, 3)
            elif best_match is not None and score >= 0.52:
                return "INCONCLUSIVE", best_match, round(score, 3)
            else:
                return "UNKNOWN", None, round(max(0.0, score), 3)

    def analyze_frame_faces(self, frame_bgr: np.ndarray) -> Dict[str, Any]:
        """
        Analyzes a camera frame for faces, extracts crops, and classifies them.
        Returns structured analysis result with canonical landmark alignment.
        """
        if frame_bgr is None or frame_bgr.size == 0:
            return {"faces": [], "count": 0}

        faces = self.detect_faces(frame_bgr)
        h, w = frame_bgr.shape[:2]
        results = []

        for face_item in faces:
            x1, y1, x2, y2, det_conf = face_item[:5]
            raw_det = face_item[5] if len(face_item) > 5 else None

            # 1. Landmark alignment & extraction
            if raw_det is not None and self.sface_recognizer is not None:
                try:
                    aligned_crop = self.sface_recognizer.alignCrop(frame_bgr, raw_det)
                    face_crop = aligned_crop
                    embedding = self.extract_embedding(frame_bgr, raw_det=raw_det)
                except Exception:
                    pad_x = int((x2 - x1) * 0.1)
                    pad_y = int((y2 - y1) * 0.1)
                    cx1 = max(0, x1 - pad_x)
                    cy1 = max(0, y1 - pad_y)
                    cx2 = min(w, x2 + pad_x)
                    cy2 = min(h, y2 + pad_y)
                    face_crop = frame_bgr[cy1:cy2, cx1:cx2]
                    embedding = self.extract_embedding(face_crop)
            else:
                pad_x = int((x2 - x1) * 0.1)
                pad_y = int((y2 - y1) * 0.1)
                cx1 = max(0, x1 - pad_x)
                cy1 = max(0, y1 - pad_y)
                cx2 = min(w, x2 + pad_x)
                cy2 = min(h, y2 + pad_y)
                face_crop = frame_bgr[cy1:cy2, cx1:cx2]
                if face_crop.size == 0:
                    continue
                embedding = self.extract_embedding(face_crop)

            if face_crop is None or face_crop.size == 0:
                continue

            status, matched, confidence = self.compare_embedding_to_enrolled(embedding)

            # Encode face crop as JPEG base64 for UI unknown-face flagging and alert displays
            _, crop_buf = cv2.imencode(".jpg", face_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            crop_b64 = base64.b64encode(crop_buf.tobytes()).decode("utf-8")

            results.append({
                "box": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
                "pixels": [x1, y1, x2, y2],
                "detection_confidence": round(det_conf, 2),
                "face_status": status,  # MATCH_VALID, MATCH_INVALID, INCONCLUSIVE, UNKNOWN
                "confidence": confidence,
                "person": {
                    "id": matched["person_id"],
                    "name": matched["name"],
                    "classification": matched["classification"],
                    "rfid_uid": matched["rfid_uid"]
                } if matched else None,
                "crop_b64": crop_b64,
                "crop_bytes": crop_buf.tobytes()
            })

        return {
            "count": len(results),
            "faces": results
        }


# Singleton service instance
face_service = FaceRecognitionService()
