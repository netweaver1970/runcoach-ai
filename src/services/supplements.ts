import * as FileSystem from 'expo-file-system';

// Lightweight supplement tracker: a user-defined list + a per-supplement log of the ISO dates taken.
// Kept SEPARATE from the timeline events so daily intakes don't clutter the life-events history, and so
// one-tap logging stays instant. Fed to the coach as a compact adherence line.

const FILE = `${FileSystem.documentDirectory}runcoach-supplements.json`;

export interface SupplementData {
  list:   string[];                              // supplement names, in display order
  log:    Record<string, string[]>;              // name → ISO dates taken (YYYY-MM-DD)
  doses?: Record<string, Record<string, number>>; // name → dateISO → mg (optional; for dosed stimulants)
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

async function read(): Promise<SupplementData> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { list: [], log: {} };
    const d = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as SupplementData;
    return { list: d.list ?? [], log: d.log ?? {}, doses: d.doses ?? {} };
  } catch { return { list: [], log: {}, doses: {} }; }
}
async function write(d: SupplementData): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(d)); } catch { /* ignore */ }
}

export async function loadSupplements(): Promise<SupplementData> { return read(); }

export async function addSupplement(name: string): Promise<void> {
  const n = name.trim(); if (!n) return;
  const d = await read();
  if (!d.list.some(x => x.toLowerCase() === n.toLowerCase())) { d.list.push(n); await write(d); }
}
export async function removeSupplement(name: string): Promise<void> {
  const d = await read();
  d.list = d.list.filter(x => x !== name);
  delete d.log[name];
  await write(d);
}

/** One-tap: mark taken today, or un-mark if tapped again. Returns the new taken-today state. */
export async function toggleSupplementToday(name: string): Promise<boolean> {
  const d = await read();
  const t = todayISO();
  const dates = new Set(d.log[name] ?? []);
  let taken: boolean;
  if (dates.has(t)) { dates.delete(t); taken = false; } else { dates.add(t); taken = true; }
  d.log[name] = [...dates].sort();
  await write(d);
  return taken;
}

export function takenToday(d: SupplementData, name: string, today = todayISO()): boolean {
  return (d.log[name] ?? []).includes(today);
}
/** True if ANY supplement whose name matches `re` was logged on `dateISO` (YYYY-MM-DD). Used to keep
 *  HR-raising stimulants (e.g. yohimbine) out of the auto zone calibration. */
export function anyTakenOn(d: SupplementData, dateISO: string, re: RegExp): boolean {
  return d.list.some(n => re.test(n) && (d.log[n] ?? []).includes(dateISO));
}
/** Record a dose (mg) for a supplement on a date. */
export async function setDose(name: string, dateISO: string, mg: number): Promise<void> {
  const d = await read();
  d.doses = d.doses ?? {};
  d.doses[name] = { ...(d.doses[name] ?? {}), [dateISO]: mg };
  await write(d);
}
export function getDose(d: SupplementData, name: string, dateISO: string): number {
  return d.doses?.[name]?.[dateISO] ?? 0;
}
/** Most recent recorded dose for a supplement, to prefill the next entry. */
export function lastDose(d: SupplementData, name: string, fallback = 10): number {
  const map = d.doses?.[name]; if (!map) return fallback;
  const days = Object.keys(map).sort(); return days.length ? map[days[days.length - 1]] : fallback;
}

// ── Stimulant → exercise-HR offset model (for the run-analysis EF/SE correction) ──
// Research-based (Goldberg 1983 IV dose-ranging; Berlan/Galitzky 0.2 mg/kg oral; Musso 1995 10 mg;
// 20 mg crossover, Hypertension/AHA 2008 → +5 bpm; 5 mg/14 d maximal-exercise 2025 → no HR change):
// low/moderate yohimbine (≤~10 mg) raises BP but NOT heart rate — the pressor effect is offset by the
// baroreflex — and HR only rises ~+5 bpm by 20 mg. So the correction is ~0 up to 10 mg and ramps to +5 at
// 20 mg (NOT linear from zero). A cup of coffee adds a modest ~2 bpm. Estimates; the HR-INDEPENDENT metric
// (EC = speed÷power) is the real comparator — this only tidies the HR-based EF/SE.
const COFFEE_BPM = 2;               // one cup (~100 mg caffeine); small exercise-HR effect
const YOH_THRESHOLD_MG = 10;        // below this, ~no HR effect (BP rises, HR held by the baroreflex)
const YOH_BPM_PER_MG = 0.5;         // above threshold → +5 bpm by 20 mg
const DEFAULT_YOHIMBINE_MG = 10;    // legacy entries with no recorded dose → threshold (⇒ 0 yohimbine bpm)
const MAX_HR_OFFSET = 15;           // clamp so a mis-typed dose can't wildly distort

/** Yohimbine's dose-dependent exercise-HR bump (bpm): ~0 up to ~10 mg, ~+5 by 20 mg. */
function yohimbineBpm(mg: number): number { return Math.max(0, (mg - YOH_THRESHOLD_MG) * YOH_BPM_PER_MG); }

/** date (YYYY-MM-DD) → bpm to SUBTRACT from that day's HR before EF/SE, from yohimbine dose + coffee. */
export function hrOffsetByDay(d: SupplementData, re = /yohimb/i): Record<string, number> {
  const mgByDay: Record<string, number> = {};
  for (const n of d.list) {
    if (!re.test(n)) continue;
    for (const iso of d.log[n] ?? []) mgByDay[iso] = (mgByDay[iso] ?? 0) + (d.doses?.[n]?.[iso] ?? DEFAULT_YOHIMBINE_MG);
  }
  const out: Record<string, number> = {};
  for (const [iso, mg] of Object.entries(mgByDay)) out[iso] = Math.min(MAX_HR_OFFSET, COFFEE_BPM + yohimbineBpm(mg));
  return out;
}
/** Days-taken out of the last `days` window (for the little "5/7" adherence badge). */
export function adherence(d: SupplementData, name: string, days = 7, now = todayISO()): number {
  const base = new Date(now + 'T00:00:00');
  const lo = new Date(base); lo.setDate(lo.getDate() - (days - 1));
  return (d.log[name] ?? []).filter(iso => { const t = new Date(iso + 'T00:00:00'); return t >= lo && t <= base; }).length;
}

/** Compact LLM line: "SUPPLEMENTS (7d): Creatine 6/7; Vitamin D 7/7 · today: Creatine". Empty if no list. */
export function buildSupplementContext(d: SupplementData, days = 7, now = todayISO()): string {
  if (!d.list.length) return '';
  const parts = d.list.map(n => `${n} ${adherence(d, n, days, now)}/${days}`);
  const takenT = d.list.filter(n => takenToday(d, n, now));
  return `\n\nSUPPLEMENTS (${days}d adherence): ${parts.join('; ')}${takenT.length ? ` · taken today: ${takenT.join(', ')}` : ''}`;
}
