import { ThresholdEngine } from './ThresholdEngine.js';
import { LoadManager } from './LoadManager.js';

export class SafetyEngine {
  /**
   * Evaluate CURRENT state
   */
  static evaluateCurrent(insidePassengers) {
    const load = LoadManager.totalLoad(insidePassengers);
    const threshold = ThresholdEngine.calculate(insidePassengers);
    const margin = threshold - load;
    const hardExceeded = load > ThresholdEngine.HARD_CAPACITY;
    const safe = !hardExceeded && margin >= 0;
    return { load, threshold, margin, safe, hardExceeded, status: safe ? 'SAFE' : 'UNSAFE' };
  }

  /**
   * Evaluate PROJECTED state — core predictive reasoning
   * "If I pick up this passenger, will resulting state remain safe?"
   */
  static evaluateProjected(insidePassengers, waitingPassenger) {
    const currentLoad = LoadManager.totalLoad(insidePassengers);
    const addedLoad = LoadManager.passengerLoad(waitingPassenger);
    const projectedPassengers = [...insidePassengers, waitingPassenger];
    const projectedLoad = currentLoad + addedLoad;
    const projectedThreshold = ThresholdEngine.calculate(projectedPassengers);
    const projectedMargin = projectedThreshold - projectedLoad;
    const hardExceeded = projectedLoad > ThresholdEngine.HARD_CAPACITY;
    const thresholdExceeded = projectedLoad > projectedThreshold;
    const safe = !hardExceeded && !thresholdExceeded;

    let decision = 'SAFE';
    let reason = 'Projected state within operational threshold';
    if (hardExceeded) { decision = 'UNSAFE'; reason = `Hard capacity ${ThresholdEngine.HARD_CAPACITY}kg exceeded (${projectedLoad}kg)`; }
    else if (thresholdExceeded) { decision = 'DEFERRED'; reason = `Projected ${projectedLoad}kg > threshold ${projectedThreshold}kg`; }

    return {
      currentLoad,
      addedLoad,
      projectedLoad,
      projectedThreshold,
      projectedMargin,
      hardExceeded,
      thresholdExceeded,
      safe,
      decision, // SAFE | DEFERRED | UNSAFE
      reason,
      status: safe ? 'SAFE' : (hardExceeded ? 'UNSAFE' : 'DEFERRED')
    };
  }
}
