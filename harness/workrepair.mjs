/**
 * Validates the stationary-time work-stat repair (src/services/workStatsRepair.ts).
 *
 * Builds synthetic per-second streams for a run that is 30 min of steady running with a 5-minute standing
 * phone call in the middle — the exact 17/24 Jul 2026 shape — and checks that:
 *   1. the RAW (duration-weighted) averages are diluted, reproducing the false economy dip, and
 *   2. the repaired averages recover the true running numbers.
 * Then checks a clean run is left alone.
 *
 * Run: node --import ./harness/register.mjs harness/workrepair.mjs
 */
import { repairFromDetail } from '../src/services/workStatsRepair.ts';

// ── synth helpers ────────────────────────────────────────────────────────────
// One sample per second. Running: 240 W, 150 bpm, 5:00/km (300 s/km). Standing: 0 W, HR decays, no pace.
function build({ runSec, stopSec, stopAt }) {
  const power = [], hr = [], pace = [];
  const total = runSec + stopSec;
  for (let i = 0; i < total; i++) {
    const stopped = i >= stopAt && i < stopAt + stopSec;
    const t = i * 1000;
    // Standing keeps reporting residual watts — this is what the 17 Jul 2026 reconstruction shows,
    // and it is why a power threshold cannot detect the stop while a distance threshold can.
    power.push({ t, v: stopped ? 100 : 240 });
    hr.push({ t, v: stopped ? 110 : 150 });
    pace.push({ t, v: stopped ? 0 : 300 });      // 0 = no pace while standing
  }
  return { power, hr, pace, pauseIntervals: [], activities: [{ startMs: 0, endMs: total * 1000, label: 'Work' }] };
}

// Duration-weighted average over the WHOLE work window — what the scan currently stores.
function raw(d) {
  const n = d.power.length;
  const p = d.power.reduce((a, x) => a + x.v, 0) / n;
  const h = d.hr.reduce((a, x) => a + x.v, 0) / n;
  const distM = d.pace.reduce((a, x) => a + (x.v > 0 ? 1000 / x.v : 0), 0);   // metres accrued per second
  return { power: Math.round(p), hr: Math.round(h), paceSec: Math.round(n / (distM / 1000)) };
}

const ok = (label, cond, detail) => console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
let fails = 0;
const expect = (label, cond, detail) => { if (!cond) fails++; ok(label, cond, detail); };

// ── case 1: 30 min run with a 5 min standing phone call ──────────────────────
const contaminated = build({ runSec: 1800, stopSec: 300, stopAt: 900 });
const r1 = raw(contaminated);
const rep1 = repairFromDetail(contaminated);
const ecRaw = (60000 / r1.paceSec) / r1.power;
const ecRep = (60000 / rep1.wPaceSec) / rep1.wPower;
const ecTrue = (60000 / 300) / 240;

console.log('\n── 30-min run + 5-min standing stop ──');
console.log(`   RAW      power ${r1.power}W  hr ${r1.hr}  pace ${r1.paceSec}s/km  → EC ${ecRaw.toFixed(3)}`);
console.log(`   REPAIRED power ${rep1.wPower}W  hr ${rep1.wHR}  pace ${rep1.wPaceSec}s/km  → EC ${ecRep.toFixed(3)}  (stationary ${rep1.stationaryPct}%)`);
console.log(`   TRUE     power 240W  hr 150  pace 300s/km  → EC ${ecTrue.toFixed(3)}`);
expect('raw power is diluted by the stop', r1.power < 230, `${r1.power}W vs true 240W`);
expect('raw EC is wrong (false economy dip)', Math.abs(ecRaw - ecTrue) > 0.02, `EC ${ecRaw.toFixed(3)} vs true ${ecTrue.toFixed(3)}`);
expect('repaired power recovers the truth', Math.abs(rep1.wPower - 240) <= 2, `${rep1.wPower}W`);
expect('repaired HR recovers the truth', Math.abs(rep1.wHR - 150) <= 2, `${rep1.wHR}`);
expect('repaired pace recovers the truth', Math.abs(rep1.wPaceSec - 300) <= 3, `${rep1.wPaceSec}s/km`);
expect('repaired EC matches the true EC', Math.abs(ecRep - ecTrue) < 0.005, `${ecRep.toFixed(3)} vs ${ecTrue.toFixed(3)}`);
expect('stationary share reported', Math.abs(rep1.stationaryPct - (300 / 2100) * 100) < 1, `${rep1.stationaryPct}%`);

// ── case 2: clean run — repair must not change anything materially ───────────
const clean = build({ runSec: 1800, stopSec: 0, stopAt: 99999 });
const r2 = raw(clean), rep2 = repairFromDetail(clean);
console.log('\n── clean 30-min run ──');
console.log(`   RAW      power ${r2.power}W pace ${r2.paceSec}s/km`);
console.log(`   REPAIRED power ${rep2.wPower}W pace ${rep2.wPaceSec}s/km  (stationary ${rep2.stationaryPct}%)`);
expect('clean run reports ~0% stationary', rep2.stationaryPct < 1, `${rep2.stationaryPct}%`);
expect('clean run power unchanged', Math.abs(rep2.wPower - r2.power) <= 1);
expect('clean run pace unchanged', Math.abs(rep2.wPaceSec - r2.paceSec) <= 1);

// ── case 3: unstructured run (no Work activity) must be skipped, not guessed ──
const noWin = { ...build({ runSec: 1800, stopSec: 0, stopAt: 9e9 }), activities: [] };
expect('unstructured run returns null (falls back to the cadence gate)', repairFromDetail(noWin) === null);

// ── case 4: too-short run is not repaired ────────────────────────────────────
expect('very short run returns null', repairFromDetail(build({ runSec: 120, stopSec: 0, stopAt: 9e9 })) === null);

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
