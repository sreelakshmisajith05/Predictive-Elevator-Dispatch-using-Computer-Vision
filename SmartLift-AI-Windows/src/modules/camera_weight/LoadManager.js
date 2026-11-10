/**
 * LoadManager — predicts and tracks load
 */
export class LoadManager {
  static passengerLoad(p) {
    return (p.weight || 0) + (p.luggage ? (p.luggageWeight || 0) : 0);
  }
  static totalLoad(passengers) {
    return passengers.reduce((s, p) => s + this.passengerLoad(p), 0);
  }
  static projectedLoad(currentInside, waitingPassengerOrArray) {
    const arr = Array.isArray(waitingPassengerOrArray) ? waitingPassengerOrArray : [waitingPassengerOrArray];
    return this.totalLoad(currentInside) + this.totalLoad(arr);
  }
}
