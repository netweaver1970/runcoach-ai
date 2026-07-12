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
