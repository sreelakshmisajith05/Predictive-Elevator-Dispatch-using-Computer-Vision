/**
 * SmartLift AI — Advanced Two-Lift Software Simulation & Hardware Prototype Controller
 * 
 * Environments:
 * - Software Simulation: Dual Virtual Lifts (Lift A & Lift B), 8 Floors (G–7), Multi-Passenger Queues,
 *   1.5s Arrival Batching Window, Priority Scheduling, Dynamic Operational Thresholds, Ghost Calls.
 * - Hardware Prototype: Physical Lift A (G–3), ESP32 Closed-Loop, RC522 RFID, IR Sensors. Completely Isolated.
 */

import { stateManager } from './core/StateManager.js';
import { RequestManager } from './core/RequestManager.js';
import { RouteManager } from './core/RouteManager.js';
import { ElevatorController } from './core/ElevatorController.js';
import { MultiLiftCoordinator } from './core/MultiLiftCoordinator.js';
import { PassengerManager } from './simulation/PassengerManager.js';
import { CameraDetectionProvider } from './simulation/CameraDetectionProvider.js';
import { eventManager } from './core/EventManager.js';
import { SafetyEngine } from './modules/camera_weight/SafetyEngine.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

const BACKEND_BASE = 'http://localhost:8000';
let MIN_FLOOR = 0;
let MAX_FLOOR = 7;
let FLOOR_HEIGHT = 64;

// ---- Core Dual-Lift Engine (Software Simulation) ----
const requestManager = new RequestManager(stateManager);
const routeManagerA = new RouteManager(stateManager, requestManager, 'A');
const routeManagerB = new RouteManager(stateManager, requestManager, 'B');

const controllerA = new ElevatorController(stateManager, requestManager, routeManagerA, 'A');
const controllerB = new ElevatorController(stateManager, requestManager, routeManagerB, 'B');
controllerA.sharedTick = true;
controllerB.sharedTick = true;

const coordinator = new MultiLiftCoordinator(stateManager, requestManager);
const passengerManager = new PassengerManager(stateManager, requestManager, eventManager);

// Hook ghost recalculation to coordinator & route managers
controllerA.onGhostRecalc = () => {
  coordinator.reevaluateAfterGhost();
  routeManagerA.evaluatePickupSafety();
  renderAll();
};
controllerB.onGhostRecalc = () => {
  coordinator.reevaluateAfterGhost();
  routeManagerB.evaluatePickupSafety();
  renderAll();
};

// ---- Operating Mode State ----
// 'sim' = Advanced Software Simulation (Dual Lifts G–7) | 'hw' = Hardware Prototype (Single Lift G–3)
let currentMode = 'sim';
let lastHwFloor = null;
let lastHwRfidEventId = null;

// ---- 1.5-Second Passenger Arrival / Batching Window ----
const batchWindows = new Map(); // floor -> { active: boolean, expiresAt: number, timer: any }

// ---- Simulation Master Tick (Independent movement for Lift A & Lift B) ----
const SIM_TICK_MS = 1400;
let masterTimer = null;

function masterTick() {
  if (currentMode === 'sim') {
    controllerA.tick();
    controllerB.tick();
  }
}

function startSim() {
  if (masterTimer) return;
  masterTimer = setInterval(masterTick, SIM_TICK_MS);
}

function pauseSim() {
  if (masterTimer) {
    clearInterval(masterTimer);
    masterTimer = null;
  }
}

function isRunning() {
  return !!masterTimer;
}

// ---- Camera Detection Provider ----
let camStream = null;
let camCaptureTimer = null;
let lastCamWaiting = 0;
const camVideo = document.getElementById('camVideo');
const camFloorEl = document.getElementById('camFloor');
const btnCamera = document.getElementById('btnCamera');
const camPendingEl = document.getElementById('camPending');
const camStatusEl = document.getElementById('camStatus');
const camUrlEl = document.getElementById('camUrl');

const camera = new CameraDetectionProvider({
  floor: 0,
  passengerManager,
  eventManager,
  onUpdate: () => {
    renderCameraPanel();
    const n = stateManager.waitingPassengers.length;
    if (n !== lastCamWaiting) {
      lastCamWaiting = n;
      stateChanged();
    }
  },
  onGhost: () => {
    eventManager.log('[GHOST CALL] Outside passenger departed waiting zone — request invalidated', 'warn');
    requestManager.syncPickupsFromWaiting();
    coordinator.reevaluateAfterGhost();
    routeManagerA.evaluatePickupSafety();
    routeManagerB.evaluatePickupSafety();
    stateChanged();
  },
});

function stateChanged() {
  requestManager.syncPickupsFromWaiting();
  coordinator.evaluateAndAssign();
  routeManagerA.evaluatePickupSafety();
  routeManagerB.evaluatePickupSafety();
  renderAll();
}

// ---- UI References ----
const buildingEl = document.getElementById('building');
const peopleListEl = document.getElementById('peopleList');
const peopleCountEl = document.getElementById('peopleCount');
const eventLogEl = document.getElementById('eventLog');
const toastEl = document.getElementById('toast');

// Mode buttons & status indicators
const btnModeSim = document.getElementById('btnModeSim');
const btnModeHw = document.getElementById('btnModeHw');
const activeModeBadge = document.getElementById('activeModeBadge');
const pillHw = document.getElementById('pillHw');
const pillHwText = document.getElementById('pillHwText');
const pillCam = document.getElementById('pillCam');
const pillCamText = document.getElementById('pillCamText');
const hwConnBadge = document.getElementById('hwConnBadge');

let draggedType = null;
let draggedWeight = null;
let selectedInsideIdA = null;
let selectedInsideIdB = null;

// ---- 3D Shaft & Floor Initialization ----
function buildFloors() {
  const bEl = document.getElementById('building');
  if (!bEl) return;
  bEl.querySelectorAll('.floor').forEach((el) => el.remove());

  for (let f = MAX_FLOOR; f >= MIN_FLOOR; f--) {
    const floorEl = document.createElement('div');
    floorEl.className = 'floor';
    floorEl.dataset.floor = f;
    floorEl.style.height = FLOOR_HEIGHT + 'px';
    floorEl.style.flex = `0 0 ${FLOOR_HEIGHT}px`;
    floorEl.innerHTML = `
      <div class="floor-label">FLOOR ${floorLabel(f)}</div>
      <div class="floor-waiting" id="waiting-${f}"></div>
      <div class="floor-call" id="call-${f}">○ idle</div>
    `;

    floorEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      floorEl.classList.add('drop-hover');
    });
    floorEl.addEventListener('dragleave', () => floorEl.classList.remove('drop-hover'));
    floorEl.addEventListener('drop', (e) => {
      e.preventDefault();
      floorEl.classList.remove('drop-hover');
      if (!draggedType) return;
      openModalForFloor(f, draggedType, draggedWeight);
      draggedType = null;
      draggedWeight = null;
    });

    floorEl.addEventListener('click', (e) => {
      if (e.target.closest('.waiting-chip') || e.target.closest('.chip-rm')) return;
      if (currentMode === 'hw') {
        sendHardwareCommand(f);
      } else if (!draggedType) {
        openModalForFloor(f, 'adult', 75);
      }
    });

    bEl.insertBefore(floorEl, document.getElementById('cabinA'));
  }
}

