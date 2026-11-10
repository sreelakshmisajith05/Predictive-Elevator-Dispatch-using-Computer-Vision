# SmartLift AI — Face Recognition, Valid/Invalid Databases & Security Alert Integration

All new modules, models, services, UI components, and assets have been strictly isolated in this `new changes` folder to ensure maximum safety, zero regressions, and complete reversibility.

---

## 📁 1. Directory Structure & File Manifest

```text
SmartLift-AI-Windows/
├── existing project files (UNCHANGED)
│
└── new changes/
    ├── README.md
    ├── valid_invalid_database/
    │   ├── __init__.py
    │   ├── db.py                     # SQLite models, connection handling & CRUD
    │   └── initial_records.py        # Idempotent seeder for initial records
    ├── face_recognition/
    │   ├── __init__.py
    │   ├── config.py                 # Recognition thresholds & model paths
    │   └── recognition_service.py    # ResNet-10 SSD face detection + offline ResNet-18 embeddings
    ├── person_management/
    │   ├── __init__.py
    │   └── management_service.py     # Image uploads, replacements, deletions & unknown-face flagging
    ├── security_alerts/
    │   ├── __init__.py
    │   └── alert_service.py          # Face security alert triggers, identity mismatches, dual threat & cooldowns
    ├── dashboard/
    │   ├── valid_invalid_ui.js       # Right-panel launcher, database modals, image zoom/pan/download lightbox & alert enrichments
    │   └── valid_invalid_ui.css      # Dark glassmorphic styling (no emojis, right-panel card & lightbox)
    ├── integration/
    │   ├── __init__.py
    │   └── api.py                    # FastAPI APIRouter (/api/face-db) and backend wraps
    └── data/
        ├── smartlift_persons.db      # SQLite database file
        ├── face_images/              # Persisted administrator-uploaded face images
        └── face_crops/               # Captured face crops for security alerts and flagging
```

---

## 🗄️ 2. Database Schema & Initial Records

### Schema (`new changes/data/smartlift_persons.db`)
- **`persons` Table**:
  - `id`: Integer Primary Key (Autoincrement)
  - `name`: Text (Not Null)
  - `classification`: Text Check (`VALID`, `INVALID`)
  - `rfid_uid`: Text (Optional, uppercase card UID)
  - `image_filename`: Text (Optional, filename in `face_images/`)
  - `created_at`, `updated_at`: Real timestamps
- **`face_encodings` Table**:
  - `id`: Integer Primary Key
  - `person_id`: Integer (Foreign Key -> persons.id ON DELETE CASCADE)
  - `encoding`: Blob (512-dimensional float32 feature vector)
  - `embedding_dim`: Integer (512)
  - `created_at`: Real timestamp
- **`seeding_meta` Table**:
  - Tracks `initial_records_seeded: true` to prevent any duplicate creation across restarts.

### Initial Records (Created Exactly Once)
1. **Valid Persons Database**:
   - **Name**: `Abhishek Sri Saai`
   - **Classification**: `VALID`
   - **RFID UID**: `69BDF306` (Reusing the configured authorized UID from project)
   - **Face Image**: `None` (`Image not uploaded` placeholder in UI)
2. **Invalid Persons Database**:
   - **Record 1**: `Jianna Maria Joseph` | `INVALID` | RFID: `None` | Face Image: `None`
   - **Record 2**: `Sreelakshmi Sajith` | `INVALID` | RFID: `None` | Face Image: `None`

*Note: Records with blank images remain in their respective databases but cannot be matched through facial recognition until an image is uploaded (no simulated matches).*

---

## 🔍 3. Face Recognition Pipeline & Security Alerts

1. **Face Detection**:
   - Uses OpenCV DNN with ResNet-10 SSD (`server/models/deploy.prototxt` + `server/models/res10.caffemodel`).
   - Haar Cascade fallback (`haarcascade_frontalface_default.xml`).
2. **Face Feature Extraction**:
   - 512-dimensional normalized embedding vector extracted using offline PyTorch ResNet-18 (weights loaded locally from `~/.cache/torch/hub/checkpoints/resnet18-f37072fd.pth`).
3. **Classification & Matching**:
   - Cosine similarity with enrolled embeddings:
     - Similarity $\ge 0.70 \rightarrow$ **`MATCH_VALID`** or **`MATCH_INVALID`**
     - $0.52 \le \text{Similarity} < 0.70 \rightarrow$ **`INCONCLUSIVE`**
     - Similarity $< 0.52 \rightarrow$ **`NEW / UNKNOWN`**
4. **Security Alert Triggers**:
   - **Invalid RFID Scan**: Continues generating existing security alert (even if face is unknown).
   - **Invalid Face Match**: Generates a security alert immediately even without an RFID scan.
   - **Invalid Face + Invalid RFID**: Generates a dual-threat alert with reason `Both`.
   - **Valid Face + Matching Valid RFID**: Identifies person as verified passenger.
   - **Identity Mismatch**: Face matches Person X, but scanned card belongs to Person Y (or vice-versa). Valid RFID never suppresses an invalid-face alert.
   - **Continuous Encounter Cooldown**: Configured 8.0-second cooldown prevents frame-spamming alerts while allowing subsequent encounters.
   - **Zero Lift Interference**: Face recognition never directly commands motors or changes lift movement.

---

## 👤 4. Unknown Face Flagging (Requirement 5)

When an unknown face is detected by the camera:
1. A live banner appears in the Live Camera box: `⚠️ Unknown Face Detected [Flag as Invalid Person]`.
2. Clicking the button opens the **Flag as Invalid Person** modal displaying the detected face crop.
3. Administrator enters or confirms the person's name (and optional RFID UID).
4. On confirmation, the face image is saved securely to `data/face_images/`, a record is added to the Invalid Persons Database, and their embedding is enrolled for immediate future face recognition.

---

## 📝 5. Existing Files Modified & Integration Points

Only **two existing files** were slightly modified with non-invasive, reversible hooks:

### 1. `SmartLift-AI-Windows/server/main.py` (Lines 571–580)
- **Added**:
  ```python
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
  ```

### 2. `SmartLift-AI-Windows/src/main.js` (Lines 1416–1428)
- **Added**:
  ```javascript
  // ----------------- Integration: Face Recognition & Valid/Invalid Databases -----------------
  try {
    import('../new changes/dashboard/valid_invalid_ui.js')
      .then((mod) => {
        if (mod && mod.initDatabaseUI) {
          mod.initDatabaseUI();
        }
      })
      .catch((err) => {
        console.warn('[SmartLift] new changes UI module not loaded:', err);
      });
  } catch (e) {}
  ```

---

## 🔄 6. How to Enable, Disable, or Roll Back

### To Temporarily Disable:
1. In `SmartLift-AI-Windows/server/main.py`: comment out the 10 lines at lines 571–580.
2. In `SmartLift-AI-Windows/src/main.js`: comment out the dynamic import hook at lines 1416–1428.
3. Re-run `npm run build` or refresh the Vite dev server.
- The dashboard options and face alerts are immediately inactive, and the original invalid-RFID security alerts and lift simulator remain 100% operational.

### Complete Rollback & Removal:
1. Revert the edits in `SmartLift-AI-Windows/server/main.py` and `SmartLift-AI-Windows/src/main.js` (delete the integration blocks shown above).
2. Delete the `SmartLift-AI-Windows/new changes/` directory:
   ```powershell
   Remove-Item -Recurse -Force "SmartLift-AI-Windows\new changes"
   ```
3. Rebuild frontend: `npm run build`.
4. Original repository state is completely restored without any residual changes.
