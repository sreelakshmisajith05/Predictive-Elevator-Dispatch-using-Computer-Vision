# SmartLift AI — Implementation Summary

Everything built in this project, what changed from the original Phase 1
simulation, and what is verified versus still pending.

---

## 1. The simulation dashboard (browser)

- **9 levels, two lifts.** Lift A starts at Ground, Lift B at Floor 4. Each has
  its own cabin, load, threshold, direction, requests, and route.
- **Passengers:** Adult (75 kg), Child (30 kg), Senior Citizen (70 kg),
  Wheelchair User (80 kg), Luggage (15 kg). Every passenger carries weight,
  luggage, luggage weight, boarding floor, destination, and status.
- **Drag and drop:** drag an icon onto a floor and that floor becomes the
  boarding floor automatically. The details card then asks for weight,
  luggage, and a destination dropdown. No separate boarding-floor selector.
- **People list:** each passenger shows type, boarding, weight, luggage,
  status, assigned lift, an editable destination while waiting, and an × to
  remove them (which triggers the ghost-call path).
- **Cabin buttons per lift** with double-press cancel (500 ms window).
- **Event log / reasoning trace** on the right, tagged `[SMARTLIFT]`,
  `[ALGORITHM]`, `[PREDICTION]`, `[SAFETY]`, `[LIFT A/B]`, `[GHOST CALL]`,
  `[ROUTE]`, `[SECURITY]`, `[CAMERA]`.
- **Controls:** Start, Pause, Reset, and a light/dark theme toggle.
- **Review demos A–G** under the people list for quick scenarios.

## 2. The intelligence (unchanged core, preserved)

Predictive, not reactive:

```
Current Load + Expected Passenger/Luggage Load
  -> Projected Load
  -> Projected Operational Threshold (dynamic)
  -> Projected Margin
  -> SAFE / DEFERRED / UNSAFE
  -> pickup decision and route
```

- **Dynamic threshold:** base 750 kg with deductions — wheelchair −110,
  senior −55, child −35, luggage −8/−18/−30 by total, crowding −12 per head
  over five, senior+child combo −15. Clamped 380–750, with an 800 kg hard cap.
  This is deliberately *not* a flat "current load + passenger <= 800" check.
- **Pickup deferral:** if the projected state is unsafe, the pickup is held as
  DEFERRED and re-evaluated whenever load or composition changes.
- **Ghost calls:** removing a waiting passenger marks them CANCELLED,
  invalidates only the outside pickup, drops the floor from the assigned lift,
  and recalculates. A cancelled pickup is never handed to the other lift.
  Inside destinations can never be ghost-cancelled.
- **Passenger states:** WAITING, PICKUP_REQUESTED, PICKUP_DEFERRED,
  APPROACHING, BOARDING, INSIDE, EXITING, COMPLETED, CANCELLED.
- **Door sequence:** arrive, verify, open, board/exit, recalculate threshold,
  close.

## 3. Two-lift coordination

`MultiLiftCoordinator` is a layer above the core, not a rewrite of it. For each
valid pickup it scores both lifts on current floor, direction, distance,
existing commitments, and projected load/threshold/safety, then assigns the
better one. Assignments are stable once made, so a lift already travelling
does not get reassigned mid-flight.

## 4. Camera input (real detection)

- **Backend:** FastAPI + YOLOv8n, tracking people and luggage with stable IDs,
  plus an OpenCV age network that separates child, adult, and senior. A seated
  posture hint suggests wheelchair for confirmation.
- **Frontend provider:** a track must be seen for 5 frames to become a waiting
  passenger, and 10 missed frames marks it lost. Losing a confirmed track fires
  the same ghost-call path as manual removal.
- **Weight is never guessed by the camera.** It is confirmed in the UI, because
  the core needs real numbers.
- Drag-drop remains as a fallback, so the demo never depends on lighting.

## 5. RFID security (ESP32 + RC522)

- Authorized UID `69BDF306`. Everything else is denied.
- **Granted:** LED blink plus one short beep locally, `ACCESS_GRANTED` sent.
- **Denied:** two beeps immediately and locally, `ACCESS_DENIED` sent.
- The backend re-validates the UID itself and ignores whatever event type the
  device claims, so a client cannot forge access.
