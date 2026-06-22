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
import { getPowerZones } from './claude';
import { callLLM } from './llm';
import { loadSnapshotCache } from './healthkit';
import { upsertKnowledge, knowledgeExists, readKnowledgeContent } from './coachFiles';

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

async function getMaxHR(): Promise<number> {
  const snap = await loadSnapshotCache();
  const m = (snap as any)?.estimatedMaxHR;
  return typeof m === 'number' && m > 0 ? m : 190;
}

/** Seed the zones file from the athlete's current zones if it doesn't exist yet. */
export async function ensureZonesFile(): Promise<void> {
  if (await knowledgeExists(ZONES_FILE_ID)) return;
  const [pz, maxHR] = await Promise.all([getPowerZones(), getMaxHR()]);
  await upsertKnowledge(
    ZONES_FILE_ID, 'Power & HR Zones',
    'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs',
    zonesMarkdown(maxHR, pz),
  );
}

// Decode the step name the native WorkoutProxy patch encodes into an activity's UUID
// suffix (…::meta::title=…|WorkoutStepName=…|…::stat::…). Used to spot the "Drills" step.
function stepNameFromUuid(uuid: string): string {
  const m = uuid.indexOf('::meta::');
  if (m < 0) return '';
  const s = uuid.indexOf('::stat::', m);
  const metaStr = uuid.slice(m + 8, s >= 0 ? s : undefined);
  let title = '', stepName = '';
  for (const pair of metaStr.split('|')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq), v = pair.slice(eq + 1);
    if (k === 'title') title = v;
    if (k === 'WorkoutStepName') stepName = v;
  }
  return title || stepName;
}

interface RunWindow { start: number; end: number; drillRanges: { from: number; to: number }[]; }

async function latestRun(): Promise<RunWindow | null> {
  const workouts: any[] = await safe(() => (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: new Date(Date.now() - 14 * 86_400_000), endDate: new Date() },
    limit: 50, ascending: false, energyUnit: 'kcal', distanceUnit: 'm',
  }), []);
  const run = workouts.find(w => w.workoutActivityType === RUN_TYPE);
  if (!run) return null;
  const start = new Date(run.startDate).getTime();
  const durSec = typeof run.duration === 'object' && run.duration !== null ? (run.duration.quantity ?? 0) : (run.duration ?? 0);
  // Time ranges of any "Drills" step → excluded from the power/HR-zone calibration.
  const drillRanges = ((run.activities ?? []) as any[])
    .filter(a => /drill/i.test(stepNameFromUuid(a?.uuid ?? '')))
    .map(a => ({ from: new Date(a.startDate).getTime(), to: a.endDate ? new Date(a.endDate).getTime() : 0 }))
    .filter(r => r.to > r.from);
  return { start, end: start + durSec * 1000, drillRanges };
}

export interface RunZoneAnalysis {
  date: string;
  durationMin: number;
  perZone: { z: string; minutes: number; avgPower: number; avgHR: number }[];
}

/** Observed average running power at each HR zone for the most recent run. */
export async function analyzeLastRun(): Promise<RunZoneAnalysis | null> {
  const run = await latestRun();
  if (!run) return null;
  const inDrill = (t: number) => run.drillRanges.some(r => t >= r.from && t <= r.to);
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
    if (bpm <= 0 || p.v <= 0 || inDrill(p.t)) continue; // drills excluded from calibration
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
export async function recalibrateZonesFromLastRun(): Promise<{ updated: boolean; reason?: string }> {
  await ensureZonesFile();
  const analysis = await analyzeLastRun();
  if (!analysis || analysis.perZone.length === 0) return { updated: false, reason: 'No running-power + HR data in your last run.' };

  const current = await readKnowledgeContent(ZONES_FILE_ID);
  const system =
    `You maintain a running coach's "Power & HR Zones" file (a markdown table Zone|Name|HR|Power). ` +
    `Update ONLY the Power (W) column so each HR zone maps to the OBSERVED average running power from the latest run. ` +
    `Blend gently with the existing values (move ~30% toward observed; don't overreact to one run); keep the HR ranges, ` +
    `the table structure and the surrounding text. Refresh the "Last calibrated" line. Return ONLY the updated markdown — no code fences.`;
  const user =
    `Current file:\n"""\n${current}\n"""\n\n` +
    `Latest run (${analysis.date}, ${analysis.durationMin} min) — observed power by HR zone:\n` +
    analysis.perZone.map(z => `${z.z}: ${z.minutes} min, avg HR ${z.avgHR}, avg power ${z.avgPower} W`).join('\n');

  const out = (await callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 900 }))
    .trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!out) return { updated: false, reason: 'Coach returned nothing.' };

  await upsertKnowledge(ZONES_FILE_ID, 'Power & HR Zones', 'Z1–Z5 HR ranges mapped to running power (watts); refined from your runs', out);
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

  const res = await recalibrateZonesFromLastRun();
  try { await FileSystem.writeAsStringAsync(LAST_RUN_FILE, JSON.stringify({ start: run.start, at: Date.now() })); } catch { /* ignore */ }
  return res.updated;
}
