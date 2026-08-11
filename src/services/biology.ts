/**
 * BIOLOGY mode analytics — historical body-composition + blood-pressure analysis, correlated with
 * training load, run volume, and the athlete's timeline (medical / life events).
 *
 * Scientific-soundness rules applied here (so the correlations aren't junk):
 *  • Biometrics are sparse (weight/BF% measured intermittently). We forward-fill each to a DAILY grid
 *    but only up to a STALENESS CAP — never correlate a metric against a value more than `capDays` old.
 *  • Correlation is SPEARMAN rank (robust to outliers + non-linearity), computed only over days where
 *    BOTH series have a fresh value (paired-complete), with the sample size `n` always reported.
 *  • A LAG SCAN tests whether the driver leads the metric (e.g. training load → weight N days later);
 *    the best |rho| lag is reported so we don't miss a delayed effect or over-fit a spurious zero-lag one.
 *  • Significance via the t-approximation t = rho·√((n−2)/(1−rho²)); flagged only when |t|>2 AND n≥8.
 *  • Trends are OLS slope over time (units/week) — a measured rate, not eyeballing.
 *  • Events get a BEFORE/AFTER mean comparison (±window) — the honest way to read a discrete intervention.
 *  • Correlation ≠ causation is stated, and concurrent timeline events (e.g. medication) are surfaced as
 *    confounders rather than hidden.
 */
import { loadSnapshotCache, fetchBodyMassHistory, fetchBodyFatHistory, fetchLeanBodyMassHistory, fetchBloodPressureHistory } from './healthkit';
import { loadEvents } from './timelineEvents';

export type BioKey = 'weight' | 'bodyfat' | 'lean' | 'bpSys' | 'bpDia';

export interface BioPoint { date: string; value: number }
export interface BioCorrelation {
  against:     'Fitness (CTL)' | 'Run volume (7-day km)';
  rho:         number;
  n:           number;
  lagDays:     number;   // >0 = the driver LEADS the metric by this many days
  significant: boolean;
  strength:    'strong' | 'moderate' | 'weak' | 'none';
  note:        string;
}
export interface BioMetric {
  key:          BioKey;
  label:        string;
  unit:         string;
  points:       BioPoint[];       // raw measured points (chart markers)
  latest:       number | null;
  latestDate:   string | null;
  n:            number;
  trendPerWeek: number | null;    // OLS slope × 7
  trendDir:     'up' | 'down' | 'flat' | null;
  correlations: BioCorrelation[];
}
export interface BioEventImpact {
  label: string; date: string; category: string;
  effects: { key: BioKey; label: string; unit: string; before: number | null; after: number | null; delta: number | null; nBefore: number; nAfter: number }[];
}
export interface BiologyReport {
  rangeMonths: number;
  metrics:     BioMetric[];
  ctl:         BioPoint[];                                   // daily CTL for overlay
  runKm7d:     BioPoint[];                                   // rolling 7-day run km for overlay/correlation
  events:      { date: string; endDate?: string; label: string; category: string }[];
  eventImpacts: BioEventImpact[];
  hasAnyData:  boolean;
  generatedAt: string;
}

// ── stats ──────────────────────────────────────────────────────────────────────
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;                       // average rank for ties (1-based)
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(x: number[], y: number[]): number {
  const n = x.length; if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));
function tSignificant(rho: number, n: number): boolean {
  if (n < 8 || Math.abs(rho) >= 1) return n >= 8 && Math.abs(rho) >= 0.99;
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return Math.abs(t) > 2;                              // ≈ two-sided p < 0.05 for moderate n
}
const strengthOf = (r: number): BioCorrelation['strength'] => {
  const a = Math.abs(r);
  return a >= 0.6 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'none';
};

