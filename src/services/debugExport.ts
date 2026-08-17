/**
 * Deliberately-activated DEBUG EXPORT — one consolidated, redacted snapshot of live app state
 * for off-device debugging / model calibration (body-battery, coach, training-load).
 *
 * SECURITY: secrets are stripped AT SERIALIZATION TIME, two ways:
 *   1. Settings come from exportAllSettings(false) — which already omits the BYOK LLM key, and
 *      the cloud auth accessToken/refreshToken aren't in its allowlist at all, so neither leaks.
 *   2. A defensive deep-redact walks the WHOLE assembled bundle and replaces the value of any
 *      key that looks like a credential (apikey / token / secret / password / bearer / …) with
 *      '[redacted]'. Belt-and-suspenders: even a future field that carried a secret can't escape.
 *
 * The file that leaves the device (runcoach-debug/latest.json) therefore carries health/metric/
 * config state ONLY — never a key or token.
 */
import { exportAllSettings } from './backup';
import { computeBodyBattery } from './bodyBattery';
import { buildTrainingLoadCalibration, loadSnapshotCache } from './healthkit';
import { assembleCoachSnapshot, computeCapHistory, parseWeeklyTemplate, parseWeeklyCommitments } from './coach';
import { readKnowledgeContent } from './coachFiles';
import { getPowerZones, getEffectiveMaxHr } from './claude';
import { getAccountingMode } from './accounting';
import { getBiologyReport, compositionChange } from './biology';
import { loadLabs, loadTemplates } from './labsStore';
import { getCurrentUser } from './auth';

// A key is a credential if — with separators/casing removed — it contains one of these tokens.
// Matches anthropic_api_key, llm_apikey_*, accessToken, refresh_token, clientSecret, authorization…
const SECRET_TOKENS = ['apikey', 'token', 'secret', 'password', 'passwd', 'authorization', 'bearer', 'credential'];
function isSecretKey(k: string): boolean {
  const s = k.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_TOKENS.some(t => s.includes(t));
}
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSecrets) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '[redacted]' : redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

// Multi-user attribution: which account produced this dump, so a collected/shared bundle is
// identifiable when analysed. Each user exports from their OWN signed-in account to their OWN
// Drive, so isolation is inherent — this just labels the file. Anonymous when not signed in.
export interface DebugIdentity {
  id?: string;
  email?: string;
  name?: string | null;
  role?: string;
  anonymous?: boolean;
}

export interface DebugExport {
  app: 'RunCoachAI';
  kind: 'debug-export';
  version: 1;
  exportedAt: string;
  identity: DebugIdentity;
  sections: Record<string, unknown>;
}

/**
 * Assemble the redacted debug bundle. Each section is gathered defensively — a section that
 * throws is recorded as { error } rather than failing the whole export, so a partial capture
 * (e.g. no HealthKit permission) still produces a usable file.
 */
export async function buildDebugExport(): Promise<DebugExport> {
  const sections: Record<string, unknown> = {};
  const add = async (name: string, fn: () => Promise<unknown>) => {
    try { sections[name] = await fn(); }
    catch (e: any) { sections[name] = { error: String(e?.message ?? e) }; }
  };

  await add('settings', async () => JSON.parse(await exportAllSettings(false))); // false = BYOK key excluded
  await add('bodyBattery', async () => {
    const bb = await computeBodyBattery();
    if (!bb) return null;
    return {
      current: bb.current, currentStress: bb.currentStress, trendPerHour: bb.trendPerHour,
      hrvBaseline: bb.hrvBaseline, restHR: bb.restHR,
      debug: bb.debug, correlation: bb.correlation,
    };
  });
  await add('trainingLoad', async () => JSON.parse(await buildTrainingLoadCalibration(4)));
  await add('coachSnapshot', async () => {
    const snap = await loadSnapshotCache();
    if (!snap) return null;
    return assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs);
  });

  const user = await getCurrentUser().catch(() => null);
  const identity: DebugIdentity = user
    ? { id: user.id, email: user.email, name: user.name ?? null, role: user.role }
    : { anonymous: true };

  const bundle: DebugExport = {
    app: 'RunCoachAI', kind: 'debug-export', version: 1,
    exportedAt: new Date().toISOString(), identity, sections,
  };
  return redactSecrets(bundle);
}

