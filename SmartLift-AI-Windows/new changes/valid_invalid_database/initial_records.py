"""
Initial Database Seeder for SmartLift AI.
Seeds the required initial records exactly once without creating duplicates on restarts.
"""

from . import db

INITIAL_VALID_PERSONS = [
    {
        "name": "Abhishek Sri Saai",
        "classification": "VALID",
        "rfid_uid": "69BDF306",
        "image_filename": None,
    },
    {
        "name": "Jianna Maria Joseph",
        "classification": "VALID",
        "rfid_uid": "3EAF1AAA",
        "image_filename": None,
    },
    {
        "name": "Sreelakshmi Sajith",
        "classification": "VALID",
        "rfid_uid": "6E9818AA",
        "image_filename": None,
    },
    {
        "name": "Pournami M",
        "classification": "VALID",
        "rfid_uid": "12D56B06",
        "image_filename": None,
    }
]

INITIAL_INVALID_PERSONS = []


def seed_initial_records_once():
    """Seeds the initial valid and invalid records if not already seeded."""
    db.init_db()
    if db.is_seeded():
        return False

    # Also verify existing names to prevent any chance of duplicate records
    existing_persons = db.get_all_persons()
    existing_names = {p["name"].strip().lower() for p in existing_persons}

    for rec in INITIAL_VALID_PERSONS:
        if rec["name"].strip().lower() not in existing_names:
            db.create_person(
                name=rec["name"],
                classification=rec["classification"],
                rfid_uid=rec["rfid_uid"],
                image_filename=rec["image_filename"]
            )
            existing_names.add(rec["name"].strip().lower())

    for rec in INITIAL_INVALID_PERSONS:
        if rec["name"].strip().lower() not in existing_names:
            db.create_person(
                name=rec["name"],
                classification=rec["classification"],
                rfid_uid=rec["rfid_uid"],
                image_filename=rec["image_filename"]
            )
            existing_names.add(rec["name"].strip().lower())

    db.mark_seeded()
    return True
