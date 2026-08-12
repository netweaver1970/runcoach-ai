/**
 * Power & HR zone mapping + post-run calibration. The Z1–Z5 HR zones (driven by max HR)
 * map to running-power (watt) ranges. This mapping seeds an editable coaching-knowledge
 * file ("Power & HR Zones") that the LLM refines after each run from the observed power
 * at each HR zone — so the watch workouts (which target power) reflect the athlete's true
 * power-vs-HR relationship.
 */
import * as FileSystem from 'expo-file-system';
import HealthKit from '@kingstinct/react-native-healthkit';
import { PowerZones } from '../types';
import { getPowerZones, savePowerZones, isPowerZonesConfigured } from './claude';
import { callLLM, extractJsonObject, setUsageFeature } from './llm';
import { loadSnapshotCache, extractWeatherTempC } from './healthkit';
import { getRunMeta } from './runMeta';
import { loadSupplements, anyTakenOn } from './supplements';
import { upsertKnowledge, knowledgeExists, readKnowledgeContent } from './coachFiles';

// Above this run-time temperature the auto loop skips calibration: heat elevates HR for a
// given power, so the observed power-at-HR reads artificially low and would bias zones down.
const HOT_SKIP_C = 27;

export const ZONES_FILE_ID = 'power-hr-zones';
const HR_ID    = 'HKQuantityTypeIdentifierHeartRate';
const POWER_ID = 'HKQuantityTypeIdentifierRunningPower';
const RUN_TYPE = 37;
const LAST_RUN_FILE = `${FileSystem.documentDirectory}zones-last-run.json`;

const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => { try { return await fn(); } catch { return fb; } };

export interface ZoneRow { z: string; name: string; hrLow: number; hrHigh: number; pLow: number; pHigh: number; }

// Zone HR bands are KARVONEN (% of HR RESERVE), not % of max.
//
// This table used to read `maxHR * p`, which ignores resting HR — and the load model right next door
// (trainingLoad.ZONE_HRR, and computeStrainTrimp's own Banister maths) has always worked in HR-reserve.
// The two disagreed by 15–25 bpm for Geert (max 188, rest 59): the table called 150–169 bpm "Z4" while
// the load model scored Z4 as HR-reserve 0.85 = 169. So the coach prescribed from one definition and
// every load number was computed with the other — worth ~1.3x on its own, and it made prescribedTrimp
// read 90 against a measured 38 on the same session. Same 50/60/70/80/90% breakpoints, applied to the
// reserve, so the ZONE_HRR anchors (0.50/0.62/0.72/0.85/0.93) now each land inside their own band.
// Map a running-power value → its HR-reserve fraction, using the SAME power↔HR band edges as zoneTable
// (Z1 0.50→0.60 · Z2 0.60→0.70 · Z3 0.70→0.80 · Z4 0.80→0.90 · Z5 0.90→1.0). Piecewise-linear and
// monotonic, so a power sample lands at the reserve its zone implies. Used to rebuild TRIMP from POWER
// when a run's measured HR is unreliable (flat-lined / dropped beats) — see trainingLoad.powerTrimp.
export function powerToHrrFrac(pz: PowerZones): (w: number) => number {
  const pts: [number, number][] = [
    [0,                    0.50],
    [pz.recoveryMax,       0.60],
    [pz.z2Max,             0.70],
    [pz.tempoMin,          0.70],
    [pz.tempoMax,          0.80],
    [pz.intervalsMin,      0.90],
    [pz.intervalsMin + 60, 1.00],
  ];
  return (w: number) => {
    if (w <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (w <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return x1 <= x0 ? y1 : y0 + (y1 - y0) * (w - x0) / (x1 - x0);
      }
    }
    return 1.0;
  };
}

export function zoneTable(maxHR: number, pz: PowerZones, restHR = 50): ZoneRow[] {
  const rest = restHR > 0 && restHR < maxHR ? restHR : 50;
  const hr = (p: number) => Math.round(rest + (maxHR - rest) * p);
  return [
    { z: 'Z1', name: 'Recovery',      hrLow: hr(0.50), hrHigh: hr(0.60), pLow: 0,               pHigh: pz.recoveryMax },
    { z: 'Z2', name: 'Aerobic/Easy',  hrLow: hr(0.60), hrHigh: hr(0.70), pLow: pz.recoveryMax,  pHigh: pz.z2Max },
    { z: 'Z3', name: 'Tempo',         hrLow: hr(0.70), hrHigh: hr(0.80), pLow: pz.tempoMin,     pHigh: pz.tempoMax },
    { z: 'Z4', name: 'Threshold',     hrLow: hr(0.80), hrHigh: hr(0.90), pLow: pz.tempoMax,     pHigh: pz.intervalsMin },
    { z: 'Z5', name: 'VO2/Intervals', hrLow: hr(0.90), hrHigh: maxHR,    pLow: pz.intervalsMin, pHigh: pz.intervalsMin + 60 },
  ];
}