// ── daily-grid helpers ───────────────────────────────────────────────────────────
const dayKey = (iso: string) => iso.slice(0, 10);
function dayList(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const d = new Date(startISO + 'T00:00:00'); const end = new Date(endISO + 'T00:00:00');
  while (d <= end) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); d.setDate(d.getDate() + 1); }
  return out;
}
// Forward-fill a sparse series to the daily grid, but only while the last reading is ≤ capDays old.
function forwardFill(points: BioPoint[], days: string[], capDays: number): (number | null)[] {
  const byDay = new Map(points.map(p => [dayKey(p.date), p.value]));
  const out: (number | null)[] = []; let last: number | null = null; let ageDays = Infinity;
  for (const day of days) {
    if (byDay.has(day)) { last = byDay.get(day)!; ageDays = 0; }
    else ageDays++;
    out.push(last != null && ageDays <= capDays ? last : null);
  }
  return out;
}
// OLS slope of value vs day-index (units per day). Nulls skipped.
function olsSlopePerDay(series: (number | null)[]): { slope: number; n: number } {
  const xs: number[] = [], ys: number[] = [];
  series.forEach((v, i) => { if (v != null) { xs.push(i); ys.push(v); } });
  const n = xs.length; if (n < 3) return { slope: 0, n };
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx; }
  return { slope: den > 0 ? num / den : 0, n };
}
// Best-lag Spearman: driver leads metric by L days (L in [0..maxLag]); pairs where both fresh.
function bestLagSpearman(metric: (number | null)[], driver: (number | null)[], maxLag: number): { rho: number; n: number; lag: number } {
  let best = { rho: 0, n: 0, lag: 0 };
  for (let L = 0; L <= maxLag; L++) {
    const mv: number[] = [], dv: number[] = [];
    for (let i = 0; i < metric.length; i++) {
      const di = i - L;                                // driver L days earlier
      if (di < 0) continue;
      const m = metric[i], d = driver[di];
      if (m != null && d != null) { mv.push(m); dv.push(d); }
    }
    if (mv.length >= 8) {
      const rho = spearman(dv, mv);
      if (Math.abs(rho) > Math.abs(best.rho)) best = { rho, n: mv.length, lag: L };
    }
  }
  return best;
}

const STALE_CAP: Record<BioKey, number> = { weight: 10, bodyfat: 21, lean: 21, bpSys: 7, bpDia: 7 };
const META: Record<BioKey, { label: string; unit: string }> = {
  weight:  { label: 'Weight',        unit: 'kg' },
  bodyfat: { label: 'Body fat',      unit: '%' },
  lean:    { label: 'Lean mass',     unit: 'kg' },
  bpSys:   { label: 'BP systolic',   unit: 'mmHg' },
  bpDia:   { label: 'BP diastolic',  unit: 'mmHg' },
};

