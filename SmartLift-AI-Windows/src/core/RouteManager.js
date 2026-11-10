/**
 * RouteManager — Intelligent Single-Lift Routing & Priority Engine.
 *
 * Evaluates all valid cabin destinations and floor pickups using:
 * - Dynamic operational threshold & predictive load safety.
 * - Distance and direction continuity.
 * - Passenger classification & priority weighting:
 *     * Wheelchair users: highest pickup priority bonus.
 *     * Senior citizens: elevated pickup priority bonus.
 *     * Waiting duration consideration.
 * - Explicit explainability reasoning trace logged to EventManager.
 *
 * Ghost-call protection: outside pickups can be cancelled without dropping
 * inside cabin destinations for the same floor.
 */
import { SafetyEngine } from '../modules/camera_weight/SafetyEngine.js';
import { ThresholdEngine } from '../modules/camera_weight/ThresholdEngine.js';
import { LoadManager } from '../modules/camera_weight/LoadManager.js';
import { eventManager } from './EventManager.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

export class RouteManager {
  constructor(stateManager, requestManager, liftId = 'A') {
    this.state = stateManager;
    this.requests = requestManager;
    this.liftId = liftId;
    this.lastDecision = null;
    this.lastCandidateEvaluations = [];
  }

  inside() {
    return this.state.getInside(this.liftId);
  }

  evaluatePickupSafety() {
    const inside = this.inside();
    const result = new Map();
    for (const req of this.requests.pickupRequests) {
      if (req.assignedLift && req.assignedLift !== this.liftId) continue;
      const passengersAtFloor = this.state.waitingPassengers.filter((p) => p.floor === req.floor);
      if (!passengersAtFloor.length) continue;
      let evalRes;
      if (passengersAtFloor.length > 1) evalRes = this._evalBatch(inside, passengersAtFloor);
      else evalRes = SafetyEngine.evaluateProjected(inside, passengersAtFloor[0]);

      result.set(req.floor, { req, passengers: passengersAtFloor, eval: evalRes });
      if (evalRes.decision !== 'SAFE' && req.status !== 'DEFERRED') {
        req.status = 'DEFERRED';
        eventManager.log(`[SAFETY] Floor ${floorLabel(req.floor)} pickup DEFERRED — ${evalRes.reason} (projected ${evalRes.projectedLoad}kg / threshold ${evalRes.projectedThreshold}kg)`, 'warn');
      } else if (evalRes.decision === 'SAFE' && req.status === 'DEFERRED') {
        req.status = 'WAITING';
        eventManager.log(`[SAFETY] Floor ${floorLabel(req.floor)} pickup SAFE — deferred cleared (projected ${evalRes.projectedLoad}kg ≤ ${evalRes.projectedThreshold}kg)`, 'success');
      }
    }
    return result;
  }

  _evalBatch(inside, waitingList) {
    const currentLoad = LoadManager.totalLoad(inside);
    const addedLoad = LoadManager.totalLoad(waitingList);
    const projectedPassengers = [...inside, ...waitingList];
    const projectedLoad = currentLoad + addedLoad;
    const projectedThreshold = ThresholdEngine.calculate(projectedPassengers);
    const projectedMargin = projectedThreshold - projectedLoad;
    const hardExceeded = projectedLoad > ThresholdEngine.HARD_CAPACITY;
    const thresholdExceeded = projectedLoad > projectedThreshold;
    const safe = !hardExceeded && !thresholdExceeded;
    let decision = 'SAFE';
    let reason = 'Batch projected safe';
    if (hardExceeded) { decision = 'UNSAFE'; reason = `Hard capacity exceeded (${projectedLoad}kg)`; }
    else if (thresholdExceeded) { decision = 'DEFERRED'; reason = `Projected ${projectedLoad}kg > threshold ${projectedThreshold}kg`; }
    return { currentLoad, addedLoad, projectedLoad, projectedThreshold, projectedMargin, hardExceeded, thresholdExceeded, safe, decision, reason, status: safe ? 'SAFE' : 'DEFERRED' };
  }

