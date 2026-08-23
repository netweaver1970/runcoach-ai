// Run: node --import ./harness/register.mjs harness/workoutlibtest.mjs
import { describeWorkout, workoutMinutes, toWorkoutBlob, newWorkout } from '../src/services/workoutLibrary.ts';
const w = { id:'x', name:'VO2 5×3', kind:'intervals', warmupMeters:0, drillsMinutes:4, cooldownMeters:0,
  blocks:[{repeats:5,workMinutes:3,restMinutes:2,hrZone:'Z4',recoveryZone:'Z1',label:'VO2'},
          {repeats:1,workMinutes:10,restMinutes:0,hrZone:'Z3',label:'tempo'}], updatedAt:0 };
console.log('describe:', describeWorkout(w));
console.log('minutes :', workoutMinutes(w), '(expect 4 + 5*(3+2)=25 + 10 = 39)');
console.log('blob    :', JSON.stringify(toWorkoutBlob(w, 'Mon')));
console.log('newWorkout:', JSON.stringify(newWorkout(1000)).slice(0,120));
