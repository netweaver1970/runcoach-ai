/**
 * Compare our daily metrics against the imported Bevel dataset, per KPI and per
 * component, and surface where we're systematically off — which drives the
 * component-level corrections.
 */

import { BEVEL_KPIS, kpiScale, ComponentScale, UnitKind } from './bevelScales';
import { BevelDay, BevelKpiKey } from './bevelData';

export interface Pair { date: string; bevel: number; ours: number; partial?: boolean; }

export type CompFlag = 'ok' | 'off' | 'low-data';

export interface ComponentComparison {
  key:        string;
  label:      string;
  unit:       UnitKind;
  isScore?:   boolean;
  n:          number;
  bevelMean:  number | null;
  oursMean:   number | null;
  bias:       number | null;   // ours − bevel (canonical units)
  biasPct:    number | null;   // null for clock/signed (percent meaningless)
  mae:        number | null;
  r:          number | null;   // Pearson, null if n < 3
  flag:       CompFlag;
  recommendation?: string;
  ourField:   string;
  pairs:      Pair[];
}

export interface KpiComparison {
  kpi:        BevelKpiKey;
  label:      string;
  score:      ComponentComparison;
  components: ComponentComparison[];
  offCount:   number;
}

const OFF_PCT = 15;       // magnitude components: |bias| ≥ 15% ⇒ flagged
const OFF_MIN = 25;       // clock/duration: |bias| ≥ 25 min ⇒ flagged
const LOW_R   = 0.3;      // weak correlation once we have enough days

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

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

function isMagnitude(unit: UnitKind): boolean {
  return unit !== 'clock_time' && unit !== 'signed_min';
}

function compareComponent(comp: ComponentScale, days: BevelDay[], ours: Record<string, Record<string, number>>): ComponentComparison {
  const pairs: Pair[] = [];
  for (const d of days) {
    const rec = (d as any)[componentKpi(comp.key)] as { components: Record<string, number>; partial?: boolean } | undefined;
    if (!rec) continue;
    const bev = rec.components[comp.key];
    const our = ours[d.date]?.[comp.key];
    if (bev === undefined || our === undefined) continue;
    pairs.push({ date: d.date, bevel: bev, ours: our, partial: rec.partial });
  }

  const base: ComponentComparison = {
    key: comp.key, label: comp.label, unit: comp.unit, isScore: comp.isScore,
    n: pairs.length, bevelMean: null, oursMean: null, bias: null, biasPct: null,
    mae: null, r: null, flag: 'low-data', recommendation: undefined, ourField: comp.ourField, pairs,
  };
  if (pairs.length === 0) return base;

  const bevelMean = mean(pairs.map(p => p.bevel));
  const oursMean  = mean(pairs.map(p => p.ours));
  const bias      = oursMean - bevelMean;
  const biasPct   = isMagnitude(comp.unit) && bevelMean !== 0 ? (bias / Math.abs(bevelMean)) * 100 : null;
  const mae       = mean(pairs.map(p => Math.abs(p.ours - p.bevel)));
  const r         = pearson(pairs.map(p => p.bevel), pairs.map(p => p.ours));

  const off = isMagnitude(comp.unit)
    ? (biasPct !== null && Math.abs(biasPct) >= OFF_PCT) || (r !== null && r < LOW_R)
    : Math.abs(bias) >= OFF_MIN;

  let recommendation: string | undefined;
  if (off) {
    const dir = bias > 0 ? 'higher' : 'lower';
    const amt = biasPct !== null
      ? `~${Math.abs(Math.round(biasPct))}%`
      : `~${Math.abs(Math.round(bias))} min`;
    recommendation = `Ours reads ${amt} ${dir} than Bevel (${comp.ourField}). Adjust this component toward Bevel.`;
  }

  return {
    ...base,
    bevelMean: round(bevelMean), oursMean: round(oursMean), bias: round(bias),
    biasPct: biasPct === null ? null : Math.round(biasPct),
    mae: round(mae), r,
    flag: off ? 'off' : 'ok', recommendation,
  };
}

function round(v: number): number { return Math.round(v * 10) / 10; }

/** Which KPI bucket a component key lives under (used to read the right Bevel record). */
function componentKpi(key: string): BevelKpiKey {
  for (const k of BEVEL_KPIS) if (k.components.some(c => c.key === key)) return k.key;
  return 'strain';
}

export function buildBevelComparison(
  days: BevelDay[],
  ours: Record<string, Record<string, number>>,
): KpiComparison[] {
  return BEVEL_KPIS.map(k => {
    const comps = k.components.map(c => compareComponent(c, days, ours));
    const score = comps.find(c => c.isScore)!;
    const components = comps.filter(c => !c.isScore);
    const offCount = comps.filter(c => c.flag === 'off').length;
    return { kpi: k.key, label: k.label, score, components, offCount };
  });
}
