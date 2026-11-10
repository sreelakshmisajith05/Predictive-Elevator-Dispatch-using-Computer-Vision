/**
 * ElevatorController — Single-Lift Intelligent Controller.
 *
 * Drives the single SmartLift elevator through:
 * - Door states: closed -> opening -> open -> closing -> closed.
 * - Floor arrival, sensor verification, passenger exiting & boarding.
 * - Predictive load recalculation on each stop.
 * - Real-time ghost-call re-evaluation.
 */
import { eventManager } from './EventManager.js';
import { SafetyEngine } from '../modules/camera_weight/SafetyEngine.js';
import { ThresholdEngine } from '../modules/camera_weight/ThresholdEngine.js';
import { LoadManager } from '../modules/camera_weight/LoadManager.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

globalThis.__ThresholdEngine = ThresholdEngine;
globalThis.__LoadManager = LoadManager;

export class ElevatorController {
  constructor(state, requests, route, liftId = 'A') {
    this.state = state;
    this.requests = requests;
    this.route = route;
    this.liftId = liftId;
    this.timer = null;
    this.doorTimer = null;
    this.tickMs = 900;
    this.onUpdate = null;
    this.sharedTick = false;
  }

  elev() { return this.state.getElev(this.liftId); }
  inside() { return this.state.getInside(this.liftId); }

  setUpdateCallback(cb) { this.onUpdate = cb; }

