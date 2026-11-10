"""
Valid and Invalid Persons Database Layer
SQLite-backed persistent store for SmartLift AI face recognition & access verification.
"""

import os
import sqlite3
import time
from typing import List, Optional, Dict, Any

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
NEW_CHANGES_DIR = os.path.abspath(os.path.join(MODULE_DIR, ".."))
DATA_DIR = os.path.join(NEW_CHANGES_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "smartlift_persons.db")

os.makedirs(DATA_DIR, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initializes tables for persons, face encodings, and meta information."""
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS persons (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    classification TEXT NOT NULL CHECK(classification IN ('VALID', 'INVALID')),
                    rfid_uid TEXT,
                    image_filename TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS face_encodings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    person_id INTEGER NOT NULL UNIQUE,
                    encoding BLOB NOT NULL,
                    embedding_dim INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
                );
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS seeding_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_persons_classification ON persons(classification);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_persons_rfid ON persons(rfid_uid);")
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    if not row:
        return {}
    d = dict(row)
    d["has_image"] = bool(d.get("image_filename"))
    return d


def get_all_persons(classification: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = get_connection()
    try:
        if classification:
            rows = conn.execute(
                "SELECT * FROM persons WHERE classification = ? ORDER BY id ASC",
                (classification.upper(),)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM persons ORDER BY id ASC").fetchall()
        return [row_to_dict(r) for r in rows]
    finally:
        conn.close()


def get_person_by_id(person_id: int) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM persons WHERE id = ?", (person_id,)).fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


def get_person_by_uid(uid: str) -> Optional[Dict[str, Any]]:
    if not uid:
        return None
    clean_uid = uid.strip().upper()
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM persons WHERE TRIM(UPPER(rfid_uid)) = ? ORDER BY updated_at DESC, id DESC LIMIT 1",
            (clean_uid,)
        ).fetchone()
        return row_to_dict(row) if row else None
    finally:
        conn.close()


get_person_by_rfid = get_person_by_uid



def create_person(name: str, classification: str, rfid_uid: Optional[str] = None, image_filename: Optional[str] = None) -> Dict[str, Any]:
    name = (name or "").strip()
    classification = classification.upper() if classification else "VALID"
    if classification not in ("VALID", "INVALID"):
        raise ValueError("Classification must be VALID or INVALID")
    rfid_uid = rfid_uid.strip().upper() if rfid_uid else None
    now = time.time()

    conn = get_connection()
    try:
        with conn:
            cur = conn.execute("""
                INSERT INTO persons (name, classification, rfid_uid, image_filename, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (name, classification, rfid_uid, image_filename, now, now))
            new_id = cur.lastrowid
        return get_person_by_id(new_id)
    finally:
        conn.close()


def update_person(person_id: int, name: Optional[str] = None, rfid_uid: Optional[str] = None,
                  classification: Optional[str] = None, image_filename: Optional[str] = None,
                  clear_image: bool = False) -> Optional[Dict[str, Any]]:
    existing = get_person_by_id(person_id)
    if not existing:
        return None

    new_name = name.strip() if name is not None else existing["name"]
    new_class = classification.upper() if classification is not None else existing["classification"]
    if new_class not in ("VALID", "INVALID"):
        raise ValueError("Classification must be VALID or INVALID")
    new_rfid = rfid_uid.strip().upper() if rfid_uid is not None else existing["rfid_uid"]
    if new_rfid == "":
        new_rfid = None

    if clear_image:
        new_image = None
    elif image_filename is not None:
        new_image = image_filename
    else:
        new_image = existing["image_filename"]

    now = time.time()
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                UPDATE persons
                SET name = ?, classification = ?, rfid_uid = ?, image_filename = ?, updated_at = ?
                WHERE id = ?
            """, (new_name, new_class, new_rfid, new_image, now, person_id))
        return get_person_by_id(person_id)
    finally:
        conn.close()


def delete_person(person_id: int) -> bool:
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM face_encodings WHERE person_id = ?", (person_id,))
            cur = conn.execute("DELETE FROM persons WHERE id = ?", (person_id,))
            return cur.rowcount > 0
    finally:
        conn.close()


def save_encoding(person_id: int, encoding_bytes: bytes, dim: int):
    now = time.time()
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                INSERT INTO face_encodings (person_id, encoding, embedding_dim, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    encoding = excluded.encoding,
                    embedding_dim = excluded.embedding_dim,
                    created_at = excluded.created_at
            """, (person_id, encoding_bytes, dim, now))
    finally:
        conn.close()


def get_encoding(person_id: int) -> Optional[bytes]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT encoding FROM face_encodings WHERE person_id = ?", (person_id,)).fetchone()
        return bytes(row["encoding"]) if row else None
    finally:
        conn.close()


def delete_encoding(person_id: int):
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM face_encodings WHERE person_id = ?", (person_id,))
    finally:
        conn.close()


def get_all_enrolled_encodings() -> List[Dict[str, Any]]:
    """Returns all persons who have a registered face encoding."""
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT p.id, p.name, p.classification, p.rfid_uid, p.image_filename, e.encoding, e.embedding_dim
            FROM persons p
            JOIN face_encodings e ON p.id = e.person_id
            WHERE p.image_filename IS NOT NULL
        """).fetchall()
        result = []
        for r in rows:
            result.append({
                "person_id": r["id"],
                "name": r["name"],
                "classification": r["classification"],
                "rfid_uid": r["rfid_uid"],
                "image_filename": r["image_filename"],
                "encoding": bytes(r["encoding"]),
                "embedding_dim": r["embedding_dim"],
            })
        return result
    finally:
        conn.close()


def is_seeded() -> bool:
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM seeding_meta WHERE key = 'initial_records_seeded'").fetchone()
        return bool(row and row["value"] == "true")
    finally:
        conn.close()


def mark_seeded():
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                INSERT OR REPLACE INTO seeding_meta (key, value)
                VALUES ('initial_records_seeded', 'true')
            """)
    finally:
        conn.close()
