/**
 * Strength module (Build 1, 2026-10-07): named + SOURCED routines of exercises (sets / reps / weight / rest / tempo),
 * planned on weekdays, logged set-by-set, and accumulated into a per-MUSCLE load.
 *
 * Muscle load: every completed set contributes, per muscle, (external load + the body-weight share the exercise
 * moves) × reps × that muscle's involvement (1 = prime mover, ~0.5 = strong synergist, ~0.25 = minor) = "tonnage";
 * plus fractional "hard sets" (Σ involvement), the unit hypertrophy guidelines use (~10–20 hard sets/muscle/week).
 *
 * Local-first: one JSON file in Documents (backed up by backup.ts); no network. Videos are links the athlete opens.
 */
import * as FileSystem from 'expo-file-system';

export type Muscle =
  | 'chest' | 'front_delts' | 'side_delts' | 'rear_delts' | 'triceps' | 'biceps' | 'forearms'
  | 'lats' | 'upper_back' | 'traps' | 'lower_back' | 'abs' | 'glutes' | 'quads' | 'hamstrings' | 'adductors' | 'calves';

export const MUSCLE_LABEL: Record<Muscle, string> = {
  chest: 'Chest', front_delts: 'Front delts', side_delts: 'Side delts', rear_delts: 'Rear delts', triceps: 'Triceps',
  biceps: 'Biceps', forearms: 'Forearms', lats: 'Lats', upper_back: 'Upper back', traps: 'Traps', lower_back: 'Lower back',
  abs: 'Abs', glutes: 'Glutes', quads: 'Quads', hamstrings: 'Hamstrings', adductors: 'Adductors', calves: 'Calves',
};
export const MUSCLES = Object.keys(MUSCLE_LABEL) as Muscle[];

export interface ExerciseVideo { url: string; title?: string; channel?: string }
export interface Exercise {
  id: string;
  name: string;
  muscles: Partial<Record<Muscle, number>>;   // involvement 0–1
  bodyweightFrac?: number;                     // share of body weight moved (dips ≈ 0.95); weight field = added (− = assistance)
  cue?: string;                                // one-line form cue
  video?: ExerciseVideo;
  custom?: boolean;
}

export interface RoutineItem {
  exerciseId: string;
  altIds?: string[];       // allowed swaps ("Back Squat or Hack Squat")
  sets: number;
  repsLo: number;
  repsHi: number;
  weightKg?: number;       // planned working weight (prefilled from the last session when empty)
  restSec: number;
  tempo?: string;          // e.g. "3:1:2:1" (eccentric:pause:concentric:pause)
  note?: string;
}
export interface Routine {
  id: string;
  name: string;
  source?: string;         // who/where it comes from
  sourceUrl?: string;
  days: number[];          // planned weekdays, 0 = Sun … 6 = Sat
  autoUpdate?: boolean;    // after a session, move the planned weights to the suggested next ones (default on)
  items: RoutineItem[];
  updatedAt: number;
}
export interface SetLog {
  exerciseId: string; set: number; reps: number; weightKg: number; done: boolean;
  warmup?: boolean;        // warm-up set: logged, but excluded from muscle load, records and progression
  rir?: number;            // reps in reserve after the set (0 = failure … 3 = "3+"), optional effort
  doneAt?: number;         // when ✓ was tapped (epoch ms) → the real workout window for Apple Health
}
/** How an exercise felt (optional, per session). 'hard' = that session doesn't count toward a raise. */
export type Feel = 'easy' | 'ok' | 'hard';
export const FEEL_LABEL: Record<Feel, string> = { easy: 'Easy', ok: 'OK', hard: 'Hard' };
export const isFeel = (v: unknown): v is Feel => v === 'easy' || v === 'ok' || v === 'hard';
/** A set that counts: done, not a warm-up, with reps. */
export const isWorkSet = (l: SetLog) => l.done && !l.warmup && l.reps > 0;
export interface StrengthSession {
  id: string;
  date: string;            // local YYYY-MM-DD
  routineId: string;
  routineName: string;
  startedAt: number;
  finishedAt?: number;
  bodyKg?: number;         // body weight used for body-weight exercises
  sets: SetLog[];
  rpe?: number;            // session RPE 1–10 (scales muscular load + the Health calorie estimate)
  feel?: Partial<Record<string, Feel>>;   // optional per-EXERCISE feedback (exerciseId → easy/ok/hard); gradable afterwards
  // Apple Health: written by us ('saved') / linked to a watch workout ('exists'); `enriched` = heart rate + Effort
  // related to our workout; `watch` = logged on the Apple Watch, `uuid` is the workout the WATCH recorded
  hk?: { status: 'saved' | 'exists' | 'failed'; uuid?: string; tries?: number; ver?: number;
         enriched?: { uuid: string; hr?: string; effort?: string; at: number };
         watch?: boolean;
         kcalSrc?: 'watch' | 'est'; resaveFails?: number };   // kcalSrc: the watch's measured active energy or the MET estimate
  note?: string;
}

// ── Exercise library ────────────────────────────────────────────────────────────────────────────────────────
// Involvement weights are a pragmatic EMG/biomechanics consensus (prime mover 1, synergists 0.3–0.6). Videos are
// filled in VIDEOS below (verified YouTube links).
const EX: Exercise[] = [
  { id: 'incline_db_press', name: 'Incline DB Press', muscles: { chest: 1, front_delts: 0.6, triceps: 0.5 }, cue: 'Bench ~30°, shoulder blades pinned. Lower to the upper chest, forearms vertical; press up and slightly in. Don\'t flare the elbows out to 90°.' },
  { id: 'flat_db_press', name: 'Flat DB Press', muscles: { chest: 1, front_delts: 0.5, triceps: 0.5 }, cue: 'Shoulder blades back and down, feet planted. Lower to mid-chest, elbows ~45°, press up evenly. Don\'t bounce or arch the lower back.' },
  { id: 'chest_press_machine', name: 'Chest Press Machine', muscles: { chest: 1, front_delts: 0.5, triceps: 0.5 }, cue: 'Set the seat so the handles sit at mid-chest, back flat on the pad. Press out, elbows ~45°, slow return. Don\'t shrug or let the stack rest between reps.' },
  { id: 'cable_chest_fly', name: 'Cable Chest Fly', muscles: { chest: 1, front_delts: 0.3 }, cue: 'Slight forward lean, soft fixed elbow bend. Sweep the hands together in a wide arc in front of the chest. Don\'t bend the elbows into a press.' },
  { id: 'machine_shoulder_press', name: 'Machine Shoulder Press', muscles: { front_delts: 1, side_delts: 0.5, triceps: 0.6 }, cue: 'Handles at shoulder height, back flat on the pad, core braced. Press overhead, lower to chin level. Don\'t arch the lower back off the pad.' },
  { id: 'db_lateral_raise', name: 'DB Lateral Raises', muscles: { side_delts: 1, traps: 0.25 }, cue: 'Brace, slight elbow bend. Lead with the elbows out to shoulder height, lower slowly. Don\'t swing the body or shrug the shoulders.' },
  { id: 'cable_triceps_pushdown', name: 'Cable Triceps Pushdown', muscles: { triceps: 1 }, cue: 'High pulley. Elbows pinned to your sides, push down to full extension, control the return. Don\'t lean over the bar or let the elbows drift.' },
  { id: 'overhead_rope_extension', name: 'Overhead Rope Extension', muscles: { triceps: 1 }, cue: 'Rope behind the head, elbows by the ears and still. Extend straight up, lower to a full stretch. Don\'t flare the elbows or arch the back.' },
  { id: 'triceps_dips', name: 'Triceps Dips / Dip Machine', muscles: { triceps: 1, chest: 0.6, front_delts: 0.5 }, bodyweightFrac: 0.95, cue: 'Torso upright, elbows back and close. Lower to ~90° at the elbow, press up under control. Don\'t sink so deep the shoulders roll forward. Weight = added kg (negative = assistance).' },
  { id: 'lat_pulldown', name: 'Lat Pulldown', muscles: { lats: 1, upper_back: 0.5, biceps: 0.5, rear_delts: 0.25 }, cue: 'Sit tall, slight lean back. Pull the bar to the upper chest, driving the elbows down to the ribs. Don\'t yank with momentum or lean further back.' },
  { id: 'lat_pulldown_neutral', name: 'Lat Pulldown (Neutral Grip)', muscles: { lats: 1, upper_back: 0.5, biceps: 0.6 }, cue: 'Palms facing, chest up. Drive the elbows down to your sides, handle to the upper chest, slow return. Don\'t shrug up at the top.' },
  { id: 'chest_supported_row', name: 'Chest-Supported Row', muscles: { upper_back: 1, lats: 0.6, rear_delts: 0.5, biceps: 0.5 }, cue: 'Chest on the pad, arms long. Row the elbows back to the lower ribs, squeeze the shoulder blades. Don\'t lift the chest off the pad to heave.' },
  { id: 'seated_row', name: 'Seated Row', muscles: { upper_back: 1, lats: 0.7, biceps: 0.5, rear_delts: 0.3 }, cue: 'Low pulley, sit tall, knees soft. Row the handle to the belly, elbows close, squeeze; slow return. Don\'t rock the torso back and forth.' },
  { id: 'rear_delt_fly', name: 'Rear Delt Fly', muscles: { rear_delts: 1, upper_back: 0.5 }, cue: 'Light weight, soft elbows. Sweep the arms out wide to shoulder height, shoulders down. Don\'t shrug or go heavy enough to need momentum.' },
  { id: 'db_curl', name: 'Dumbbell Curls', muscles: { biceps: 1, forearms: 0.3 }, cue: 'Elbows by your sides, palms up. Curl toward the shoulders, lower to straight arms. Don\'t swing the torso or let the elbows drift forward.' },
  { id: 'incline_db_curl', name: 'Incline DB Curls', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Bench 45–60°, arms hang straight down. Curl without moving the upper arm, lower to a full stretch. Don\'t let the elbows swing forward.' },
  { id: 'cable_biceps_curl', name: 'Cable Bicep Curls', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Low pulley, stand tall. Elbows fixed at your sides, curl up, squeeze, lower under control. Don\'t lean back or let the shoulders rise.' },
  { id: 'back_squat', name: 'Back Squat', muscles: { quads: 1, glutes: 0.8, adductors: 0.5, lower_back: 0.4, hamstrings: 0.25 }, cue: 'Brace, bar over mid-foot. Sit down between the hips, knees tracking over the toes; drive up through the whole foot. Don\'t let the knees cave in.' },
  { id: 'hack_squat', name: 'Hack Squat', muscles: { quads: 1, glutes: 0.6, adductors: 0.3 }, cue: 'Back and hips flat on the pad, feet shoulder-width. Lower under control, drive through the whole foot. Don\'t let the hips peel off the pad.' },
  { id: 'leg_press', name: 'Leg Press', muscles: { quads: 1, glutes: 0.6, adductors: 0.3 }, cue: 'Back and hips flat on the seat, feet mid-platform. Lower to ~90° at the knee, press through the whole foot. Don\'t lock the knees at the top.' },
  { id: 'leg_extension', name: 'Leg Extension', muscles: { quads: 1 }, cue: 'Line the knee up with the pivot, pad on the lower shin. Extend fully, pause, lower slowly. Don\'t kick the weight up or let the stack slam.' },
  { id: 'hamstring_curl', name: 'Hamstring Curl', muscles: { hamstrings: 1, calves: 0.2 }, cue: 'Knee in line with the pivot, pad just above the heel. Curl smoothly, squeeze, lower slowly. Don\'t lift the hips or swing the weight up.' },
  { id: 'calf_raise', name: 'Calf Raise', muscles: { calves: 1 }, bodyweightFrac: 1, cue: 'Balls of the feet on a step. Drop the heels for a full stretch, rise as high as you can, lower slowly. Don\'t bounce at the bottom. Weight = added kg (dumbbell in hand).' },
  // ── Marcy home-gym / no-bench set (2026-10-07): stack + cables, no bench / rack / leg press ──
  { id: 'pec_deck', name: 'Pec Deck (Butterfly)', muscles: { chest: 1, front_delts: 0.3 }, cue: 'Set the seat so the elbows sit at shoulder height, back flat on the pad. Squeeze the arms together, pause, slow return. Don\'t arch or use momentum.' },
  { id: 'seated_db_shoulder_press', name: 'Seated DB Shoulder Press', muscles: { front_delts: 1, side_delts: 0.5, triceps: 0.6 }, cue: 'Sit on the Marcy seat, back on the pad. Lower to ear height, wrists over the elbows, press straight up. Don\'t arch the lower back off the pad.' },
  { id: 'half_kneeling_cable_press', name: 'Half-Kneeling Cable Press', muscles: { front_delts: 1, side_delts: 0.4, triceps: 0.5, abs: 0.25 }, cue: 'Low pulley, kneel on the working-arm side; squeeze that glute, ribs down. Press up and slightly forward. Don\'t lean back or arch to finish.' },
  { id: 'cable_lateral_raise', name: 'Cable Lateral Raise', muscles: { side_delts: 1, traps: 0.25 }, cue: 'Low pulley, handle in the far hand, elbow slightly bent. Raise out to shoulder height, lower slowly. Don\'t swing or lean away from the cable.' },
  { id: 'single_arm_cable_row', name: 'Single-Arm Cable Row', muscles: { upper_back: 1, lats: 0.7, rear_delts: 0.4, biceps: 0.5 }, cue: 'Low pulley, brace. Row the elbow back past the ribs, then reach forward for a full stretch. Don\'t twist the torso to finish the rep.' },
  { id: 'face_pull', name: 'Face Pull', muscles: { rear_delts: 1, upper_back: 0.6, traps: 0.3 }, cue: 'High pulley, rope at face height, thumbs back. Pull to the forehead, elbows high, spreading the rope apart. Don\'t lean back or shrug.' },
  { id: 'bayesian_cable_curl', name: 'Bayesian Cable Curl', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Back to the low pulley, staggered stance, arm behind you. Curl without moving the elbow forward; full stretch on the way down. Don\'t swing.' },
  { id: 'bulgarian_split_squat', name: 'Bulgarian Split Squat', muscles: { quads: 1, glutes: 0.8, adductors: 0.4 }, bodyweightFrac: 0.8, cue: 'Rear foot on the Marcy seat. Drop straight down, front shin near vertical; drive up through the front foot. Don\'t let the front knee cave in. Weight = dumbbells in hand.' },
  { id: 'goblet_squat', name: 'Goblet Squat', muscles: { quads: 1, glutes: 0.7, adductors: 0.4 }, bodyweightFrac: 0.8, cue: 'Dumbbell at the chest, elbows in. Sit between the heels, chest up, knees over the toes; stand through the whole foot. Don\'t round the lower back.' },
  { id: 'cable_squat', name: 'Cable Squat', muscles: { quads: 1, glutes: 0.7, adductors: 0.3 }, bodyweightFrac: 0.8, cue: 'Low pulley, handle at the chest. Sit the hips down and back, torso upright, drive up through the whole foot. Don\'t lean back into a hip hinge.' },
  { id: 'close_grip_pushup', name: 'Close-Grip Push-up', muscles: { triceps: 1, chest: 0.6, front_delts: 0.4 }, bodyweightFrac: 0.65, cue: 'Hands under the shoulders, elbows brushing the ribs, body in one line. Knees down to make it easier. Don\'t let the hips sag.' },
  { id: 'overhead_cable_triceps_extension', name: 'Overhead Cable Triceps Extension', muscles: { triceps: 1 }, cue: 'Face away from the high pulley, staggered stance, upper arms by the ears. Extend to lockout, return to a full stretch. Don\'t flare the elbows.' },
];