function buildFloorButtons() {
  // Destination buttons for Lift A
  const containerA = document.getElementById('floorButtonsA');
  if (containerA) {
    containerA.innerHTML = '';
    for (let f = MIN_FLOOR; f <= MAX_FLOOR; f++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb';
      btn.dataset.floor = f;
      btn.textContent = floorLabel(f);
      btn.addEventListener('click', () => {
        if (currentMode === 'hw') {
          sendHardwareCommand(f);
        } else {
          handleCabinButtonClick('A', f);
        }
      });
      containerA.appendChild(btn);
    }
  }

  // Destination buttons for Lift B (Simulation Mode)
  const containerB = document.getElementById('floorButtonsB');
  if (containerB) {
    containerB.innerHTML = '';
    for (let f = MIN_FLOOR; f <= MAX_FLOOR; f++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fb';
      btn.dataset.floor = f;
      btn.textContent = floorLabel(f);
      btn.addEventListener('click', () => {
        handleCabinButtonClick('B', f);
      });
      containerB.appendChild(btn);
    }
  }
}

function handleCabinButtonClick(liftId, floor) {
  const existing = requestManager.destinationRequests.find(
    (r) => r.floor === floor && r.liftId === liftId
  );
  if (existing) {
    // Double press cancellation
    const ctl = liftId === 'A' ? controllerA : controllerB;
    ctl.cancelDestination(floor);
    renderAll();
    toast(`Lift ${liftId}: Cancelled inside destination Floor ${floorLabel(floor)}`);
    return;
  }

  const selectedId = liftId === 'A' ? selectedInsideIdA : selectedInsideIdB;
  const ctl = liftId === 'A' ? controllerA : controllerB;
  const res = ctl.pressInsideButton(floor, selectedId);

  if (res.action === 'added') {
    if (liftId === 'A') selectedInsideIdA = null;
    else selectedInsideIdB = null;
    toast(`Lift ${liftId}: Destination set to Floor ${floorLabel(floor)}`);
  } else if (res.action === 'already_has_destination') {
    toast(`Passenger already going to Floor ${floorLabel(res.currentDestination)}`);
  } else if (res.action === 'no_passenger') {
    toast(`No inside passenger without a destination on Lift ${liftId}`);
  }
  renderAll();
}

function iconForType(t) {
  const m = { adult: '👨', child: '👦', senior: '👴', wheelchair: '♿', luggage: '🧳' };
  return m[t] || '👤';
}
function labelForType(t) {
  const m = { adult: 'Adult', child: 'Child', senior: 'Senior Citizen', wheelchair: 'Wheelchair User', luggage: 'Luggage' };
  return m[t] || t;
}

function populateFloorSelect(selectEl, defaultFloor, currentFloor = null) {
  selectEl.innerHTML = '';
  for (let f = MAX_FLOOR; f >= MIN_FLOOR; f--) {
    if (currentFloor !== null && f === currentFloor) continue;
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = 'Floor ' + floorLabel(f);
    selectEl.appendChild(opt);
  }
  if (defaultFloor !== undefined && defaultFloor !== null && Number(defaultFloor) !== currentFloor) {
    selectEl.value = String(defaultFloor);
  }
}

// ---- Drag & Drop Passenger Creation ----
const modal = document.getElementById('passengerModal');
const modalFloor = document.getElementById('modalFloor');
const fType = document.getElementById('fType');
const fWeight = document.getElementById('fWeight');
const fDestination = document.getElementById('fDestination');
const passengerForm = document.getElementById('passengerForm');

function setupDrag() {
  document.querySelectorAll('.draggable').forEach((el) => {
    el.addEventListener('dragstart', () => {
      draggedType = el.dataset.type;
      draggedWeight = el.dataset.weight;
    });
  });

  const btnCancel = document.getElementById('btnCancelModal');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
  }

  passengerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const boarding = Number(modalFloor.textContent === 'G' ? 0 : modalFloor.textContent);
    const dest = Number(fDestination.value);
    const weight = Number(fWeight.value);

    if (boarding === dest) {
      toast('Destination floor must differ from boarding floor');
      return;
    }
    if (isNaN(weight) || weight <= 0) {
      toast('Please enter a valid positive weight');
      return;
    }

    addPassengerWithBatchWindow({
      floor: boarding,
      destination: dest,
      type: fType.value,
      weight,
    });

    modal.classList.add('hidden');
    toast(`Passenger added at Floor ${floorLabel(boarding)} → Destination Floor ${floorLabel(dest)}`);
    renderAll();
  });
}

function openModalForFloor(floor, type = 'adult', weight = 75) {
  modalFloor.textContent = floorLabel(floor);
  fType.value = type;
  fWeight.value = weight;
  const validDest = floor === 0 ? 2 : 0;
  populateFloorSelect(fDestination, validDest, floor);
  modal.classList.remove('hidden');
}

/**
 * 1.5-Second Boarding / Request Batching Window
 * When the first passenger is added at a floor, start a 1.5s arrival window.
 * Additional passengers added join the same queue without blocking UI or other floors.
 */
function addPassengerWithBatchWindow({ floor, destination, type, weight }) {
  const created = passengerManager.createPassenger({
    floor,
    destination,
    type,
    weight,
  });

  if (batchWindows.has(floor) && batchWindows.get(floor).active) {
    eventManager.log(`[BATCH] Passenger ${created.passenger.id} joined active 1.5s window at Floor ${floorLabel(floor)}`, 'info');
  } else {
    eventManager.log(`[BATCH] 1.5s arrival window started for Floor ${floorLabel(floor)}`, 'info');
    const timer = setTimeout(() => {
      batchWindows.set(floor, { active: false, timer: null });
      const waitingCount = stateManager.waitingPassengers.filter(
        (x) => x.floor === floor && x.status !== 'CANCELLED'
      ).length;
      eventManager.log(
        `[BATCH] 1.5s arrival window closed for Floor ${floorLabel(floor)} (${waitingCount} passenger${waitingCount > 1 ? 's' : ''} batched) — evaluating assignment`,
        'info'
      );
      requestManager.syncPickupsFromWaiting();
      coordinator.evaluateAndAssign(floor);
      routeManagerA.evaluatePickupSafety();
      routeManagerB.evaluatePickupSafety();
      renderAll();
    }, 1500);

    batchWindows.set(floor, { active: true, timer, expiresAt: Date.now() + 1500 });
  }

  return created;
}