export function zonesMarkdown(maxHR: number, pz: PowerZones, note?: string, restHR = 50): string {
  const body = zoneTable(maxHR, pz, restHR)
    .map(r => `| ${r.z} | ${r.name} | ${r.hrLow}–${r.hrHigh} | ${r.pHigh > r.pLow ? `${r.pLow}–${r.pHigh}` : `≥ ${r.pLow}`} |`)
    .join('\n');
  return [
    '# Power & HR Zones (calibrated)',
    '',
    'DRIVING FACTS for every workout. Prescribe sessions by HR ZONE (Z1–Z5) + duration + structure;',
    `the watch targets the matching POWER (watts) from this table. Max HR ≈ ${maxHR} bpm, resting ≈ ${restHR} bpm;`,
    'HR bands are % of HR RESERVE (Karvonen), matching how training load is scored.',
    '',
    '| Zone | Name | HR (bpm) | Power (W) |',
    '|------|------|----------|-----------|',
    body,
    '',
    `Last calibrated: ${new Date().toISOString().slice(0, 10)}${note ? ` · ${note}` : ''}.`,
    'The coach refines the Power column from post-run power-vs-HR data so each HR zone maps to your true power.',
  ].join('\n');
}

// Parse the "Power & HR Zones" markdown table back into structured zones, so getPowerZones (which the
// SYNTHESIZED watch workouts read) can be kept in sync with the calibrated file. Row: `| Z2 | … | … | 155–201 |`.
export function parseZonesMarkdown(md: string): PowerZones | null {
  const rows: Record<string, [number, number]> = {};
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*\|\s*(Z[1-5])\b[^|]*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const nums = (m[2].match(/\d+/g) ?? []).map(Number);
    if (!nums.length) continue;
    rows[m[1]] = [nums[0], nums.length > 1 ? nums[1] : nums[0]];
  }
  const z2 = rows['Z2'], z3 = rows['Z3'], z4 = rows['Z4'], z5 = rows['Z5'];
  if (!z2 || !z3) return null;
  const pz: PowerZones = {
    recoveryMax:  z2[0],
    z2Max:        z2[1],
    tempoMin:     z3[0],
    tempoMax:     z3[1],
    intervalsMin: z4 ? z4[1] : (z5 ? z5[0] : z3[1] + 20),
  };
  if (!(pz.z2Max > 0 && pz.tempoMax > 0)) return null;
  // Power must rise across the zones. A calibration reply that inverts them (Z1 above Z3, say) is not a
  // usable zone set, and rejecting it here means validate-before-write keeps the previous table. This
  // matters more since the HR bands moved to HR-reserve: analyzeLastRun buckets observed power by the
  // zone the HR fell in, and short reps whose HR never reaches steady state now land a zone or two LOW
  // (Geert's 256 W intervals sit at HR 134 = Z1), so an uncritical loop could drag easy-zone power up.
  const ladder = [pz.recoveryMax, pz.z2Max, pz.tempoMin, pz.tempoMax, pz.intervalsMin];
  for (let i = 1; i < ladder.length; i++) if (ladder[i] < ladder[i - 1]) return null;
  return pz;
}

async function getMaxHR(): Promise<number> {
  const snap = await loadSnapshotCache();
  const m = (snap as any)?.estimatedMaxHR;
  return typeof m === 'number' && m > 0 ? m : 190;
}

/** Median recent resting HR — the Karvonen floor for zoneTable. Mirrors the load model's own
 *  restHR (median of the resting-HR series, fallback 50) so zones and load agree on the reserve. */
async function getRestHR(): Promise<number> {
  try {
    const snap = await loadSnapshotCache();
    const vals = (((snap as any)?.restingHR ?? []) as { value?: number }[])
      .map(r => r?.value).filter((v): v is number => typeof v === 'number' && v > 0)
      .slice(-30).sort((a, b) => a - b);
    return vals.length ? Math.round(vals[Math.floor(vals.length / 2)]) : 50;
  } catch { return 50; }
}