// Verified YouTube technique videos (oEmbed-checked 2026-10-07; one per exercise, reputable coaching channels).
const VIDEOS: Record<string, ExerciseVideo> = {
  incline_db_press: { url: "https://www.youtube.com/watch?v=hChjZQhX1Ls", title: "How To: Dumbbell Incline Press | 3 GOLDEN RULES (MADE BETTER!)", channel: "ScottHermanFitness" },
  chest_press_machine: { url: "https://www.youtube.com/watch?v=n8TOta_pfr4", title: "How to Use a Chest Press Machine", channel: "LIVESTRONG" },
  machine_shoulder_press: { url: "https://www.youtube.com/watch?v=TnhIyp4kmO8", title: "How To Use The Shoulder Press Machine", channel: "PureGym" },
  db_lateral_raise: { url: "https://www.youtube.com/shorts/f_OGBg2KxgY", title: "Stop Messing Up Lateral Raises (Easy Fix)", channel: "Jeff Nippard" },
  cable_triceps_pushdown: { url: "https://www.youtube.com/watch?v=_w-HpW70nSQ", title: "HOW TO: Cable Triceps Pushdown || 3 Golden Rules (FOR GROWTH)", channel: "ScottHermanFitness" },
  overhead_rope_extension: { url: "https://www.youtube.com/watch?v=mRozZKkGIfg", title: "Cable Rope Overhead Tricep Extension", channel: "Bodybuilding.com" },
  lat_pulldown: { url: "https://www.youtube.com/shorts/hnSqbBk15tw", title: "Stop Messing Up Your Lat Pulldowns", channel: "Jeff Nippard" },
  lat_pulldown_neutral: { url: "https://www.youtube.com/watch?v=4P3-TXbH4tw", title: "Neutral-Grip Pulldown Tutorial", channel: "Merrick Lincoln, DPT, CSCS" },
  chest_supported_row: { url: "https://www.youtube.com/watch?v=llFTFDwmGcw", title: "How to PROPERLY Incline Dumbbell Row (Chest Supported Row)", channel: "Colossus Fitness" },
  seated_row: { url: "https://www.youtube.com/watch?v=xQNrFHEMhI4", title: "Seated Cable Row | Exercise Guide", channel: "Bodybuilding.com" },
  rear_delt_fly: { url: "https://www.youtube.com/watch?v=lPt0GqwaqEw", title: "How To Do A PROPER Dumbbell Rear Delt Fly", channel: "Mind Pump TV" },
  db_curl: { url: "https://www.youtube.com/watch?v=3OZ2MT_5r3Q", title: "Dumbbell Bicep Curl", channel: "Bodybuilding.com" },
  incline_db_curl: { url: "https://www.youtube.com/watch?v=DCe8f6vMe9A", title: "Stop Screwing Up Incline Dumbbell Curls (PROPER FORM!)", channel: "ATHLEAN-X" },
  back_squat: { url: "https://www.youtube.com/watch?v=my0tLDaWyDU", title: "How To Squat Correctly (NO BACK PAIN)", channel: "Squat University" },
  hack_squat: { url: "https://www.youtube.com/watch?v=plv5ur26Q7A", title: "Hack Squat", channel: "Bodybuilding.com" },
  leg_press: { url: "https://www.youtube.com/watch?v=cDGOn-yfKJA", title: "How to do a Leg Press | Proper Form & Technique", channel: "NASM" },
  leg_extension: { url: "https://www.youtube.com/watch?v=xAUvXdHu1sI", title: "How to do the LEG EXTENSION properly (in just 80 seconds)", channel: "Tim Bullici" },
  hamstring_curl: { url: "https://www.youtube.com/watch?v=jxctD6fL_FQ", title: "Lying Leg Curls", channel: "Bodybuilding.com" },
  calf_raise: { url: "https://www.youtube.com/watch?v=MAMzF7iZNkc", title: "Standing Calf Raises", channel: "Bodybuilding.com" },
  flat_db_press: { url: "https://www.youtube.com/watch?v=Vc63DPUoA40", title: "Dumbbell Bench Press", channel: "Bodybuilding.com" },
  cable_chest_fly: { url: "https://www.youtube.com/watch?v=8Um35Es-ROE", title: "How To: Cable Fly (High-To-Low) || 3 GOLDEN RULES", channel: "ScottHermanFitness" },
  cable_biceps_curl: { url: "https://www.youtube.com/watch?v=16aEi1a68E0", title: "How to Do the Cable Biceps Curl With Perfect Form", channel: "Men's Health Muscle" },
  triceps_dips: { url: "https://www.youtube.com/watch?v=6MwtkyNC2ZY", title: "Training Tips: Dips Focusing On Triceps", channel: "Muscle & Strength" },
  pec_deck: { url: "https://www.youtube.com/watch?v=10hg4LAa7UQ", title: "How to Perform a Pec Deck Fly", channel: "Hunter Labrada" },
  seated_db_shoulder_press: { url: "https://www.youtube.com/watch?v=qEwKCR5JCog", title: "How To: Dumbbell Shoulder Press", channel: "ScottHermanFitness" },
  half_kneeling_cable_press: { url: "https://www.youtube.com/watch?v=6D-O-DfcfmY", title: "Half Kneeling Single Arm Cable Overhead Press", channel: "OPEX Fitness" },
  cable_lateral_raise: { url: "https://www.youtube.com/watch?v=hLrFCb1fm3w", title: "How To: Cable Side Lateral Raise", channel: "Physique Development" },
  single_arm_cable_row: { url: "https://www.youtube.com/watch?v=CrylzZHfO1c", title: "Single Arm Seated Cable Row", channel: "KAGED" },
  face_pull: { url: "https://www.youtube.com/watch?v=eTCBSFlCJ_s", title: "How to do a Face Pull | Proper Form & Technique", channel: "NASM" },
  bayesian_cable_curl: { url: "https://www.youtube.com/watch?v=8PXe7YNOfb4", title: "Bayesian Curls: How to in 3 Minutes", channel: "Leo Fanner" },
  bulgarian_split_squat: { url: "https://www.youtube.com/watch?v=hPlKPjohFS0", title: "The PERFECT Bulgarian Split Squat (Avoid These Errors!)", channel: "Squat University" },
  goblet_squat: { url: "https://www.youtube.com/watch?v=MeIiIdhvXT4", title: "How To: Goblet Squat", channel: "ScottHermanFitness" },
  cable_squat: { url: "https://www.youtube.com/watch?v=VdWQ6Dn-o2k", title: "How To: Low Cable Squat With Rope", channel: "Live Lean TV" },
  close_grip_pushup: { url: "https://www.youtube.com/watch?v=J0DnG1_S92I", title: "How To: Diamond Push-Up", channel: "ScottHermanFitness" },
  overhead_cable_triceps_extension: { url: "https://www.youtube.com/watch?v=57fWTQID-1Y", title: "How to PROPERLY Overhead Cable Tricep Extension", channel: "Colossus Fitness" },
};