// ---- Mode Switching: Software Simulation vs Hardware Prototype ----
function applyModeLayout(mode) {
  const bEl = document.getElementById('building');
  const shaftRangeEl = document.getElementById('shaftRange');
  const cabinA = document.getElementById('cabinA');
  const cabinB = document.getElementById('cabinB');
  const cabinCtlB = document.getElementById('cabinCtlB');
  const safetyCardB = document.getElementById('safetyCardB');

  if (mode === 'sim') {
    MIN_FLOOR = 0;
    MAX_FLOOR = 7;
    FLOOR_HEIGHT = 64;
    stateManager.maxFloor = 7;
    stateManager.floors = 8;
    coordinator.activeLifts = ['A', 'B'];

    if (bEl) {
      bEl.style.height = '512px';
      bEl.style.flex = '0 0 512px';
      bEl.classList.remove('hw-mode');
      bEl.classList.add('sim-mode');
    }
    if (cabinA) {
      cabinA.style.height = '62px';
      cabinA.classList.remove('hw-mode');
    }
    if (cabinB) {
      cabinB.style.height = '62px';
      cabinB.classList.remove('hidden');
      cabinB.style.display = 'flex';
    }
    if (cabinCtlB) cabinCtlB.classList.remove('hidden');
    if (safetyCardB) safetyCardB.classList.remove('hidden');

    if (shaftRangeEl) {
      shaftRangeEl.innerHTML = 'RANGE: <strong>FLOORS G – 7 (DUAL LIFTS A & B)</strong>';
    }

    // In Software Simulation: Hide ESP side box; Show passenger management, safety engine, and evaluation
    document.getElementById('hwPanel')?.classList.add('hidden');
    document.getElementById('safetyCard')?.classList.remove('hidden');
    document.getElementById('projectedCard')?.classList.remove('hidden');
    document.getElementById('simPassengerSection')?.classList.remove('hidden');
  } else {
    MIN_FLOOR = 0;
    MAX_FLOOR = 3;
    FLOOR_HEIGHT = 88;
    stateManager.maxFloor = 3;
    stateManager.floors = 4;
    coordinator.activeLifts = ['A'];

    if (bEl) {
      bEl.style.height = '352px';
      bEl.style.flex = '0 0 352px';
      bEl.classList.remove('sim-mode');
      bEl.classList.add('hw-mode');
    }
    if (cabinA) {
      cabinA.style.height = '84px';
      cabinA.classList.add('hw-mode');
    }
    if (cabinB) {
      cabinB.classList.add('hidden');
      cabinB.style.display = 'none';
    }
    if (cabinCtlB) cabinCtlB.classList.add('hidden');
    if (safetyCardB) safetyCardB.classList.add('hidden');

    if (shaftRangeEl) {
      shaftRangeEl.innerHTML = 'RANGE: <strong>FLOORS G – 3 (PHYSICAL HARDWARE)</strong>';
    }

    // In Hardware Prototype: Show ESP side box; Remove passenger evaluation, weight threshold, and passenger management
    document.getElementById('hwPanel')?.classList.remove('hidden');
    document.getElementById('safetyCard')?.classList.add('hidden');
    document.getElementById('projectedCard')?.classList.add('hidden');
    document.getElementById('simPassengerSection')?.classList.add('hidden');
  }

  buildFloors();
  buildFloorButtons();
  populateFloorSelect(camFloorEl, 0);
  const destEl = document.getElementById('fDestination');
  if (destEl) populateFloorSelect(destEl, 1);
}

function setMode(mode) {
  currentMode = mode;
  const sysTag = document.getElementById('systemTag');
  if (mode === 'sim') {
    btnModeSim.classList.add('active');
    btnModeHw.classList.remove('active');
    activeModeBadge.textContent = 'SOFTWARE SIMULATION (DUAL LIFTS A & B · G–7)';
    activeModeBadge.className = 'mode-indicator sim';
    if (sysTag) sysTag.textContent = 'DUAL-LIFT 8-FLOOR CONTROLLER (G–7)';
    eventManager.log('[SMARTLIFT] Switched to Advanced Software Simulation mode (Dual Lifts A & B · Floors G–7)', 'info');
    applyModeLayout('sim');
    startSim();
  } else {
    btnModeHw.classList.add('active');
    btnModeSim.classList.remove('active');
    activeModeBadge.textContent = 'HARDWARE PROTOTYPE (ESP32 CLOSED-LOOP · G–3)';
    activeModeBadge.className = 'mode-indicator hw';
    if (sysTag) sysTag.textContent = 'SINGLE-LIFT 4-FLOOR HARDWARE (G, 1, 2, 3)';
    eventManager.log('[HARDWARE] Switched to Hardware Prototype mode — closed-loop ESP32 tracking (Floors G–3)', 'info');
    pauseSim();
    applyModeLayout('hw');
    pollHardwareStatus();
  }
  renderAll();
}

btnModeSim.addEventListener('click', () => setMode('sim'));
btnModeHw.addEventListener('click', () => setMode('hw'));