  /**
   * Evaluates all candidate floors and returns the next target floor
   * along with an explainable decision trace.
   */
  getNextTarget() {
    const elev = this.state.getElev(this.liftId);
    const cur = elev.currentFloor;
    const dir = elev.direction;

    // Inside-cabin destinations (highest commitment)
    const destFloors = this.requests.destinationRequests
      .filter((r) => r.liftId === this.liftId)
      .map((r) => r.floor);

    // Eligible outside pickups that are SAFE
    const eligiblePickups = this.requests.pickupRequests
      .filter((r) => r.status === 'WAITING' && (!r.assignedLift || r.assignedLift === this.liftId))
      .map((r) => r.floor);

    const deferredPickups = this.requests.pickupRequests
      .filter((r) => r.status === 'DEFERRED' && (!r.assignedLift || r.assignedLift === this.liftId))
      .map((r) => r.floor);

    const allCandidates = [...new Set([...destFloors, ...eligiblePickups])];

    if (allCandidates.length === 0) {
      if (deferredPickups.length > 0) {
        eventManager.log(`[ROUTE] All outside pickups currently DEFERRED due to load limits (floors: ${deferredPickups.map(floorLabel).join(', ')})`, 'warn');
      }
      this.lastDecision = null;
      this.lastCandidateEvaluations = [];
      return null;
    }

    const evaluations = [];
    const now = Date.now();

    for (const floor of allCandidates) {
      const isInside = destFloors.includes(floor);
      const isPickup = eligiblePickups.includes(floor);
      const dist = Math.abs(floor - cur);

      // Direction continuity cost
      let directionCost = 0;
      if (dir === 'up' && floor < cur) directionCost = 2.5;
      else if (dir === 'down' && floor > cur) directionCost = 2.5;

      // Inside cabin passengers exiting gets high priority bonus
      let insideBonus = isInside ? 3.0 : 0.0;

      // Priority calculation from waiting passengers
      let priorityScore = 0;
      let priorityReasons = [];
      const waitingHere = this.state.waitingPassengers.filter((p) => p.floor === floor);

      for (const p of waitingHere) {
        if (p.type === 'wheelchair') {
          priorityScore += 5.0;
          priorityReasons.push('Wheelchair user');
        } else if (p.type === 'senior') {
          priorityScore += 3.0;
          priorityReasons.push('Senior citizen');
        } else if (p.type === 'child') {
          priorityScore += 1.0;
          priorityReasons.push('Child');
        }

        // Wait time bonus: +0.5 per 5 seconds of waiting
        if (p.createdAt) {
          const waitedSec = (now - p.createdAt) / 1000;
          if (waitedSec > 5) {
            priorityScore += Math.min(2.0, waitedSec * 0.1);
          }
        }
      }

      // Safety check for pickup
      let safetyOk = true;
      let safetyReason = 'Inside stop';
      if (isPickup && waitingHere.length > 0) {
        const sEval = waitingHere.length === 1
          ? SafetyEngine.evaluateProjected(this.inside(), waitingHere[0])
          : this._evalBatch(this.inside(), waitingHere);
        safetyOk = sEval.safe;
        safetyReason = sEval.reason;
      }

      // Route Cost Formula:
      // Lower cost = better choice
      const cost = (dist * 1.5) + directionCost - insideBonus - priorityScore;

      evaluations.push({
        floor,
        floorName: floorLabel(floor),
        isInside,
        isPickup,
        dist,
        directionCost,
        insideBonus,
        priorityScore,
        priorityReasons,
        safetyOk,
        safetyReason,
        cost: Math.round(cost * 10) / 10
      });
    }

    // Filter candidate floors that are safe to stop at
    const viableCandidates = evaluations.filter((e) => e.isInside || e.safetyOk);
    if (viableCandidates.length === 0) {
      this.lastCandidateEvaluations = evaluations;
      return null;
    }

    // Sort by lowest cost
    viableCandidates.sort((a, b) => a.cost - b.cost);
    const chosen = viableCandidates[0];

    // Build reasoning explanation
    const reasons = [];
    if (chosen.isInside) reasons.push('Inside cabin destination');
    if (chosen.priorityReasons.length > 0) reasons.push(`Priority request (${chosen.priorityReasons.join(', ')})`);
    if (chosen.dist === 0) reasons.push('Immediate current floor stop');
    else reasons.push(`Distance ${chosen.dist} floor${chosen.dist > 1 ? 's' : ''}`);
    if (chosen.directionCost === 0 && dir !== 'idle') reasons.push('Direction continuity');

    const explanation = `Target Floor ${chosen.floorName} (Cost: ${chosen.cost} | ${reasons.join(' | ')})`;

    // Log decision trace when target changes or on fresh evaluation
    if (!this.lastDecision || this.lastDecision.floor !== chosen.floor) {
      if (chosen.priorityReasons.length > 0) {
        eventManager.log(`[PRIORITY] Elevated pickup scheduled for Floor ${chosen.floorName}: ${chosen.priorityReasons.join(', ')}`, 'info');
      }
      eventManager.log(`[ROUTE] Intelligent stop chosen: ${explanation}`, 'reason');
    }

    this.lastDecision = {
      floor: chosen.floor,
      explanation,
      chosen
    };
    this.lastCandidateEvaluations = evaluations;

    return chosen.floor;
  }
}