export const BUILTIN_EXERCISES: Exercise[] = EX.map(e => (VIDEOS[e.id] ? { ...e, video: VIDEOS[e.id] } : e));

// ── The 4 starter programs ───────────────────────────────────────────────────────────────────────────────────
// Structure (exercise slots, sets, rep ranges, tempo) as published by Kian Deehan Fitness (Instagram reel "Stop
// training 5x a week if you're 25% body fat…"), ADAPTED (rev 2, 2026-10-07) to Geert's Marcy home gym — single weight
// stack with chest-press arms, pec deck, high + low pulley, leg extension/curl; NO bench, rack or leg press. Each slot
// keeps the original's muscle target; a dumbbell / body-weight option is a one-tap swap (altIds). Cues are our own.
// Rest isn't in the source → 90–150 s compounds / 60 s isolation.
const SRC = 'Kian Deehan Fitness — Instagram reel "Stop training 5x a week if you\'re 25% body fat" (adapted for a Marcy home gym)';
const T = '3:1:2:1';
const it = (exerciseId: string, sets: number, repsLo: number, repsHi: number, restSec: number, altIds?: string[]): RoutineItem =>
  ({ exerciseId, sets, repsLo, repsHi, restSec, tempo: T, ...(altIds ? { altIds } : {}) });

export const STARTER_REV = 2;
export const STARTER_ROUTINES: Routine[] = [
  { id: 'kd_push', name: 'Push', source: SRC, days: [], updatedAt: 0, items: [
    it('chest_press_machine', 4, 6, 8, 120),                                       // was incline DB press
    it('pec_deck', 3, 10, 12, 90),                                                 // was 2nd chest press → fly keeps 2 chest angles
    it('half_kneeling_cable_press', 3, 8, 10, 90, ['seated_db_shoulder_press']),   // was machine shoulder press
    it('cable_lateral_raise', 3, 12, 15, 60, ['db_lateral_raise']),
    it('cable_triceps_pushdown', 3, 12, 15, 60),
    it('overhead_cable_triceps_extension', 3, 12, 15, 60),
  ] },
  { id: 'kd_pull', name: 'Pull', source: SRC, days: [], updatedAt: 0, items: [
    it('lat_pulldown', 4, 8, 10, 120),
    it('single_arm_cable_row', 3, 8, 10, 90),                                      // was chest-supported row (needs a bench)
    it('seated_row', 3, 10, 12, 90),
    it('face_pull', 3, 12, 15, 60, ['rear_delt_fly']),                             // was rear delt fly
    it('cable_biceps_curl', 3, 10, 12, 60, ['db_curl']),                           // was DB curls
    it('bayesian_cable_curl', 3, 10, 12, 60),                                      // was incline DB curls (same stretched position)
  ] },
  { id: 'kd_legs', name: 'Legs', source: SRC, days: [], updatedAt: 0, items: [
    it('bulgarian_split_squat', 4, 6, 8, 120, ['goblet_squat']),                   // was back / hack squat
    it('cable_squat', 3, 10, 12, 90, ['goblet_squat']),                            // was leg press
    it('leg_extension', 3, 12, 15, 60),
    it('hamstring_curl', 3, 10, 12, 60),
    it('calf_raise', 4, 12, 15, 60),
  ] },
  { id: 'kd_upper', name: 'Upper', source: SRC, days: [], updatedAt: 0, items: [
    it('chest_press_machine', 4, 6, 8, 120),                                       // was flat DB press
    it('pec_deck', 3, 12, 15, 60),                                                 // was cable chest fly
    it('lat_pulldown_neutral', 3, 10, 12, 90),
    it('seated_row', 3, 10, 12, 90),
    it('cable_biceps_curl', 3, 12, 15, 60),
    it('close_grip_pushup', 3, 8, 10, 90, ['cable_triceps_pushdown']),             // was dips (no dip station)
  ] },
];

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────
export const STRENGTH_FILE = `${FileSystem.documentDirectory}runcoach-strength.json`;
export interface StrengthStore { v: 1; starterRev?: number; saveToHealth?: boolean; hkExtrasAsked?: boolean; voice?: boolean;   // voice = spoken set announcements in the session (default on)
  routines: Routine[]; customExercises: Exercise[]; sessions: StrengthSession[] }

let cache: StrengthStore | null = null;
let loading: Promise<StrengthStore> | null = null;   // one in-flight read shared by concurrent callers
let writeQ: Promise<unknown> = Promise.resolve();     // every write goes through this queue, in order

const fresh = (): StrengthStore => ({ v: 1, starterRev: STARTER_REV, routines: STARTER_ROUTINES.map(r => ({ ...r, days: [...r.days], items: r.items.map(i => ({ ...i })) })), customExercises: [], sessions: [] });
const writeFile = (st: StrengthStore) => FileSystem.writeAsStringAsync(STRENGTH_FILE, JSON.stringify(st));

/**
 * Read the store. A READ error (e.g. file protection while the phone is locked) is thrown — callers catch it —
 * and never resets anything; only an unparsable / wrong-shape file is set aside (.bad-…) and replaced.
 */
export function loadStrength(): Promise<StrengthStore> {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;
  loading = (async () => {
    try {
      const info = await FileSystem.getInfoAsync(STRENGTH_FILE);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(STRENGTH_FILE);   // throws → propagate, don't reset
        let j: any = null;
        try { j = JSON.parse(raw); } catch { j = null; }
        if (j && Array.isArray(j.routines)) {
          cache = { v: 1, starterRev: j.starterRev ?? 1, ...(typeof j.saveToHealth === 'boolean' ? { saveToHealth: j.saveToHealth } : {}), ...(j.hkExtrasAsked ? { hkExtrasAsked: true } : {}), ...(typeof j.voice === 'boolean' ? { voice: j.voice } : {}), routines: j.routines, customExercises: j.customExercises ?? [], sessions: j.sessions ?? [] };
          if ((cache.starterRev ?? 1) < STARTER_REV) {
            // The starter programs changed (rev 2 = adapted to the Marcy home gym): swap the EXERCISES of the stored
            // starter routines; keep their name, planned days and source, and every logged session.
            const byId = new Map(STARTER_ROUTINES.map(r => [r.id, r]));
            cache = { ...cache, starterRev: STARTER_REV, routines: cache.routines.map(r => {
              const st = byId.get(r.id);
              return st ? { ...r, source: st.source, items: st.items.map(i => ({ ...i, ...(i.altIds ? { altIds: [...i.altIds] } : {}) })), updatedAt: Date.now() } : r;
            }) };
            await writeFile(cache).catch(() => {});
          }
          return cache;
        }
        await FileSystem.copyAsync({ from: STRENGTH_FILE, to: `${STRENGTH_FILE}.bad-${Date.now()}` }).catch(() => {});
      }
      const st = fresh();
      await writeFile(st).catch(() => {});
      cache = st;
      return st;
    } finally { loading = null; }
  })();
  return loading;
}
/**
 * The ONLY way to change the store: `fn` is applied to the LATEST data inside the write queue, so two screens (or
 * a screen holding an older copy) can never overwrite each other's sessions. Resolves with the new store.
 */
export function updateStrength(fn: (s: StrengthStore) => StrengthStore): Promise<StrengthStore> {
  const p = writeQ.then(async () => {
    const cur = await loadStrength();
    const next = fn(cur);
    cache = next;
    await writeFile(next).catch(() => {});
    return next;
  });
  writeQ = p.catch(() => {});
  return p;
}
/** After a restore wrote a new file. */
export function clearStrengthCache(): void { cache = null; }

export function allExercises(s: StrengthStore): Exercise[] { return [...BUILTIN_EXERCISES, ...s.customExercises]; }
export function exerciseById(s: StrengthStore, id: string): Exercise | undefined { return allExercises(s).find(e => e.id === id); }

export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
export const localDateKey = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ── Planning ─────────────────────────────────────────────────────────────────────────────────────────────────
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function routinesForDate(s: StrengthStore, date = new Date()): Routine[] {
  const dow = date.getDay();
  return s.routines.filter(r => r.days.includes(dow));
}
export function sessionsOn(s: StrengthStore, dateKey: string): StrengthSession[] {
  return s.sessions.filter(x => x.date === dateKey && x.finishedAt);
}
/** Rough duration: ~40 s per set + the rest after each set but the last of an exercise. */
export function estimateMinutes(r: Routine): number {
  const sec = r.items.reduce((a, i) => a + i.sets * 40 + Math.max(0, i.sets - 1) * i.restSec + 60, 0);
  return Math.round(sec / 60);
}

/** The rep range in order — the editor saves each bound as typed, so lo > hi can occur mid-edit. */
export const repRange = (i: RoutineItem): [number, number] => [Math.min(i.repsLo, i.repsHi), Math.max(i.repsLo, i.repsHi)];

// ── Progression (double progression, 3-session stable rule) ─────────────────────────────────────────────────────────────────────────
/** The last finished session's completed sets for this exercise (newest first). */
export function lastSetsFor(s: StrengthStore, exerciseId: string): SetLog[] {
  const done = s.sessions.filter(x => x.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const x of done) {
    const sets = x.sets.filter(l => l.exerciseId === exerciseId && isWorkSet(l));
    if (sets.length) return sets;
  }
  return [];
}
/** Weight increment for manual steps and deloads: dumbbell racks go in 2 kg steps; stacks/plates 2.5. */
export const weightStep = (ex?: Exercise) => (ex && /\bDB\b|Dumbbell/i.test(ex.name) ? 2 : 2.5);
/** The last `n` finished sessions' WORK sets of this exercise (newest first), one entry per session, with its feel. */
export function recentSetsFor(s: StrengthStore, exerciseId: string, n: number): { sets: SetLog[]; feel?: Feel }[] {
  const out: { sets: SetLog[]; feel?: Feel }[] = [];
  for (const x of s.sessions.filter(q => q.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))) {
    const sets = x.sets.filter(l => l.exerciseId === exerciseId && isWorkSet(l));
    if (sets.length) { out.push({ sets, feel: x.feel?.[exerciseId] }); if (out.length >= n) break; }
  }
  return out;
}
// Progression rules (Geert, 2026-10-08): raise ONLY after 3 sessions in a row that were STABLE — every planned set at
// the top of the rep range at the same weight, and not graded 'hard'; in steps of 5, 2.5 or 1 kg, the largest within
// ~8 % of the load (12.5 kg → +1, 31.25 → +2.5, 62.5 → +5; first asked 5 %, "too little" once seen).
export const STABLE_SESSIONS = 3;
export const RAISE_MAX_FRAC = 0.08;
export const RAISE_STEPS = [5, 2.5, 1];
/** The largest allowed raise for a load (kg moved): 5 / 2.5 / 1 kg, within 8 %. 0 = even 1 kg would be > 8 %. */
export const raiseStep = (loadKg: number) => RAISE_STEPS.find(st => st <= loadKg * RAISE_MAX_FRAC + 1e-9) ?? 0;
/**
 * Suggested working weight:
 *  · the last 3 sessions of this exercise each did every planned set at the TOP of the rep range at the SAME weight
 *    (and none was graded 'hard') → raise by the largest of 5 / 2.5 / 1 kg within 8 % of the load (body-weight moves:
 *    of body-weight share + added kg). When even 1 kg is more than 8 % (light loads) it says so and leaves it to you;
 *  · the per-exercise feel is OPTIONAL: without it the rule runs on reps/sets/weight alone;
 *  · fell short of the BOTTOM of the range at failure (RIR 0) on ≥ half the sets → −1 step;
 *  · otherwise repeat the weight (and say how far along the 3-session streak is).
 */
