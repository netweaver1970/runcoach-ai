/**
 * Plain-English glossary + this-run values + light history for the TrainingPeaks-style metrics, for the Run
 * Analysis screen. DETERMINISTIC (no LLM) so it always renders and works keyless — it's the "what do these
 * numbers even mean?" companion to the prose review. Each entry: a metric, its value for THIS run, a one-line
 * explanation, and a read that folds in recent history. Proper history GRAPHS live on the Statistics screen.
 */
import { loadSnapshotCache } from './healthkit';
import { assembleCoachSnapshot } from './coach';
import { getPowerZones } from './claude';
import { ftpFromZones } from './powerMetrics';
import { efficiencyTrend, decouplingTrend } from './runStats';
import { RunWorkout } from '../types';

export interface MetricEntry {
  key:   string;
  label: string;             // "TSS · Training Stress"
  value: string;             // "65"
  plain: string;             // what it measures, plain English
  read?: string;             // interpretation for THIS run + recent history
  tone?: 'good' | 'watch' | 'neutral';
}
export interface RunMetricsGlossary { runUUID: string; runLabel: string; entries: MetricEntry[]; }

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Build the glossary for a run (defaults to the latest). Returns null if there's no run data yet. */
export async function loadRunMetricsGlossary(runUUID?: string): Promise<RunMetricsGlossary | null> {
  const snap = await loadSnapshotCache();
  const runs: RunWorkout[] = (snap?.runs ?? []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!runs.length) return null;
  const run = (runUUID && runs.find(r => r.uuid === runUUID)) || runs[runs.length - 1];
  const prev = runs.slice(0, runs.indexOf(run));

  const [pz, cs] = await Promise.all([
    getPowerZones().catch(() => null),
    assembleCoachSnapshot(snap?.strain ?? null, snap?.activities, snap?.runs).catch(() => null),
  ]);
  const ftp = pz ? ftpFromZones(pz) : 0;
  const E: MetricEntry[] = [];

  // ── TSS ─────────────────────────────────────────────────────────────────────
  if (run.tss != null && run.tss > 0) {
    const recent = avg(prev.slice(-12).map(r => r.tss ?? 0).filter(x => x > 0));
    E.push({
      key: 'tss', label: 'TSS · Training Stress Score', value: String(Math.round(run.tss)),
      plain: 'One number for the whole session — how long × how hard. ~50 = an easy hour · 100 = a hard threshold hour · 150+ = a big day.',
      read: recent > 0
        ? `Recent avg ~${Math.round(recent)} — ${run.tss > recent * 1.15 ? 'bigger than usual' : run.tss < recent * 0.85 ? 'lighter than usual' : 'about typical for you'}.`
        : undefined,
    });
  }
  // ── IF ──────────────────────────────────────────────────────────────────────
  const iff = (run.np && ftp > 0) ? Math.round((run.np / ftp) * 100) / 100 : null;
  if (iff != null) {
    E.push({
      key: 'if', label: 'IF · Intensity Factor', value: iff.toFixed(2),
      plain: 'How hard the run was vs your threshold. 0.65–0.75 = easy · ~0.85 = tempo · 1.0 = threshold · >1.05 = intervals/race.',
      read: iff < 0.78 ? 'Easy / aerobic effort.' : iff < 0.9 ? 'Tempo effort.' : iff < 1.02 ? 'Threshold effort.' : 'Very hard — intervals or race pace.',
    });
  }
  // ── NP ──────────────────────────────────────────────────────────────────────
  if (run.np != null && run.np > 0) {
    E.push({
      key: 'np', label: 'NP · Normalized Power', value: `${Math.round(run.np)} W`,
      plain: 'Your “effective” power — weights the surges more than the easy stretches, so it reflects the real physiological cost better than raw average watts.',
      read: ftp > 0 ? `Your threshold power (FTP) ≈ ${ftp} W.` : undefined,
    });
  }
  // ── EF (aerobic engine) ──────────────────────────────────────────────────────
  const efPts = efficiencyTrend([...prev, run]);
  const mineEf = efPts[efPts.length - 1];
  if (mineEf && mineEf.ef > 0) {
    const base = avg(efPts.slice(0, -1).filter(p => p.aerobic && p.ef > 0).slice(-8).map(p => p.ef));
    const dir = base > 0 ? (mineEf.ef > base * 1.02 ? '↑ improving' : mineEf.ef < base * 0.98 ? '↓ down' : '→ flat') : '';
    E.push({
      key: 'ef', label: 'EF · Efficiency Factor', value: mineEf.ef.toFixed(2),
      plain: 'Power per heartbeat — your aerobic engine. Rising EF at the same HR means you’re getting fitter, even when CTL looks flat.',
      read: base > 0 ? `Recent aerobic avg ~${base.toFixed(2)} · ${dir}.` : undefined,
      tone: dir.startsWith('↑') ? 'good' : dir.startsWith('↓') ? 'watch' : 'neutral',
    });
  }
  // ── Decoupling (aerobic durability) — cached; only for steady aerobic runs ────
  try {
    const dc = await decouplingTrend([run]);   // only THIS run (cached by uuid) — avoids fetching the whole history's detail
    const mineDc = dc.find(p => p.date === run.date) ?? dc[0];
    if (mineDc && Number.isFinite(mineDc.pct)) {
      const v = mineDc.pct;
      E.push({
        key: 'dc', label: 'Decoupling · Pw:HR', value: `${v > 0 ? '+' : ''}${v.toFixed(1)}%`,
        plain: 'Aerobic durability — did your HR drift up relative to power in the 2nd half? Under 5% = strong base · over 8% = you faded or under-fuelled.',
        read: v < 5 ? 'Strong — you held form to the end.' : v < 8 ? 'Some drift — normal on longer or harder runs.' : 'Notable fade — check pacing, heat, or fuelling.',
        tone: v < 5 ? 'good' : v < 8 ? 'neutral' : 'watch',
      });
    }
  } catch { /* decoupling is aerobic-only + needs the detail stream; skip quietly */ }
  // ── CTL / ATL / TSB (the PMC) ─────────────────────────────────────────────────
  if (cs && cs.ctl != null) {
    const tsb = Math.round(cs.tsb ?? 0);
    E.push({
      key: 'pmc', label: 'CTL / ATL / TSB · Fitness · Fatigue · Form',
      value: `${Math.round(cs.ctl ?? 0)} / ${Math.round(cs.atl ?? 0)} / ${tsb >= 0 ? '+' : ''}${tsb}`,
      plain: 'CTL = fitness (42-day load) · ATL = fatigue (7-day load) · TSB = form (fitness − fatigue). Negative form = training hard · positive = fresh.',
      read: tsb < -20 ? 'Deep fatigue — a recovery day is due.' : tsb < -5 ? 'Carrying training fatigue (normal in a build).' : tsb > 5 ? 'Fresh / tapered.' : 'Balanced.',
      tone: tsb < -20 ? 'watch' : 'neutral',
    });
  }

  return E.length ? { runUUID: run.uuid, runLabel: run.label ?? 'Run', entries: E } : null;
}
