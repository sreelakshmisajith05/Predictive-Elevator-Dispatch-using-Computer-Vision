/**
 * PassengerManager — simulation layer that creates passengers.
 * Drop location = boarding floor (automatic). Destination comes from the
 * passenger-details dropdown. Emits SimulationDetectionProvider-compatible
 * detection objects so the Core stays source-agnostic.
 */
let counter = 1;
export class PassengerManager {
  constructor(stateManager, requestManager, eventManager) {
    this.state = stateManager;
    this.requests = requestManager;
    this.events = eventManager;
  }

  createPassenger({ floor, destination = null, type = 'adult', weight = 75 }) {
    const id = 'P' + String(counter++).padStart(3, '0');
    const destNum = destination !== null && destination !== undefined && destination !== '' ? Number(destination) : null;
    const validatedWeight = Math.max(10, Math.min(250, Number(weight) || 75));
    const priority = type === 'wheelchair' ? 3 : type === 'senior' ? 2 : 1;
    const p = {
      id,
      floor: Number(floor),
      destination: destNum,
      type,
      weight: validatedWeight,
      priority,
      status: 'WAITING',
      createdAt: Date.now(),
    };
    this.state.addWaiting(p);
    this.requests.syncPickupsFromWaiting();
    return {
      passenger: p,
      detection: {
        passenger_type: type,
        weight: p.weight,
        priority: p.priority,
      },
    };
  }

  removePassenger(id) {
    const removed = this.state.removeWaiting(id);
    if (removed) this.requests.syncPickupsFromWaiting();
    return removed;
  }

  setDestination(passengerId, floor, liftId = 'A') {
    this.requests.addDestination(passengerId, Number(floor), liftId);
  }
}
