/**
 * ThresholdEngine — Dynamic Operational Threshold
 * ------------------------------------------------
 * Computes operational threshold from passenger composition.
 * This is NOT a simple 800kg check. It varies by classification.
 *
 * Architecture: Used for both CURRENT and PROJECTED states.
 * Core knows waiting passenger classification BEFORE arrival.
 *
 * Later: CameraDetectionProvider will feed same interface.
 */
export class ThresholdEngine {
  static HARD_CAPACITY = 800; // absolute hard limit — never exceed
  static BASE_THRESHOLD = 750; // operational base

  /**
   * @param {Array} passengers — array of {type, weight, luggage, luggageWeight}
   * @returns {number} operational threshold in kg
   */
  static calculate(passengers) {
    let threshold = this.BASE_THRESHOLD;

    const types = passengers.map(p => p.type);
    const hasWheelchair = types.includes('wheelchair');
    const hasSenior = types.includes('senior');
    const hasChild = types.includes('child');
    const hasAdult = types.includes('adult');

    // Vulnerability deductions — makes Child vs Adult behave differently (Test B)
    if (hasWheelchair) threshold -= 110; // wheelchair needs extra margin
    else if (hasSenior) threshold -= 55;
    // child penalty stacks slightly
    if (hasChild) threshold -= 35;
    // adult alone keeps full threshold — demonstrates difference

    // Luggage penalty
    const totalLuggage = passengers.reduce((s, p) => s + (p.luggage ? (p.luggageWeight || 0) : 0), 0);
    if (totalLuggage > 40) threshold -= 30;
    else if (totalLuggage > 20) threshold -= 18;
    else if (totalLuggage > 0) threshold -= 8;

    // Crowding penalty — more than 5 pax reduces comfort threshold
    if (passengers.length > 5) threshold -= (passengers.length - 5) * 12;

    // Senior+Child combo extra caution
    if (hasSenior && hasChild) threshold -= 15;

    // Clamp
    threshold = Math.max(380, Math.min(750, threshold));
    return Math.round(threshold);
  }

  static explain(passengers) {
    const t = this.calculate(passengers);
    const reasons = [];
    const types = passengers.map(p=>p.type);
    if (types.includes('wheelchair')) reasons.push('Wheelchair -110kg');
    else if (types.includes('senior')) reasons.push('Senior -55kg');
    if (types.includes('child')) reasons.push('Child -35kg');
    const lug = passengers.reduce((s,p)=>s+(p.luggage?p.luggageWeight:0),0);
    if (lug>40) reasons.push(`Luggage ${lug}kg -30kg`);
    else if (lug>20) reasons.push(`Luggage ${lug}kg -18kg`);
    else if (lug>0) reasons.push(`Luggage ${lug}kg -8kg`);
    if (passengers.length>5) reasons.push(`Crowding x${passengers.length} -${(passengers.length-5)*12}kg`);
    if (types.includes('senior') && types.includes('child')) reasons.push('Senior+Child combo -15kg');
    if (!reasons.length) reasons.push('Base 750kg — no deductions');
    return { threshold: t, reasons };
  }
}