  start() {
    if (this.timer) return;
    if (!this.sharedTick) {
      eventManager.log(`[SMARTLIFT] Core initialized — single-lift intelligent mode active`, 'info');
      this.timer = setInterval(() => this.tick(), 400);
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  tick() {
    this.route.evaluatePickupSafety();

    const elev = this.elev();
    if (elev.door !== 'closed') return;

    if (elev.targetFloor === null || elev.targetFloor === elev.currentFloor) {
      const atFloor = elev.currentFloor;
      const needsService = this._shouldOpenAt(atFloor);
      if (needsService.should) {
        this._arriveAndOpen(atFloor, needsService);
        return;
      }
      const next = this.route.getNextTarget();
      if (next === null) {
        if (elev.moving || elev.direction !== 'idle') {
          elev.direction = 'idle';
          elev.moving = false;
          elev.targetFloor = null;
          this._notify();
        }
        return;
      }
      elev.targetFloor = next;
      elev.direction = next > elev.currentFloor ? 'up' : next < elev.currentFloor ? 'down' : 'idle';
      if (elev.direction !== 'idle') {
        elev.moving = true;
        eventManager.log(`[SMARTLIFT] Moving toward Floor ${floorLabel(next)}`, 'info');
        const waitingHere = this.state.waitingPassengers.filter((p) => p.floor === next);
        if (waitingHere.length) {
          const proj = SafetyEngine.evaluateProjected(this.inside(), waitingHere[0]);
          eventManager.reasoning([
            `[PREDICTION] Current Load = ${proj.currentLoad}kg`,
            `[PREDICTION] Expected Added Load = ${proj.addedLoad}kg`,
            `[PREDICTION] Projected Load = ${proj.projectedLoad}kg`,
            `[PREDICTION] Projected Threshold = ${proj.projectedThreshold}kg`,
            `[PREDICTION] Projected Margin = ${proj.projectedMargin}kg`,
            `[SAFETY] Floor ${floorLabel(next)} Pickup = ${proj.decision} — ${proj.reason}`,
          ]);
        }
      }
      this._notify();
      return;
    }

    const targetValid = this._isTargetStillValid(elev.targetFloor);
    if (!targetValid) {
      eventManager.log(`[ROUTE] Target Floor ${floorLabel(elev.targetFloor)} invalidated (passenger left or cancelled)`, 'warn');
      eventManager.log(`[ROUTE] Recalculating remaining requests`, 'info');
      elev.targetFloor = null;
      elev.moving = false;
      this._notify();
      if (this.onGhostRecalc) this.onGhostRecalc();
      return;
    }

    if (elev.currentFloor < elev.targetFloor) {
      elev.currentFloor++;
      elev.direction = 'up';
    } else if (elev.currentFloor > elev.targetFloor) {
      elev.currentFloor--;
      elev.direction = 'down';
    }
    eventManager.log(`[SMARTLIFT] Passing Floor ${floorLabel(elev.currentFloor)}`, 'info');
    this._notify();

    const midCheck = this._shouldOpenAt(elev.currentFloor);
    if (midCheck.should) {
      this._arriveAndOpen(elev.currentFloor, midCheck);
    } else if (elev.currentFloor === elev.targetFloor) {
      elev.targetFloor = null;
      elev.moving = false;
      elev.direction = 'idle';
    }
  }

  _isTargetStillValid(target) {
    if (target === null) return false;
    // Inside passenger destination always keeps the target valid
    if (this.requests.isDestinationFloor(target, this.liftId)) return true;
    // Outside pickup check
    if (this.requests.isPickupFloor(target, this.liftId)) {
      return this.state.waitingPassengers.some((p) => p.floor === target);
    }
    return false;
  }

  _shouldOpenAt(floor) {
    const dests = this.requests.destinationRequests.filter((r) => r.floor === floor && r.liftId === this.liftId);
    if (dests.length) return { should: true, type: 'destination', dests };
    const pickup = this.requests.pickupRequests.find(
      (r) => r.floor === floor && (!r.assignedLift || r.assignedLift === this.liftId)
    );
    if (pickup) {
      const waiting = this.state.waitingPassengers.filter((p) => p.floor === floor && p.status !== 'CANCELLED');
      if (waiting.length) {
        const canAny = waiting.some((p) => SafetyEngine.evaluateProjected(this.inside(), p).safe);
        if (canAny) {
          pickup.status = 'WAITING';
          return { should: true, type: 'pickup', passengers: waiting };
        } else {
          pickup.status = 'DEFERRED';
          return { should: false, reason: 'All waiting passengers exceed threshold' };
        }
      }
    }
    return { should: false };
  }

  _batchEval(waitingList) {
    const currentLoad = LoadManager.totalLoad(this.inside());
    const addedLoad = LoadManager.totalLoad(waitingList);
    const projectedPassengers = [...this.inside(), ...waitingList];
    const projectedLoad = currentLoad + addedLoad;
    const projectedThreshold = ThresholdEngine.calculate(projectedPassengers);
    const safe = projectedLoad <= projectedThreshold && projectedLoad <= ThresholdEngine.HARD_CAPACITY;
    return {
      safe,
      projectedLoad,
      projectedThreshold,
      decision: safe ? 'SAFE' : 'DEFERRED',
      reason: safe ? 'Batch safe' : `Batch ${projectedLoad}kg > ${projectedThreshold}kg`,
    };
  }

  _arriveAndOpen(floor, info) {
    const elev = this.elev();
    elev.currentFloor = floor;
    elev.moving = false;
    elev.targetFloor = null;
    elev.direction = 'idle';
    eventManager.log(`[LIFT ${this.liftId}] Arrived at Floor ${floorLabel(floor)} — verifying service`, 'info');

    if (info.type === 'pickup' && !this.state.waitingPassengers.filter((p) => p.floor === floor && p.status !== 'CANCELLED').length) {
      eventManager.log(`[GHOST CALL] Ghost call at Floor ${floorLabel(floor)} — passenger departed before arrival — skipping`, 'warn');
      this._notify();
      return;
    }
    this._openDoors(floor, info);
  }

  _openDoors(floor, info) {
    const elev = this.elev();
    elev.door = 'opening';
    this._notify();
    eventManager.log(`[LIFT ${this.liftId}] Doors opening at Floor ${floorLabel(floor)}`, 'info');
    setTimeout(() => {
      elev.door = 'open';
      this._notify();
      eventManager.log(`[SMARTLIFT] Doors open at Floor ${floorLabel(floor)}`, 'info');
      this._handleBoardingAndExiting(floor, info);
      this.doorTimer = setTimeout(() => this._closeDoors(floor), 1800);
    }, 450);
  }

  _handleBoardingAndExiting(floor, info) {
    // 1. Process exits
    const exiting = this.inside().filter((p) => p.destination === floor);
    if (exiting.length) {
      for (const p of [...exiting]) {
        this.state.removeInside(p.id, this.liftId);
        this.requests.removeDestination(floor, p.id, this.liftId);
      }
      eventManager.log(`[LIFT ${this.liftId}] ${exiting.length} passenger(s) exited at Floor ${floorLabel(floor)}`, 'success');
      this.route.evaluatePickupSafety();
    }

    // 2. Process priority-aware cumulative boarding
    if (info.type === 'pickup' || this.requests.isPickupFloor(floor, this.liftId)) {
      const waiting = this.state.waitingPassengers.filter((p) => p.floor === floor && p.status !== 'CANCELLED');
      // Sort by priority (Wheelchair 3 -> Senior 2 -> Adult 1), then arrival time
      waiting.sort((a, b) => {
        const prioA = a.priority || (a.type === 'wheelchair' ? 3 : a.type === 'senior' ? 2 : 1);
        const prioB = b.priority || (b.type === 'wheelchair' ? 3 : b.type === 'senior' ? 2 : 1);
        if (prioB !== prioA) return prioB - prioA;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });

      const boarded = [];
      const deferred = [];

      for (const p of waiting) {
        const curInside = this.inside();
        const evalRes = SafetyEngine.evaluateProjected(curInside, p);
        if (evalRes.safe) {
          this.state.moveToInside(p.id, p.destination, this.liftId);
          const moved = this.state.findInside(p.id);
          if (moved && moved.passenger.destination !== null && moved.passenger.destination !== undefined) {
            this.requests.addDestination(moved.passenger.id, moved.passenger.destination, this.liftId);
          }
          boarded.push(p);
        } else {
          p.status = 'DEFERRED';
          deferred.push({ passenger: p, reason: evalRes.reason });
          eventManager.log(
            `[SAFETY - LIFT ${this.liftId}] Passenger ${p.id} (${p.type}, ${p.weight}kg) DEFERRED at Floor ${floorLabel(floor)}: ${evalRes.reason}`,
            'warn'
          );
        }
      }

      if (boarded.length > 0) {
        eventManager.log(
          `[LIFT ${this.liftId}] Boarded ${boarded.length} passenger(s) at Floor ${floorLabel(floor)} (Total load now: ${LoadManager.totalLoad(this.inside())}kg)`,
          'success'
        );
      }
      if (deferred.length > 0) {
        eventManager.log(
          `[LIFT ${this.liftId}] ${deferred.length} passenger(s) remain queued at Floor ${floorLabel(floor)} as DEFERRED`,
          'warn'
        );
      }
      this.requests.syncPickupsFromWaiting();
      const cur = SafetyEngine.evaluateCurrent(this.inside());
      eventManager.log(
        `[SAFETY - LIFT ${this.liftId}] Load updated — current ${cur.load}kg / threshold ${cur.threshold}kg / margin ${cur.margin}kg — status: ${cur.status}`,
        'reason'
      );
    }

    this.requests.consumeArrivedFloor(floor, this.liftId);
    this._notify();
  }

  _closeDoors(floor) {
    const elev = this.elev();
    elev.door = 'closing';
    this._notify();
    eventManager.log(`[SMARTLIFT] Doors closing at Floor ${floorLabel(floor)}`, 'info');
    setTimeout(() => {
      elev.door = 'closed';
      this._notify();
      eventManager.log(`[SMARTLIFT] Doors closed`, 'info');
    }, 400);
  }

  pressInsideButton(floor, passengerId = null) {
    const existing = this.requests.destinationRequests.find(
      (r) => r.floor === Number(floor) && r.liftId === this.liftId,
    );
    if (existing) return { action: 'exists', floor };
    let targetPassenger = null;
    if (passengerId) {
      targetPassenger = this.inside().find((p) => p.id === passengerId);
      if (targetPassenger && targetPassenger.destination !== null && targetPassenger.destination !== undefined) {
        return { action: 'already_has_destination', floor, passengerId: targetPassenger.id, currentDestination: targetPassenger.destination };
      }
    } else {
      targetPassenger = this.inside().find((p) => p.destination === null || p.destination === undefined);
    }
    if (!targetPassenger) {
      eventManager.log(`[SMARTLIFT] All inside passengers already have destinations`, 'warn');
      return { action: 'no_passenger' };
    }
    targetPassenger.destination = Number(floor);
    this.requests.addDestination(targetPassenger.id, Number(floor), this.liftId);
    eventManager.log(`[SMARTLIFT] Inside button pressed for Floor ${floorLabel(floor)} (Passenger ${targetPassenger.id})`, 'info');
    return { action: 'added', floor, passengerId: targetPassenger.id };
  }

  cancelDestination(floor) {
    const req = this.requests.destinationRequests.find(
      (r) => r.floor === Number(floor) && r.liftId === this.liftId,
    );
    if (req) {
      const p = this.inside().find((x) => x.id === req.passengerId);
      if (p) p.destination = null;
      this.requests.removeDestination(Number(floor), req.passengerId, this.liftId);
      eventManager.log(`[SMARTLIFT] Inside destination Floor ${floorLabel(floor)} cancelled`, 'warn');
      return true;
    }
    return false;
  }

  _notify() { if (this.onUpdate) this.onUpdate(this.getSnapshot()); }

  getSnapshot() {
    const curEval = SafetyEngine.evaluateCurrent(this.inside());
    let nextEval = null;
    const nextTarget = this.route.getNextTarget();
    if (this.state.waitingPassengers.length) {
      const sorted = [...this.state.waitingPassengers].sort(
        (a, b) => Math.abs(a.floor - this.elev().currentFloor) - Math.abs(b.floor - this.elev().currentFloor),
      );
      const candidatePassenger = sorted[0];
      if (candidatePassenger) {
        const evalRes = SafetyEngine.evaluateProjected(this.inside(), candidatePassenger);
        nextEval = { floor: candidatePassenger.floor, passenger: candidatePassenger, eval: evalRes };
      }
    }
    return {
      liftId: this.liftId,
      elevator: { ...this.elev() },
      inside: [...this.inside()],
      waiting: [...this.state.waitingPassengers],
      pickupRequests: [...this.requests.pickupRequests],
      destinationRequests: this.requests.destinationRequests.filter((r) => r.liftId === this.liftId),
      currentEval: curEval,
      nextEval,
      nextTarget,
    };
  }

  onStateChanged() {
    this.requests.syncPickupsFromWaiting();
    this.route.evaluatePickupSafety();
    this._notify();
  }

  nudgeLoad() { this._notify(); }
}
