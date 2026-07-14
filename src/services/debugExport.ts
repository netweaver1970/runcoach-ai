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
import { assembleCoachSnapshot } from './coach';
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
    return assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs);
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