export function suggestWeight(s: StrengthStore, item: RoutineItem): { kg?: number; why?: string } {
  const hist = recentSetsFor(s, item.exerciseId, STABLE_SESSIONS);
  const last = hist[0]?.sets;
  if (!last) return item.weightKg != null ? { kg: item.weightKg } : {};
  const top = Math.max(...last.map(l => l.weightKg));
  const atTop = last.filter(l => l.weightKg === top);
  const ex = exerciseById(s, item.exerciseId);
  const step = weightStep(ex);
  const [lo, hi] = repRange(item);
  const r4 = (x: number) => Math.round(x * 4) / 4;
  const reps = atTop.map(l => `${l.reps}${l.rir != null ? `@${l.rir >= 3 ? '3+' : l.rir}` : ''}`).join('/');
  // stable = this session's heaviest weight is the same `top`, and every planned set reached the top of the range there
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const stable = ({ sets, feel }: { sets: SetLog[]; feel?: Feel }) => {
    if (feel === 'hard') return false;   // graded hard → not yet stable, whatever the reps
    const t = Math.max(...sets.map(l => l.weightKg));
    // ≥ the planned number of sets at that weight reached the top of the range (an extra/AMRAP set doesn't spoil it)
    return same(t, top) && sets.filter(l => same(l.weightKg, t) && l.reps >= hi).length >= item.sets;
  };
  let streak = 0;
  for (const h of hist) { if (stable(h)) streak++; else break; }
  if (streak >= STABLE_SESSIONS) {
    const bodyKg = s.sessions.filter(q => q.finishedAt && q.bodyKg).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]?.bodyKg ?? 80;
    const load = ex?.bodyweightFrac ? bodyKg * ex.bodyweightFrac + top : top;
    const assisted = !!ex?.bodyweightFrac && top < 0;
    if (load <= 0) return { kg: top, why: `${STABLE_SESSIONS} stable sessions at ${top} kg — reduce the assistance yourself in the kg field` };
    const up = raiseStep(load);
    if (up > 0) return { kg: r4(top + up), why: `${STABLE_SESSIONS} sessions in a row: ${item.sets}×${hi} at ${top} kg → ${assisted ? `${up} kg less assistance` : `+${up} kg`} (${Math.round((up / load) * 1000) / 10}%)` };
    return { kg: top, why: `${STABLE_SESSIONS} stable sessions at ${top} kg — ready to go up, but +1 kg is more than 8% of ${Math.round(load * 10) / 10} kg; type the heavier weight in the kg field if you want it` };
  }
  // ≥ half the sets fell short of the range AT FAILURE → lighter. Body-weight moves store ASSISTANCE as negative kg,
  // so "lighter" = more assistance (−20 → −22.5), never clamped to 0 (which would remove the assistance).
  if (atTop.filter(l => l.reps < lo && l.rir === 0).length * 2 >= atTop.length) {
    const next = ex?.bodyweightFrac ? top - step : Math.max(0, top - step);
    return { kg: r4(next), why: `missed ${lo} reps at failure last time (${reps} at ${top} kg) → ${ex?.bodyweightFrac ? `${step} kg more assistance` : `−${step} kg`}` };
  }
  if (hist[0].feel === 'hard') return { kg: top, why: `felt hard last time at ${top} kg — hold it until ${STABLE_SESSIONS} sessions in a row feel fine` };
  if (streak > 0) return { kg: top, why: `${streak}/${STABLE_SESSIONS} stable sessions at ${top} kg (${item.sets}×${hi}) — raise after ${STABLE_SESSIONS} in a row` };
  return { kg: top, why: `last time ${reps} reps at ${top} kg — aim for ${hi} on every set, ${STABLE_SESSIONS} sessions in a row` };
}

/**
 * Grade (or re-grade / clear) how an exercise felt in a session — during it or any time after. For a finished session
 * the routine's auto-update is re-run, so a raise that a later 'hard' rules out is taken back (and vice versa).
 */
export function setExerciseFeel(sessionId: string, exerciseId: string, feel: Feel | undefined): Promise<StrengthStore> {
  return updateStrength(cur => {
    const sessions = cur.sessions.map(x => {
      if (x.id !== sessionId) return x;
      const f = { ...(x.feel ?? {}) };
      if (feel) f[exerciseId] = feel; else delete f[exerciseId];
      return { ...x, feel: f };
    });
    const next = { ...cur, sessions };
    // only the GRADED exercise's planned weight follows — every other item keeps what it has (hand-typed weights too)
    const upd = autoUpdatedRoutine(next, sessionId);
    if (!upd) return next;
    return { ...next, routines: next.routines.map(r => r.id !== upd.routine.id ? r
      : { ...r, items: r.items.map((it, k) => it.exerciseId === exerciseId ? upd.routine.items[k] : it) }) };
  });
}

/**
 * Auto-update (Bevel "Auto Update Template"): after a finished session, each item of the routine that was performed
 * gets its planned weight moved to the suggested next weight. Returns what changed (for the finish summary).
 */
export function autoUpdatedRoutine(s: StrengthStore, sessionId: string): { routine: Routine; changes: string[] } | null {
  const x = s.sessions.find(q => q.id === sessionId);
  const r = x && s.routines.find(q => q.id === x.routineId);
  if (!x?.finishedAt || !r || r.autoUpdate === false) return null;
  const changes: string[] = [];
  const items = r.items.map(it => {
    // the exercise actually done for this slot (it may have been swapped to an alternative)
    // only the slot's OWN exercise moves its target — a swapped-in alternative has its own history and weights
    const id = x.sets.some(l => l.exerciseId === it.exerciseId && isWorkSet(l)) ? it.exerciseId : undefined;
    if (!id) return it;
    const sug = suggestWeight(s, { ...it, exerciseId: id });
    if (sug.kg == null || sug.kg === it.weightKg) return it;
    changes.push(`${exerciseById(s, id)?.name ?? id}: ${it.weightKg ?? '–'} → ${sug.kg} kg`);
    return { ...it, weightKg: sug.kg };
  });
  return changes.length ? { routine: { ...r, items, updatedAt: Date.now() }, changes } : null;
}

// ── Muscle load ──────────────────────────────────────────────────────────────────────────────────────────────
export interface MuscleLoad { muscle: Muscle; tonnageKg: number; hardSets: number }
/** Per-muscle load of a list of sessions (completed sets only). */
export function muscleLoad(s: StrengthStore, sessions: StrengthSession[], fallbackBodyKg = 80): MuscleLoad[] {
  const acc = new Map<Muscle, { t: number; h: number }>();
  for (const x of sessions) {
    for (const l of x.sets) {
      if (!isWorkSet(l)) continue;
      const ex = exerciseById(s, l.exerciseId);
      if (!ex) continue;
      const load = Math.max(0, (l.weightKg || 0) + (ex.bodyweightFrac ? ex.bodyweightFrac * (x.bodyKg ?? fallbackBodyKg) : 0));
      for (const [m, inv] of Object.entries(ex.muscles) as [Muscle, number][]) {
        const a = acc.get(m) ?? { t: 0, h: 0 };
        a.t += load * l.reps * inv;
        a.h += inv;
        acc.set(m, a);
      }
    }
  }
  return [...acc.entries()].map(([muscle, a]) => ({ muscle, tonnageKg: Math.round(a.t), hardSets: Math.round(a.h * 10) / 10 }))
    .sort((a, b) => b.hardSets - a.hardSets || b.tonnageKg - a.tonnageKg);
}
export function sessionsWithinDays(s: StrengthStore, days: number, now = new Date()): StrengthSession[] {
  const from = new Date(now); from.setDate(from.getDate() - (days - 1));
  const fromKey = localDateKey(from);
  return s.sessions.filter(x => x.finishedAt && x.date >= fromKey);
}
/** Session tonnage (all muscles, external + body-weight share) — the headline number on a finished session. */
export function sessionTonnage(s: StrengthStore, x: StrengthSession, fallbackBodyKg = 80): number {
  let t = 0;
  for (const l of x.sets) {
    if (!isWorkSet(l)) continue;
    const ex = exerciseById(s, l.exerciseId);
    t += Math.max(0, (l.weightKg || 0) + (ex?.bodyweightFrac ? ex.bodyweightFrac * (x.bodyKg ?? fallbackBodyKg) : 0)) * l.reps;
  }
  return Math.round(t);
}

// ── LLM context (appModel) ───────────────────────────────────────────────────────────────────────────────────
/** One compact line: planned strength days, last 7 days' sessions and the most-loaded muscles. '' when unused. */
export async function strengthLineForLLM(): Promise<string> {
  const st = await loadStrength();
  const planned = st.routines.filter(r => r.days.length).map(r => `${r.name} (${r.days.slice().sort().map(d => WEEKDAYS[d]).join('/')})`);
  const week = sessionsWithinDays(st, 7);
  if (!planned.length && !week.length) return '';
  const top = muscleLoad(st, week).slice(0, 6).map(l => `${MUSCLE_LABEL[l.muscle]} ${l.hardSets}`).join(', ');
  // leg freshness (strength + runs) — the part that matters for tomorrow's run
  // lazy require: keeps strength.ts out of the healthkit ↔ claude ↔ appModel import cycle
  const { loadSnapshotCache } = require('./healthkit') as typeof import('./healthkit');
  const runs = ((await loadSnapshotCache().catch(() => null))?.runs ?? []) as RunLike[];
  const legs = muscleFreshness(muscleEvents(st, runs)).filter(f => ['quads', 'glutes', 'hamstrings', 'calves'].includes(f.muscle))
    .map(f => `${MUSCLE_LABEL[f.muscle]} ${f.state === 'Calibrating' ? 'calibrating' : `${f.pct}% ${f.state.toLowerCase()}`}`).join(', ');
  return `• STRENGTH (athlete-logged sessions on a Marcy home gym, separate from running): planned ${planned.join(', ') || 'none'}; last 7 days ${week.length} session${week.length === 1 ? '' : 's'}${week.length ? ` (${week.map(x => `${x.date.slice(5)} ${x.routineName}${x.rpe ? ` RPE ${x.rpe}` : ''}`).join('; ')})` : ''}${top ? `; hard sets/muscle: ${top}` : ''}; leg freshness now: ${legs}. Strength load is NOT in CTL/ATL (it has its own muscular load) — account for heavy LEG days and low leg freshness before quality and long runs.`;
}