/**
 * DETERMINISTIC power-zone seed from the athlete's own runs — so watt targets appear on the plan (and the
 * watch) immediately, even before the LLM calibration has run (that path needs a key + a clean power run
 * and is fragile). Only fires when zones are still unconfigured; the LLM refinement then adjusts over time.
 * Base = recent Z2/easy WORK power (the aerobic anchor); other zones scale around it.
 */
export async function seedPowerZonesFromRuns(
  runs: { label?: string; workPower?: number }[],
): Promise<boolean> {
  if (isPowerZonesConfigured(await getPowerZones())) return false;
  const withPower = (runs ?? []).filter(r => (r.workPower ?? 0) > 0);
  if (withPower.length < 3) return false;
  const z2ish = withPower.filter(r => /z2|easy|recovery|long/i.test(r.label ?? ''));
  const pool = (z2ish.length >= 3 ? z2ish : withPower).slice(0, 20);
  const base = Math.round(pool.reduce((s, r) => s + (r.workPower ?? 0), 0) / pool.length);
  if (base <= 0) return false;
  await savePowerZones({
    recoveryMax:  Math.round(base * 0.90),   // Z1↔Z2 boundary
    z2Max:        Math.round(base * 1.08),   // Z2 upper
    tempoMin:     Math.round(base * 1.10),
    tempoMax:     Math.round(base * 1.28),
    intervalsMin: Math.round(base * 1.35),
  });
  return true;
}

/** Seed the zones file from the athlete's current zones if it doesn't exist yet — or REPAIR it. */
/**
 * Write the calibrated markdown file from an EXPLICIT zone set (manual Settings edit). savePowerZones
 * alone only updates the watch's zones (getPowerZones); the LLM coach reads THIS file, so without also
 * writing it the two silently disagree — a hand-edit reached the watch but not the coach's reasoning.
 * Reads maxHR/restHR internally so the HR bands stay consistent with the calibration path.
 */
export async function writeZonesFileFrom(pz: PowerZones, note?: string): Promise<void> {
  const [maxHR, restHR] = await Promise.all([getMaxHR(), getRestHR()]);
  await upsertKnowledge(
    ZONES_FILE_ID, 'Power & HR Zones',
    'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
    zonesMarkdown(maxHR, pz, note, restHR),
  );
}

export async function ensureZonesFile(): Promise<void> {
  if (await knowledgeExists(ZONES_FILE_ID)) {
    // SELF-HEAL a corrupted file. recalibrateZonesFromLastRun used to write the LLM's raw reply
    // straight over this file, so one badly-formatted (or maxTokens-truncated) reply replaced the
    // whole table with prose — and nothing ever repaired it, because the file still "exists". Found
    // on Geert's device 2026-07-22: 2767 chars of the model's own reasoning, cut off mid-sentence,
    // ZERO table rows. The coach LLM had been reading that as its authoritative zone table, and the
    // calibration loop had been feeding it back in as "Current file" on every run since.
    // Rebuilding from getPowerZones is safe: that's the last set of zones that actually parsed.
    try {
      const current = await readKnowledgeContent(ZONES_FILE_ID);
      const parsed = parseZonesMarkdown(current);
      if (!parsed) {
        const [pz, maxHR, restHR] = await Promise.all([getPowerZones(), getMaxHR(), getRestHR()]);
        if (isPowerZonesConfigured(pz)) {
          await upsertKnowledge(
            ZONES_FILE_ID, 'Power & HR Zones',
            'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
            zonesMarkdown(maxHR, pz, 'table rebuilt — previous file had no readable zone table', restHR),
          );
        }
      } else if (!isPowerZonesConfigured(await getPowerZones())) {
        // The file is the calibrated source of truth, but synthesized watch workouts read
        // getPowerZones — mirror the file into it when still unconfigured (don't clobber a manual
        // Settings edit), so a synthesized/adjusted session carries the same power targets.
        await savePowerZones(parsed);
      }
    } catch { /* best-effort sync */ }
    return;
  }
  const [pz, maxHR, restHR] = await Promise.all([getPowerZones(), getMaxHR(), getRestHR()]);
  await upsertKnowledge(
    ZONES_FILE_ID, 'Power & HR Zones',
    'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
    zonesMarkdown(maxHR, pz, undefined, restHR),
  );
}

