/**
 * RequestManager — pickupRequests vs destinationRequests (dual-lift aware).
 *
 * PRESERVED Phase 1 rule:
 *  - Ghost-call logic ONLY for outside pickups. Inside destinations are
 *    never ghost-cancelled.
 *  - A CANCELLED outside pickup is INVALID and must never be reassigned
 *    to the other lift. Only valid outstanding requests move between lifts.
 */
import { eventManager } from './EventManager.js';

function floorLabel(f) { return f === 0 ? 'G' : String(f); }

export class RequestManager {
  constructor(stateManager) {
    this.state = stateManager;
    // pickupRequests: { floor, passengerIds: [], status: WAITING|DEFERRED|CANCELLED, assignedLift: 'A'|'B'|null }
    this.pickupRequests = [];
    // destinationRequests: { floor, passengerId, liftId, status }
    this.destinationRequests = [];
  }

  syncPickupsFromWaiting() {
    const waitingByFloor = new Map();
    for (const p of this.state.waitingPassengers) {
      if (!waitingByFloor.has(p.floor)) waitingByFloor.set(p.floor, []);
      waitingByFloor.get(p.floor).push(p.id);
    }
    for (const [floor, ids] of waitingByFloor) {
      let req = this.pickupRequests.find((r) => r.floor === floor);
      if (!req) {
        req = { floor, passengerIds: [...ids], status: 'WAITING', assignedLift: null, createdAt: Date.now() };
        this.pickupRequests.push(req);
        eventManager.log(`[REQUEST] Pickup request created: Floor ${floorLabel(floor)}`, 'info');
      } else {
        req.passengerIds = [...ids];
        if (req.status === 'CANCELLED') req.status = 'WAITING';
      }
    }
    for (let i = this.pickupRequests.length - 1; i >= 0; i--) {
      const r = this.pickupRequests[i];
      if (!waitingByFloor.has(r.floor)) {
        if (r.status !== 'CANCELLED') {
          eventManager.log(`[GHOST CALL] Pickup request Floor ${floorLabel(r.floor)} invalidated`, 'warn');
          eventManager.log(`[ROUTE] Floor ${floorLabel(r.floor)} removed from pending pickup queue`, 'warn');
        }
        // Remove entirely — a cancelled outside pickup is no longer a valid
        // request and must not be handed to the other lift.
        this.pickupRequests.splice(i, 1);
      }
    }
  }

  setPickupStatus(floor, status) {
    const r = this.pickupRequests.find((x) => x.floor === floor);
    if (r) r.status = status;
  }

  setAssignment(floor, liftId) {
    const r = this.pickupRequests.find((x) => x.floor === floor);
    if (r) r.assignedLift = liftId;
  }

  clearAssignmentForFloor(floor) {
    const r = this.pickupRequests.find((x) => x.floor === floor);
    if (r) r.assignedLift = null;
  }

  pickupsForLift(liftId) {
    return this.pickupRequests.filter((r) => r.assignedLift === liftId && r.status !== 'CANCELLED');
  }

  addDestination(passengerId, floor, liftId = 'A') {
    if (this.destinationRequests.find((r) => r.floor === floor && r.passengerId === passengerId)) return;
    this.destinationRequests.push({ floor, passengerId, liftId, status: 'ACTIVE', createdAt: Date.now() });
    eventManager.log(`[LIFT ${liftId}] Destination request → Floor ${floorLabel(floor)} (inside passenger ${passengerId})`, 'info');
  }

  removeDestination(floor, passengerId = null, liftId = null) {
    const idx = this.destinationRequests.findIndex(
      (r) => r.floor === floor && (passengerId ? r.passengerId === passengerId : true) && (liftId ? r.liftId === liftId : true),
    );
    if (idx >= 0) {
      const r = this.destinationRequests.splice(idx, 1)[0];
      eventManager.log(`[LIFT ${r.liftId}] Destination Floor ${floorLabel(r.floor)} cancelled (double-press)`, 'warn');
      return r;
    }
    return null;
  }

  hasDestination(floor, liftId = null) {
    return this.destinationRequests.some((r) => r.floor === floor && (liftId ? r.liftId === liftId : true));
  }

  getAllPendingFloors(liftId = null) {
    const floors = new Set();
    for (const r of this.pickupRequests) {
      if (r.status === 'CANCELLED') continue;
      if (liftId && r.assignedLift && r.assignedLift !== liftId) continue;
      floors.add(r.floor);
    }
    for (const r of this.destinationRequests) {
      if (liftId && r.liftId !== liftId) continue;
      floors.add(r.floor);
    }
    return [...floors];
  }

  isPickupFloor(floor, liftId = null) {
    return this.pickupRequests.some((r) => r.floor === floor && (liftId ? (!r.assignedLift || r.assignedLift === liftId) : true));
  }
  isDestinationFloor(floor, liftId = null) {
    return this.destinationRequests.some((r) => r.floor === floor && (liftId ? r.liftId === liftId : true));
  }

  consumeArrivedFloor(floor, liftId) {
    this.destinationRequests = this.destinationRequests.filter(
      (r) => !(r.floor === floor && (!liftId || r.liftId === liftId)),
    );
  }
}