// ════ Build 2 (2026-10-07): records, muscle freshness, muscular-load status — Bevel 2026 Fall-release parity ════

// ── Personal records / estimated 1RM ─────────────────────────────────────────────────────────────────────────
/** Load actually moved on a set: external kg + the body-weight share (dips, split squats, push-ups…). */
export function setLoadKg(ex: Exercise | undefined, l: SetLog, bodyKg?: number): number {
  return Math.max(0, (l.weightKg || 0) + (ex?.bodyweightFrac ? ex.bodyweightFrac * (bodyKg ?? 80) : 0));
}
/**
 * Epley e1RM. With effort logged it's effort-adjusted (Bevel-style): reps + reps-in-reserve = reps to failure, so a
 * set of 8 with 2 in reserve counts like 10. Beyond 12 (or 15 effort-adjusted) reps to failure → null (too far to
 * extrapolate to a single).
 */
export function e1rm(loadKg: number, reps: number, rir?: number): number | null {
  const toFail = reps + (rir != null ? Math.min(rir, 3) : 0);
  if (loadKg <= 0 || reps <= 0 || toFail > (rir != null ? 15 : 12)) return null;
  return toFail === 1 ? loadKg : Math.round(loadKg * (1 + toFail / 30) * 10) / 10;
}
export interface ExerciseSessionStat { feel?: Feel; bestReps?: number; bodyKg?: number; sessionId: string; date: string; at: number; topKg: number; bestE1rm: number | null; bestSetVol: number; volume: number; sets: number }
/** Per finished session: the exercise's top weight, best e1RM, best single-set volume and total volume. */
export function exerciseHistory(s: StrengthStore, exerciseId: string): ExerciseSessionStat[] {
  const ex = exerciseById(s, exerciseId);
  const out: ExerciseSessionStat[] = [];
  for (const x of s.sessions) {
    if (!x.finishedAt) continue;
    const sets = x.sets.filter(l => l.exerciseId === exerciseId && isWorkSet(l));
    if (!sets.length) continue;
    let topKg = -Infinity, bestE = 0, bestV = 0, vol = 0;
    for (const l of sets) {
      const kg = setLoadKg(ex, l, x.bodyKg);
      topKg = Math.max(topKg, ex?.bodyweightFrac ? l.weightKg : kg);   // body-weight moves: "heaviest" = added kg (−20 → −15 = less assistance)
      bestE = Math.max(bestE, e1rm(kg, l.reps, l.rir) ?? 0);
      bestV = Math.max(bestV, kg * l.reps);
      vol += kg * l.reps;
    }
    out.push({ feel: x.feel?.[exerciseId], bestReps: Math.max(...sets.map(l => l.reps)), bodyKg: x.bodyKg, sessionId: x.id, date: x.date, at: x.finishedAt, topKg, bestE1rm: bestE || null, bestSetVol: Math.round(bestV), volume: Math.round(vol), sets: sets.length });
  }
  return out.sort((a, b) => a.at - b.at);
}
// ── Stats (exercise list + Strength stats screen) ─────────────────────────────────────────────────────────────
/** One line of stats per exercise for the list: last top weight × reps, e1RM, its trend over the last 8 weeks. */
export interface ExerciseStatLine { sessions: number; lastAt: number; lastTop: number; lastReps: number; e1rm: number | null; bestE1rm: number | null; trendPct: number | null; spark: number[] }
export function exerciseStatLine(s: StrengthStore, exerciseId: string): ExerciseStatLine | null {
  const h = exerciseHistory(s, exerciseId);
  if (!h.length) return null;
  const last = h[h.length - 1];
  const lastSess = s.sessions.find(x => x.id === last.sessionId);
  const lastSets = lastSess?.sets.filter(l => l.exerciseId === exerciseId && isWorkSet(l)) ?? [];
  const lastReps = Math.max(0, ...lastSets.filter(l => l.weightKg === Math.max(...lastSets.map(q => q.weightKg))).map(l => l.reps));
  const e = h.filter(x => x.bestE1rm != null);
  // e1RM change over the last 8 weeks: OLS over those sessions (≥ 3), as % of the fitted start (same idea as the
  // cardio Efficiency Trends) — null when there isn't enough to call a trend
  const recent = e.filter(x => x.at >= Date.now() - 56 * 86_400_000).map(x => x.bestE1rm!);
  let trendPct: number | null = null;
  if (recent.length >= 3) {
    const n = recent.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    recent.forEach((v, i) => { sx += i; sy += v; sxx += i * i; sxy += i * v; });
    const den = n * sxx - sx * sx;
    if (den) { const m = (n * sxy - sx * sy) / den, b0 = (sy - m * sx) / n; if (b0 > 0) trendPct = Math.round((m * (n - 1) / b0) * 1000) / 10; }
  }
  return { sessions: h.length, lastAt: last.at, lastTop: last.topKg, lastReps, e1rm: last.bestE1rm, bestE1rm: e.length ? Math.max(...e.map(x => x.bestE1rm!)) : null,
    trendPct, spark: e.slice(-12).map(x => x.bestE1rm!) };
}
/** Per finished session: when, tonnage, work sets, hard sets per load area, RPE — the Strength stats series. */
export interface SessionStat { t: number; tonnage: number; sets: number; rpe?: number; areaSets: Record<string, number> }
export function sessionStats(s: StrengthStore): SessionStat[] {
  return s.sessions.filter(x => x.finishedAt).sort((a, b) => a.startedAt - b.startedAt).map(x => {
    const areaSets: Record<string, number> = {};
    for (const l of x.sets.filter(isWorkSet)) {
      const ex = exerciseById(s, l.exerciseId);
      for (const g of LOAD_GROUPS) {
        if (g.key === 'body') continue;
        const inv = g.muscles.reduce((m, mu) => Math.max(m, ex?.muscles[mu] ?? 0), 0);   // the area's main muscle involvement
        if (inv > 0) areaSets[g.key] = (areaSets[g.key] ?? 0) + inv;
      }
    }
    return { t: x.startedAt, tonnage: sessionTonnage(s, x), sets: x.sets.filter(isWorkSet).length, rpe: x.rpe, areaSets };
  });
}

export interface PrHit { exerciseId: string; name: string; kind: 'e1RM' | 'Heaviest' | 'Set volume' | 'Volume'; value: number; prev: number }
/** PRs this (finished) session set vs every EARLIER session — first-ever sessions don't count as PRs. */
export function sessionPRs(s: StrengthStore, sessionId: string): PrHit[] {
  const sess = s.sessions.find(x => x.id === sessionId);
  if (!sess?.finishedAt) return [];
  const ids = [...new Set(sess.sets.filter(isWorkSet).map(l => l.exerciseId))];
  const hits: PrHit[] = [];
  for (const id of ids) {
    const h = exerciseHistory(s, id);
    const cur = h.find(x => x.sessionId === sessionId);
    const prior = h.filter(x => x.at < sess.finishedAt!);
    if (!cur || !prior.length) continue;
    const name = exerciseById(s, id)?.name ?? id;
    const best = (f: (x: ExerciseSessionStat) => number) => Math.max(...prior.map(f));
    const e = best(x => x.bestE1rm ?? 0);
    if ((cur.bestE1rm ?? 0) > e && e > 0) hits.push({ exerciseId: id, name, kind: 'e1RM', value: cur.bestE1rm!, prev: e });
    else if (cur.topKg > best(x => x.topKg)) hits.push({ exerciseId: id, name, kind: 'Heaviest', value: cur.topKg, prev: best(x => x.topKg) });
    else if (cur.bestSetVol > best(x => x.bestSetVol)) hits.push({ exerciseId: id, name, kind: 'Set volume', value: cur.bestSetVol, prev: best(x => x.bestSetVol) });
  }
  return hits;
}

// ── Muscle load units over time (strength sets + runs) ────────────────────────────────────────────────────────
// One "unit" = one hard set for that muscle. Strength: Σ involvement per completed set × session effort (RPE/8,
// 0.75–1.25). Runs load the legs too (Bevel: cardio contributes muscular load): per 10 min, calves 0.5, quads 0.4,
// hamstrings 0.3, glutes 0.3, adductors 0.15, × intensity (avg HR / max HR: 70 % → 1.0 rising smoothly to 1.6 at 90 %).
export interface RunLike { date: string; duration: number; avgHeartRate?: number }
export interface MuscleEvent { at: number; units: Partial<Record<Muscle, number>>; kind: 'strength' | 'run' }
const RUN_LEGS: Partial<Record<Muscle, number>> = { calves: 0.5, quads: 0.4, hamstrings: 0.3, glutes: 0.3, adductors: 0.15 };
export function muscleEvents(s: StrengthStore, runs: RunLike[], maxHr = 188, sinceMs = Date.now() - 150 * 86_400_000): MuscleEvent[] {
  const ev: MuscleEvent[] = [];
  for (const x of s.sessions) {
    if (!x.finishedAt || x.finishedAt < sinceMs) continue;
    const eff = x.rpe ? Math.max(0.75, Math.min(1.25, x.rpe / 8)) : 1;
    const u: Partial<Record<Muscle, number>> = {};
    for (const l of x.sets) {
      if (!isWorkSet(l)) continue;
      const ex = exerciseById(s, l.exerciseId);
      for (const [m, inv] of Object.entries(ex?.muscles ?? {}) as [Muscle, number][]) u[m] = (u[m] ?? 0) + inv * eff;
    }
    ev.push({ at: x.finishedAt, units: u, kind: 'strength' });
  }
  for (const r of runs) {
    const end = new Date(r.date).getTime() + (r.duration || 0) * 1000;
    if (!(end >= sinceMs) || !(r.duration > 0)) continue;
    const rel = r.avgHeartRate && maxHr ? r.avgHeartRate / maxHr : 0.7;
    const f = (r.duration / 600) * (1 + 0.6 * Math.max(0, Math.min(1, (rel - 0.7) / 0.2)));   // 70 % HRmax → ×1.0 … 90 % → ×1.6, smooth
    const u: Partial<Record<Muscle, number>> = {};
    for (const [m, w] of Object.entries(RUN_LEGS) as [Muscle, number][]) u[m] = w * f;
    ev.push({ at: end, units: u, kind: 'run' });
  }
  return ev.sort((a, b) => a.at - b.at);
}

