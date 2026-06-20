/**
 * Compare our daily metrics against the Bevel dataset, per KPI and per component.
 *
 * Primary signal = Bevel's EXACT 30-day average (printed on every detail screen)
 * vs OUR 30-day average over the same window. This is reliable and drives the
 * component-level "off" flags and correction recommendations.
 *
 * Secondary = day-by-day pairs (today's exact value + any imported days) → Pearson
 * r once ≥3 days, for trend agreement.
 */

import { BEVEL_KPIS, ComponentScale, UnitKind } from './bevelScales';
import { BevelDay, BevelKpiKey, BevelComponentAvg } from './bevelData';

export interface Pair { date: string; bevel: number; ours: number; partial?: boolean; }

export type CompFlag = 'ok' | 'off' | 'low-data';

export interface ComponentComparison {
  key:        string;
  label:      string;
  unit:       UnitKind;
  isScore?:   boolean;
  ourField:   string;
  // 30-day averages (primary)
  bevelAvg:   number | null;
  ourAvg:     number | null;
  ourDays:    number;
  avgBias:    number | null;   // ourAvg − bevelAvg (canonical units)
  avgBiasPct: number | null;   // null for clock/signed units
  // day-by-day (secondary)
  n:          number;
  r:          number | null;
  flag:       CompFlag;
  recommendation?: string;
}

export interface KpiComparison {
  kpi:        BevelKpiKey;
  label:      string;
  score:      ComponentComparison;
  components: ComponentComparison[];
  offCount:   number;
}

const OFF_PCT = 15;   // magnitude components: |avg bias| ≥ 15% ⇒ flagged
const OFF_MIN = 25;   // clock/duration: |avg bias| ≥ 25 min ⇒ flagged
const LOW_R   = 0.3;

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function round(v: number): number { return Math.round(v * 10) / 10; }

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return Math.round((num / Math.sqrt(da * db)) * 100) / 100;
}

const isMagnitude = (u: UnitKind) => u !== 'clock_time' && u !== 'signed_min';

function componentKpi(key: string): BevelKpiKey {
  for (const k of BEVEL_KPIS) if (k.components.some(c => c.key === key)) return k.key;
  return 'strain';
}

function compareComponent(
  comp: ComponentScale,
  averages: Record<string, BevelComponentAvg>,
  days: BevelDay[],
  ours: Record<string, Record<string, number>>,
): ComponentComparison {
  // Our 30-day average for this component
  const ourVals = Object.values(ours)
    .map(d => d[comp.key])
    .filter((v): v is number => v !== undefined);
  const ourAvg = ourVals.length ? mean(ourVals) : null;

  // Bevel exact 30-day average
  const bevelAvg = averages[comp.key]?.avg ?? null;

  // Day-by-day pairs (for r)
  const kpi = componentKpi(comp.key);
  const pairs: Pair[] = [];
  for (const d of days) {
    const rec = (d as any)[kpi] as { components: Record<string, number> } | undefined;
    const bev = rec?.components[comp.key];
    const our = ours[d.date]?.[comp.key];
    if (bev !== undefined && our !== undefined) pairs.push({ date: d.date, bevel: bev, ours: our });
  }
  const r = pairs.length >= 3 ? pearson(pairs.map(p => p.bevel), pairs.map(p => p.ours)) : null;

  let avgBias: number | null = null, avgBiasPct: number | null = null;
  let flag: CompFlag = 'low-data', recommendation: string | undefined;

  if (bevelAvg !== null && ourAvg !== null) {
    avgBias = ourAvg - bevelAvg;
    avgBiasPct = isMagnitude(comp.unit) && bevelAvg !== 0 ? (avgBias / Math.abs(bevelAvg)) * 100 : null;
    const off = isMagnitude(comp.unit)
      ? (avgBiasPct !== null && Math.abs(avgBiasPct) >= OFF_PCT) || (r !== null && r < LOW_R)
      : Math.abs(avgBias) >= OFF_MIN;
    flag = off ? 'off' : 'ok';
    if (off) {
      const dir = avgBias > 0 ? 'higher' : 'lower';
      const amt = avgBiasPct !== null ? `~${Math.abs(Math.round(avgBiasPct))}%` : `~${Math.abs(Math.round(avgBias))} min`;
      recommendation = `Our 30-day avg is ${amt} ${dir} than Bevel (${comp.ourField}). Adjust this component toward Bevel.`;
    }
  }

  return {
    key: comp.key, label: comp.label, unit: comp.unit, isScore: comp.isScore, ourField: comp.ourField,
    bevelAvg: bevelAvg === null ? null : round(bevelAvg),
    ourAvg:   ourAvg === null ? null : round(ourAvg),
    ourDays:  ourVals.length,
    avgBias:  avgBias === null ? null : round(avgBias),
    avgBiasPct: avgBiasPct === null ? null : Math.round(avgBiasPct),
    n: pairs.length, r, flag, recommendation,
  };
}

export function buildBevelComparison(
  averages: Record<string, BevelComponentAvg>,
  days: BevelDay[],
  ours: Record<string, Record<string, number>>,
): KpiComparison[] {
  return BEVEL_KPIS.map(k => {
    const comps = k.components.map(c => compareComponent(c, averages, days, ours));
    const score = comps.find(c => c.isScore)!;
    const components = comps.filter(c => !c.isScore);
    const offCount = comps.filter(c => c.flag === 'off').length;
    return { kpi: k.key, label: k.label, score, components, offCount };
  });
}
