/**
 * Classification — maps icon type to detection result
 * Abstraction so SimulationDetectionProvider and future CameraDetectionProvider
 * both emit { passenger_type, weight, luggage_detected, luggage_weight }
 */
export const PassengerTypes = {
  adult: { label: 'Adult', icon: '👨', defaultWeight: 75 },
  child: { label: 'Child', icon: '👦', defaultWeight: 30 },
  senior: { label: 'Senior Citizen', icon: '👴', defaultWeight: 70 },
  wheelchair: { label: 'Wheelchair User', icon: '♿', defaultWeight: 80 },
  luggage: { label: 'Luggage', icon: '🧳', defaultWeight: 15 },
};

export function classifyDetection(raw) {
  // raw from any provider: { passenger_type, weight, luggage_detected, luggage_weight }
  return {
    type: raw.passenger_type,
    weight: raw.weight,
    luggage: !!raw.luggage_detected,
    luggageWeight: raw.luggage_detected ? (raw.luggage_weight || 0) : 0,
  };
}