// ── Muscle freshness (per muscle, 0–100 %) ────────────────────────────────────────────────────────────────────
// Fatigue = Σ units × e^(−hours/τ), τ by muscle size (small ~20 h, upper-body large ~28 h, legs ~34 h → ~90 %
// recovered after ~2 / 2.5 / 3 days). Referenced to the athlete's OWN normal: F_ref = max(5 × their time-averaged
// fatigue over 6 weeks (so habitual load reads ~80 %), 1.2 × the biggest single session, 3). Bands as Bevel: ≥75 Recovered, 35–75 Fatigued, <35
// Depleted; < 3 loading events in 6 weeks → Calibrating.
const TAU_H: Record<Muscle, number> = {
  biceps: 20, triceps: 20, forearms: 20, side_delts: 20, rear_delts: 20, front_delts: 22, calves: 22, abs: 20,
  chest: 28, lats: 28, upper_back: 28, traps: 26, lower_back: 34, quads: 34, glutes: 34, hamstrings: 34, adductors: 30,
};
export type FreshState = 'Recovered' | 'Fatigued' | 'Depleted' | 'Calibrating';
export interface MuscleFresh { muscle: Muscle; pct: number; state: FreshState; events: number }
export function muscleFreshness(allEvents: MuscleEvent[], now = Date.now()): MuscleFresh[] {
  const H = 3_600_000, from = now - 42 * 86_400_000;
  const events = allEvents.filter(e => e.at >= from - 14 * 86_400_000);   // 6 weeks + the 14-day decay tail
  const fatigueAt = (m: Muscle, t: number) => events.reduce((a, e) => (e.at <= t && t - e.at < 14 * 86_400_000 ? a + (e.units[m] ?? 0) * Math.exp(-(t - e.at) / H / TAU_H[m]) : a), 0);
  return MUSCLES.map(m => {
    const evs = events.filter(e => e.at >= from && (e.units[m] ?? 0) >= 0.3);
    const cur = fatigueAt(m, now);
    if (evs.length < 3) return { muscle: m, pct: Math.round(100 * Math.max(0, Math.min(1, 1 - cur / 6))), state: 'Calibrating' as FreshState, events: evs.length };
    // your HABITUAL fatigue: time-averaged over 6 weeks (every 3 h — independent of when you train)
    let sum = 0, n = 0;
    for (let t = now - 42 * 86_400_000; t < now; t += 3 * H) { sum += fatigueAt(m, t); n++; }
    const habitual = sum / Math.max(1, n);
    const biggest = Math.max(...evs.map(e => e.units[m] ?? 0));   // your biggest single dose (runs are many small ones)
    // habitual load reads ~80 % (Recovered); only ABOVE-normal load reads Fatigued/Depleted
    const ref = Math.max(5 * habitual, 1.2 * biggest, 3);
    const pct = Math.round(100 * Math.max(0, Math.min(1, 1 - cur / ref)));
    return { muscle: m, pct, state: (pct >= 75 ? 'Recovered' : pct >= 35 ? 'Fatigued' : 'Depleted') as FreshState, events: evs.length };
  });
}

// ── Muscular load status (7 d vs 6-week average) ──────────────────────────────────────────────────────────────
export const LOAD_GROUPS: { key: string; label: string; muscles: Muscle[] }[] = [
  { key: 'body', label: 'Whole body', muscles: MUSCLES },
  { key: 'push', label: 'Upper — push', muscles: ['chest', 'front_delts', 'side_delts', 'triceps'] },
  { key: 'pull', label: 'Upper — pull', muscles: ['lats', 'upper_back', 'rear_delts', 'traps', 'biceps', 'forearms'] },
  { key: 'legs', label: 'Legs', muscles: ['quads', 'glutes', 'hamstrings', 'adductors', 'calves'] },
  { key: 'core', label: 'Core', muscles: ['abs', 'lower_back'] },
];
export type LoadStatus = 'Detraining' | 'Maintaining' | 'Productive' | 'Peaking' | 'Overtraining' | 'Calibrating';
export interface GroupLoad { key: string; label: string; acute: number; chronicWk: number; ratio: number | null; status: LoadStatus; days: number }
/**
 * Acute vs chronic as EXPONENTIALLY-weighted daily load (τ 7 d / 42 d) — the same ATL/CTL method as the cardio load,
 * so the two agree. A flat 6-week mean let a holiday (two ~zero weeks) drag the baseline down and read the RETURN to
 * normal running as "Overtraining" (Geert, 2026-10-07: legs ×1.59 on an ordinary week). Needs ≥ 28 days of history
 * and ≥ 10 (body) / 6 (group) training days in the last 6 weeks, else Calibrating.
 */
export function muscularLoad(events: MuscleEvent[], now = Date.now()): GroupLoad[] {
  // Areas first; WHOLE BODY then sums only the areas that have finished calibrating — a brand-new area (first upper-body
  // sessions after months of running only) has no baseline yet, and adding its load to the total read the first gym
  // session as whole-body "Overtraining" (×1.65 while legs were ×1.17). It joins once it has its own baseline.
  const areas = LOAD_GROUPS.filter(g => g.key !== 'body').map(g => groupLoad(events, now, g));
  const calibrated = new Set(areas.filter(a => a.status !== 'Calibrating').map(a => a.key));
  const bodyMuscles = LOAD_GROUPS.filter(g => calibrated.has(g.key)).flatMap(g => g.muscles);
  const body = LOAD_GROUPS.find(g => g.key === 'body')!;
  const whole = bodyMuscles.length
    ? { ...groupLoad(events, now, { ...body, muscles: bodyMuscles }), label: calibrated.size < areas.length ? 'Whole body*' : body.label }
    : { key: 'body', label: body.label, acute: 0, chronicWk: 0, ratio: null, status: 'Calibrating' as LoadStatus, days: 0 };
  return [whole, ...areas];
}
function groupLoad(events: MuscleEvent[], now: number, g: { key: string; label: string; muscles: Muscle[] }): GroupLoad {
  const D = 86_400_000, La = 1 - Math.exp(-1 / 7), Lc = 1 - Math.exp(-1 / 42);
  const dayIdx = (t: number) => Math.floor((now - t) / D);   // 0 = last 24 h
  {
    const u = (e: MuscleEvent) => g.muscles.reduce((a, m) => a + (e.units[m] ?? 0), 0);
    const mine = events.filter(e => e.at <= now && u(e) > 0.3);
    const days = new Set(mine.filter(e => now - e.at < 42 * D).map(e => new Date(e.at).toDateString())).size;
    const span = mine.length ? dayIdx(Math.min(...mine.map(e => e.at))) + 1 : 0;
    const daily = new Array(Math.max(span, 1)).fill(0);
    for (const e of mine) daily[dayIdx(e.at)] += u(e);
    // seed both averages at the level of the OLDEST 4 weeks (not 0) — the 42-day EWMA would otherwise need ~4 months
    // of warm-up and read every week as a spike
    const seedDays = daily.slice(-28);
    let atl = seedDays.reduce((a, b) => a + b, 0) / Math.max(1, seedDays.length), ctl = atl;
    for (let d = daily.length - 1; d >= 0; d--) { atl += La * (daily[d] - atl); ctl += Lc * (daily[d] - ctl); }
    const need = g.key === 'body' && g.muscles.length === MUSCLES.length ? 10 : 6;   // a partial whole body = an area
    if (span < 28 || days < need || ctl <= 0) return { key: g.key, label: g.label, acute: Math.round(atl * 7), chronicWk: Math.round(ctl * 7), ratio: null, status: 'Calibrating' as LoadStatus, days };
    const ratio = Math.round((atl / ctl) * 100) / 100;
    const status: LoadStatus = ratio < 0.8 ? 'Detraining' : ratio < 1.0 ? 'Maintaining' : ratio <= 1.3 ? 'Productive' : ratio <= 1.5 ? 'Peaking' : 'Overtraining';
    return { key: g.key, label: g.label, acute: Math.round(atl * 7), chronicWk: Math.round(ctl * 7), ratio, status, days };
  }
}
// ── Exercise chart metrics (Bevel: e1RM · heaviest · volume · sets · reps) + relative strength ────────────────
export type ExMetric = 'e1rm' | 'heaviest' | 'volume' | 'sets' | 'reps' | 'rel';
export const EX_METRIC_LABEL: Record<ExMetric, string> = { e1rm: 'Est. 1RM', heaviest: 'Heaviest', volume: 'Volume', sets: 'Sets', reps: 'Best reps', rel: '× body weight' };
/** One point per session for the chosen metric (rel = e1RM ÷ body weight; sessions without a weight are skipped). */
export function exerciseMetricSeries(s: StrengthStore, exerciseId: string, m: ExMetric): { t: number; v: number; sessionId: string }[] {
  const fallbackKg = s.sessions.filter(x => x.bodyKg).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]?.bodyKg;
  return exerciseHistory(s, exerciseId).map(x => {
    const v = m === 'e1rm' ? x.bestE1rm : m === 'heaviest' ? x.topKg : m === 'volume' ? x.volume : m === 'sets' ? x.sets
      : m === 'reps' ? (x.bestReps ?? null) : (x.bestE1rm != null && (x.bodyKg ?? fallbackKg) ? Math.round((x.bestE1rm / (x.bodyKg ?? fallbackKg)!) * 100) / 100 : null);
    return { t: x.at, v: v as number, sessionId: x.sessionId, ok: v != null && Number.isFinite(v) };
  }).filter(p => p.ok).map(({ t, v, sessionId }) => ({ t, v, sessionId }));
}

/** Weekly work sets by reps-in-reserve: 0 (failure) / 1 / 2 / 3+ / not rated — creeping grind or sandbagging shows. */
export interface RirWeek { wk: number; r0: number; r1: number; r2: number; r3: number; none: number }
export function rirWeekly(s: StrengthStore, weeks = 12, now = Date.now()): RirWeek[] {
  const monday = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const out = new Map<number, RirWeek>();
  const d0 = new Date(monday(now)); d0.setDate(d0.getDate() - 7 * (weeks - 1));   // calendar weeks back (DST-safe, not ms)
  for (let k = 0; k < weeks; k++) { const wk = new Date(d0); wk.setDate(wk.getDate() + 7 * k); out.set(monday(wk.getTime()), { wk: monday(wk.getTime()), r0: 0, r1: 0, r2: 0, r3: 0, none: 0 }); }
  for (const x of s.sessions) {
    if (!x.finishedAt) continue;
    const w = out.get(monday(x.finishedAt));
    if (!w) continue;
    for (const l of x.sets.filter(isWorkSet)) {
      if (l.rir == null) w.none++; else if (l.rir <= 0) w.r0++; else if (l.rir === 1) w.r1++; else if (l.rir === 2) w.r2++; else w.r3++;
    }
  }
  return [...out.values()];
}