- On denial the backend captures the latest camera frame, stores it in
  `server/security_images/`, and links it to the event. If no frame is
  available it records `IMAGE_CAPTURE_FAILED` rather than faking success.
- A duplicate-read window (8 s per UID) stops a card held on the reader from
  producing a stream of events.
- **RFID never moves the lift, creates passengers, or assigns floors.**

## 6. Physical model link

- The dashboard POSTs Lift A's position to `POST /mirror/lift`; the firmware
  polls `GET /mirror/lift` and drives the motor to match.
- 4 IR floor sensors on GPIO 15, 2, 21, 13 (bottom to top). Movement stops when
  the target sensor triggers, so travel does not drift.
- 9 simulated levels map onto 4 physical floors: sim 0–1 → floor 1,
  2–3 → floor 2, 4–6 → floor 3, 7–8 → floor 4.
- On boot the cabin homes to the bottom sensor.

## 7. Files

```
index.html                     dashboard markup
src/main.js                    UI, wiring, mirror push, camera panel
src/styles.css                 styling, themes, animation timing
src/core/                      SmartLift Core
  StateManager.js              lifts + passengers + states
  RequestManager.js            pickup vs destination requests
  RouteManager.js              per-lift SCAN + predictive safety
  ElevatorController.js        per-lift tick, doors, ghost re-evaluation
  MultiLiftCoordinator.js      lift selection
  EventManager.js              reasoning trace
src/modules/camera_weight/     ThresholdEngine, SafetyEngine, LoadManager,
                               Classification
src/simulation/                PassengerManager, SimulationDetectionProvider,
                               CameraDetectionProvider
server/main.py                 API: camera, RFID security, lift mirror
server/detector.py             YOLOv8n tracking + type mapping
server/age.py                  face + age estimation
server/esp32/                  SmartLift_RFID and SmartLift_Combined sketches
```

## 8. What changed from the original Phase 1

1. One lift became two, with a coordination layer above the existing core.
2. Drag-drop now sets the boarding floor automatically; destination moved to a
   dropdown in the passenger details card.
3. Dashboard redesigned around the elevator view. The simulated camera feed,
   architecture, provider, and Phase 2 explanation boxes were removed from the
   UI but kept in the code.
4. Event log extended with lift tags, prediction, safety, ghost, and route
   reasoning.
5. Lift movement slowed (1600 ms per floor, 1.4 s cabin glide).
6. Real camera pipeline added (YOLO backend plus camera provider and panel).
7. RFID security added end to end: firmware, validation, capture, storage,
   dashboard panel.
8. Physical model link added via the lift mirror endpoints.
9. Light and dark themes.

Nothing in the routing, threshold, safety, or ghost algorithms was rewritten.

## 9. Verified

- Core logic suite: 34 of 34 checks (projection maths, dynamic threshold,
  algorithmic lift assignment, ghost invalidation without cross-lift leakage,
  inside destinations surviving, single-floor double-press cancel, full
  board-ride-exit cycle, dashboard wiring).
- Camera provider suite: 12 of 12 (confirm timing, no duplicates, walk-out
  ghost, flicker rejection, seated hint).
- Backend: RFID grant, deny, forged grant rejected, malformed rejected,
  duplicates suppressed, image captured and served, capture failure recorded.
- Mirror endpoints: valid push accepted, out-of-range rejected.
- Firmware: both sketches compile (ESP32 core 3.3.12, MFRC522 1.4.12).
- Beep sequencer verified to produce two clean beeps.

## 10. Not verified, and known limits

- No live webcam test was possible here; run it once on your machine.
- The ESP32 sketches are compile-verified but not run against real hardware.
- The IR sensor order and polarity need the one-time `SENSOR_CHECK` pass.
- The physical model has 4 floors, so it is a proportional indicator of the
  9-level simulation, not a floor-exact twin.
- GPIO 2 also drives the onboard LED and can misread; moving that sensor wire
  to GPIO 14 is recommended.
- Not implemented, by scope: facial recognition, identity matching, RFID-based
  destination selection, and real hardware beyond the RFID reader, motor, and
  IR sensors.
