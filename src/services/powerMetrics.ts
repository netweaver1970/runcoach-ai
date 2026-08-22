/**
 * TrainingPeaks-style power-stress metrics from a running-power stream.
 *   NP  (Normalized Power)  — 4th-root of the mean of the 30-s rolling-average power, to the 4th power.
 *   VI  (Variability Index) — NP ÷ average power (1.0 = perfectly steady, higher = surgey/intervals).
 *   IF  (Intensity Factor)  — NP ÷ FTP (threshold power).
 *   TSS (Training Stress)   — duration·NP·IF ÷ (FTP·3600) · 100  (=  hours · IF² · 100).
 *
 * FTP is derived from the athlete's configured power zones (mid-Threshold band); if zones aren't set,
 * NP + VI still compute (they don't need FTP) and IF/TSS are returned null.
 */
import { PowerZones } from '../types';

export interface PowerMetrics {
  np: number;
  avgPower: number;
  vi: number;
  if: number | null;
  tss: number | null;
  ftp: number;          // 0 when unknown
}

/** FTP (threshold power) ≈ the middle of the Threshold (Z4) band = tempoMax→intervalsMin. */
export function ftpFromZones(pz: PowerZones): number {
  if (pz.tempoMax > 0 && pz.intervalsMin > 0) return Math.round((pz.tempoMax + pz.intervalsMin) / 2);
  if (pz.intervalsMin > 0) return Math.round(pz.intervalsMin * 0.95);
  if (pz.tempoMax > 0)     return Math.round(pz.tempoMax * 1.05);
  return 0;
}

export function computePowerMetrics(
  power: { t: number; v: number }[],
  ftpW: number,
  durationSec: number,
): PowerMetrics | null {
  if (!power || power.length < 10 || durationSec <= 0) return null;

  // 1-Hz resample (nearest-held) so the 30-s window is well-defined even with irregular sampling.
  const sorted = [...power].filter(p => p.v >= 0).sort((a, b) => a.t - b.t);
  if (sorted.length < 10) return null;
  const startMs = sorted[0].t, endMs = sorted[sorted.length - 1].t;
  const secs = Math.min(36_000, Math.max(1, Math.round((endMs - startMs) / 1000)));  // cap 10h guard
  const perSec: number[] = [];
  let idx = 0;
  for (let sIdx = 0; sIdx <= secs; sIdx++) {
    const tMs = startMs + sIdx * 1000;
    while (idx < sorted.length - 1 && sorted[idx + 1].t <= tMs) idx++;
    perSec.push(Math.max(0, sorted[idx].v));
  }
  if (perSec.length < 30) return null;

  // 30-s rolling average, then NP = (mean(rolled^4))^(1/4).
  const WIN = 30;
  let sum = 0;
  const rolled: number[] = [];
  for (let i = 0; i < perSec.length; i++) {
    sum += perSec[i];
    if (i >= WIN) sum -= perSec[i - WIN];
    if (i >= WIN - 1) rolled.push(sum / WIN);
  }
  if (!rolled.length) return null;

  const meanQuad = rolled.reduce((a, v) => a + v * v * v * v, 0) / rolled.length;
  const np = Math.round(Math.pow(meanQuad, 0.25));
  const avgPower = Math.round(perSec.reduce((a, v) => a + v, 0) / perSec.length);
  const vi = avgPower > 0 ? Math.round((np / avgPower) * 100) / 100 : 0;
  const iff = ftpW > 0 ? Math.round((np / ftpW) * 100) / 100 : null;
  const tss = (ftpW > 0 && iff != null) ? Math.round((durationSec * np * iff) / (ftpW * 3600) * 100) : null;

  return { np, avgPower, vi, if: iff, tss, ftp: ftpW };
}