/** One session, broken down: muscle units (as the load model counts them), per exercise sets/reps/top kg/feel, PRs. */
export interface SessionBreakdown {
  muscles: Partial<Record<Muscle, number>>;
  exercises: { exerciseId: string; name: string; sets: number; reps: string; topKg: number; load: string; volume: number; feel?: Feel }[];
  tonnage: number; workSets: number; minutes: number; ticks: number[];
}
export function sessionBreakdown(s: StrengthStore, sessionId: string): SessionBreakdown | null {
  const x = s.sessions.find(q => q.id === sessionId);
  if (!x?.finishedAt) return null;
  const eff = x.rpe ? Math.max(0.75, Math.min(1.25, x.rpe / 8)) : 1;
  const muscles: Partial<Record<Muscle, number>> = {};
  const order: string[] = [];
  for (const l of x.sets.filter(isWorkSet)) {
    if (!order.includes(l.exerciseId)) order.push(l.exerciseId);
    for (const [m, inv] of Object.entries(exerciseById(s, l.exerciseId)?.muscles ?? {}) as [Muscle, number][]) muscles[m] = (muscles[m] ?? 0) + inv * eff;
  }
  const exercises = order.map(id => {
    const ex = exerciseById(s, id);
    const sets = x.sets.filter(l => l.exerciseId === id && isWorkSet(l));
    const reps = sets.map(l => l.reps);
    return { exerciseId: id, name: ex?.name ?? id, sets: sets.length, reps: Math.min(...reps) === Math.max(...reps) ? `${reps[0]}` : `${Math.min(...reps)}–${Math.max(...reps)}`,
      topKg: Math.max(...sets.map(l => l.weightKg)),
      // body-weight moves: the kg field is ADDED weight (− = assistance) → "BW", "BW+5", "BW−20"
      load: (() => { const t = Math.max(...sets.map(l => l.weightKg)); return ex?.bodyweightFrac ? (t === 0 ? 'BW' : `BW${t > 0 ? '+' : '−'}${Math.abs(t)}`) : `${t} kg`; })(),
      volume: Math.round(sets.reduce((a, l) => a + setLoadKg(ex, l, x.bodyKg) * l.reps, 0)), feel: x.feel?.[id] };
  });
  const r = s.routines.find(q => q.id === x.routineId);
  const win = strengthWindow(x, r);
  return { muscles, exercises, tonnage: sessionTonnage(s, x), workSets: x.sets.filter(isWorkSet).length,
    minutes: Math.round((win.end - win.start) / 60000), ticks: x.sets.filter(l => l.done && l.doneAt).map(l => l.doneAt!).sort((a, b) => a - b) };
}

/** Leg strength index per session: the mean of each leg exercise's e1RM as % of its first recorded e1RM (100 = start). */
export function legStrengthIndex(s: StrengthStore): { t: number; v: number }[] {
  const legIds = allExercises(s).filter(e => ((e.muscles.quads ?? 0) + (e.muscles.hamstrings ?? 0) + (e.muscles.glutes ?? 0)) >= 1).map(e => e.id);
  // each exercise's LAST known % is carried forward, so alternating A/B routines (or a new exercise entering at 100 %)
  // doesn't make the line jump without any real strength change
  const first = new Map<string, number>(), lastPct = new Map<string, number>();
  const out: { t: number; v: number }[] = [];
  for (const x of s.sessions.filter(q => q.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)) {
    let any = false;
    for (const id of legIds) {
      const best = Math.max(0, ...x.sets.filter(l => l.exerciseId === id && isWorkSet(l)).map(l => e1rm(setLoadKg(exerciseById(s, id), l, x.bodyKg), l.reps, l.rir) ?? 0));
      if (!(best > 0)) continue;
      if (!first.has(id)) first.set(id, best);
      lastPct.set(id, (best / first.get(id)!) * 100); any = true;
    }
    if (any) { const v = [...lastPct.values()]; out.push({ t: x.finishedAt!, v: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 }); }
  }
  return out;
}

// ── Over-time views (Strength stats: muscular load per area, leg-load timeline, records) ────────────────────
/** Daily muscular-load status per area over the last `days` days (ratio null while calibrating) — the strength PMC. */
export interface LoadPt { t: number; ratio: number | null; acute: number; chronic: number }
export function muscularLoadSeries(events: MuscleEvent[], days = 90, now = Date.now()): { key: string; label: string; pts: LoadPt[] }[] {
  const end = new Date(now); end.setHours(23, 59, 0, 0);
  return LOAD_GROUPS.filter(g => g.key !== 'body').map(g => {
    const pts: LoadPt[] = [];
    for (let k = days - 1; k >= 0; k--) {
      const t = Math.min(now, end.getTime() - k * 86_400_000);
      const gl = groupLoad(events, t, g);
      pts.push({ t, ratio: gl.ratio, acute: gl.acute, chronic: gl.chronicWk });
    }
    return { key: g.key, label: g.label, pts };
  });
}
const LEGS: Muscle[] = ['quads', 'hamstrings', 'glutes', 'calves', 'adductors'];
/**
 * Leg-load timeline: per day the leg units from RUNS vs from STRENGTH, plus leg freshness at the end of the day
 * (same decay + habitual-reference model as Muscle Freshness, for the legs as one group). Freshness reference is
 * computed once (now), so the line is comparable across days.
 */
export interface LegDay { t: number; run: number; strength: number; fresh: number }
export function legLoadDaily(events: MuscleEvent[], days = 28, now = Date.now()): LegDay[] {
  const H = 3_600_000, D = 86_400_000;
  const legsOf = (e: MuscleEvent) => LEGS.reduce((a, m) => a + (e.units[m] ?? 0), 0);
  const ev = events.filter(e => e.at >= now - (days + 56) * D && legsOf(e) > 0);
  const tau = LEGS.reduce((a, m) => a + TAU_H[m], 0) / LEGS.length;
  const fatigueAt = (t: number) => ev.reduce((a, e) => (e.at <= t && t - e.at < 14 * D ? a + legsOf(e) * Math.exp(-(t - e.at) / H / tau) : a), 0);
  let sum = 0, n = 0;
  for (let t = now - 42 * D; t < now; t += 3 * H) { sum += fatigueAt(t); n++; }
  const recent = ev.filter(e => e.at >= now - 42 * D);
  const ref = Math.max(5 * (sum / Math.max(1, n)), 1.2 * Math.max(0, ...recent.map(legsOf)), 3);
  const out: LegDay[] = [];
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  for (let k = days - 1; k >= 0; k--) {
    const s0 = day0.getTime() - k * D, e0 = s0 + D;
    const inDay = ev.filter(e => e.at >= s0 && e.at < e0);
    const at = Math.min(now, e0 - 1);
    out.push({ t: s0, run: inDay.filter(e => e.kind === 'run').reduce((a, e) => a + legsOf(e), 0),
      strength: inDay.filter(e => e.kind === 'strength').reduce((a, e) => a + legsOf(e), 0),
      fresh: Math.round(100 * Math.max(0, Math.min(1, 1 - fatigueAt(at) / ref))) });
  }
  return out;
}
/** Every PR ever set, oldest first (recomputed from history: each session vs the sessions before it). */
export interface PrEvent extends PrHit { t: number; sessionId: string }
export function prTimeline(s: StrengthStore): PrEvent[] {
  return s.sessions.filter(x => x.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)
    .flatMap(x => sessionPRs(s, x.id).map(p => ({ ...p, t: x.finishedAt!, sessionId: x.id })));
}
/** Hard sets per muscle over [from, to] (fractional: weighted by involvement), work sets only. */
export function muscleSetsBetween(s: StrengthStore, from: number, to = Date.now()): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const x of s.sessions) {
    if (!x.finishedAt || x.finishedAt < from || x.finishedAt > to) continue;
    for (const l of x.sets.filter(isWorkSet)) {
      for (const [m, inv] of Object.entries(exerciseById(s, l.exerciseId)?.muscles ?? {}) as [Muscle, number][]) out[m] = (out[m] ?? 0) + inv;
    }
  }
  return out;
}

export const FRESH_COLOR: Record<FreshState, string> = { Recovered: '#2f9e44', Fatigued: '#e8a317', Depleted: '#e5484d', Calibrating: '#8a8f98' };
export const LOAD_COLOR: Record<LoadStatus, string> = { Detraining: '#5b8def', Maintaining: '#8a8f98', Productive: '#2f9e44', Peaking: '#e8a317', Overtraining: '#e5484d', Calibrating: '#8a8f98' };

// ── 7-day plan helpers ────────────────────────────────────────────────────────────────────────────────────────
/** Leg-heavy routine: ≥ 6 hard sets across quads/glutes/hamstrings — worth keeping off the day before a long/quality run. */
export function legHardSets(s: StrengthStore, r: Routine): number {
  let n = 0;
  for (const it of r.items) {
    const ex = exerciseById(s, it.exerciseId);
    n += it.sets * ((ex?.muscles.quads ?? 0) + (ex?.muscles.glutes ?? 0) * 0.5 + (ex?.muscles.hamstrings ?? 0));
  }
  return Math.round(n * 10) / 10;
}

// ── Strain (2026-10-07) ─────────────────────────────────────────────────────────────────────────────────────
/**
 * The MUSCULAR part of a day's strain, from the sets actually logged that day. The CARDIO part of a strength workout
 * comes from its heart rate like any other activity (as Bevel does). The old rule — 1 load unit per workout MINUTE,
 * whatever the effort — scored a 76-min session at avg HR 67 as strain 45 where Bevel gave 21.
 * 0.3 load per hard set at RPE 7 (scaled by session RPE): 19 sets @ RPE 5 ≈ 4 load ≈ +4 strain on top of the HR part.
 */
export const MUSC_LOAD_PER_SET = 0.3;
/** One session's muscular strain load (work sets × 0.3 × RPE/7) — shared by the day total and the session detail. */
export const sessionStrainLoad = (x: StrengthSession) => x.sets.filter(isWorkSet).length * MUSC_LOAD_PER_SET * ((x.rpe ?? 7) / 7);
export function strengthStrainLoad(s: StrengthStore, dayKey: string): number {
  // dayKey = the STRAIN day (trainingDayKey: 04:00 → 04:00), so a session after midnight lands on the same day as its HR
  const { trainingDayKey } = require('./trainingLoad') as typeof import('./trainingLoad');
  return s.sessions.filter(x => x.finishedAt && trainingDayKey(x.startedAt) === dayKey).reduce((a, x) => a + sessionStrainLoad(x), 0);
}

// ── Apple Health (build 2b) ───────────────────────────────────────────────────────────────────────────────────
/** Active kcal estimate for a strength session: (MET − 1) × kg × h, MET 3.5 + 0.25 × RPE (RPE 8 ≈ 5.5 METs). */
export function strengthKcal(x: StrengthSession, minutes: number): number {
  const met = 3.5 + 0.25 * (x.rpe ?? 7);
  return Math.round((met - 1) * (x.bodyKg ?? 80) * (minutes / 60));
}
/**
 * The real workout window: first ✓ − 3 min (the warm-up / setup before the first logged set) → last ✓ + 1 min, from
 * the per-set tick times. Older sessions without tick times: from start, capped at 2× the routine estimate (a session
 * left open, or Finish tapped hours later, must not become a 5-hour workout).
 */
