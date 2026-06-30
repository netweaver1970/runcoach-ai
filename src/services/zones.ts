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
import { callLLM } from './llm';
import { loadSnapshotCache, extractWeatherTempC } from './healthkit';
import { getRunMeta } from './runMeta';
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

export function zoneTable(maxHR: number, pz: PowerZones): ZoneRow[] {
  const hr = (p: number) => Math.round(maxHR * p);
  return [
    { z: 'Z1', name: 'Recovery',      hrLow: hr(0.50), hrHigh: hr(0.60), pLow: 0,               pHigh: pz.recoveryMax },
    { z: 'Z2', name: 'Aerobic/Easy',  hrLow: hr(0.60), hrHigh: hr(0.70), pLow: pz.recoveryMax,  pHigh: pz.z2Max },
    { z: 'Z3', name: 'Tempo',         hrLow: hr(0.70), hrHigh: hr(0.80), pLow: pz.tempoMin,     pHigh: pz.tempoMax },
    { z: 'Z4', name: 'Threshold',     hrLow: hr(0.80), hrHigh: hr(0.90), pLow: pz.tempoMax,     pHigh: pz.intervalsMin },
    { z: 'Z5', name: 'VO2/Intervals', hrLow: hr(0.90), hrHigh: maxHR,    pLow: pz.intervalsMin, pHigh: pz.intervalsMin + 60 },
  ];
}

export function zonesMarkdown(maxHR: number, pz: PowerZones, note?: string): string {
  const body = zoneTable(maxHR, pz)
    .map(r => `| ${r.z} | ${r.name} | ${r.hrLow}–${r.hrHigh} | ${r.pHigh > r.pLow ? `${r.pLow}–${r.pHigh}` : `≥ ${r.pLow}`} |`)
    .join('\n');
  return [
    '# Power & HR Zones (calibrated)',
    '',
    'DRIVING FACTS for every workout. Prescribe sessions by HR ZONE (Z1–Z5) + duration + structure;',
    `the watch targets the matching POWER (watts) from this table. Max HR ≈ ${maxHR} bpm.`,
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
  return pz.z2Max > 0 && pz.tempoMax > 0 ? pz : null;
}

async function getMaxHR(): Promise<number> {
  const snap = await loadSnapshotCache();
  const m = (snap as any)?.estimatedMaxHR;
  return typeof m === 'number' && m > 0 ? m : 190;
}

/** Seed the zones file from the athlete's current zones if it doesn't exist yet. */
export async function ensureZonesFile(): Promise<void> {
  if (await knowledgeExists(ZONES_FILE_ID)) {
    // The file is the calibrated source of truth, but synthesized watch workouts read getPowerZones —
    // mirror the file's zones into it when it's still unconfigured (don't clobber a manual Settings edit),
    // so a synthesized/adjusted session carries the same power targets the LLM gets from the file.
    try {
      if (!isPowerZonesConfigured(await getPowerZones())) {
        const parsed = parseZonesMarkdown(await readKnowledgeContent(ZONES_FILE_ID));
        if (parsed) await savePowerZones(parsed);
      }
    } catch { /* best-effort sync */ }
    return;
  }
  const [pz, maxHR] = await Promise.all([getPowerZones(), getMaxHR()]);
  await upsertKnowledge(
    ZONES_FILE_ID, 'Power & HR Zones',
    'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
    zonesMarkdown(maxHR, pz),
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
}

/** Observed average running power at each HR zone for the most recent run. */
export async function analyzeLastRun(prefetched?: RunWindow): Promise<RunZoneAnalysis | null> {
  const run = prefetched ?? await latestRun();
  if (!run) return null;
  // Structured run → use only the real work segments; free run → use the whole window.
  const workOnly = run.workRanges.length > 0;
  const inWork = (t: number) => run.workRanges.some(r => t >= r.from && t <= r.to);
  const [pz, maxHR] = await Promise.all([getPowerZones(), getMaxHR()]);
  const rows = zoneTable(maxHR, pz);
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

  return { date: new Date(run.start).toISOString().slice(0, 10), durationMin: Math.round((run.end - run.start) / 60000), perZone };
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

  const analysis = await analyzeLastRun(run);
  if (!analysis || analysis.perZone.length === 0) return { updated: false, reason: 'No running-power + HR data in your last run.' };

  // Conditions the LLM should weigh when deciding how much to trust this run.
  const conditions: string[] = [];
  if (run.tempC != null) {
    conditions.push(`Temperature ~${run.tempC}°C${run.tempC >= 24 ? ' (hot — HR runs high for a given power, so observed power-at-HR is understated)' : ''}`);
  }
  if (run.note?.trim()) conditions.push(`Athlete's run note: "${run.note.trim()}"`);
  const condText = conditions.length ? conditions.join('\n') : 'No special conditions noted.';

  const current = await readKnowledgeContent(ZONES_FILE_ID);
  const system =
    `You maintain a running coach's "Power & HR Zones" file (a markdown table Zone|Name|HR|Power). ` +
    `Update ONLY the Power (W) column so each HR zone maps to the OBSERVED average running power from the latest run. ` +
    `Blend gently with the existing values (move ~30% toward observed; never overreact to one run); keep the HR ranges, ` +
    `the table structure and the surrounding text.\n\n` +
    `CRUCIAL — weigh the CONDITIONS, which bias the power-vs-HR relationship: heat and stimulants (caffeine, yohimbine, ` +
    `pre-workout, etc.) RAISE heart rate for a given power, so observed power-at-HR reads artificially LOW; interruptions ` +
    `(phone calls, toilet/stops, walking breaks) inject noise. The more the conditions confound the data, the SMALLER the ` +
    `adjustment you should make (down to none). State, briefly, on the "Last calibrated" line what you did and why ` +
    `(e.g. "held — hot + yohimbine inflated HR"). Return ONLY the updated markdown — no code fences.`;
  const user =
    `Current file:\n"""\n${current}\n"""\n\n` +
    `Conditions:\n${condText}\n\n` +
    `Latest run (${analysis.date}, ${analysis.durationMin} min) — observed power by HR zone ` +
    `(warm-up, drills, recovery jogs & cool-down excluded; real work only):\n` +
    analysis.perZone.map(z => `${z.z}: ${z.minutes} min, avg HR ${z.avgHR}, avg power ${z.avgPower} W`).join('\n');

  const out = (await callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 900 }))
    .trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!out) return { updated: false, reason: 'Coach returned nothing.' };

  await upsertKnowledge(ZONES_FILE_ID, 'Power & HR Zones', 'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs', out);
  // Mirror the refined power into getPowerZones so synthesized watch workouts target the same watts.
  const parsedPz = parseZonesMarkdown(out);
  if (parsedPz) await savePowerZones(parsedPz).catch(() => {});
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