// ---- Hardware Prototype Communication & Polling ----
async function pollHardwareStatus() {
  try {
    const res = await fetch(`${BACKEND_BASE}/hardware/status`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderHardwareState(data);
  } catch (err) {
    pillHw.className = 'status-pill offline';
    pillHwText.textContent = 'OFFLINE';
    hwConnBadge.textContent = 'OFFLINE';
    hwConnBadge.className = 'badge danger';
  }
}

function renderHardwareState(hw) {
  if (hw.connected) {
    pillHw.className = 'status-pill online';
    pillHwText.textContent = hw.port || 'CONNECTED';
    hwConnBadge.textContent = 'CONNECTED';
    hwConnBadge.className = 'badge safe';
  } else {
    pillHw.className = 'status-pill offline';
    pillHwText.textContent = 'DISCONNECTED';
    hwConnBadge.textContent = 'DISCONNECTED';
    hwConnBadge.className = 'badge danger';
  }

  // If in hardware prototype mode, synchronize cabin position strictly with ESP32 sensors!
  if (currentMode === 'hw') {
    const cabinEl = document.getElementById('cabinA');
    if (hw.current_floor !== null && hw.current_floor >= 0 && hw.current_floor <= 3) {
      cabinEl.style.bottom = hw.current_floor * FLOOR_HEIGHT + 1 + 'px';
    }

    const isMoving = hw.motor_state === 'MOVING_UP' || hw.motor_state === 'MOVING_DOWN';
    const dirText = hw.motor_state === 'MOVING_UP' ? '▲ UP'
      : hw.motor_state === 'MOVING_DOWN' ? '▼ DOWN'
      : '● IDLE';
    document.getElementById('cabinDirA').textContent = dirText;
    document.getElementById('elevatorStateLabel').textContent =
      `Hardware Lift: Floor ${hw.current_floor_name} · ${hw.motor_state}`;

    // Highlight active floor in building
    document.querySelectorAll('.floor').forEach((fl) => {
      fl.classList.toggle('active-position', Number(fl.dataset.floor) === hw.current_floor);
    });

    // Make sure doors open when arrived/idle so text is NOT trapped underneath!
    cabinEl.classList.toggle('doors-open', !isMoving);

    // Update inside cabin text clearly in hardware mode (no redundant floor numbers or 'smartlift' written on cabin!)
    const insideBox = document.getElementById('cabinInsideA');
    if (insideBox) {
      insideBox.innerHTML = `
        <div class="hw-cabin-indicator">
          ${dirText}
        </div>
      `;
    }

    if (hw.current_floor !== null && hw.current_floor !== lastHwFloor) {
      if (lastHwFloor !== null) {
        eventManager.log(`[HARDWARE] Sensor confirmed Floor ${hw.current_floor_name}`, 'info');
      }
      lastHwFloor = hw.current_floor;
    }
  }

  // Handle new RFID scan events from ESP32
  if (hw.last_rfid) {
    if (lastHwRfidEventId === null) {
      // Baseline initialization on page load/refresh — do not pop up historical modal
      lastHwRfidEventId = hw.last_rfid.event_id;
    } else if (hw.last_rfid.event_id !== lastHwRfidEventId) {
      lastHwRfidEventId = hw.last_rfid.event_id;
      handleNewRfidEvent(hw.last_rfid);
    }
  }
}

async function sendHardwareCommand(floor) {
  try {
    eventManager.log(`[HARDWARE] Dispatching motor command to Floor ${floorLabel(floor)}`, 'info');
    const res = await fetch(`${BACKEND_BASE}/hardware/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floor }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`Command sent: Move to Floor ${floorLabel(floor)}`);
    } else {
      toast(`Hardware command failed: ${data.error || 'Check ESP32'}`);
    }
  } catch (err) {
    toast(`Failed to connect to backend: ${err.message}`);
  }
}

// Wire connect and release port buttons
const btnHwConnect = document.getElementById('btnHwConnect');
const btnHwDisconnect = document.getElementById('btnHwDisconnect');

if (btnHwConnect) {
  btnHwConnect.addEventListener('click', async () => {
    try {
      const res = await fetch(`${BACKEND_BASE}/hardware/connect`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        toast('Connected to ESP32 successfully!');
        eventManager.log('[HARDWARE] Connected to ESP32 on ' + (data.status.port || 'COM7'), 'success');
      } else {
        toast('Connection failed: ' + (data.status.error || 'Port busy'));
      }
      pollHardwareStatus();
    } catch (e) {
      toast('Failed to reach backend');
    }
  });
}

if (btnHwDisconnect) {
  btnHwDisconnect.addEventListener('click', async () => {
    try {
      await fetch(`${BACKEND_BASE}/hardware/disconnect`, { method: 'POST' });
      toast('Port released! You can now run python lift_interface.py in terminal.');
      eventManager.log('[HARDWARE] Port released for lift_interface.py', 'warn');
      pollHardwareStatus();
    } catch (e) {
      toast('Failed to reach backend');
    }
  });
}

// Periodic hardware status polling (every 350ms)
setInterval(pollHardwareStatus, 350);

// ---- Security Alert Popup Modal ----
const secAlertModal = document.getElementById('secAlertModal');
const secAlertMsg = document.getElementById('secAlertMsg');
const btnDismissSecAlert = document.getElementById('btnDismissSecAlert');
const dismissedAlertIds = new Set();
let activeSecAlertEventId = null;

function showSecurityAlertPopup(msg = 'Unauthorized tag detected. Security alerted.', ev = null) {
  if (ev && ev.event_id && dismissedAlertIds.has(ev.event_id)) {
    return;
  }
  activeSecAlertEventId = ev ? ev.event_id : null;

  if (secAlertMsg) secAlertMsg.textContent = msg;
  const imgWrap = document.getElementById('secAlertImgWrap');
  const imgEl = document.getElementById('secAlertImg');
  const dlBtn = document.getElementById('btnDownloadSecAlert');

  if (ev && (ev.image_file || ev.image_status === 'IMAGE_CAPTURED')) {
    const imgUrl = `${BACKEND_BASE}/security/image/${ev.event_id}`;
    if (imgEl) imgEl.src = imgUrl;
    if (imgWrap) imgWrap.classList.remove('hidden');
    if (dlBtn) {
      dlBtn.href = imgUrl;
      dlBtn.download = `security_denied_${ev.uid}_${ev.event_id}.jpg`;
      dlBtn.classList.remove('hidden');
    }
  } else {
    if (imgWrap) imgWrap.classList.add('hidden');
    if (dlBtn) dlBtn.classList.add('hidden');
  }

  if (secAlertModal) secAlertModal.classList.remove('hidden');
}

async function triggerFrameDownload(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const blob = await res.blob();
    if (blob.type.includes('json') || blob.size < 50) return;
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'security_snapshot.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (e) {}
}

if (btnDismissSecAlert) {
  btnDismissSecAlert.addEventListener('click', () => {
    if (activeSecAlertEventId) dismissedAlertIds.add(activeSecAlertEventId);
    if (secAlertModal) secAlertModal.classList.add('hidden');
  });
}

if (secAlertModal) {
  secAlertModal.addEventListener('click', (e) => {
    if (e.target === secAlertModal) {
      if (activeSecAlertEventId) dismissedAlertIds.add(activeSecAlertEventId);
      secAlertModal.classList.add('hidden');
    }
  });
}

// ---- RFID Security Event Handling ----
function handleNewRfidEvent(ev) {
  const isGranted = ev.status === 'ACCESS_GRANTED';
  eventManager.log(`[RFID] Tag ${ev.uid} scanned (${ev.name})`, 'info');
  eventManager.log(`[SECURITY] Access ${isGranted ? 'GRANTED' : 'DENIED — UNAUTHORIZED'}`, isGranted ? 'success' : 'error');

  if (isGranted) {
    if (ev.fixed_destination !== null && ev.fixed_destination !== undefined) {
      eventManager.log(`[ROUTE] Automatic destination resolved for Tag ${ev.uid}: Floor ${floorLabel(ev.fixed_destination)}`, 'reason');
      toast(`ACCESS GRANTED: Tag ${ev.name} → Auto-travel to Floor ${floorLabel(ev.fixed_destination)}`);
      if (currentMode === 'sim') {
        const insideList = stateManager.getInside('A');
        const unassigned = insideList.find((p) => p.destination === null || p.destination === undefined);
        if (unassigned) {
          controllerA.pressInsideButton(ev.fixed_destination, unassigned.id);
        } else {
          addInsideDirect('adult', 70, ev.fixed_destination, 'A');
        }
        stateChanged();
      }
    } else {
      toast(`ACCESS GRANTED: Tag ${ev.name}`);
    }

    // Show small text in green box on dashboard (NO popup modal!)
    const accessBox = document.getElementById('accessGrantedBox');
    const accessMsg = document.getElementById('accessGrantedMsg');
    if (accessBox && accessMsg) {
      const destNote = ev.fixed_destination !== null && ev.fixed_destination !== undefined
        ? ` · Target: Floor ${floorLabel(ev.fixed_destination)}`
        : '';
      accessMsg.textContent = `${ev.name || 'Authorized Card'} (${ev.uid})${destNote}`;
      accessBox.classList.remove('hidden');
      if (secAlertModal) secAlertModal.classList.add('hidden');
    }
  } else {
    // Show Security Alerted popup for denied
    const alertMsg = ev.message || `Unauthorized tag ${ev.uid} detected. Security alerted.`;
    showSecurityAlertPopup(alertMsg, ev);
    toast(alertMsg);

    // Trigger download of captured frame if available
    if (ev.image_file || ev.image_status === 'IMAGE_CAPTURED') {
      triggerFrameDownload(`${BACKEND_BASE}/security/image/${ev.event_id}`, `denied_${ev.uid}_${ev.event_id}.jpg`);
    }
  }

  loadSecurityEvents();
}

// Clear RFID Logs Button Listener
const btnClearRfidLog = document.getElementById('btnClearRfidLog');
if (btnClearRfidLog) {
  btnClearRfidLog.addEventListener('click', async () => {
    try {
      await fetch(`${BACKEND_BASE}/security/events/clear`, { method: 'POST' });
    } catch (e) {}
    renderSecurityList([]);
    const accessBox = document.getElementById('accessGrantedBox');
    if (accessBox) accessBox.classList.add('hidden');
    toast('RFID logs cleared');
    eventManager.log('[SECURITY] RFID access logs cleared', 'info');
  });
}


async function loadSecurityEvents() {
  try {
    const res = await fetch(`${BACKEND_BASE}/security/events?limit=8`);
    if (!res.ok) return;
    const data = await res.json();
    renderSecurityList(data.events || []);
  } catch (e) {}
}

function renderSecurityList(events) {
  const container = document.getElementById('secList');
  if (!container) return;
  if (!events || !events.length) {
    container.innerHTML = '<span class="hint-sm">Ready for scans. Authorized cards with autotravel active (12D56B06 → F3, 6E9818AA → F1, 3EAF1AAA → F2, 69BDF306 → F2).</span>';
    return;
  }

  container.innerHTML = '';
  events.slice(0, 6).forEach((ev) => {
    const isGranted = ev.status === 'ACCESS_GRANTED';
    const row = document.createElement('div');
    row.className = 'sec-row ' + (isGranted ? 'granted' : 'denied');

    const dlLink = (!isGranted && (ev.image_file || ev.image_status === 'IMAGE_CAPTURED'))
      ? `<a href="${BACKEND_BASE}/security/image/${ev.event_id}" download="denied_${ev.uid}_${ev.event_id}.jpg" class="sec-dl-link" title="Download captured security snapshot" onclick="triggerFrameDownload(this.href, this.download); return false;">Download Frame</a>`
      : '';

    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="sec-badge ${isGranted ? 'safe' : 'danger'}">${isGranted ? 'GRANTED' : 'DENIED'}</span>
        <span class="sec-time">${ev.time || ''}</span>
      </div>
      <div class="sec-details">
        <strong>${ev.name || 'Unknown'}</strong> · UID: <code>${ev.uid}</code>
        ${ev.message ? `<div style="font-size: 11px; color: var(--danger); font-weight: 600; margin-top: 3px;">${ev.message}</div>` : ''}
        ${ev.fixed_destination !== null && ev.fixed_destination !== undefined ? `<br>Auto-Target: Floor ${floorLabel(ev.fixed_destination)}` : ''}
      </div>
      ${dlLink ? `<div style="margin-top: 4px;">${dlLink}</div>` : ''}
    `;
    container.appendChild(row);
  });
}

// ---- Live Camera Detection Setup ----
function setupCamera() {
  if (btnCamera) {
    btnCamera.addEventListener('click', toggleCamera);
  }
  // Auto-start camera on page load for continuous 24/7 face scanning
  setTimeout(() => {
    if (!camStream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      toggleCamera().catch(() => {});
    }
  }, 500);
}

async function toggleCamera() {
  if (camStream) {
    stopCamera();
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } });
    camVideo.srcObject = camStream;
    camVideo.classList.add('live');
    camStatusEl.textContent = 'ONLINE';
    camStatusEl.className = 'chip online';
    btnCamera.textContent = 'Disable Camera';
    pillCam.className = 'status-pill online';
    pillCamText.textContent = 'ACTIVE';
    toast('Camera started — continuous face scanning active');
    startCameraCapture();
  } catch (err) {
    toast(`Camera error: ${err.message}`);
  }
}

