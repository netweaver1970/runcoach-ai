/**
 * Race-time predictor from the power-duration curve + running economy + Riegel.
 *
 * Anchor: Critical Power (CP) from the power-duration curve → 60-minute race power ≈ 0.95·CP
 * (the standard FTP≈95%CP relationship). Convert that power to pace via the athlete's median running
 * economy (speed ÷ power from their own runs) → distance coverable in 60 min. Then Riegel
 * (T₂ = T₁·(D₂/D₁)^1.06) scales that anchor to 5K / 10K / Half / Marathon — Riegel's exponent is the
 * empirical endurance-decay term, so it handles the long-distance fade the raw CP model can't.
 */

export interface RacePrediction { name: string; km: number; timeSec: number; paceSec: number }

/** Median running economy (speed m/s per watt) from the athlete's runs. 0 if none usable. */
export function medianEcFromRuns(runs: { workPace?: number; workPower?: number; pace?: number; isEstimatedPower?: boolean }[]): number {
  const ecs: number[] = [];
  for (const r of runs) {
    if (r.isEstimatedPower) continue;                 // needs real measured power
    const pace = r.workPace ?? r.pace ?? 0;           // s/km
    const pw = r.workPower ?? 0;                       // watts
    if (pace > 150 && pace < 900 && pw >= 120) ecs.push((1000 / pace) / pw);
  }
  if (!ecs.length) return 0;
  ecs.sort((a, b) => a - b);
  return ecs[Math.floor(ecs.length / 2)];
}

const RACES = [
  { name: '5K',       km: 5 },
  { name: '10K',      km: 10 },
  { name: 'Half',     km: 21.0975 },
  { name: 'Marathon', km: 42.195 },
];
const RIEGEL = 1.06;

export function predictRaces(cp: number | null, medianEC: number): { races: RacePrediction[]; thresholdPaceSec: number; d60: number } | null {
  if (!cp || cp <= 0 || medianEC <= 0) return null;
  const ftp60   = cp * 0.95;                 // 60-min sustainable power
  const speed60 = medianEC * ftp60;          // m/s
  if (speed60 <= 0) return null;
  const pace60  = 1000 / speed60;            // s/km at 60-min power
  const d60     = 3600 / pace60;             // km covered in 60 min
  if (!(d60 > 3 && d60 < 25)) return null;   // implausible economy/CP → bail rather than mislead
  const races = RACES.map(r => {
    const timeSec = 3600 * Math.pow(r.km / d60, RIEGEL);
    return { name: r.name, km: r.km, timeSec, paceSec: timeSec / r.km };
  });
  return { races, thresholdPaceSec: Math.round(pace60), d60 };
}

/** H:MM:SS (drops the hour when 0). */
export function fmtRaceTime(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** M:SS per km. */
export function fmtRacePace(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