// Decode the step name + type the native WorkoutProxy patch encodes into an activity's
// UUID suffix (…::meta::title=…|WorkoutStepName=…|WorkoutStepType=…|…::stat::…).
// WorkoutStepType: 0=Warmup, 1=Work, 2=Recovery, 3=Cooldown.
function segInfo(uuid: string): { name: string; type: number } {
  const m = uuid.indexOf('::meta::');
  if (m < 0) return { name: '', type: -1 };
  const s = uuid.indexOf('::stat::', m);
  const metaStr = uuid.slice(m + 8, s >= 0 ? s : undefined);
  let title = '', stepName = '', type = -1;
  for (const pair of metaStr.split('|')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq), v = pair.slice(eq + 1);
    if (k === 'title')           title    = v;
    if (k === 'WorkoutStepName') stepName = v;
    if (k === 'WorkoutStepType') type     = parseInt(v, 10);
  }
  return { name: title || stepName, type };
}

// Real work only — exclude warm-up, drills, recovery jogs and cool-down from calibration.
function isRealWork(name: string, type: number): boolean {
  if (/drill|warm|cool|recover|rest/i.test(name)) return false;
  if (type === 0 || type === 2 || type === 3) return false; // warmup / recovery / cooldown
  if (type === 1) return true;                              // work
  return /work/i.test(name);                                // fallback by name
}

interface RunWindow {
  start: number; end: number;
  workRanges: { from: number; to: number }[]; // real work segments; empty for free runs
  uuid: string; tempC?: number; note?: string;
}

async function latestRun(): Promise<RunWindow | null> {
  const workouts: any[] = await safe(() => (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: new Date(Date.now() - 14 * 86_400_000), endDate: new Date() },
    limit: 50, ascending: false, energyUnit: 'kcal', distanceUnit: 'm',
  }), []);
  const run = workouts.find(w => w.workoutActivityType === RUN_TYPE);
  if (!run) return null;
  const start = new Date(run.startDate).getTime();
  const durSec = typeof run.duration === 'object' && run.duration !== null ? (run.duration.quantity ?? 0) : (run.duration ?? 0);
  // Time ranges of the REAL WORK steps — the only data the calibration uses (structured
  // runs). Empty for free runs (no steps), where we fall back to the whole window.
  const workRanges = ((run.activities ?? []) as any[])
    .filter(a => { const { name, type } = segInfo(a?.uuid ?? ''); return isRealWork(name, type); })
    .map(a => ({ from: new Date(a.startDate).getTime(), to: a.endDate ? new Date(a.endDate).getTime() : 0 }))
    .filter(r => r.to > r.from);
  // Conditions that bias the power-vs-HR relationship: recorded temp + the athlete's note.
  const uuid = String(run.uuid ?? '').split('::')[0];
  const meta = uuid ? await getRunMeta(uuid).catch(() => ({} as any)) : ({} as any);
  const tempC = meta?.tempC ?? extractWeatherTempC(run);
  return { start, end: start + durSec * 1000, workRanges, uuid, tempC, note: meta?.note };
}

export interface RunZoneAnalysis {
  date: string;
  durationMin: number;
  perZone: { z: string; minutes: number; avgPower: number; avgHR: number }[];
  decouplePct: number | null;   // Pw:HR drift over the work window — high = fasted/dehydrated/ill/hot
}

// Cardiac-drift ceiling for accepting a run into the zone calibration. Fasted, dehydrated, ill or
// over-hot efforts all make HR climb relative to power across a sustained run (Pw:HR "decoupling"); a
// fed, well-fuelled run stays coupled (<5%). Compromised runs produce artificially LOW power-at-HR, so
// letting them into the loop drags the zones DOWN — exactly the drift Geert's fasted tests caused
// (zones fell from a provisional 295 W to 271 W). Friel's "aerobically coupled" threshold is 5%; a fed,
// well-paced training run sits at 2–4%. 6% catches a clearly compromised day (a 20-bpm fasted drift
// measures ~6.5%) while leaving headroom for normal variation. Tests aren't meant to feed the auto-loop
// anyway — zones are set from a test manually, via the paired analysis, not this path.
const CALIB_MAX_DRIFT_PCT = 6;
// Words in the athlete's run note that mark a run as not-representative for calibration.
const COMPROMISED_NOTE = /fast(ed|ing)?|hung.?over|sick|ill\b|unwell|dehydrat|exhaust|cramp|bonk|yohimb/i;

