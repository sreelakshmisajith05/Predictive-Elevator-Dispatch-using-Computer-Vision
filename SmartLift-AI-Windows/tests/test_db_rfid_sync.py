import json
import urllib.request

BASE_URL = "http://localhost:8000"

def post(path, data):
    req = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def put(path, data):
    req = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="PUT"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def get(path):
    with urllib.request.urlopen(BASE_URL + path) as resp:
        return json.loads(resp.read().decode("utf-8"))

def delete(path):
    req = urllib.request.Request(
        BASE_URL + path,
        headers={"X-Security-Password": "xyz123"},
        method="DELETE"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def run():
    print("=== TEST: RFID Database Ground Truth & Dynamic UI Sync ===")

    # Step 1: Create person with RFID 'AABBCCDD' classified as INVALID
    created = post("/api/face-db/persons", {
        "name": "Test Subject AABB",
        "classification": "INVALID",
        "rfid_uid": "AABBCCDD"
    })
    person_id = created["person"]["id"]
    print(f"1. Created: ID {person_id}, Name: {created['person']['name']}, Class: {created['person']['classification']}, UID: {created['person']['rfid_uid']}")

    # Step 2: Scan AABBCCDD while in DB as INVALID -> Must be ACCESS_DENIED
    scan1 = post("/security/rfid-event", {"uid": "AABBCCDD"})
    ev1 = scan1.get("last_event") or {}
    print(f"2. Scan 1 (INVALID in DB): status={ev1.get('status')}, name={ev1.get('name')}")
    assert ev1.get("status") == "ACCESS_DENIED", f"Expected ACCESS_DENIED, got {ev1.get('status')}"
    assert "Test Subject AABB" in ev1.get("name", ""), f"Expected person name in event, got {ev1.get('name')}"

    # Step 3: Edit person in DB to VALID!
    updated = put(f"/api/face-db/persons/{person_id}", {
        "name": "Test Subject AABB",
        "classification": "VALID",
        "rfid_uid": "AABBCCDD"
    })
    print(f"3. Updated in DB: ID {person_id}, Class: {updated['person']['classification']}")
    assert updated["person"]["classification"] == "VALID"

    # Step 4: Scan AABBCCDD after editing to VALID -> MUST BE ACCESS_GRANTED!
    scan2 = post("/security/rfid-event", {"uid": "AABBCCDD"})
    ev2 = scan2.get("last_event") or {}
    print(f"4. Scan 2 (after edited to VALID): status={ev2.get('status')}, name={ev2.get('name')}, dest={ev2.get('fixed_destination')}")
    assert ev2.get("status") == "ACCESS_GRANTED", f"Expected ACCESS_GRANTED, got {ev2.get('status')}"
    assert ev2.get("fixed_destination") is not None, "Expected destination floor resolved"

    # Step 5: Edit person in DB back to INVALID!
    updated2 = put(f"/api/face-db/persons/{person_id}", {
        "name": "Test Subject AABB",
        "classification": "INVALID",
        "rfid_uid": "AABBCCDD"
    })
    print(f"5. Updated in DB back to INVALID: Class: {updated2['person']['classification']}")

    # Step 6: Scan AABBCCDD after editing to INVALID -> MUST BE ACCESS_DENIED!
    scan3 = post("/security/rfid-event", {"uid": "AABBCCDD"})
    ev3 = scan3.get("last_event") or {}
    print(f"6. Scan 3 (after edited to INVALID): status={ev3.get('status')}, name={ev3.get('name')}")
    assert ev3.get("status") == "ACCESS_DENIED", f"Expected ACCESS_DENIED, got {ev3.get('status')}"

    # Step 7: Clean up test person
    del_res = delete(f"/api/face-db/persons/{person_id}")
    print(f"7. Cleanup: {del_res}")

    # Step 8: Verify status counts
    status = get("/api/face-db/status")
    print(f"8. Status Counts: Valid={status['valid_persons_count']}, Invalid={status['invalid_persons_count']}")

    print("\n>>> ALL TESTS PASSED! RFID STATUS ALWAYS MIRRORS THE DATABASE! <<<")

if __name__ == "__main__":
    run()