export function strengthWindow(x: StrengthSession, r?: Routine): { start: number; end: number } {
  const capMin = Math.max(20, (r ? estimateMinutes(r) : 45) * 2);
  const ticks = x.sets.filter(l => l.done && l.doneAt).map(l => l.doneAt!);
  if (ticks.length >= 2) {
    const start = Math.min(...ticks) - 3 * 60000;
    return { start, end: Math.min(Math.max(...ticks) + 60000, start + capMin * 60000) };   // ticks hours apart → capped
  }
  const mins = Math.max(5, Math.min(((x.finishedAt ?? x.startedAt) - x.startedAt) / 60000, capMin));
  return { start: x.startedAt, end: x.startedAt + mins * 60000 };
}
/** "Chest Press 4×8–10 @ 27.5 kg; Pec Deck 3×15 @ 7.5 kg; …" — written into the workout's metadata. */
export function exerciseSummary(s: StrengthStore, x: StrengthSession): string {
  const order: string[] = [];
  for (const l of x.sets) if (isWorkSet(l) && !order.includes(l.exerciseId)) order.push(l.exerciseId);
  return order.map(id => {
    const sets = x.sets.filter(l => l.exerciseId === id && isWorkSet(l));
    const reps = sets.map(l => l.reps), lo = Math.min(...reps), hi = Math.max(...reps), top = Math.max(...sets.map(l => l.weightKg));
    return `${exerciseById(s, id)?.name ?? id} ${sets.length}×${lo === hi ? lo : `${lo}–${hi}`} @ ${top} kg`;
  }).join('; ');
}
/** Save a finished session to Apple Health (unless switched off) and remember the outcome on the session. */
const hkInFlight = new Map<string, Promise<StrengthSession['hk'] | null>>();   // concurrent callers share ONE save
export function syncSessionToHealth(sessionId: string, measuredKcal?: number): Promise<StrengthSession['hk'] | null> {
  const running = hkInFlight.get(sessionId);
  if (running) return running;
  const p = syncSessionToHealthOnce(sessionId, measuredKcal).finally(() => hkInFlight.delete(sessionId));
  hkInFlight.set(sessionId, p);
  return p;
}
// Bump when what we WRITE changes: a saved session with an older version is re-saved with the higher SyncVersion, which
// makes HealthKit REPLACE our workout (same SyncIdentifier) — v2 adds the exercise list + exact first→last-set window.
export const HK_SAVE_VER = 3;   // v3 (2026-10-07): measured watch active energy instead of the MET estimate
async function syncSessionToHealthOnce(sessionId: string, measuredKcal?: number): Promise<StrengthSession['hk'] | null> {
  const st = await loadStrength();
  const x = st.sessions.find(s => s.id === sessionId);
  if (!x?.finishedAt || st.saveToHealth === false) return x?.hk ?? null;
  // stale = an older save format, or saved with the ESTIMATE and the watch's measured kcal has synced since
  const stale = x.hk?.status === 'saved' && (x.hk.resaveFails ?? 0) < 3
    && ((x.hk.ver ?? 1) < HK_SAVE_VER || (measuredKcal != null && x.hk.kcalSrc === 'est'));
  if (x.hk && !stale && (x.hk.status !== 'failed' || (x.hk.tries ?? 1) >= 3)) return x.hk;   // done, or gave up after 3 tries
  const r = st.routines.find(q => q.id === x.routineId);
  const win = strengthWindow(x, r);
  const mins = (win.end - win.start) / 60000;
  const { saveStrengthWorkout, watchActiveEnergy } = require('./healthkit') as typeof import('./healthkit');   // lazy (import cycle)
  // the watch's MEASURED active energy in the window; the MET estimate only when the watch wasn't worn (it was
  // generous: 363 kcal for a session the watch measured at an average HR of 67)
  const measured = measuredKcal ?? await watchActiveEnergy(win.start, win.end).catch(() => null);
  // SyncVersion must RISE for HealthKit to replace our workout: format version × 100, +1 once the kcal is measured
  const res = await saveStrengthWorkout({ id: x.id, start: win.start, end: win.end,
    spanStart: x.startedAt, spanEnd: x.finishedAt, kcal: measured ?? strengthKcal(x, mins), name: x.routineName, exercises: exerciseSummary(st, x),
    version: HK_SAVE_VER * 100 + (measured != null ? 1 : 0) });
  // a stale (v1) copy that now overlaps a watch workout: the re-save links the watch one — delete our old copy
  if (stale && res.status === 'exists') {
    const hkMod = require('./healthkit') as typeof import('./healthkit');
    const near = await hkMod.strengthWorkoutsNear(x.id, x.startedAt, x.finishedAt).catch(() => ({ foreign: null, own: null }));
    if (near.own) await hkMod.deleteOwnWorkout(near.own).catch(() => false);
  }
  // a failed RE-save keeps the earlier saved workout's record (it's still in Health; dedupe/enrich keep working on it)
  if (stale && res.status === 'failed') {   // …and counts the failure: 3 strikes → stop retrying the re-save
    const kept = { ...x.hk!, resaveFails: (x.hk!.resaveFails ?? 0) + 1 };
    await updateStrength(cur => ({ ...cur, sessions: cur.sessions.map(s => s.id === sessionId ? { ...s, hk: kept } : s) }));
    return kept;
  }
  const hk: NonNullable<StrengthSession['hk']> = { status: res.status, ...(res.uuid ? { uuid: res.uuid } : {}), tries: stale ? 1 : (x.hk?.tries ?? 0) + 1, ver: HK_SAVE_VER,
    ...(res.status === 'saved' ? { kcalSrc: measured != null ? 'watch' as const : 'est' as const } : {}) };
  await updateStrength(cur => ({ ...cur, sessions: cur.sessions.map(s => s.id === sessionId ? { ...s, hk } : s) }));
  // heart rate + Effort attach in the BACKGROUND (may show a one-time permission sheet) — Finish never waits on it
  if (hk.status === 'saved' && hk.uuid) enrichSession(sessionId).catch(() => {});
  return hk;
}

/**
 * Relate heart rate (the watch's samples in the workout window) + the session RPE as Apple's Effort score to OUR saved
 * workout — the two things Health actually shows for a strength workout. Native (phone build ≥ 2026-10-07); a no-op on
 * older binaries. Asks once for the extra share permissions. Retried later while the watch's heart rate hasn't synced
 * yet ("none", within 12 h of the session), and redone after a re-save (new uuid).
 */
const enrichInFlight = new Map<string, Promise<StrengthSession['hk'] | null>>();   // one enrichment per session at a time
export function enrichSession(sessionId: string): Promise<StrengthSession['hk'] | null> {
  const running = enrichInFlight.get(sessionId);
  if (running) return running;
  const p = enrichSessionOnce(sessionId).finally(() => enrichInFlight.delete(sessionId));
  enrichInFlight.set(sessionId, p);
  return p;
}
async function enrichSessionOnce(sessionId: string): Promise<StrengthSession['hk'] | null> {
  const st = await loadStrength();
  const x = st.sessions.find(s => s.id === sessionId);
  const hk = x?.hk;
  // our own saved workout, or the one our WATCH app recorded (a watch-logged session) — never someone else's
  if (!x?.finishedAt || !hk?.uuid || !(hk.status === 'saved' || hk.watch)) return hk ?? null;
  const e = hk.enriched;
  const hrPending = e?.hr === 'none' && Date.now() - x.finishedAt < 12 * 3_600_000 && Date.now() - e.at > 10 * 60_000;
  // Effort waits while the workout still carries the calorie ESTIMATE (≤ 6 h): the measured re-save replaces it with a
  // new uuid, and the effort sample related to the old one would stay behind in Health as a duplicate
  const deferEffort = hk.kcalSrc === 'est' && Date.now() - x.finishedAt < 6 * 3_600_000;
  const effortPending = !deferEffort && (x.rpe ?? 0) > 0 && e?.uuid === hk.uuid && e.effort === undefined;   // never attempted yet
  if (e && e.uuid === hk.uuid && !hrPending && !effortPending) return hk;
  const mod = require('../../modules/runcoach-workout') as typeof import('../../modules/runcoach-workout');
  if (!mod.default?.enrichStrengthWorkout) return hk;   // old binary without the native functions → nothing to ask/do
  if (!st.hkExtrasAsked) {
    await mod.authorizeStrengthExtras();
    await updateStrength(cur => ({ ...cur, hkExtrasAsked: true }));
  }
  // Effort is related ONCE per workout uuid; a heart-rate-only retry must not add another effort sample
  const effortDone = e?.uuid === hk.uuid && e.effort === 'ok';
  const res = await mod.enrichStrengthWorkout(hk.uuid, effortDone || deferEffort ? 0 : (x.rpe ?? 0));
  // the workout isn't in this phone's Health yet (a watch workout syncs over later) → don't record a result; retried
  // on the next focus (syncRecentSessionsToHealth) for a day instead of being marked done with nothing related
  if (!res || (res.error && Date.now() - x.finishedAt < 24 * 3_600_000)) return hk;
  const next = { ...hk, enriched: { uuid: hk.uuid, hr: res.hr ?? res.error, effort: effortDone ? 'ok' : res.effort, at: Date.now() } };
  await updateStrength(cur => ({ ...cur, sessions: cur.sessions.map(s => s.id === sessionId ? { ...s, hk: next } : s) }));
  return next;
}
/**
 * Backfill + reconcile, quiet (Strength screen / Daily Coach focus): sessions of the last 3 days not yet in Health
 * (or failed, < 3 tries) are saved; a copy WE saved that now overlaps a watch workout synced later is deleted and the
 * session linked to the watch one instead — so Health (and this app's load) never counts it twice.
 */
export async function syncRecentSessionsToHealth(): Promise<void> {
  const st = await loadStrength();
  if (st.saveToHealth === false) return;
  const since = Date.now() - 3 * 86_400_000;
  const hkMod = require('./healthkit') as typeof import('./healthkit');
  for (const x of st.sessions.filter(s => s.finishedAt && s.finishedAt >= since)) {
    if (!x.hk || (x.hk.status === 'failed' && (x.hk.tries ?? 1) < 3) || (x.hk.status === 'saved' && (x.hk.ver ?? 1) < HK_SAVE_VER && (x.hk.resaveFails ?? 0) < 3)) {
      await syncSessionToHealth(x.id).catch(() => {}); continue;
    }
    if (x.hk.watch) { await enrichSession(x.id).catch(() => {}); continue; }   // the watch's own workout: Effort only to add
    // saved with the calorie ESTIMATE because the watch's samples hadn't synced yet → re-save once they have
    if (x.hk.status === 'saved' && x.hk.kcalSrc === 'est' && (x.hk.resaveFails ?? 0) < 3) {
      const win = strengthWindow(x, st.routines.find(q => q.id === x.routineId));
      const m = await hkMod.watchActiveEnergy(win.start, win.end).catch(() => null);
      if (m != null) { await syncSessionToHealth(x.id, m).catch(() => {}); continue; }
    }
    if (x.hk.status === 'saved') await enrichSession(x.id).catch(() => {});   // heart rate synced late → relate it now
    if (x.hk.status === 'saved') {
      // our copy is found in Health by its SyncIdentifier (not the stored uuid, which a concurrent save could leave stale)
      const { foreign, own } = await hkMod.strengthWorkoutsNear(x.id, x.startedAt, x.finishedAt!).catch(() => ({ foreign: null, own: null }));
      if (foreign && (!own || await hkMod.deleteOwnWorkout(own))) {
        await updateStrength(cur => ({ ...cur, sessions: cur.sessions.map(s => s.id === x.id ? { ...s, hk: { status: 'exists', uuid: foreign } } : s) }));
      }
    }
  }
}