/** Observed average running power at each HR zone for the most recent run. */
export async function analyzeLastRun(prefetched?: RunWindow): Promise<RunZoneAnalysis | null> {
  const run = prefetched ?? await latestRun();
  if (!run) return null;
  // Structured run → use only the real work segments; free run → use the whole window.
  const workOnly = run.workRanges.length > 0;
  const inWork = (t: number) => run.workRanges.some(r => t >= r.from && t <= r.to);
  const [pz, maxHR, restHR] = await Promise.all([getPowerZones(), getMaxHR(), getRestHR()]);
  const rows = zoneTable(maxHR, pz, restHR);
  const from = new Date(run.start), to = new Date(run.end);

  const [hrRaw, pwrRaw] = await Promise.all([
    safe(() => (HealthKit.queryQuantitySamples as any)(HR_ID, { filter: { startDate: from, endDate: to }, unit: 'count/min', ascending: true, limit: 50_000 }), [] as any[]),
    safe(() => (HealthKit.queryQuantitySamples as any)(POWER_ID, { filter: { startDate: from, endDate: to }, unit: 'W', ascending: true, limit: 100_000 }), [] as any[]),
  ]);
  if ((hrRaw as any[]).length === 0 || (pwrRaw as any[]).length === 0) return null;

  const hr = (hrRaw as any[]).map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity as number })).sort((a, b) => a.t - b.t);
  const pwr = (pwrRaw as any[]).map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity as number })).sort((a, b) => a.t - b.t);
  const zoneOf = (bpm: number) => { for (let i = rows.length - 1; i >= 0; i--) if (bpm >= rows[i].hrLow) return i; return 0; };

  const acc = rows.map(() => ({ pSum: 0, n: 0, hrSum: 0 }));
  let hi = 0;
  for (const p of pwr) {
    while (hi + 1 < hr.length && hr[hi + 1].t <= p.t) hi++;
    const bpm = hr[hi]?.v ?? 0;
    if (bpm <= 0 || p.v <= 0 || (workOnly && !inWork(p.t))) continue; // real work only
    const zi = zoneOf(bpm);
    acc[zi].pSum += p.v; acc[zi].n++; acc[zi].hrSum += bpm;
  }
  const intervalSec = pwr.length > 1 ? Math.max(1, (run.end - run.start) / 1000 / pwr.length) : 1;
  const perZone = rows.map((r, i) => ({
    z: r.z,
    minutes:  Math.round((acc[i].n * intervalSec / 60) * 10) / 10,
    avgPower: acc[i].n ? Math.round(acc[i].pSum / acc[i].n) : 0,
    avgHR:    acc[i].n ? Math.round(acc[i].hrSum / acc[i].n) : 0,
  })).filter(z => z.minutes >= 0.5 && z.avgPower > 0);

  // Pw:HR DECOUPLING — first half vs second half of mean(power)/mean(HR). Needs a sustained effort
  // (≥20 min) to mean anything; null otherwise. For a STRUCTURED run the work segments already exclude
  // warm-up/cool-down; for a FREE run (no steps) trim 15% off each end so the easy warm-up/cool-down
  // don't masquerade as drift and falsely reject a good run.
  let paired: { p: number; hr: number }[] = [];
  { let j = 0;
    for (const p of pwr) {
      while (j + 1 < hr.length && hr[j + 1].t <= p.t) j++;
      const bpm = hr[j]?.v ?? 0;
      if (bpm > 0 && p.v > 0 && (!workOnly || inWork(p.t))) paired.push({ p: p.v, hr: bpm });
    }
  }
  if (!workOnly && paired.length > 20) {
    const trim = Math.floor(paired.length * 0.15);
    paired = paired.slice(trim, paired.length - trim);
  }
  let decouplePct: number | null = null;
  if (paired.length * intervalSec >= 20 * 60) {
    const mid = Math.floor(paired.length / 2);
    const ratio = (arr: { p: number; hr: number }[]) => {
      const mh = arr.reduce((s, x) => s + x.hr, 0) / arr.length;
      return mh > 0 ? (arr.reduce((s, x) => s + x.p, 0) / arr.length) / mh : 0;
    };
    const r1 = ratio(paired.slice(0, mid)), r2 = ratio(paired.slice(mid));
    if (r1 > 0) decouplePct = Math.round(((r1 - r2) / r1) * 1000) / 10;
  }

  return { date: new Date(run.start).toISOString().slice(0, 10), durationMin: Math.round((run.end - run.start) / 60000), perZone, decouplePct };
}

