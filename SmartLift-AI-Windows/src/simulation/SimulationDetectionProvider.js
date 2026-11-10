/**
 * SimulationDetectionProvider — temporary replacement for CameraDetectionProvider
 * Both emit common format: { passenger_type, weight, luggage_detected, luggage_weight, floor }
 * Core consumes without caring about source — enables future real camera swap.
 */
export class SimulationDetectionProvider {
  // In simulation, detection is synthetic from drag-drop
  // This class just validates/formats
  static fromForm(form) {
    return {
      passenger_type: form.type,
      weight: Number(form.weight),
      luggage_detected: !!form.luggage,
      luggage_weight: form.luggage ? Number(form.luggageWeight||0) : 0,
      floor: Number(form.floor),
    };
  }
  static toPassenger(detection, id) {
    return {
      id,
      floor: detection.floor,
      type: detection.passenger_type,
      weight: detection.weight,
      luggage: detection.luggage_detected,
      luggageWeight: detection.luggage_weight,
      status: 'WAITING'
    };
  }
}
