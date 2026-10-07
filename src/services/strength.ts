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
  items: RoutineItem[];
  updatedAt: number;
}
export interface SetLog { exerciseId: string; set: number; reps: number; weightKg: number; done: boolean }
export interface StrengthSession {
  id: string;
  date: string;            // local YYYY-MM-DD
  routineId: string;
  routineName: string;
  startedAt: number;
  finishedAt?: number;
  bodyKg?: number;         // body weight used for body-weight exercises
  sets: SetLog[];
  rpe?: number;            // session RPE 1–10 (feeds strength load into training load in a later build)
  note?: string;
}

// ── Exercise library ────────────────────────────────────────────────────────────────────────────────────────
// Involvement weights are a pragmatic EMG/biomechanics consensus (prime mover 1, synergists 0.3–0.6). Videos are
// filled in VIDEOS below (verified YouTube links).
const EX: Exercise[] = [
  { id: 'incline_db_press', name: 'Incline DB Press', muscles: { chest: 1, front_delts: 0.6, triceps: 0.5 }, cue: 'Bench ~30°, lower to the upper chest with elbows slightly in, press up and slightly together.' },
  { id: 'flat_db_press', name: 'Flat DB Press', muscles: { chest: 1, front_delts: 0.5, triceps: 0.5 }, cue: 'Shoulder blades back and down, elbows ~45°, both sides press evenly.' },
  { id: 'chest_press_machine', name: 'Chest Press Machine', muscles: { chest: 1, front_delts: 0.5, triceps: 0.5 }, cue: 'Handles at mid-chest, chest up, press out without shrugging; squeeze at full extension.' },
  { id: 'cable_chest_fly', name: 'Cable Chest Fly', muscles: { chest: 1, front_delts: 0.3 }, cue: 'Soft bend in the elbows, hug an arc, bring the hands together in front of the chest.' },
  { id: 'machine_shoulder_press', name: 'Machine Shoulder Press', muscles: { front_delts: 1, side_delts: 0.5, triceps: 0.6 }, cue: 'Brace, lower to about chin height, press overhead without arching the back.' },
  { id: 'db_lateral_raise', name: 'DB Lateral Raises', muscles: { side_delts: 1, traps: 0.25 }, cue: 'Lead with the elbows out to the side up to shoulder height; no swinging.' },
  { id: 'cable_triceps_pushdown', name: 'Cable Triceps Pushdown', muscles: { triceps: 1 }, cue: 'Elbows pinned at your sides, extend fully and pause at the bottom.' },
  { id: 'overhead_rope_extension', name: 'Overhead Rope Extension', muscles: { triceps: 1 }, cue: 'Rope behind the head, upper arms still, extend straight up for a full stretch-to-lockout.' },
  { id: 'triceps_dips', name: 'Triceps Dips / Dip Machine', muscles: { triceps: 1, chest: 0.6, front_delts: 0.5 }, bodyweightFrac: 0.95, cue: 'Upright torso, lower to ~90° at the elbow, press back up under control. Weight = added kg (negative = assistance).' },
  { id: 'lat_pulldown', name: 'Lat Pulldown', muscles: { lats: 1, upper_back: 0.5, biceps: 0.5, rear_delts: 0.25 }, cue: 'Chest tall, drive the elbows down toward the ribs; no leaning back or momentum.' },
  { id: 'lat_pulldown_neutral', name: 'Lat Pulldown (Neutral Grip)', muscles: { lats: 1, upper_back: 0.5, biceps: 0.6 }, cue: 'Palms facing, pull the elbows down and slightly forward while the chest stays up.' },
  { id: 'chest_supported_row', name: 'Chest-Supported Row', muscles: { upper_back: 1, lats: 0.6, rear_delts: 0.5, biceps: 0.5 }, cue: 'Chest on the pad, row to the lower chest and squeeze the shoulder blades together.' },
  { id: 'seated_row', name: 'Seated Row', muscles: { upper_back: 1, lats: 0.7, biceps: 0.5, rear_delts: 0.3 }, cue: 'Sit tall, row the handle to the belly button, slow and controlled return.' },
  { id: 'rear_delt_fly', name: 'Rear Delt Fly', muscles: { rear_delts: 1, upper_back: 0.5 }, cue: 'Arms move out wide, feel the back of the shoulders; keep the traps down.' },
  { id: 'db_curl', name: 'Dumbbell Curls', muscles: { biceps: 1, forearms: 0.3 }, cue: 'Elbows by your sides, palms up, slow curl and a full squeeze at the top.' },
  { id: 'incline_db_curl', name: 'Incline DB Curls', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Arms hang behind you for a full stretch, curl slowly, no swinging.' },
  { id: 'cable_biceps_curl', name: 'Cable Bicep Curls', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Elbows fixed, smooth curl, squeeze at the top, control the way down.' },
  { id: 'back_squat', name: 'Back Squat', muscles: { quads: 1, glutes: 0.8, adductors: 0.5, lower_back: 0.4, hamstrings: 0.25 }, cue: 'Brace the core, sit down under control, drive up through the whole foot.' },
  { id: 'hack_squat', name: 'Hack Squat', muscles: { quads: 1, glutes: 0.6, adductors: 0.3 }, cue: 'Back flat on the pad, controlled descent, push through the whole foot.' },
  { id: 'leg_press', name: 'Leg Press', muscles: { quads: 1, glutes: 0.6, adductors: 0.3 }, cue: 'Feet mid-platform, knees to ~90°, never lock out at the top.' },
  { id: 'leg_extension', name: 'Leg Extension', muscles: { quads: 1 }, cue: 'Lift with the quads, pause at the top, lower slowly.' },
  { id: 'hamstring_curl', name: 'Hamstring Curl', muscles: { hamstrings: 1, calves: 0.2 }, cue: 'Hips stay down, curl smoothly, squeeze at full flexion.' },
  { id: 'calf_raise', name: 'Calf Raise', muscles: { calves: 1 }, bodyweightFrac: 1, cue: 'On a step: full stretch at the bottom, push through the big toe, slow descent. Weight = added kg (dumbbell in hand).' },
  // ── Marcy home-gym / no-bench set (2026-10-07): stack + cables, no bench / rack / leg press ──
  { id: 'pec_deck', name: 'Pec Deck (Butterfly)', muscles: { chest: 1, front_delts: 0.3 }, cue: 'Back flat on the pad, elbows slightly bent, squeeze the arms together in front of the chest, slow return.' },
  { id: 'seated_db_shoulder_press', name: 'Seated DB Shoulder Press', muscles: { front_delts: 1, side_delts: 0.5, triceps: 0.6 }, cue: 'Sit on the Marcy seat, back on the pad; lower to ear height, press up without arching.' },
  { id: 'half_kneeling_cable_press', name: 'Half-Kneeling Cable Press', muscles: { front_delts: 1, side_delts: 0.4, triceps: 0.5, abs: 0.25 }, cue: 'Low pulley, kneel on the side of the working arm, ribs down, press up and slightly forward.' },
  { id: 'cable_lateral_raise', name: 'Cable Lateral Raise', muscles: { side_delts: 1, traps: 0.25 }, cue: 'Low pulley, handle in the far hand, raise out to the side to shoulder height; no swinging.' },
  { id: 'single_arm_cable_row', name: 'Single-Arm Cable Row', muscles: { upper_back: 1, lats: 0.7, rear_delts: 0.4, biceps: 0.5 }, cue: 'Low pulley, brace, row the elbow back past the ribs, full stretch forward on the return.' },
  { id: 'face_pull', name: 'Face Pull', muscles: { rear_delts: 1, upper_back: 0.6, traps: 0.3 }, cue: 'High pulley at face height, pull toward the forehead with the elbows high and wide, squeeze the rear delts.' },
  { id: 'bayesian_cable_curl', name: 'Bayesian Cable Curl', muscles: { biceps: 1, forearms: 0.25 }, cue: 'Face away from the low pulley, arm behind you for a full stretch, curl without moving the elbow forward.' },
  { id: 'bulgarian_split_squat', name: 'Bulgarian Split Squat', muscles: { quads: 1, glutes: 0.8, adductors: 0.4 }, bodyweightFrac: 0.8, cue: 'Rear foot on the Marcy seat, drop straight down, front knee tracks over the toes; drive up through the front foot. Weight = dumbbells in hand.' },
  { id: 'goblet_squat', name: 'Goblet Squat', muscles: { quads: 1, glutes: 0.7, adductors: 0.4 }, bodyweightFrac: 0.8, cue: 'Dumbbell against the chest, sit between the heels, chest up, push through the whole foot.' },
  { id: 'cable_squat', name: 'Cable Squat', muscles: { quads: 1, glutes: 0.7, adductors: 0.3 }, bodyweightFrac: 0.8, cue: 'Hold the low-pulley handle at the chest, lean back slightly against the cable, squeeze down and drive up.' },
  { id: 'close_grip_pushup', name: 'Close-Grip Push-up', muscles: { triceps: 1, chest: 0.6, front_delts: 0.4 }, bodyweightFrac: 0.65, cue: 'Hands under the shoulders, elbows brushing the ribs, body straight; knees down to make it easier.' },
  { id: 'overhead_cable_triceps_extension', name: 'Overhead Cable Triceps Extension', muscles: { triceps: 1 }, cue: 'Face away from the high pulley (bar or rope), upper arms by the ears, extend to lockout, full stretch back.' },
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
export interface StrengthStore { v: 1; starterRev?: number; routines: Routine[]; customExercises: Exercise[]; sessions: StrengthSession[] }

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
          cache = { v: 1, starterRev: j.starterRev ?? 1, routines: j.routines, customExercises: j.customExercises ?? [], sessions: j.sessions ?? [] };
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

// ── Progression (double progression) ─────────────────────────────────────────────────────────────────────────
/** The last finished session's completed sets for this exercise (newest first). */
export function lastSetsFor(s: StrengthStore, exerciseId: string): SetLog[] {
  const done = s.sessions.filter(x => x.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const x of done) {
    const sets = x.sets.filter(l => l.exerciseId === exerciseId && l.done);
    if (sets.length) return sets;
  }
  return [];
}
/**
 * Suggested working weight: every set of last time reached the TOP of the rep range at the same weight → add a
 * step (2.5 kg for compounds/upper body machines, 1 kg for small isolation dumbbells); else repeat last weight.
 */
export function suggestWeight(s: StrengthStore, item: RoutineItem): { kg?: number; why?: string } {
  const last = lastSetsFor(s, item.exerciseId);
  if (!last.length) return item.weightKg != null ? { kg: item.weightKg } : {};
  const top = Math.max(...last.map(l => l.weightKg));
  const atTop = last.filter(l => l.weightKg === top);
  const ex = BUILTIN_EXERCISES.find(e => e.id === item.exerciseId);
  const step = ex && /\bDB\b|Dumbbell/i.test(ex.name) ? 2 : 2.5;   // dumbbell racks go in 2 kg steps; stacks/plates 2.5
  const hi = repRange(item)[1];
  if (atTop.length >= item.sets && atTop.every(l => l.reps >= hi)) {
    return { kg: Math.round((top + step) * 4) / 4, why: `all ${item.sets} sets hit ${hi} reps at ${top} kg last time → +${step} kg` };
  }
  return { kg: top, why: `last time ${atTop.map(l => l.reps).join('/')} reps at ${top} kg — aim for ${hi} on every set` };
}

// ── Muscle load ──────────────────────────────────────────────────────────────────────────────────────────────
export interface MuscleLoad { muscle: Muscle; tonnageKg: number; hardSets: number }
/** Per-muscle load of a list of sessions (completed sets only). */
export function muscleLoad(s: StrengthStore, sessions: StrengthSession[], fallbackBodyKg = 80): MuscleLoad[] {
  const acc = new Map<Muscle, { t: number; h: number }>();
  for (const x of sessions) {
    for (const l of x.sets) {
      if (!l.done || l.reps <= 0) continue;
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
    if (!l.done) continue;
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
  return `• STRENGTH (athlete-logged gym sessions, separate from running): planned ${planned.join(', ') || 'none'}; last 7 days ${week.length} session${week.length === 1 ? '' : 's'}${week.length ? ` (${week.map(x => `${x.date.slice(5)} ${x.routineName}${x.rpe ? ` RPE ${x.rpe}` : ''}`).join('; ')})` : ''}${top ? `; hard sets/muscle: ${top}` : ''}. Strength load is NOT yet in CTL/ATL — account for heavy LEG days (quads/glutes/hamstrings) before quality runs and long runs.`;
}
