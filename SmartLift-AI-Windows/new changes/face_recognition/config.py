"""
Face Recognition Configuration & Thresholds.
"""

import os

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_CHANGES_DIR = os.path.abspath(os.path.join(MODULE_DIR, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(NEW_CHANGES_DIR, ".."))
SERVER_DIR = os.path.join(PROJECT_ROOT, "server")
SERVER_MODELS_DIR = os.path.join(SERVER_DIR, "models")

# YuNet 5-Point Landmark Face Detector & SFace Deep Face Recognizer
YUNET_MODEL_PATH = os.path.join(SERVER_MODELS_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_MODEL_PATH = os.path.join(SERVER_MODELS_DIR, "face_recognition_sface_2021dec.onnx")

# Face Detection Models Fallback (SSD ResNet-10)
FACE_PROTO_PATH = os.path.join(SERVER_MODELS_DIR, "deploy.prototxt")
FACE_MODEL_PATH = os.path.join(SERVER_MODELS_DIR, "res10.caffemodel")

# PyTorch ResNet18 Checkpoint (cached offline fallback)
TORCH_CHECKPOINT_PATH = os.path.expanduser("~/.cache/torch/hub/checkpoints/resnet18-f37072fd.pth")

# Thresholds for SFace Deep Biometric Recognizer
MATCH_THRESHOLD = 0.363           # Cosine similarity >= 0.363 is a confirmed match (OpenCV standard)
INCONCLUSIVE_THRESHOLD = 0.280    # Cosine similarity between 0.280 and 0.363 is inconclusive
FACE_DETECTION_CONFIDENCE = 0.50  # Minimum confidence to accept a detected face
EMBEDDING_DIM = 128               # SFace output feature vector dimension

# Alert & Cooldown Settings
ALERT_COOLDOWN_SECONDS = 8.0      # Prevent duplicate alerts during one continuous encounter
MAX_RECENT_DETECTIONS = 20