export async function buildDebugExportJson(): Promise<string> {
  return JSON.stringify(await buildDebugExport(), null, 2);
}

async function currentIdentity(): Promise<DebugIdentity> {
  const user = await getCurrentUser().catch(() => null);
  return user ? { id: user.id, email: user.email, name: user.name ?? null, role: user.role } : { anonymous: true };
}

/**
 * COMPACT, TOPIC-SCOPED exports — one small file per concern (a few KB each) instead of one ~500 KB
 * monolith. An off-device reader (Claude via the Drive link) fetches ONLY the section it needs and decodes
 * it in one step — no giant base64 blob, no sub-agent to dig a section out. Chat history + full run lists
 * are dropped; body-battery ships its ready-to-plot clock-time series (not the bulky raw debug traces).
 */
export async function buildDebugSections(): Promise<{ name: string; json: string }[]> {
  const identity = await currentIdentity();
  const stamp = (body: Record<string, unknown>) =>
    JSON.stringify(redactSecrets({ app: 'RunCoachAI', kind: 'debug-section', exportedAt: new Date().toISOString(), identity, ...body }), null, 1);
  const out: { name: string; json: string }[] = [];
  const add = async (name: string, fn: () => Promise<unknown>) => {
    try { out.push({ name, json: stamp({ section: name, data: await fn() }) }); }
    catch (e: any) { out.push({ name, json: stamp({ section: name, error: String(e?.message ?? e) }) }); }
  };

  // FULL body-battery trace — the whole L0→L2 calibration chain in ONE small file (nothing trimmed): the
  // summary + `series` (t-stamped battery/stress) + `debug` (per-bin hr + hrv (L0) + s/s0 (L1) + battery
  // (L2), plus the HRV trust/reject trace and model constants/baselines) + `correlation` (t-stamped per-bin
  // series + night stages). It's small on its own — only the monolith's runs/chat bulk is what's gone.
  await add('bodybattery', async () => (await computeBodyBattery()) ?? null);
  // RECOVERY AUDIT (read-only, 2026-07-14). computeRecoveryScore z-scores today against 60-day ROLLING MEANS
  // of weightedRMSSD and Apple resting HR. For an IMPROVING athlete (Geert: fitness returning post-PFPS,
  // HRV climbing +0.09 ms/night) a trailing mean sits ~half the window BEHIND, so BOTH terms inflate:
  // zHRV = (today − laggingMean)/6.3 and zRHR = (laggingMean − today)/3.3 — a falling RHR inflates the second
  // one the same way. Suspicion: recovery reads ~100 on nights that are only ~+0.3 SD above his own trend
  // (i.e. utterly ordinary), which would mean it's scoring "fitter than your old self", not "recovered today".
  // This section exports the raw inputs so the lag can be MEASURED (and a trend-corrected score compared)
  // before anything that feeds the coach's green-light gate is touched.
  await add('recovery', async () => {
    const snap = await loadSnapshotCache();
    if (!snap) return null;
    return {
      todayRecovery:     snap.todayRecovery,       // score + the transparent breakdown (z-terms)
      recentNightlyHRV:  snap.recentNightlyHRV,    // per-night weightedRMSSD + overnightHR (the HRV baseline input)
      nightlyLean:       snap.nightlyLean,         // lean nightly series (d/h/s)
      hrv:               snap.hrv,                 // daily HRV series
      restingHR:         snap.restingHR,           // daily Apple resting-HR series (the RHR baseline input)
      recentSleep:       snap.recentSleep,
    };
  });
  await add('trainingload', async () => JSON.parse(await buildTrainingLoadCalibration(4)));
  await add('coach', async () => {
    const snap = await loadSnapshotCache();
    if (!snap) return null;
    const coach = await assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs);
    // The weekly template the planner ACTUALLY reads, raw + parsed. Without this a wrong plan can't be
    // diagnosed off-device: the schedule lives in a knowledge file, so every reconstruction is a guess.
    let schedule: any = null;
    try {
      const raw = await readKnowledgeContent('running-schedule').catch(() => '');
      const tmpl = parseWeeklyTemplate(raw), cm = parseWeeklyCommitments(raw);
      const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      schedule = {
        raw,
        rawLength: raw.length,
        parsed: Object.fromEntries(WD.map((w, i) => [w, tmpl[i]])),
        commitments: Object.fromEntries(Object.entries(cm).map(([d, v]: any) => [WD[+d], v])),
      };
    } catch (e: any) { schedule = { error: e?.message ?? String(e) }; }
    return { ...coach, schedule };
  });
  // PER-RUN STRUCTURE — so a run can be correctly interpreted OFF-device: the labelled phases
  // (Warmup/Work/Recovery/Cooldown/Walk/Drills) with per-segment KPIs, plus the settings that DRIVE
  // interpretation (power zones + max/rest HR for zone adherence; accounting mode for what counts as
  // time-on-feet). `countsTof` mirrors the ToF exclusion (by LABEL) and `tofMin` is what ToF should total
  // for the run — compare to the app's recentTimeOnFeet to catch accounting bugs (e.g. a cool-down leak).
  // CAP — Volume vs Budget per CALENDAR week (Mon-based): actual time-on-feet vs the +cap% rolling ceiling.
  // The current (in-progress) week is isCurrent:true; actualMin is the week-to-date, ceilingMin the budget.
  await add('cap', async () => (await computeCapHistory(8)).map(w => ({
    weekStart: w.weekStart, label: w.label, actualMin: w.actualMin, ceilingMin: w.ceilingMin,
    hitPct: w.hitPct, phase: w.phase, heatTaxPct: w.heatTaxPct, isCurrent: w.isCurrent,
  })));
  await add('runs', async () => {
    const snap = await loadSnapshotCache();
    if (!snap) return null;
    const [pz, maxHR, acct] = await Promise.all([
      getPowerZones().catch(() => null),
      getEffectiveMaxHr().catch(() => 190),
      getAccountingMode().catch(() => 'work' as const),
    ]);
    const rv = (snap.restingHR ?? []).map(v => v.value).filter(v => v > 0).sort((a, b) => a - b);
    const restHR = rv.length ? rv[Math.floor(rv.length / 2)] : 55;
    const reserve = Math.max(1, maxHR - restHR);
    const EXCLUDE = /warm|cool|recover|rest|walk|prep/i;   // === healthkit TOF_EXCLUDE_PHASE (segment counts unless its LABEL matches)
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const hrr = (hr: number) => hr > 0 ? Math.round(((hr - restHR) / reserve) * 100) / 100 : null;
    const paceOf = (durSec: number, distM: number) => distM > 0 ? Math.round(durSec / (distM / 1000)) : null; // sec/km
    const r3 = (n: number) => Math.round(n * 1000) / 1000;   // EC ~0.70 → 3 decimals so 0.70 vs 0.71 is visible
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const eff = (paceSec: number, power: number, hr: number) => {
      const spd = paceSec > 0 ? 60000 / paceSec : 0;
      return {
        ec: spd > 0 && power > 0 ? r3(spd / power) : null,   // speed÷power (HR-independent — the economy trend; needs resolution)
        ef: power > 0 && hr > 0  ? r2(power / hr)  : null,   // power÷HR
        se: spd > 0 && hr > 0    ? r3(spd / hr)    : null,   // speed÷HR
      };
    };
    const runs = (snap.runs ?? []).slice(0, 40).map(r => {
      const segs = (r.segments ?? []).map(s => ({
        phase:     s.label,
        min:       r1(s.durationSec / 60),
        distM:     Math.round(s.distanceM),
        paceSec:   paceOf(s.durationSec, s.distanceM),
        avgHR:     s.avgHR || null,
        hrr:       hrr(s.avgHR),
        avgPower:  s.avgPower || null,
        cadence:   s.cadenceSPM || null,
        countsTof: acct === 'full' ? true : !EXCLUDE.test(s.label || ''),
      }));
      const tofMin = acct === 'full'
        ? Math.round(r.duration / 60)
        : r1(segs.filter(s => s.countsTof).reduce((a, s) => a + s.min, 0));
      const wHR = r.workHR ?? r.avgHeartRate ?? 0;
      return {
        date: r.date, uuid: r.uuid, type: r.label ?? null,
        distanceKm: r1(r.distance / 1000), durationMin: Math.round(r.duration / 60),
        workMin: r.workDuration ? Math.round(r.workDuration / 60) : null,
        tofMin,   // ← time-on-feet this run SHOULD contribute (labels + accounting mode); cross-check vs recentTimeOnFeet
        wHR: wHR || null, wHRr: hrr(wHR), wPower: r.workPower || null,
        wPaceSec: r.workPace ?? r.pace ?? null, ...eff(r.workPace ?? r.pace ?? 0, r.workPower ?? 0, wHR),
        estimatedPower: r.isEstimatedPower ?? false, hrUnreliable: r.hrUnreliable ?? false,
        tempC: r.tempC ?? null, note: r.note ?? null,
        segments: segs,
        intervals: r.intervals?.length ? r.intervals.map(i => ({ hr: i.avgHR, paceSec: i.avgPaceSecs, powerW: i.avgPowerW })) : undefined,
      };
    });
    return {
      context: { powerZones: pz, maxHR, restHR, accountingMode: acct,
        note: 'EC=speed÷power (HR-indep) · EF=power÷HR · SE=speed÷HR; hrr=HR-reserve; ToF excludes warm/cool/recover/rest/walk/prep by LABEL' },
      runs,
    };
  });
  // BIOLOGY — body-composition + BP series (validity-cleaned) + the fat-vs-lean split over standard windows,
  // so the Biology mode is verifiable off-device (weight/fat%/lean readings aren't in any other section).
  await add('biology', async () => {
    // Same shared provider the graphs use → the backup reflects a just-Refreshed report (and reuses it
    // instead of pulling ~40y of HealthKit again); otherwise it recomputes live within the memo TTL.
    const rep = await getBiologyReport().catch(() => null);
    if (!rep) return null;
    const now = Date.now();
    const weight = rep.metrics.find(m => m.key === 'weight')?.points ?? [];
    const fat    = rep.metrics.find(m => m.key === 'bodyfat')?.points ?? [];
    const wins: Record<string, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, all: 100000 };
    const composition: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(wins)) {
      const cc = compositionChange(weight, fat, now - d * 86_400_000, now);
      composition[k] = cc ? {
        from: new Date(cc.fromT).toISOString().slice(0, 10), to: new Date(cc.toT).toISOString().slice(0, 10),
        dWeight: cc.dW, dFatMass: cc.dFat, dLeanMass: cc.dLean,
        startWeight: cc.startW, endWeight: cc.endW, startFatPct: cc.startFatPct, endFatPct: cc.endFatPct,
        leanShareOfChangePct: (Math.abs(cc.dFat) + Math.abs(cc.dLean)) > 0 ? Math.round(Math.abs(cc.dLean) / (Math.abs(cc.dFat) + Math.abs(cc.dLean)) * 100) : null,
      } : null;
    }
    return {
      metrics: rep.metrics.map(m => ({ key: m.key, unit: m.unit, n: m.n, latest: m.latest, latestDate: m.latestDate, trendPerWeek: m.trendPerWeek, points: m.points })),
      composition,
    };
  });
  // LABS — imported blood-test history + saved panels, so it's recoverable/inspectable off-device.
  await add('labs', async () => {
    const [store, templates] = await Promise.all([loadLabs(), loadTemplates()]);
    return {
      updatedAt: store.updatedAt,
      analyteCount: store.analytes.length,
      templates,   // named marker panels (keys)
      analytes: store.analytes.map(a => ({
        key: a.key, label: a.label, category: a.category, unit: a.unit, kind: a.kind,
        refLow: a.refLow, refHigh: a.refHigh, hkType: a.hkType, note: a.note,
        series: a.series, textSeries: a.textSeries,
      })),
    };
  });
  await add('settings', async () => {
    const s = JSON.parse(await exportAllSettings(false));
    // Drop ONLY the chat history (bulky + not calibration data); KEEP the real config files (schedule,
    // zones, knowledge, plan logs…).
    if (s && typeof s === 'object' && s.files && typeof s.files === 'object') {
      for (const k of Object.keys(s.files)) if (/chat/i.test(k)) delete s.files[k];
    }
    return s;
  });
  return out;
}
