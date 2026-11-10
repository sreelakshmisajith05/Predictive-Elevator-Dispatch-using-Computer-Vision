/**
 * StateManager — single source of truth (dual-lift aware).
 *
 * Preserves ALL original Phase 1 passenger/load/threshold intelligence.
 * Extension for 50% review: two elevators (A + B) sharing one waiting pool,
 * each with its own cabin state and inside-passenger list.
 *
 * Waiting passengers carry BOTH boarding floor (drop location) and
 * destination (user-selected dropdown). Core never lets the user drive
 * the route — controllers + coordinator decide.
 */
import { eventManager } from './EventManager.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

const PASSENGER_STATES = [
  'WAITING', 'PICKUP_REQUESTED', 'PICKUP_DEFERRED', 'APPROACHING',
  'BOARDING', 'INSIDE', 'EXITING', 'COMPLETED', 'CANCELLED',
];
export { PASSENGER_STATES };

function makeElevator(id, startFloor) {
  return {
    id,
    currentFloor: startFloor,
    targetFloor: null,
    direction: 'idle', // idle | up | down
    door: 'closed', // closed | opening | open | closing
    moving: false,
    capacityHard: 800,
  };
}

export class StateManager {
  constructor() {
    this.elevators = {
      A: makeElevator('A', 0), // Ground
      B: makeElevator('B', 0), // Ground
    };
    this.insideByLift = { A: [], B: [] };
    this.waitingPassengers = []; // [{id, floor, destination, type, weight, priority, status, createdAt}]
    this.minFloor = 0;
    this.maxFloor = 7;
    this.floors = this.maxFloor - this.minFloor + 1;
  }

  // ---- legacy compat ----
  get elevator() { return this.elevators.A; }
  get insidePassengers() { return this.insideByLift.A; }
  set insidePassengers(v) { this.insideByLift.A = v; }
  set waitingList(v) { this.waitingPassengers = v; }

  getElev(liftId = 'A') { return this.elevators[liftId] || this.elevators.A; }
  getInside(liftId = 'A') { return this.insideByLift[liftId] || []; }

  resetLifts() {
    this.elevators.A = makeElevator('A', 0);
    this.elevators.B = makeElevator('B', 0);
    this.insideByLift = { A: [], B: [] };
    this.waitingPassengers = [];
  }

  getState() {
    return {
      elevators: { A: { ...this.elevators.A }, B: { ...this.elevators.B } },
      elevator: { ...this.elevators.A },
      insideByLift: { A: [...this.insideByLift.A], B: [...this.insideByLift.B] },
      insidePassengers: [...this.insideByLift.A],
      waitingPassengers: [...this.waitingPassengers],
    };
  }

  addWaiting(p) {
    p.status = 'WAITING';
    p.createdAt = p.createdAt || Date.now();
    if (p.destination === undefined) p.destination = null;
    if (!p.priority) {
      p.priority = p.type === 'wheelchair' ? 3 : p.type === 'senior' ? 2 : 1;
    }
    this.waitingPassengers.push(p);
    const prioNote = p.priority === 3 ? ' [High Priority]' : p.priority === 2 ? ' [Priority]' : '';
    eventManager.log(`[SMARTLIFT] Passenger ${p.id} (${this._label(p)}${prioNote}, ${p.weight}kg) added at Floor ${floorLabel(p.floor)}`, 'info', { passenger: p });
    if (p.destination !== null && p.destination !== undefined) {
      eventManager.log(`[SMARTLIFT] Request: Floor ${floorLabel(p.floor)} → Floor ${floorLabel(p.destination)}`, 'reason');
    }
  }

  removeWaiting(id) {
    const idx = this.waitingPassengers.findIndex((p) => p.id === id);
    if (idx >= 0) {
      const p = this.waitingPassengers[idx];
      p.status = 'CANCELLED';
      this.waitingPassengers.splice(idx, 1);
      eventManager.log(`[GHOST CALL] Passenger ${p.id} removed from Floor ${floorLabel(p.floor)} (request cancelled)`, 'warn');
      return p;
    }
    return null;
  }

  moveToInside(waitingId, destination = null, liftId = 'A') {
    const idx = this.waitingPassengers.findIndex((p) => p.id === waitingId);
    if (idx < 0) return null;
    const w = this.waitingPassengers.splice(idx, 1)[0];
    const dest = destination !== null && destination !== undefined ? destination : w.destination;
    const inside = { ...w, destination: dest !== undefined ? dest : null, status: 'INSIDE', boardedAt: Date.now(), liftId };
    delete inside.floor;
    if (!this.insideByLift[liftId]) this.insideByLift[liftId] = [];
    this.insideByLift[liftId].push(inside);
    eventManager.log(`[LIFT ${liftId}] ${this._label(inside)} ${inside.id} boarded — now inside (${inside.weight}kg)`, 'success');
    return inside;
  }

  removeInside(id, liftId = null) {
    const lifts = liftId ? [liftId] : ['A', 'B'];
    for (const l of lifts) {
      const idx = this.insideByLift[l].findIndex((p) => p.id === id);
      if (idx >= 0) {
        const p = this.insideByLift[l].splice(idx, 1)[0];
        p.status = 'COMPLETED';
        eventManager.log(`[LIFT ${l}] Passenger ${p.id} exited at Floor ${floorLabel(this.elevators[l].currentFloor)} — freed ${p.weight + (p.luggage ? p.luggageWeight : 0)}kg`, 'success');
        return { passenger: p, liftId: l };
      }
    }
    return null;
  }

  findInside(id) {
    for (const l of ['A', 'B']) {
      const p = this.insideByLift[l].find((x) => x.id === id);
      if (p) return { passenger: p, liftId: l };
    }
    return null;
  }

  _label(p) {
    const map = { adult: 'Adult', child: 'Child', senior: 'Senior Citizen', wheelchair: 'Wheelchair User', luggage: 'Luggage' };
    return map[p.type] || p.type;
  }
}
export const stateManager = new StateManager();
