"""
Face + age estimation for passenger-type mapping.

Pipeline per tracked person: crop person box -> OpenCV DNN face detect
-> largest face -> age-bucket net -> representative age in years.

Returns None whenever anything is uncertain (no face, low confidence,
models missing) so the caller always falls back to the height heuristic.
A wrong child/adult call is worse than no call.

Models (downloaded once, lazily, from official OpenCV repos):
  deploy.prototxt + res10_300x300_ssd (face)
  age_deploy.prototxt + age_net.caffemodel (age buckets)
"""
import os

import cv2
import numpy as np

MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
FACE_PROTO_URL = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
FACE_MODEL_URL = "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel"
AGE_PROTO_URL = "https://raw.githubusercontent.com/spmallick/learnopencv/master/AgeGender/age_deploy.prototxt"
# Same Levi & Hassner 8-bucket architecture; learnopencv's caffemodel link is
# dead, so weights come from the original authors' repo (net definition above fits).
AGE_MODEL_URL = "https://raw.githubusercontent.com/GilLevi/AgeGenderDeepLearning/master/models/age_net.caffemodel"

AGE_BUCKETS = ["(0-2)", "(4-6)", "(8-12)", "(15-20)", "(25-32)", "(38-43)", "(48-53)", "(60-100)"]
AGE_MIDPOINTS = [1, 5, 10, 17, 28, 40, 50, 75]

MODEL_MEAN = (78.4263377603, 87.7689143744, 114.895847746)


def bucket_to_age(idx):
    """Bucket index -> representative years. Pure function, unit-tested."""
    if idx is None or not (0 <= idx < len(AGE_MIDPOINTS)):
        return None
    return AGE_MIDPOINTS[idx]


def _download(url, path):
    if os.path.exists(path):
        return True
    import urllib.request
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, path)
    return True


class FaceAgeEstimator:
    def __init__(self, face_conf=0.6, age_conf=0.55):
        _download(FACE_PROTO_URL, os.path.join(MODEL_DIR, "deploy.prototxt"))
        _download(FACE_MODEL_URL, os.path.join(MODEL_DIR, "res10.caffemodel"))
        _download(AGE_PROTO_URL, os.path.join(MODEL_DIR, "age_deploy.prototxt"))
        _download(AGE_MODEL_URL, os.path.join(MODEL_DIR, "age_net.caffemodel"))
        self.face = cv2.dnn.readNetFromCaffe(
            os.path.join(MODEL_DIR, "deploy.prototxt"),
            os.path.join(MODEL_DIR, "res10.caffemodel"),
        )
        self.age = cv2.dnn.readNetFromCaffe(
            os.path.join(MODEL_DIR, "age_deploy.prototxt"),
            os.path.join(MODEL_DIR, "age_net.caffemodel"),
        )
        self.face_conf = face_conf
        self.age_conf = age_conf

    def estimate(self, frame_bgr, person_pixels):
        """frame: full BGR image; person_pixels: [x1,y1,x2,y2]. Returns int|None."""
        h, w = frame_bgr.shape[:2]
        x1, y1, x2, y2 = (int(v) for v in person_pixels)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 < 20 or y2 - y1 < 20:
            return None
        crop = frame_bgr[y1:y2, x1:x2]
        ch, cw = crop.shape[:2]
        blob = cv2.dnn.blobFromImage(crop, 1.0, (300, 300), (104.0, 177.0, 123.0))
        self.face.setInput(blob)
        dets = self.face.forward()
        best, best_conf = None, 0.0
        for i in range(dets.shape[2]):
            conf = float(dets[0, 0, i, 2])
            if conf > best_conf:
                fx1 = int(dets[0, 0, i, 3] * cw)
                fy1 = int(dets[0, 0, i, 4] * ch)
                fx2 = int(dets[0, 0, i, 5] * cw)
                fy2 = int(dets[0, 0, i, 6] * ch)
                best, best_conf = (fx1, fy1, fx2, fy2), conf
        if best is None or best_conf < self.face_conf:
            return None
        fx1, fy1, fx2, fy2 = best
        face = crop[max(0, fy1):fy2, max(0, fx1):fx2]
        if face.size == 0:
            return None
        blob = cv2.dnn.blobFromImage(face, 1.0, (227, 227), MODEL_MEAN, swapRB=False)
        self.age.setInput(blob)
        preds = self.age.forward()[0]
        idx = int(np.argmax(preds))
        if float(preds[idx]) < self.age_conf:
            return None
        return bucket_to_age(idx)
