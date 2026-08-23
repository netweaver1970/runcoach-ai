// Run: node --import ./harness/register.mjs harness/wlseedtest.mjs
import { loadLibrary, describeWorkout, workoutMinutes } from '../src/services/workoutLibrary.ts';
const lib = await loadLibrary();
console.log(`seeded ${lib.length} workouts:\n`);
for (const w of lib) console.log(`  [${w.kind.padEnd(9)}] ${w.name.padEnd(24)} ~${String(workoutMinutes(w)).padStart(3)}m  ${describeWorkout(w)}`);