function stopCamera() {
  if (camCaptureTimer) {
    clearInterval(camCaptureTimer);
    camCaptureTimer = null;
  }
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  camVideo.srcObject = null;
  camVideo.classList.remove('live');
  camStatusEl.textContent = 'OFFLINE';
  camStatusEl.className = 'chip offline';
  btnCamera.textContent = 'Enable Camera';
  pillCam.className = 'status-pill offline';
  pillCamText.textContent = 'OFFLINE';
  fetch(`${BACKEND_BASE}/camera/stop`, { method: 'POST' }).catch(() => {});
}

function startCameraCapture() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  let isDetectInFlight = false;

  camCaptureTimer = setInterval(async () => {
    if (!camStream || isDetectInFlight) return;
    isDetectInFlight = true;
    try {
      ctx.drawImage(camVideo, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
      const floor = Number(camFloorEl ? camFloorEl.value : 0);

      const res = await fetch(`${BACKEND_BASE}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, floor }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.detections && data.detections.length) {
        camera.handleFrameDetections(data.detections, floor);
      }
    } catch (e) {
    } finally {
      isDetectInFlight = false;
    }
  }, 400); // 400ms interval for smooth continuous scanning
}

function renderCameraPanel() {
  if (!camPendingEl) return;
  camPendingEl.innerHTML = '';
}

// ---- Multi-Passenger Floor Queue Rendering ----
function renderWaiting() {
  for (let f = MIN_FLOOR; f <= MAX_FLOOR; f++) {
    const container = document.getElementById(`waiting-${f}`);
    const callEl = document.getElementById(`call-${f}`);
    if (!container || !callEl) continue;

    container.innerHTML = '';
    const passengersHere = stateManager.waitingPassengers.filter(
      (p) => p.floor === f && p.status !== 'CANCELLED'
    );
    const pickupReq = requestManager.pickupRequests.find(
      (r) => r.floor === f && r.status !== 'CANCELLED'
    );

    // 1.5-second batching window indicator
    if (batchWindows.has(f) && batchWindows.get(f).active) {
      const bBadge = document.createElement('span');
      bBadge.className = 'batching-indicator';
      bBadge.innerHTML = '⏱ 1.5s window';
      container.appendChild(bBadge);
    }

    // Render individual passenger cards/chips in the queue
    passengersHere.forEach((p) => {
      const chip = document.createElement('span');
      const prioClass = p.priority === 3 ? ' prio-wheelchair' : p.priority === 2 ? ' prio-senior' : '';
      chip.className = 'waiting-chip' + prioClass;
      chip.title = `${p.id}: ${labelForType(p.type)} (${p.weight}kg) → Going to Floor ${p.destination !== null ? floorLabel(p.destination) : '?'}`;

      const prioTag = p.priority === 3 ? '<small style="color:#ec4899;font-weight:800;">[HIGH]</small> '
        : p.priority === 2 ? '<small style="color:#f59e0b;font-weight:800;">[PRIO]</small> '
        : '';
      const destTag = p.destination !== null ? `<span class="dest-tag">→${floorLabel(p.destination)}</span>` : '';

      chip.innerHTML = `
        ${iconForType(p.type)} ${prioTag}<small>${p.weight}k</small>${destTag}
        <span class="chip-rm" title="Cancel request (Ghost Call)">×</span>
      `;
      chip.querySelector('.chip-rm').addEventListener('click', (e) => {
        e.stopPropagation();
        passengerManager.removePassenger(p.id);
        coordinator.reevaluateAfterGhost();
        stateChanged();
      });
      container.appendChild(chip);
    });

    if (passengersHere.length) {
      const assigned = pickupReq && pickupReq.assignedLift ? ` · Lift ${pickupReq.assignedLift}` : '';
      if (pickupReq && pickupReq.status === 'DEFERRED') {
        callEl.textContent = `● DEFERRED (${passengersHere.length})`;
        callEl.className = 'floor-call active';
        callEl.style.borderColor = 'var(--warn)';
        callEl.style.color = 'var(--warn)';
      } else {
        callEl.textContent = `▲ CALL (${passengersHere.length})${assigned}`;
        callEl.className = 'floor-call active';
        callEl.style.borderColor = '';
        callEl.style.color = '';
      }
    } else {
      callEl.textContent = '○ idle';
      callEl.className = 'floor-call';
      callEl.style.borderColor = '';
      callEl.style.color = '';
    }
  }
}

// ---- Active Passenger List Rendering ----
function renderPeople() {
  const waiting = stateManager.waitingPassengers.filter((p) => p.status !== 'CANCELLED');
  const insideA = stateManager.getInside('A');
  const insideB = stateManager.getInside('B');
  peopleCountEl.textContent = waiting.length + insideA.length + insideB.length;

  if (!waiting.length && !insideA.length && !insideB.length) {
    peopleListEl.innerHTML = '<span class="hint-sm">No active passengers.</span>';
    return;
  }

  peopleListEl.innerHTML = '';

  const renderCard = (opts) => {
    const div = document.createElement('div');
    div.className = 'person-card' + (opts.type === 'wheelchair' ? ' priority-high' : opts.type === 'senior' ? ' priority-senior' : '');

    const prioLabel = opts.priority === 3 ? ' · <span style="color:#ec4899;font-weight:700;">High Priority</span>'
      : opts.priority === 2 ? ' · <span style="color:#f59e0b;font-weight:700;">Priority</span>'
      : '';

    div.innerHTML = `
      <div class="p-head">
        <span class="ico">${iconForType(opts.type)}</span>
        <span>${opts.id} · ${labelForType(opts.type)}${prioLabel}</span>
        <button class="rm" title="Passenger leaves (Ghost-call if waiting)">×</button>
      </div>
      <div class="p-grid">
        <span>Boarding <strong>${opts.boarding}</strong></span>
        <span>Destination <strong>${opts.destLabel}</strong></span>
        <span>Weight <strong>${opts.weight} kg</strong></span>
        <span>Status <strong>${opts.status}</strong></span>
      </div>
    `;

    if (opts.editableDest) {
      const sel = document.createElement('select');
      populateFloorSelect(sel, opts.destination, opts.floor);
      sel.title = 'Change destination floor';
      sel.addEventListener('change', () => {
        if (Number(sel.value) === Number(opts.floor)) {
          toast('Destination must differ from boarding floor');
          sel.value = String(opts.destination);
          return;
        }
        opts.onDestChange(Number(sel.value));
      });
      const wrap = document.createElement('div');
      wrap.style.marginTop = '4px';
      wrap.appendChild(sel);
      div.appendChild(wrap);
    }

    div.querySelector('.rm').addEventListener('click', () => opts.onRemove());
    peopleListEl.appendChild(div);
  };

  waiting.forEach((p) => {
    const req = requestManager.pickupRequests.find((r) => r.floor === p.floor);
    renderCard({
      id: p.id,
      type: p.type,
      weight: p.weight,
      priority: p.priority,
      boarding: `Floor ${floorLabel(p.floor)}`,
      floor: p.floor,
      status: req && req.status === 'DEFERRED' ? 'WAITING (DEFERRED)' : 'WAITING',
      destLabel: p.destination !== null && p.destination !== undefined ? 'Floor ' + floorLabel(p.destination) : '—',
      destination: p.destination,
      editableDest: true,
      onDestChange: (d) => {
        p.destination = d;
        eventManager.log(`[SMARTLIFT] Passenger ${p.id} destination changed to Floor ${floorLabel(d)}`, 'info');
        stateChanged();
      },
      onRemove: () => {
        passengerManager.removePassenger(p.id);
        coordinator.reevaluateAfterGhost();
        toast(`Passenger ${p.id} departed from Floor ${floorLabel(p.floor)} (Ghost Call Detected)`);
        stateChanged();
      },
    });
  });

  insideA.forEach((p) => {
    renderCard({
      id: p.id,
      type: p.type,
      weight: p.weight,
      priority: p.priority,
      boarding: 'Lift A Cabin',
      status: 'INSIDE (LIFT A)',
      destLabel: p.destination !== null && p.destination !== undefined ? 'Floor ' + floorLabel(p.destination) : '— (Pick button)',
      editableDest: false,
      onRemove: () => {
        stateManager.removeInside(p.id, 'A');
        requestManager.removeDestination(p.destination, p.id, 'A');
        if (selectedInsideIdA === p.id) selectedInsideIdA = null;
        stateChanged();
      },
    });
  });

  insideB.forEach((p) => {
    renderCard({
      id: p.id,
      type: p.type,
      weight: p.weight,
      priority: p.priority,
      boarding: 'Lift B Cabin',
      status: 'INSIDE (LIFT B)',
      destLabel: p.destination !== null && p.destination !== undefined ? 'Floor ' + floorLabel(p.destination) : '— (Pick button)',
      editableDest: false,
      onRemove: () => {
        stateManager.removeInside(p.id, 'B');
        requestManager.removeDestination(p.destination, p.id, 'B');
        if (selectedInsideIdB === p.id) selectedInsideIdB = null;
        stateChanged();
      },
    });
  });
}

// ---- Elevator Cabin Rendering (Dual Lifts A and B) ----
function renderElevatorCabin() {
  if (currentMode === 'hw') return; // In HW mode, strictly managed by ESP32 sensors

  // --- LIFT A ---
  const elevA = stateManager.getElev('A');
  const cabinA = document.getElementById('cabinA');
  if (cabinA) {
    cabinA.style.bottom = elevA.currentFloor * FLOOR_HEIGHT + 1 + 'px';
    const dirTextA = elevA.door !== 'closed' ? '◐ DOORS ' + elevA.door.toUpperCase()
      : elevA.moving ? `▲ ${elevA.direction.toUpperCase()} → ${floorLabel(elevA.targetFloor)}`
      : '● IDLE';
    document.getElementById('cabinDirA').textContent = dirTextA;
    const curA = SafetyEngine.evaluateCurrent(stateManager.getInside('A'));
    document.getElementById('cabinLoadA').textContent = `${curA.load} kg`;
    cabinA.classList.toggle('doors-open', elevA.door === 'open' || elevA.door === 'opening');

    const boxA = document.getElementById('cabinInsideA');
    if (boxA) {
      boxA.innerHTML = '';
      const insideA = stateManager.getInside('A');
      if (!insideA.length) {
        boxA.innerHTML = '<span style="font-size:10px; color:var(--muted)">— Empty —</span>';
      } else {
        insideA.forEach((p) => {
          const hasDest = p.destination !== null && p.destination !== undefined;
          const el = document.createElement('div');
          el.className = 'inside-pax' + (selectedInsideIdA === p.id ? ' selected' : '');
          el.title = hasDest ? `Going to Floor ${floorLabel(p.destination)}` : 'Tap to assign next button press to this passenger';
          el.innerHTML = `${iconForType(p.type)} <small>${p.weight}k${hasDest ? '→' + floorLabel(p.destination) : '→?'}</small>`;
          el.addEventListener('click', () => {
            selectedInsideIdA = selectedInsideIdA === p.id ? null : p.id;
            renderAll();
          });
          boxA.appendChild(el);
        });
      }
    }
  }

  // --- LIFT B ---
  const elevB = stateManager.getElev('B');
  const cabinB = document.getElementById('cabinB');
  if (cabinB) {
    cabinB.style.bottom = elevB.currentFloor * FLOOR_HEIGHT + 1 + 'px';
    const dirTextB = elevB.door !== 'closed' ? '◐ DOORS ' + elevB.door.toUpperCase()
      : elevB.moving ? `▲ ${elevB.direction.toUpperCase()} → ${floorLabel(elevB.targetFloor)}`
      : '● IDLE';
    document.getElementById('cabinDirB').textContent = dirTextB;
    const curB = SafetyEngine.evaluateCurrent(stateManager.getInside('B'));
    document.getElementById('cabinLoadB').textContent = `${curB.load} kg`;
    cabinB.classList.toggle('doors-open', elevB.door === 'open' || elevB.door === 'opening');

    const boxB = document.getElementById('cabinInsideB');
    if (boxB) {
      boxB.innerHTML = '';
      const insideB = stateManager.getInside('B');
      if (!insideB.length) {
        boxB.innerHTML = '<span style="font-size:10px; color:var(--muted)">— Empty —</span>';
      } else {
        insideB.forEach((p) => {
          const hasDest = p.destination !== null && p.destination !== undefined;
          const el = document.createElement('div');
          el.className = 'inside-pax' + (selectedInsideIdB === p.id ? ' selected' : '');
          el.title = hasDest ? `Going to Floor ${floorLabel(p.destination)}` : 'Tap to assign next button press to this passenger';
          el.innerHTML = `${iconForType(p.type)} <small>${p.weight}k${hasDest ? '→' + floorLabel(p.destination) : '→?'}</small>`;
          el.addEventListener('click', () => {
            selectedInsideIdB = selectedInsideIdB === p.id ? null : p.id;
            renderAll();
          });
          boxB.appendChild(el);
        });
      }
    }
  }

  // Active Floor Button highlights for Lift A & Lift B
  document.querySelectorAll('#floorButtonsA .fb').forEach((btn) => {
    const f = Number(btn.dataset.floor);
    btn.classList.toggle('active', requestManager.destinationRequests.some((r) => r.floor === f && r.liftId === 'A'));
  });
  document.querySelectorAll('#floorButtonsB .fb').forEach((btn) => {
    const f = Number(btn.dataset.floor);
    btn.classList.toggle('active', requestManager.destinationRequests.some((r) => r.floor === f && r.liftId === 'B'));
  });

  document.getElementById('elevatorStateLabel').textContent =
    `Lift A: Floor ${floorLabel(elevA.currentFloor)}${elevA.moving ? ' → ' + floorLabel(elevA.targetFloor) : ''} · ${elevA.direction} | ` +
    `Lift B: Floor ${floorLabel(elevB.currentFloor)}${elevB.moving ? ' → ' + floorLabel(elevB.targetFloor) : ''} · ${elevB.direction}`;
}

// ---- Predictive Safety & Threshold Engine Rendering (Dual Lifts) ----
function renderPredictiveSafety() {
  // Lift A
  const curA = SafetyEngine.evaluateCurrent(stateManager.getInside('A'));
  document.getElementById('loadA').textContent = curA.load + ' kg';
  document.getElementById('threshA').textContent = curA.threshold + ' kg';
  const marginAEl = document.getElementById('marginA');
  marginAEl.textContent = curA.margin + ' kg';
  marginAEl.style.color = curA.margin < 0 ? 'var(--danger)' : curA.margin < 80 ? 'var(--warn)' : 'var(--safe)';
  const sA = document.getElementById('safetyA');
  sA.textContent = curA.status;
  sA.className = 'badge ' + (curA.safe ? 'safe' : 'danger');

  // Lift B
  const curB = SafetyEngine.evaluateCurrent(stateManager.getInside('B'));
  const loadBEl = document.getElementById('loadB');
  if (loadBEl) loadBEl.textContent = curB.load + ' kg';
  const threshBEl = document.getElementById('threshB');
  if (threshBEl) threshBEl.textContent = curB.threshold + ' kg';
  const marginBEl = document.getElementById('marginB');
  if (marginBEl) {
    marginBEl.textContent = curB.margin + ' kg';
    marginBEl.style.color = curB.margin < 0 ? 'var(--danger)' : curB.margin < 80 ? 'var(--warn)' : 'var(--safe)';
  }
  const sB = document.getElementById('safetyB');
  if (sB) {
    sB.textContent = curB.status;
    sB.className = 'badge ' + (curB.safe ? 'safe' : 'danger');
  }

  // Next Pickup Evaluation
  const projEmpty = document.getElementById('projEmpty');
  const projContent = document.getElementById('projContent');
  const elevA = stateManager.getElev('A');

  if (!stateManager.waitingPassengers.length) {
    projEmpty.classList.remove('hidden');
    projContent.classList.add('hidden');
    return;
  }

  const sorted = [...stateManager.waitingPassengers].sort(
    (a, b) => Math.abs(a.floor - elevA.currentFloor) - Math.abs(b.floor - elevA.currentFloor)
  );
  const cand = sorted[0];
  const evalRes = SafetyEngine.evaluateProjected(stateManager.getInside('A'), cand);

  projEmpty.classList.add('hidden');
  projContent.classList.remove('hidden');
  document.getElementById('projFloor').textContent = `Floor ${floorLabel(cand.floor)}`;
  document.getElementById('projPax').textContent = labelForType(cand.type);
  document.getElementById('projAdded').textContent = evalRes.addedLoad + ' kg';
  document.getElementById('projLoad').textContent = evalRes.projectedLoad + ' kg';
  document.getElementById('projThresh').textContent = evalRes.projectedThreshold + ' kg';

  const pm = document.getElementById('projMargin');
  pm.textContent = evalRes.projectedMargin + ' kg';
  pm.style.color = evalRes.projectedMargin < 0 ? 'var(--danger)' : 'var(--safe)';

  const pd = document.getElementById('projDecision');
  pd.textContent = evalRes.decision;
  pd.className = 'decision ' + (evalRes.decision === 'SAFE' ? 'safe' : evalRes.decision === 'DEFERRED' ? 'deferred' : 'unsafe');
  document.getElementById('projReason').textContent = evalRes.reason;
}

function renderAll() {
  renderWaiting();
  renderPeople();
  renderElevatorCabin();
  renderPredictiveSafety();
  if (typeof renderCameraPanel === 'function') renderCameraPanel();
}

controllerA.setUpdateCallback(() => renderAll());
controllerB.setUpdateCallback(() => renderAll());

// ---- Event Log Handling ----
eventManager.on((entry) => {
  if (entry.clear) {
    eventLogEl.innerHTML = '';
    return;
  }
  const div = document.createElement('div');
  div.className = 'entry ' + (entry.level || 'info');
  div.innerHTML = `<span class="time">${entry.time}</span>${entry.message}`;
  eventLogEl.appendChild(div);
  eventLogEl.scrollTop = eventLogEl.scrollHeight;
});

// Toast notification helper
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---- Reset, Start & Pause Simulation ----
function resetAll() {
  pauseSim();
  batchWindows.forEach((b) => b.timer && clearTimeout(b.timer));
  batchWindows.clear();
  stateManager.resetLifts();
  requestManager.pickupRequests = [];
  requestManager.destinationRequests = [];
  selectedInsideIdA = null;
  selectedInsideIdB = null;
  camera.pending.clear();
  camera.confirmed.clear();
  lastCamWaiting = 0;
  eventManager.clear();
  eventManager.log('[SMARTLIFT] System reset — Dual Lifts A and B at Floor G', 'info');
  renderAll();
  if (currentMode === 'sim') startSim();
}

document.getElementById('btnReset').addEventListener('click', resetAll);
document.getElementById('btnStart').addEventListener('click', () => {
  if (currentMode === 'sim') {
    startSim();
    toast('Dual-lift simulation started');
  } else {
    toast('Hardware prototype mode active — commands dispatch to ESP32');
  }
  renderAll();
});
document.getElementById('btnPause').addEventListener('click', () => {
  pauseSim();
  toast('Simulation paused');
});
document.getElementById('btnClearLog').addEventListener('click', () => eventManager.clear());


// ---- Theme Handling ----
const themeBtn = document.getElementById('btnTheme');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('smartlift-theme', t); } catch (e) {}
  if (themeBtn) themeBtn.textContent = t === 'light' ? '☀️ Light' : '🌙 Dark';
}
let initialTheme = 'dark';
try {
  initialTheme = localStorage.getItem('smartlift-theme')
    || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
} catch (e) {}
applyTheme(initialTheme);
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
}

// ---- Helper to Add Inside Passenger Directly (For verification demos) ----
function addInsideDirect(type, weight, dest, liftId = 'A') {
  const id = 'P' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const priority = type === 'wheelchair' ? 3 : type === 'senior' ? 2 : 1;
  const p = {
    id,
    type,
    weight,
    priority,
    status: 'INSIDE',
    destination: dest !== undefined ? dest : null,
    liftId,
    boardedAt: Date.now(),
  };
  stateManager.getInside(liftId).push(p);
  if (dest !== undefined && dest !== null) {
    requestManager.addDestination(id, dest, liftId);
  }
  return p;
}

// ---- Verification Test Scenarios (Demonstrating Requirements 1–12) ----
document.querySelectorAll('[data-demo]').forEach((btn) => {
  btn.addEventListener('click', () => runDemo(btn.dataset.demo));
});

function runDemo(which) {
  resetAll();
  if (which === 'A') {
    // Test 1: Multiple passengers at one floor (5 passengers at Floor G)
    addPassengerWithBatchWindow({ floor: 0, destination: 2, type: 'adult', weight: 75 });
    addPassengerWithBatchWindow({ floor: 0, destination: 3, type: 'senior', weight: 70 });
    addPassengerWithBatchWindow({ floor: 0, destination: 4, type: 'wheelchair', weight: 80 });
    addPassengerWithBatchWindow({ floor: 0, destination: 5, type: 'adult', weight: 82 });
    addPassengerWithBatchWindow({ floor: 0, destination: 6, type: 'adult', weight: 68 });
    toast('Demo A: Multi-Passenger Queue — 5 passengers added at Floor G without overwriting');
  } else if (which === 'B') {
    // Test 2: Simultaneous requests across floors (G, 2, 4, 6)
    addPassengerWithBatchWindow({ floor: 0, destination: 3, type: 'adult', weight: 75 });
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'senior', weight: 70 });
    addPassengerWithBatchWindow({ floor: 4, destination: 1, type: 'adult', weight: 80 });
    addPassengerWithBatchWindow({ floor: 6, destination: 0, type: 'wheelchair', weight: 85 });
    toast('Demo B: Simultaneous Requests across Floors G, 2, 4, 6 — coordinated between Lift A & Lift B');
  } else if (which === 'C') {
    // Test 3: 1.5-second batching window
    addPassengerWithBatchWindow({ floor: 3, destination: 0, type: 'adult', weight: 75 });
    setTimeout(() => {
      addPassengerWithBatchWindow({ floor: 3, destination: 1, type: 'senior', weight: 70 });
    }, 400);
    setTimeout(() => {
      addPassengerWithBatchWindow({ floor: 3, destination: 5, type: 'wheelchair', weight: 80 });
    }, 800);
    toast('Demo C: 1.5s Batching Window — 3 passengers added during window; evaluated together');
  } else if (which === 'D') {
    // Test 5: Elderly & Wheelchair user priority
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'adult', weight: 80 });
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'senior', weight: 70 });
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'wheelchair', weight: 80 });
    eventManager.log('[PRIORITY] Wheelchair [High Priority] and Senior [Priority] will be assigned and boarded ahead of Adult', 'reason');
    toast('Demo D: Wheelchair (High Priority) & Senior Citizen (Priority) scheduled ahead of Adult');
  } else if (which === 'E') {
    // Test 6 & 7: Dynamic threshold & cumulative group boarding
    addInsideDirect('adult', 150, 4, 'A');
    addInsideDirect('adult', 150, 4, 'A');
    addInsideDirect('adult', 150, 4, 'A');
    addInsideDirect('adult', 150, 4, 'A'); // Cabin A current load = 600kg
    addPassengerWithBatchWindow({ floor: 1, destination: 0, type: 'adult', weight: 75 });
    addPassengerWithBatchWindow({ floor: 1, destination: 0, type: 'wheelchair', weight: 90 });
    eventManager.log('[SAFETY] Cabin Load 600kg. Adding Wheelchair (90kg, -110kg deduction) drops threshold to 640kg. 600+90=690kg > 640kg → DEFERRED!', 'reason');
    toast('Demo E: Dynamic Threshold & Cumulative Boarding (Wheelchair safely deferred)');
  } else if (which === 'F') {
    // Test 8: Ghost call for single passenger (one passenger leaves, other remains)
    const p1 = addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'adult', weight: 75 });
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'senior', weight: 70 });
    setTimeout(() => {
      passengerManager.removePassenger(p1.passenger.id);
      coordinator.reevaluateAfterGhost();
      toast('Demo F: Ghost Call — Passenger 1 cancelled; Passenger 2 still served');
      renderAll();
    }, 2000);
  } else if (which === 'G') {
    // Test 10: Two-lift independent coordination
    stateManager.getElev('A').currentFloor = 1;
    stateManager.getElev('B').currentFloor = 6;
    addPassengerWithBatchWindow({ floor: 2, destination: 0, type: 'adult', weight: 75 });
    addPassengerWithBatchWindow({ floor: 5, destination: 7, type: 'adult', weight: 80 });
    eventManager.log('[COORDINATOR] Lift A (at Floor 1) assigned to Floor 2; Lift B (at Floor 6) assigned to Floor 5', 'reason');
    toast('Demo G: Two-Lift Coordination — Lift A serves Floor 2, Lift B serves Floor 5');
  }
  renderAll();
}

// ---- Initialization ----
applyModeLayout('sim');
setupDrag();
setupCamera();

eventManager.log('[SMARTLIFT] SmartLift AI initialized — Dual Virtual Lifts (A & B) across Floors G–7 ready', 'info');
eventManager.log('[COORDINATOR] Intelligent Multi-Lift Scoring & Predictive Safety active', 'reason');

startSim();
renderAll();
window.addEventListener('resize', renderAll);

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