export async function computeBiologyReport(months = 12): Promise<BiologyReport> {
  const [snap, events, weight, bodyfat, lean, bp] = await Promise.all([
    loadSnapshotCache().catch(() => null),
    loadEvents().catch(() => []),
    fetchBodyMassHistory(months).catch(() => []),
    fetchBodyFatHistory(months).catch(() => []),
    fetchLeanBodyMassHistory(months).catch(() => []),
    fetchBloodPressureHistory(months).catch(() => []),
  ]);

  const rawPoints: Record<BioKey, BioPoint[]> = {
    weight, bodyfat, lean,
    bpSys: bp.map(b => ({ date: b.date, value: b.systolic })),
    bpDia: bp.map(b => ({ date: b.date, value: b.diastolic })),
  };

  // Training-load + run-volume drivers (daily).
  const load = (snap?.trainingLoad ?? []) as { date: string; ctl: number }[];
  const ctlPoints: BioPoint[] = load.map(l => ({ date: dayKey(l.date), value: Math.round(l.ctl * 10) / 10 }));
  const runByDay = new Map<string, number>();
  for (const r of (snap?.runs ?? [])) { const k = dayKey(r.date); runByDay.set(k, (runByDay.get(k) ?? 0) + (r.distance ?? 0) / 1000); }

  // Window = from the earliest data point to today.
  const allDates = [
    ...weight, ...bodyfat, ...lean, ...bp.map(b => ({ date: b.date })), ...ctlPoints, ...[...runByDay.keys()].map(d => ({ date: d })),
  ].map(p => dayKey((p as any).date)).filter(Boolean).sort();
  const hasAnyData = weight.length + bodyfat.length + lean.length + bp.length > 0;
  const today = dayKey(new Date().toISOString());
  const start = allDates[0] ?? today;
  const days = dayList(start, today);

  // Daily driver arrays.
  const ctlFilled = forwardFill(ctlPoints, days, 3);
  const runKm7Arr: (number | null)[] = days.map((_, i) => {
    let sum = 0, any = false;
    for (let k = 0; k < 7; k++) { const j = i - k; if (j >= 0) { const v = runByDay.get(days[j]); if (v != null) { sum += v; any = true; } } }
    return any || i >= 6 ? sum : null;                 // 7-day rolling km (0 counts once ≥7 days in)
  });
  const runKm7d: BioPoint[] = days.map((d, i) => ({ date: d, value: runKm7Arr[i] ?? 0 }));
  const ctl: BioPoint[] = days.map((d, i) => ({ date: d, value: ctlFilled[i] ?? 0 })).filter((_, i) => ctlFilled[i] != null);

  const metrics: BioMetric[] = (Object.keys(META) as BioKey[]).map(key => {
    const points = rawPoints[key];
    const filled = forwardFill(points, days, STALE_CAP[key]);
    const { slope, n } = olsSlopePerDay(filled);
    const trendPerWeek = n >= 3 ? Math.round(slope * 7 * 100) / 100 : null;
    const latest = points.length ? points[points.length - 1].value : null;

    const correlations: BioCorrelation[] = [];
    if (points.length >= 8) {
      const drivers: { against: BioCorrelation['against']; arr: (number | null)[] }[] = [
        { against: 'Fitness (CTL)',        arr: ctlFilled },
        { against: 'Run volume (7-day km)', arr: runKm7Arr },
      ];
      for (const d of drivers) {
        const { rho, n: cn, lag } = bestLagSpearman(filled, d.arr, 21);
        if (cn >= 8) {
          const sig = tSignificant(rho, cn);
          const dir = rho > 0 ? 'rises with' : 'falls as';
          correlations.push({
            against: d.against, rho: Math.round(rho * 100) / 100, n: cn, lagDays: lag,
            significant: sig, strength: sig ? strengthOf(rho) : 'none',
            note: sig
              ? `${META[key].label} ${dir} ${d.against.toLowerCase()}${lag ? ` (lag ${lag}d)` : ''} — Spearman ρ=${(Math.round(rho * 100) / 100)}, n=${cn}. Association only, not proof of cause; check concurrent timeline events.`
              : `No significant link to ${d.against.toLowerCase()} (ρ=${(Math.round(rho * 100) / 100)}, n=${cn}).`,
          });
        }
      }
    }
    return {
      key, label: META[key].label, unit: META[key].unit, points,
      latest, latestDate: points.length ? dayKey(points[points.length - 1].date) : null,
      n: points.length, trendPerWeek,
      trendDir: trendPerWeek == null ? null : Math.abs(trendPerWeek) < trendEps(key) ? 'flat' : trendPerWeek > 0 ? 'up' : 'down',
      correlations,
    };
  });

  // Event impacts: medical / life events, mean ±21d before/after per metric.
  const relevant = events.filter(e => e.type === 'event' && (e.category === 'medical' || e.category === 'life'));
  const WIN = 21;
  const eventImpacts: BioEventImpact[] = relevant.slice(0, 12).map(e => {
    const ed = dayKey(e.date);
    const effects = (Object.keys(META) as BioKey[]).map(key => {
      const pts = rawPoints[key];
      const before = pts.filter(p => dayKey(p.date) < ed && withinDays(p.date, ed, WIN)).map(p => p.value);
      const after  = pts.filter(p => dayKey(p.date) >= ed && withinDays(p.date, ed, WIN)).map(p => p.value);
      const bM = before.length ? Math.round(mean(before) * 10) / 10 : null;
      const aM = after.length  ? Math.round(mean(after) * 10) / 10  : null;
      return { key, label: META[key].label, unit: META[key].unit, before: bM, after: aM,
        delta: bM != null && aM != null ? Math.round((aM - bM) * 10) / 10 : null, nBefore: before.length, nAfter: after.length };
    }).filter(x => x.before != null || x.after != null);
    return { label: e.title || e.category || 'Event', date: ed, category: e.category || 'other', effects };
  }).filter(ei => ei.effects.some(x => x.delta != null));

  return {
    rangeMonths: months, metrics, ctl, runKm7d,
    events: relevant.map(e => ({ date: dayKey(e.date), endDate: e.endDate ? dayKey(e.endDate) : undefined, label: e.title || e.category || 'Event', category: e.category || 'other' })),
    eventImpacts, hasAnyData, generatedAt: new Date().toISOString(),
  };
}

// "flat" threshold per metric (weekly change below this = no meaningful trend).
function trendEps(key: BioKey): number { return key === 'bodyfat' ? 0.05 : key === 'bpSys' || key === 'bpDia' ? 0.3 : 0.05; }
function withinDays(aISO: string, bISO: string, win: number): boolean {
  const a = new Date(dayKey(aISO) + 'T00:00:00').getTime(), b = new Date(bISO + 'T00:00:00').getTime();
  return Math.abs(a - b) <= win * 86_400_000;
}
