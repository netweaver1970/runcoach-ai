/**
 * HRV-CV interpretation — the night-to-night variation of ln(RMSSD) over 7 nights, read together with the 7-night
 * LEVEL (mean ln RMSSD), because the same low CV means opposite things depending on where the level is heading:
 *   • high CV vs your own normal → unsettled: bigger swings than usual. Grosicki…Plews, Altini 2026 (Am J Physiol
 *     Heart Circ Physiol, ~2M nights / 21k wearable users): higher HRV-CV goes with more alcohol, less activity,
 *     shorter and less consistent sleep, higher BMI — and tracks alcohol and sleep more strongly than HRV itself.
 *   • low CV + level steady or rising → settled: coping well (Flatt & Esco; HRV4Training).
 *   • low CV + level FALLING → Plews et al. 2012 (Eur J Appl Physiol): the elite triathlete who became non-
 *     functionally over-reached showed an unusually flat, declining HRV before it was diagnosed.
 * Judged against the runner's OWN history (z-score), with a population fallback (typical weekly CV ≈ 3–7.5%) until
 * there are 14 days of history. Guidance, not a diagnosis.
 */
export type HrvCvState = 'unsettled' | 'flat-falling' | 'settled' | 'normal' | 'drifting';

export interface HrvCvReading {
  state: HrvCvState;
  title: string;
  advice: string;
  z: number | null;                         // CV vs own history; null → population fallback used
  trend: 'up' | 'flat' | 'down' | null;     // 7-night level vs a week earlier; null → not enough data
  normalLo: number | null; normalHi: number | null;   // own normal range (mean ± 1 SD), %
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sdOf = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

/**
 * @param cv        today's HRV-CV (%)
 * @param cvHist    earlier HRV-CV values (%), oldest→newest, EXCLUDING today (last ~60 used)
 * @param ln7Now    today's 7-night mean ln(RMSSD)
 * @param ln7Prev   the 7-night mean ln(RMSSD) one week earlier (null if missing)
 * @param ln7Hist   earlier 7-night means, for the smallest-worthwhile-change band
 */
export function interpretHrvCv(
  cv: number, cvHist: number[], ln7Now: number | null, ln7Prev: number | null, ln7Hist: number[],
): HrvCvReading {
  const hist = cvHist.slice(-60);
  let z: number | null = null, normalLo: number | null = null, normalHi: number | null = null;
  if (hist.length >= 14) {
    const m = mean(hist), sd = sdOf(hist);
    if (sd > 0) { z = (cv - m) / sd; normalLo = Math.max(0, Math.round((m - sd) * 10) / 10); normalHi = Math.round((m + sd) * 10) / 10; }
  }
  const high = z !== null ? z >= 1 : cv > 10;
  const low  = z !== null ? z <= -1 : cv < 3;

  // Level trend: change vs a week earlier beyond the smallest worthwhile change (0.5 × SD of the 7-night means —
  // Plews/Buchheit convention), floored so a very stable history doesn't make noise look like a trend.
  let trend: HrvCvReading['trend'] = null;
  if (ln7Now != null && ln7Prev != null) {
    const swc = Math.max(0.02, 0.5 * sdOf(ln7Hist.slice(-60)));
    const d = ln7Now - ln7Prev;
    trend = d > swc ? 'up' : d < -swc ? 'down' : 'flat';
  }

  if (high) return { state: 'unsettled', title: 'Unsettled', z, trend, normalLo, normalHi,
    advice: 'Bigger night-to-night HRV swings than usual — typical of a hard block, stress, alcohol or short/irregular sleep. Keep intensity in check until it settles.' };
  if (low && trend === 'down') return { state: 'flat-falling', title: 'Flat and falling', z, trend, normalLo, normalHi,
    advice: 'Unusually steady HRV while its level drops — the pattern that preceded over-reaching in Plews 2012. Watch for fatigue; consider an easier day.' };
  if (trend === 'down') return { state: 'drifting', title: 'Normal swings, level drifting down', z, trend, normalLo, normalHi,
    advice: 'Night-to-night variation is normal, but the 7-night HRV level is sliding. Keep an eye on it.' };
  if (low || trend === 'up') return { state: 'settled', title: 'Settled', z, trend, normalLo, normalHi,
    advice: 'Stable HRV at a steady or rising level — coping well with training.' };
  return { state: 'normal', title: 'Normal fluctuation', z, trend, normalLo, normalHi,
    advice: 'Night-to-night variation within your usual range.' };
}
