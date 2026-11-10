/**
 * MultiLiftCoordinator — Intelligent Dual-Lift Coordination Engine (Lift A + Lift B).
 *
 * Evaluates both virtual lifts for every eligible floor pickup batch considering:
 *  - Distance to pickup floor
 *  - Current direction & directional continuity
 *  - Existing route & destination commitments
 *  - Current cabin load & projected load
 *  - Dynamic operational threshold & safety margin
 *  - Passenger priority (wheelchair & senior citizen elevated priority)
 *  - Waiting duration & fairness (avoids starvation of adult passengers)
 *  - EventManager reasoning trace logging
 */
import { eventManager } from './EventManager.js';
import { SafetyEngine } from '../modules/camera_weight/SafetyEngine.js';
import { LoadManager } from '../modules/camera_weight/LoadManager.js';
import { ThresholdEngine } from '../modules/camera_weight/ThresholdEngine.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

export class MultiLiftCoordinator {
  constructor(stateManager, requestManager) {
    this.state = stateManager;
    this.requests = requestManager;
    this.activeLifts = ['A', 'B'];
  }

  commitmentsFor(liftId) {
    const picks = this.requests.pickupRequests.filter(
      (r) => r.assignedLift === liftId && r.status !== 'CANCELLED'
    ).length;
    const dests = this.requests.destinationRequests.filter(
      (r) => r.liftId === liftId && r.status !== 'COMPLETED'
    ).length;
    return picks + dests;
  }

  scoreLift(liftId, floor) {
    const elev = this.state.getElev(liftId);
    const inside = this.state.getInside(liftId);
    const waitingHere = this.state.waitingPassengers.filter(
      (p) => p.floor === floor && p.status !== 'CANCELLED'
    );
    if (!waitingHere.length) return null;

    let proj;
    if (waitingHere.length === 1) {
      proj = SafetyEngine.evaluateProjected(inside, waitingHere[0]);
    } else {
      const curLoad = LoadManager.totalLoad(inside);
      const addLoad = LoadManager.totalLoad(waitingHere);
      const projLoad = curLoad + addLoad;
      const projThresh = ThresholdEngine.calculate([...inside, ...waitingHere]);
      const hardExceeded = projLoad > ThresholdEngine.HARD_CAPACITY;
      const threshExceeded = projLoad > projThresh;
      const safe = !hardExceeded && !threshExceeded;
      proj = {
        currentLoad: curLoad,
        addedLoad: addLoad,
        projectedLoad: projLoad,
        projectedThreshold: projThresh,
        projectedMargin: projThresh - projLoad,
        safe,
        decision: hardExceeded ? 'UNSAFE' : threshExceeded ? 'DEFERRED' : 'SAFE',
        reason: hardExceeded ? `Exceeds 800kg hard cap (${projLoad}kg)` : threshExceeded ? `Exceeds dynamic ${projThresh}kg` : 'Safe',
      };
    }

    const dist = Math.abs(elev.currentFloor - floor);
    let distCost = dist * 1.6;

    // Direction alignment
    if (elev.direction === 'idle' && !elev.moving) {
      distCost -= 2.0; // Idle lift gets a head start
    } else if (elev.moving || elev.direction !== 'idle') {
      const movingToward =
        (elev.direction === 'up' && floor >= elev.currentFloor) ||
        (elev.direction === 'down' && floor <= elev.currentFloor);
      if (movingToward) {
        distCost -= 2.5; // Natural en-route stop
      } else {
        distCost += 5.0; // Heading away requires round-trip turnaround
      }
    }

    // Existing commitments
    distCost += this.commitmentsFor(liftId) * 0.8;

    // Priority bonus (wheelchair / elderly requests bias assignment toward earlier response)
    const maxPrio = Math.max(...waitingHere.map((p) => p.priority || 1));
    if (maxPrio === 3) distCost -= 2.0;
    else if (maxPrio === 2) distCost -= 1.0;

    // Wait time consideration to prevent starvation
    const oldestWait = Math.min(...waitingHere.map((p) => p.createdAt || Date.now()));
    const waitSec = (Date.now() - oldestWait) / 1000;
    if (waitSec > 5) {
      distCost -= Math.min(3, waitSec * 0.15);
    }

    // Safety constraint penalties
    if (!proj.safe) {
      if (proj.decision === 'UNSAFE') distCost += 100;
      else if (proj.decision === 'DEFERRED') distCost += 15;
    }

    return {
      liftId,
      score: Math.round(distCost * 10) / 10,
      proj,
      elev: { ...elev },
      safe: proj.safe,
      decision: proj.decision,
      dist,
    };
  }

  evaluateAndAssign(triggerFloor = null) {
    const pending = this.requests.pickupRequests.filter((r) => r.status !== 'CANCELLED');
    if (!pending.length) return;
    if (triggerFloor !== null) {
      eventManager.log(`[COORDINATOR] Evaluating pickup assignment for Floor ${floorLabel(triggerFloor)}`, 'info');
    }
    for (const req of pending) {
      const waiting = this.state.waitingPassengers.some(
        (p) => p.floor === req.floor && p.status !== 'CANCELLED'
      );
      if (!waiting) continue;
      if (req.assignedLift) continue; // Stable: don't flap existing assignment
      this.assignFloor(req.floor);
    }
  }

  assignFloor(floor) {
    const scores = [];
    for (const lid of this.activeLifts) {
      const s = this.scoreLift(lid, floor);
      if (s) scores.push(s);
    }
    if (!scores.length) return null;

    scores.sort((a, b) => a.score - b.score);
    const chosen = scores[0];

    if (scores.length >= 2) {
      const a = scores.find((s) => s.liftId === 'A');
      const b = scores.find((s) => s.liftId === 'B');
      eventManager.log(
        `[COORDINATOR] Lift A (Floor ${floorLabel(a.elev.currentFloor)}, score ${a.score}, load ${a.proj.projectedLoad}kg, ${a.proj.decision}) vs Lift B (Floor ${floorLabel(b.elev.currentFloor)}, score ${b.score}, load ${b.proj.projectedLoad}kg, ${b.proj.decision})`,
        'reason'
      );
    }

    if (!chosen.safe) {
      eventManager.log(
        `[COORDINATOR] Lift ${chosen.liftId} projects ${chosen.decision} — holding Floor ${floorLabel(floor)} as DEFERRED`,
        'warn'
      );
      this.requests.setPickupStatus(floor, 'DEFERRED');
    } else {
      this.requests.setPickupStatus(floor, 'WAITING');
    }

    this.requests.setAssignment(floor, chosen.liftId);
    eventManager.log(
      `[COORDINATOR] Lift ${chosen.liftId} assigned to Floor ${floorLabel(floor)} (Score: ${chosen.score} | Distance: ${chosen.dist})`,
      'success'
    );
    return chosen.liftId;
  }

  /** After a ghost call: drop invalid stops, re-evaluate survivors. */
  reevaluateAfterGhost() {
    eventManager.log('[COORDINATOR] Ghost-call detected — re-evaluating remaining active requests', 'info');
    for (const req of this.requests.pickupRequests) {
      if (req.status === 'CANCELLED') continue;
      const stillValid = this.state.waitingPassengers.some(
        (p) => p.floor === req.floor && p.status !== 'CANCELLED'
      );
      if (!stillValid) continue;
      if (!req.assignedLift) this.assignFloor(req.floor);
    }
  }
}