/** Feed the last run's power-by-HR-zone to the LLM to refine the zones file. */
export async function recalibrateZonesFromLastRun(opts?: { auto?: boolean }): Promise<{ updated: boolean; reason?: string }> {
  await ensureZonesFile();
  const run = await latestRun();
  if (!run) return { updated: false, reason: 'No recent run found.' };

  // Heat guard: on the automatic path, don't silently bake in a hot, HR-inflated run.
  if (opts?.auto && run.tempC != null && run.tempC >= HOT_SKIP_C) {
    return { updated: false, reason: `Skipped — hot run (${run.tempC}°C) would bias zones low.` };
  }
  // NOTE guard: the athlete flagged the run as fasted / ill / yohimbine / etc. — not representative.
  if (run.note && COMPROMISED_NOTE.test(run.note)) {
    return { updated: false, reason: `Skipped — run noted as compromised ("${run.note.trim().slice(0, 40)}"); not calibrating from it.` };
  }
  // YOHIMBINE guard: an HR-raising stimulant elevates HR, so power-at-HR reads LOW and would drag zones
  // DOWN — the same bias as a fasted run. Skip if it was logged on the run's day (either path).
  {
    const rd = new Date(run.start);
    const runDay = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}-${String(rd.getDate()).padStart(2, '0')}`;
    const supps = await loadSupplements().catch(() => null);
    if (supps && anyTakenOn(supps, runDay, /yohimb/i)) {
      return { updated: false, reason: `Skipped — yohimbine logged on ${runDay}; it raises HR, so this run's power-at-HR reads low and would lower your zones incorrectly.` };
    }
  }

  const [pzNow, maxHRNow, restHRNow] = await Promise.all([getPowerZones(), getMaxHR(), getRestHR()]);
  const analysis = await analyzeLastRun(run);
  if (!analysis || analysis.perZone.length === 0) return { updated: false, reason: 'No running-power + HR data in your last run.' };
  // DRIFT guard: high Pw:HR decoupling = the body couldn't hold output steady = a fasted / dehydrated /
  // ill / over-hot day. Such a run produces artificially low power-at-HR, so calibrating from it drags the
  // zones DOWN — the exact fasted-test drift the athlete flagged. Reject on BOTH paths (the auto loop is
  // what silently drifted; the manual button gets a clear reason so the user knows why nothing moved).
  // Only fires when drift is measurable (a sustained ≥20-min effort); short/interval runs pass through.
  if (analysis.decouplePct != null && analysis.decouplePct > CALIB_MAX_DRIFT_PCT) {
    return { updated: false, reason: `Skipped — ${analysis.decouplePct}% cardiac drift signals a fasted/compromised effort; calibrating from it would lower your zones incorrectly.` };
  }

  // Conditions the LLM should weigh when deciding how much to trust this run.
  const conditions: string[] = [];
  if (run.tempC != null) {
    conditions.push(`Temperature ~${run.tempC}°C${run.tempC >= 24 ? ' (hot — HR runs high for a given power, so observed power-at-HR is understated)' : ''}`);
  }
  if (run.note?.trim()) conditions.push(`Athlete's run note: "${run.note.trim()}"`);
  const condText = conditions.length ? conditions.join('\n') : 'No special conditions noted.';

  const current = await readKnowledgeContent(ZONES_FILE_ID);
  const curPz = parseZonesMarkdown(current) ?? pzNow;

  // Ask for NUMBERS, not a file.
  //
  // This used to ask the model to return the whole updated markdown table, and it kept replying with its
  // reasoning instead — which the old code wrote straight over the file, destroying the table (that is how
  // Geert's zones file became 2767 chars of prose). Validation now rejects those replies, but rejecting
  // every reply just means the loop never works. The durable fix is to stop asking an LLM to regenerate a
  // structured document at all: it proposes five integers, the APP renders the file with zonesMarkdown().
  // Formatting can no longer be got wrong, because the model never touches it.
  const system =
    `You calibrate a runner's power zones. Given their CURRENT zone powers and the OBSERVED average ` +
    `running power at each HR zone from their latest run, propose updated zone powers.\n\n` +
    `Move only ~30% of the way toward the observed value — never overreact to a single run — and leave a ` +
    `zone unchanged when its observed coverage is thin (a minute or two) or absent.\n\n` +
    `CRUCIAL — weigh the CONDITIONS, which bias the power-vs-HR relationship: heat and stimulants ` +
    `(caffeine, yohimbine, pre-workout) RAISE heart rate for a given power, so observed power-at-HR reads ` +
    `artificially LOW; interruptions (phone calls, stops, walking breaks) inject noise. The more the ` +
    `conditions confound the data, the SMALLER the adjustment — down to none.\n\n` +
    `Return ONLY minified JSON, no prose, no markdown, no code fences, with EXACTLY these keys: ` +
    `{"recoveryMax":int,"z2Max":int,"tempoMin":int,"tempoMax":int,"intervalsMin":int,"note":string}. ` +
    `The values are watts and MUST be non-decreasing in that order. note = at most 12 words on what you ` +
    `changed and why (e.g. "held — hot run inflated HR").`;
  const user =
    `Current zone powers (W): recoveryMax ${curPz.recoveryMax}, z2Max ${curPz.z2Max}, ` +
    `tempoMin ${curPz.tempoMin}, tempoMax ${curPz.tempoMax}, intervalsMin ${curPz.intervalsMin}\n\n` +
    `Conditions:\n${condText}\n\n` +
    `Latest run (${analysis.date}, ${analysis.durationMin} min) — observed power by HR zone ` +
    `(warm-up, drills, recovery jogs & cool-down excluded; real work only):\n` +
    analysis.perZone.map(z => `${z.z}: ${z.minutes} min, avg HR ${z.avgHR}, avg power ${z.avgPower} W`).join('\n');

  setUsageFeature('zone-calibration');
  const raw = await callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 1600 });
  if (!raw?.trim()) return { updated: false, reason: 'Coach returned nothing.' };

  let o: any;
  try { o = JSON.parse(extractJsonObject(raw) ?? ''); } catch { o = null; }
  if (!o) return { updated: false, reason: 'Coach reply was not usable JSON — zones left unchanged.' };

  const n = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : NaN);
  const next: PowerZones = {
    recoveryMax:  n(o.recoveryMax),  z2Max:    n(o.z2Max),
    tempoMin:     n(o.tempoMin),     tempoMax: n(o.tempoMax),
    intervalsMin: n(o.intervalsMin),
  };
  const ladder = [next.recoveryMax, next.z2Max, next.tempoMin, next.tempoMax, next.intervalsMin];
  if (ladder.some(v => !(v > 0) || v > 1000)) return { updated: false, reason: 'Coach proposed implausible watts — zones left unchanged.' };
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i] < ladder[i - 1]) return { updated: false, reason: 'Coach proposed a non-monotonic zone ladder — zones left unchanged.' };
  }
  // Backstop the "~30%" instruction in code: no single run may move any zone by more than 15%.
  const cur = [curPz.recoveryMax, curPz.z2Max, curPz.tempoMin, curPz.tempoMax, curPz.intervalsMin];
  if (cur.every(v => v > 0) && ladder.some((v, i) => Math.abs(v - cur[i]) > cur[i] * 0.15)) {
    return { updated: false, reason: 'Coach proposed a >15% jump from one run — zones left unchanged.' };
  }

  const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 80) : undefined;
  await upsertKnowledge(ZONES_FILE_ID, 'Power & HR Zones',
    'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
    zonesMarkdown(maxHRNow, next, note, restHRNow));
  await savePowerZones(next).catch(() => {});
  return { updated: true };
}

/** Auto-recalibrate when a run newer than the last analysed one is available. */
export async function maybeAutoRecalibrate(): Promise<boolean> {
  const run = await latestRun();
  if (!run) return false;
  let last = 0;
  try {
    const info = await FileSystem.getInfoAsync(LAST_RUN_FILE);
    if (info.exists) last = JSON.parse(await FileSystem.readAsStringAsync(LAST_RUN_FILE)).start ?? 0;
  } catch { /* ignore */ }
  if (run.start <= last) return false;

  const res = await recalibrateZonesFromLastRun({ auto: true });
  try { await FileSystem.writeAsStringAsync(LAST_RUN_FILE, JSON.stringify({ start: run.start, at: Date.now() })); } catch { /* ignore */ }
  return res.updated;
}
