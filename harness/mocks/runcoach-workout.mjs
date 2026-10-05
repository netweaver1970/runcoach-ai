// Native watch/WorkoutKit module (modules/runcoach-workout) — zones.ts asks it for Apple's HR zones; in Node there
// are none, so zones fall back to the computed Karvonen table exactly as on a pre-iOS-27 phone.
export async function getAppleHeartRateZones() { return null; }
export default {};
