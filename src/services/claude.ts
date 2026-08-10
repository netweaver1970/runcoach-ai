import * as SecureStore from 'expo-secure-store';
import { HealthSnapshot, CoachingReport, PowerZones, WorkoutLabel, RunWorkout, KmSplit } from '../types';
import { callLLM, getActiveApiKey, setUsageFeature } from './llm';
import { agentComplete } from './agent';
import { buildTimelineContext } from './timelineEvents';
import { buildKnowledgePrompt } from './coachFiles';
import { buildAppModelPrompt } from './appModel';
import { tsbStatus, ctlRamp, trainingDayKey } from './trainingLoad';

// Legacy constant — kept so existing imports don't break; actual model comes from llm.ts config.
const API_KEY_KEY = 'anthropic_api_key';
export const MODEL      = 'claude-haiku-4-5-20251001';
export const CHAT_MODEL = 'claude-sonnet-4-6';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Returns the active API key for the currently-selected provider. */
export async function getApiKey(): Promise<string | null> {
  return getActiveApiKey();
}
export async function saveApiKey(key: string): Promise<void> {
  return SecureStore.setItemAsync(API_KEY_KEY, key.trim());
}
export async function deleteApiKey(): Promise<void> {
  return SecureStore.deleteItemAsync(API_KEY_KEY);
}

/**
 * Validate an API key against the Anthropic API, then save it on success.
 * Returns { valid: true } on success, { valid: false, error } on failure.
 * A warning message is included when the key works but credits are exhausted.
 */
export interface ApiKeyValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  debug?: {
    keyPrefix:      string;   // first 20 chars
    keySuffix:      string;   // last 8 chars
    keyLength:      number;
    nonAscii:       string;   // positions/codes of any non-ASCII chars, or 'none'
    requestUrl:     string;   // the endpoint we hit
    status:         number;
    errorType:      string;   // body.error.type if present
    errorMessage:   string;   // body.error.message if present
    responseHeaders: string;  // relevant response headers
    bodySnippet:    string;   // first 500 chars of response body
    model:          string;
  };
}

export async function validateAndSaveApiKey(
  key: string,
): Promise<ApiKeyValidationResult> {
  // Strip surrounding whitespace. Also collapse any internal whitespace —
  // API keys never contain spaces, so a space in the middle always means a
  // copy-paste artefact (e.g. a line-break when copying a long key).
  const trimmed = key.trim().replace(/\s+/g, '');

  // Scan every character for anything that isn't a printable ASCII char that
  // would appear in a base64url-style API key. Regular spaces (U+0020, code 32)
  // are included even though they passed the old >127||<32 check.
  const nonAsciiInfo = (() => {
    const hits: string[] = [];
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      // Valid key chars: printable ASCII 33-126 (no space, no control chars)
      if (code < 33 || code > 126) hits.push(`pos${i}=U+${code.toString(16).toUpperCase().padStart(4,'0')}`);
    }
    return hits.length > 0 ? hits.join(', ') : 'none';
  })();

  const REQUEST_URL = 'https://api.anthropic.com/v1/models';

  const baseDebug = {
    keyPrefix:       trimmed.slice(0, 20),
    keySuffix:       trimmed.slice(-8),
    keyLength:       trimmed.length,
    nonAscii:        nonAsciiInfo,
    model:           MODEL,
    requestUrl:      REQUEST_URL,
    status:          0,
    errorType:       '',
    errorMessage:    '',
    responseHeaders: '',
    bodySnippet:     '',
  };

  if (!trimmed.startsWith('sk-ant-')) {
    return {
      valid: false,
      error: 'Anthropic API keys start with "sk-ant-".',
      debug: { ...baseDebug, bodySnippet: '(not sent — format check failed)' },
    };
  }

  try {
    // Use GET /v1/models — a pure authentication check that needs no body or
    // model name, so a wrong model string can never be the cause of a 401.
    const response = await fetch(REQUEST_URL, {
      method: 'GET',
      headers: {
        'x-api-key': trimmed,
        'anthropic-version': '2023-06-01',
      },
    });

    const rawBody = await response.text();

    // Capture interesting response headers for diagnostics
    const HEADER_NAMES = ['x-request-id', 'cf-ray', 'cf-cache-status', 'content-type', 'anthropic-ratelimit-requests-remaining'];
    const respHeaders = HEADER_NAMES
      .map(h => { const v = response.headers.get(h); return v ? `${h}: ${v}` : null; })
      .filter(Boolean)
      .join('\n');

    let body: any = {};
    try { body = JSON.parse(rawBody); } catch {}

    const debugInfo = {
      ...baseDebug,
      status:          response.status,
      errorType:       body?.error?.type    ?? '',
      errorMessage:    body?.error?.message ?? '',
      responseHeaders: respHeaders || '(none captured)',
      bodySnippet:     rawBody.slice(0, 500),
    };

    // 401 = authentication failed (bad key)
    if (response.status === 401) {
      const detail = body?.error?.message ?? '';
      return {
        valid: false,
        error: [
          `API key rejected (401 — ${detail || 'invalid x-api-key'}).`,
          ``,
          `Likely causes:`,
          `• Key was revoked or never activated — check console.anthropic.com`,
          `• Wrong key pasted (mismatched copy) — generate a new one`,
          `• Spaces stripped: key is now ${trimmed.length} chars — if that changed, re-paste carefully`,
          ``,
          `Tap "Show debug info" for the full API response.`,
        ].join('\n'),
        debug: debugInfo,
      };
    }
    // 403 = key valid but no permissions
    if (response.status === 403) {
      return { valid: false, error: 'API key has no access (403). Check your Anthropic account.', debug: debugInfo };
    }

    // GET /v1/models returns 200 for any authenticated key regardless of credits.
    // Any non-401/403 response means the key is valid.
    let warning: string | undefined;
    if (!response.ok) {
      warning = `Key saved, but received HTTP ${response.status}. Check console.anthropic.com if issues persist.`;
    }

    await SecureStore.setItemAsync(API_KEY_KEY, trimmed);
    return { valid: true, warning, debug: debugInfo };
  } catch (e: any) {
    return {
      valid: false,
      error: `Network error: ${e?.message ?? String(e)}`,
      debug: { ...baseDebug, bodySnippet: String(e) },
    };
  }
}

const BODY_MASS_KEY  = 'body_mass_kg';
const SYNC_MONTHS_KEY = 'sync_months';
export const DEFAULT_BODY_MASS_KG = 70;

const VALID_MONTHS = [1, 3, 6, 12, 24] as const;
export type SyncMonths = (typeof VALID_MONTHS)[number];

export async function getSyncMonths(): Promise<SyncMonths> {
  const raw = await SecureStore.getItemAsync(SYNC_MONTHS_KEY);
  const n = raw ? parseInt(raw, 10) : 3;
  return (VALID_MONTHS as readonly number[]).includes(n) ? (n as SyncMonths) : 3;
}
export async function setSyncMonths(months: SyncMonths): Promise<void> {
  await SecureStore.setItemAsync(SYNC_MONTHS_KEY, String(months));
}

const LONG_RUN_MINUTES_KEY = 'long_run_minutes';
export const DEFAULT_LONG_RUN_MINUTES = 75;

export async function getLongRunMinutes(): Promise<number> {
  const raw = await SecureStore.getItemAsync(LONG_RUN_MINUTES_KEY);
  const n = raw ? parseInt(raw, 10) : DEFAULT_LONG_RUN_MINUTES;
  return isNaN(n) || n < 20 || n > 300 ? DEFAULT_LONG_RUN_MINUTES : n;
}
export async function setLongRunMinutes(minutes: number): Promise<void> {
  await SecureStore.setItemAsync(LONG_RUN_MINUTES_KEY, String(Math.round(minutes)));
}

// True max HR for %max-HR strain zones. We can only OBSERVE a peak from logged runs, which badly
// under-estimates it for easy-only runners (→ zones shift up → strain inflates). Let the user set
// their real max; 0 = auto (observed peak, floored).
const MAX_HR_KEY = 'user_max_hr';
export async function getUserMaxHr(): Promise<number> {
  const raw = await SecureStore.getItemAsync(MAX_HR_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 150 && n <= 220 ? n : 0; // 0 = auto
}
export async function setUserMaxHr(bpm: number): Promise<void> {
  await SecureStore.setItemAsync(MAX_HR_KEY, String(Math.round(bpm)));
}

// Observed max HR — a robust, glitch-filtered peak derived from HealthKit during scans (see
// computeRobustObservedMaxHr). Cached so getEffectiveMaxHr can auto-anchor without a live HK query.
const OBSERVED_MAX_HR_KEY = 'observed_max_hr';
export async function setObservedMaxHr(bpm: number): Promise<void> {
  try { if (bpm >= 150 && bpm <= 220) await SecureStore.setItemAsync(OBSERVED_MAX_HR_KEY, String(Math.round(bpm))); } catch { /* ignore */ }
}
export async function getObservedMaxHr(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(OBSERVED_MAX_HR_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 150 && n <= 220 ? n : 0;
  } catch { return 0; }
}

/**
 * The max HR the load engine (TRIMP / strain / CTL) should use. Priority:
 *   1. the user's explicit Settings value (always wins),
 *   2. the robust OBSERVED peak from their own data (auto-anchor — the sensible default),
 *   3. the age-predicted estimate (Tanaka) if age is known,
 *   4. a last-resort 190.
 * Callers used to improvise this per-site with a raw observed peak floored at 185/190 — which pulled
 * in sensor glitches and diverged between sites. A user-SET value now also flows to zones/body-battery
 * via snap.estimatedMaxHR (see healthkit snapshot), so the set max governs the whole app; when UNSET,
 * the load engine uses this resolver while zones fall back to the run-classifier's observed estimate.
 */
export async function getEffectiveMaxHr(): Promise<number> {
  const set = await getUserMaxHr();
  if (set > 0) return set;
  const obs = await getObservedMaxHr();
  if (obs > 0) return obs;
  const { age } = await getUserProfile();
  if (age && age > 0) return estimateMaxHr(age);
  return 190;
}

// ── Date-keyed max HR ────────────────────────────────────────────────────────────
// When the user changes their max HR we ask whether to RECOMPUTE ALL history at the new value
// (correcting a wrong number) or apply it FROM NOW (a genuine change over time — e.g. max drifts down
// with age). "From now" records a per-date segment so each historical day is scored against the max
// that was in force then; "recalculate" clears the segments so one value covers everything.
export interface MaxHrSegment { from: string; maxHR: number; } // 'from' = YYYY-MM-DD inclusive
const MAX_HR_HISTORY_KEY = 'max_hr_history_v1';
export async function getMaxHrHistory(): Promise<MaxHrSegment[]> {
  try {
    const raw = await SecureStore.getItemAsync(MAX_HR_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr.filter((s: any) => s && typeof s.from === 'string' && s.maxHR >= 150 && s.maxHR <= 220)
           .sort((a: MaxHrSegment, b: MaxHrSegment) => a.from.localeCompare(b.from))
      : [];
  } catch { return []; }
}
async function saveMaxHrHistory(segs: MaxHrSegment[]): Promise<void> {
  try { await SecureStore.setItemAsync(MAX_HR_HISTORY_KEY, JSON.stringify(segs)); } catch { /* ignore */ }
}

/** Change max HR and recompute the ENTIRE history at the new value (correcting a wrong max). */
export async function setMaxHrRecalcAll(bpm: number): Promise<void> {
  await setUserMaxHr(bpm);
  await saveMaxHrHistory([]); // no date-keying → every day resolves to the single current max
}
/** Change max HR from TODAY forward, leaving past days on the prior max (a genuine change over time). */
export async function setMaxHrFromNow(bpm: number): Promise<void> {
  const prior = await getEffectiveMaxHr();          // max in force up to now
  const today = trainingDayKey(Date.now());         // 4am-boundary day key — matches the load engine's day keys
  const hist  = await getMaxHrHistory();
  const segs  = hist.length ? hist : [{ from: '2000-01-01', maxHR: prior }]; // seed the whole past with the prior max
  const next  = segs.filter((s) => s.from !== today);
  next.push({ from: today, maxHR: Math.round(bpm) });
  next.sort((a, b) => a.from.localeCompare(b.from));
  await saveMaxHrHistory(next);
  await setUserMaxHr(bpm);                            // today's zones / effective max = new value
}
/** Per-day max-HR resolver from the segments; falls back to `fallback` (0 = caller's engine default). */
export function buildMaxHrResolver(history: MaxHrSegment[], fallback: number): (day: string) => number {
  if (history.length === 0) return () => fallback;
  return (day: string) => {
    let m = history[0].maxHR;              // days before the first segment take the earliest max
    for (const seg of history) { if (seg.from <= day) m = seg.maxHR; else break; }
    return m;
  };
}

// ── Onboarding / welcome flow ──────────────────────────────────────────────────
const ONBOARDING_KEY = 'onboarding_done_v1';
export async function getOnboardingDone(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(ONBOARDING_KEY)) === '1'; } catch { return false; }
}
export async function setOnboardingDone(done: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(ONBOARDING_KEY, done ? '1' : '0'); } catch { /* ignore */ }
}

// Athlete profile (age + sex) — feeds the max-HR estimate + tailors defaults / the athlete-profile file.
export interface UserProfile { age?: number; sex?: 'M' | 'F' | ''; }
const PROFILE_KEY = 'user_profile_v1';
export async function getUserProfile(): Promise<UserProfile> {
  try { const raw = await SecureStore.getItemAsync(PROFILE_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
export async function setUserProfile(p: UserProfile): Promise<void> {
  try { await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
// Tanaka (2001) age-predicted max HR — a better default than 220−age for most adults.
export function estimateMaxHr(age: number): number { return Math.round(208 - 0.7 * age); }

const AI_WEEKS_KEY = 'ai_weeks';
export const DEFAULT_AI_WEEKS = 8;
export async function getAiWeeks(): Promise<number> {
  const raw = await SecureStore.getItemAsync(AI_WEEKS_KEY);
  const n = raw ? parseInt(raw, 10) : DEFAULT_AI_WEEKS;
  return (!isNaN(n) && n >= 6 && n <= 52) ? n : DEFAULT_AI_WEEKS;
}
export async function setAiWeeks(weeks: number): Promise<void> {
  await SecureStore.setItemAsync(AI_WEEKS_KEY, String(Math.round(Math.max(6, Math.min(52, weeks)))));
}

export async function getBodyMassKg(): Promise<number> {
  const raw = await SecureStore.getItemAsync(BODY_MASS_KEY);
  const parsed = raw ? parseFloat(raw) : NaN;
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_BODY_MASS_KG : parsed;
}
export async function saveBodyMassKg(kg: number): Promise<void> {
  return SecureStore.setItemAsync(BODY_MASS_KEY, String(Math.round(kg)));
}

// ─── Power zones ──────────────────────────────────────────────────────────────

const POWER_ZONES_KEY = 'power_zones';

export const DEFAULT_POWER_ZONES: PowerZones = {
  recoveryMax:  0,
  z2Max:        0,
  tempoMin:     0,
  tempoMax:     0,
  intervalsMin: 0,
};

export function isPowerZonesConfigured(pz: PowerZones): boolean {
  return pz.z2Max > 0 || pz.tempoMin > 0 || pz.tempoMax > 0 || pz.intervalsMin > 0;
}

export async function getPowerZones(): Promise<PowerZones> {
  const raw = await SecureStore.getItemAsync(POWER_ZONES_KEY);
  if (!raw) return DEFAULT_POWER_ZONES;
  try { return { ...DEFAULT_POWER_ZONES, ...JSON.parse(raw) }; }
  catch { return DEFAULT_POWER_ZONES; }
}

export async function savePowerZones(zones: PowerZones): Promise<void> {
  await SecureStore.setItemAsync(POWER_ZONES_KEY, JSON.stringify(zones));
}

// ─── Run type overrides ───────────────────────────────────────────────────────

const RUN_OVERRIDES_KEY = 'run_overrides';

export async function getRunOverrides(): Promise<Record<string, WorkoutLabel>> {
  const raw = await SecureStore.getItemAsync(RUN_OVERRIDES_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

/** Set label = null to remove an override. Returns the updated overrides map. */
export async function saveRunOverride(
  uuid: string,
  label: WorkoutLabel | null,
): Promise<Record<string, WorkoutLabel>> {
  const current = await getRunOverrides();
  if (label === null) {
    delete current[uuid];
  } else {
    current[uuid] = label;
  }
  await SecureStore.setItemAsync(RUN_OVERRIDES_KEY, JSON.stringify(current));
  return current;
}

const HR_UNRELIABLE_KEY = 'hr_unreliable_runs';
export async function getHrUnreliableRuns(): Promise<Record<string, boolean>> {
  const raw = await SecureStore.getItemAsync(HR_UNRELIABLE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
export async function saveHrUnreliable(uuid: string, unreliable: boolean): Promise<void> {
  const cur = await getHrUnreliableRuns();
  if (!unreliable) delete cur[uuid];
  else cur[uuid] = true;
  await SecureStore.setItemAsync(HR_UNRELIABLE_KEY, JSON.stringify(cur));
}

// ─── Compact formatting helpers ───────────────────────────────────────────────
// All helpers keep output as short as possible to preserve tokens.

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fd(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}${MONTHS[d.getMonth()]}${d.getFullYear()}`;
}

function ft(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fp(secs: number): string {
  if (!secs || secs <= 0) return '—';
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}

function fdur(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${m.toString().padStart(2,'0')}` : `${m}m`;
}

const LSHORT: Record<string, string> = {
  Intervals: 'Ivl', Tempo: 'Tmp', Z2: 'Z2', LongRun: 'Lng', Recovery: 'Rec', Unknown: '?',
};

// ─── Shared data block (used by both prompts) ─────────────────────────────────

function buildDataBlock(snap: HealthSnapshot, maxRuns = 10): string {
  const { runs, vo2max, restingHR, weeklyMileage, todayRecovery,
          recentNightlyHRV, recentSleep, workoutTypeStats } = snap;

  // ── Training load (CTL/ATL/TSB) + recent cross-training ─────────────────────
  const load = snap.trainingLoad ?? [];
  const lastLoad = load.length > 0 ? load[load.length - 1] : null;
  const loadLine = lastLoad
    ? `Fitness(CTL) ${lastLoad.ctl} · Fatigue(ATL) ${lastLoad.atl} · Form(TSB) ${lastLoad.tsb >= 0 ? '+' : ''}${lastLoad.tsb}`
    : '—';
  const acts = snap.activities ?? [];
  const sevenAgo = new Date(Date.now() - 7 * 86_400_000);
  const crossActs = acts.filter(a => a.activityType !== 37 && new Date(a.date) >= sevenAgo);
  const crossLine = crossActs.length > 0
    ? crossActs.slice(0, 8).map(a => `${fd(a.date)} ${a.name} ${a.durationMin}m`).join(', ')
    : 'none';

  // ── Runs ──────────────────────────────────────────────────────────────────
  const runLines = runs.slice(0, maxRuns).map(r => {
    const lbl   = LSHORT[r.label ?? 'Unknown'] ?? '?';
    const dist  = (r.distance / 1000).toFixed(1);
    const pace  = fp(r.workPace ?? r.pace);
    const hr    = r.workHR ? `wHR${r.workHR}` : (r.avgHeartRate ? `HR${r.avgHeartRate}` : '');
    const power = (r.workPower ?? 0) > 0 ? ` ${r.workPower}W` : '';
    const hrFlag = r.hrUnreliable === true ? ' ⚠HR' : '';
    // Show work-only duration when it differs meaningfully from total
    const durStr = (r.workDuration && r.workDuration > 0 && Math.abs(r.workDuration - r.duration) > 30)
      ? `${fdur(r.workDuration)}w/${fdur(r.duration)}`
      : fdur(r.duration);
    let extra   = '';
    if (r.segments && r.segments.length > 0) {
      // Structured workout (Custom Workout): show per-phase breakdown
      const segStrs = r.segments.map(s => {
        const sdist  = s.distanceM >= 1000 ? `${(s.distanceM/1000).toFixed(2)}km` : `${s.distanceM}m`;
        const stime  = `${Math.floor(s.durationSec/60)}:${(s.durationSec%60).toString().padStart(2,'0')}`;
        const spkm   = s.distanceM > 0 ? s.durationSec / (s.distanceM / 1000) : 0;
        const space  = spkm > 0 ? fp(spkm) : '';
        const shr    = s.avgHR     > 0 ? `HR${s.avgHR}`        : '';
        const spwr   = s.avgPower  > 0 ? `${s.avgPower}W`      : '';
        const scad   = s.cadenceSPM > 0 ? `${s.cadenceSPM}spm` : '';
        return `  ${s.label}: ${sdist} ${stime}${space ? ` @${space}` : ''}${shr ? ` ${shr}` : ''}${spwr ? ` ${spwr}` : ''}${scad ? ` ${scad}` : ''}`;
      });
      extra = '\n' + segStrs.join('\n');
    } else if (r.intervals && r.intervals.length > 0) {
      const hrs    = r.intervals.map(i => i.avgHR).join('/');
      const paces  = r.intervals.map(i => fp(i.avgPaceSecs)).filter(p => p !== '—').join('/');
      const powers = r.intervals.some(i => (i.avgPowerW ?? 0) > 0)
        ? ` pwr:${r.intervals.map(i => i.avgPowerW > 0 ? `${i.avgPowerW}W` : '—').join('/')}`
        : '';
      extra = ` reps:${r.intervals.length} HR${hrs}${paces ? ` @${paces}` : ''}${powers}`;
    }
    const temp = r.tempC != null ? ` ${r.tempC}°C` : '';
    const note = r.note ? ` note:"${r.note.replace(/\s+/g, ' ').trim().slice(0, 140)}"` : '';
    return `[${lbl}] ${fd(r.date)} ${dist}km ${durStr} ${pace} ${hr}${power}${temp}${hrFlag}${note}${extra}`;
  }).join('\n') || 'none';

  // ── Type stats ────────────────────────────────────────────────────────────
  const typeLines = workoutTypeStats.map(t => {
    const hrTrend = t.hrTrend.length >= 3
      ? (t.hrTrend[t.hrTrend.length - 1] - t.hrTrend[0] < -2 ? 'HR↓' :
         t.hrTrend[t.hrTrend.length - 1] - t.hrTrend[0] > 2  ? 'HR↑' : 'HRstable')
      : '';
    const paceTrend = t.paceTrend.length >= 3
      ? (t.paceTrend[t.paceTrend.length - 1] - t.paceTrend[0] < -5 ? 'pace↑' :
         t.paceTrend[t.paceTrend.length - 1] - t.paceTrend[0] > 5  ? 'pace↓' : '')
      : '';
    const trend = [hrTrend, paceTrend].filter(Boolean).join(' ');
    return `${LSHORT[t.label] ?? t.label}(${t.count}) wHR${t.avgHR} ${fp(t.avgPace)}${trend ? ` ${trend}` : ''}`;
  }).join('  ') || 'none';

  // ── Weekly mileage ────────────────────────────────────────────────────────
  const kmLine = weeklyMileage.map(w => w.km).join(' | ') || '—';

  // ── VO2Max trend ──────────────────────────────────────────────────────────
  const vo2Line = vo2max.length === 0 ? '—'
    : vo2max.slice(-4).map(v => v.value).join('→');

  // ── Resting HR ────────────────────────────────────────────────────────────
  const rhrLine = restingHR.slice(-7).map(v => v.value).join(' ') || '—';

  // ── Recovery ─────────────────────────────────────────────────────────────
  const rec = todayRecovery;
  let recBlock: string;
  if (!rec) {
    recBlock = 'No data (sleep not synced)';
  } else if (rec.weightedRMSSD === 0) {
    recBlock = `Sleep detected, HRV pending${rec.sleep ? `. Sleep ${(rec.sleep.totalMinutes/60).toFixed(1)}h` : ''}`;
  } else {
    const hrLine = rec.overnightHR > 0
      ? ` | oHR ${rec.overnightHR}bpm base ${rec.overnightHRBaseline}bpm`
      : '';
    const sleepLine = rec.sleep
      ? `\nSleep ${(rec.sleep.totalMinutes/60).toFixed(1)}h deep${rec.sleep.deepMinutes}m REM${rec.sleep.remMinutes}m wake${rec.sleep.awakeMinutes}m ${ft(rec.sleep.bedtime)}→${ft(rec.sleep.wakeTime)}`
      : '';
    recBlock = `${rec.recoveryScore}/100 ${rec.label} [65%HRV+35%RHR]\nRMSSD ${rec.weightedRMSSD}ms base ${rec.baseline7Day}ms${hrLine} trend:${rec.trend}${sleepLine}`;
  }

  // ── HRV + sleep history ───────────────────────────────────────────────────
  const hrvLines = recentNightlyHRV.slice(-10).map(n => {
    const sl = recentSleep.find(s => s.date === n.date);
    const slStr = sl ? `|${(sl.totalMinutes/60).toFixed(1)}h` : '';
    return `${n.date.slice(5)}:${n.weightedRMSSD > 0 ? `${n.weightedRMSSD}ms` : '?'}${slStr}`;
  }).join('  ') || '—';

  // ── Timeline: current status + life events (economical, ±120d window) + supplements ──
  const timelineBlock = buildTimelineContext(snap.timelineEvents ?? [], snap.athleteStatus ?? null) + (snap.supplementContext ?? '');

  return `RUNS (4w, [type] date dist dur pace wHR temp note):
${runLines}

TYPE STATS (wHR=work-only HR):
${typeLines}

WEEKLY KM (oldest→latest): ${kmLine}
VO2MAX (ml/kg/min, trend): ${vo2Line}
RHR (7d bpm): ${rhrLine}

RECOVERY: ${recBlock}

TRAINING LOAD (all activity): ${loadLine}
CROSS-TRAINING (7d, non-run): ${crossLine}

HRV+SLEEP (10 nights, MM-DD:rmssd|sleep):
${hrvLines}${timelineBlock}`;
}

// ─── Coaching report prompt ───────────────────────────────────────────────────

// TODAY'S STATUS — a coach with the data should know whether today's prescribed session is already run.
// Ground truth for "did they run" is a workout dated today in snap.runs; the prescription comes from the
// cached daily plan (passed in). Without this the report blindly re-prescribes a session already completed.
function buildTodayStatus(snap: HealthSnapshot, todayPlan?: TodayPlanContext): string {
  const now = new Date();
  const key = (d: any) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };
  const todayKey = key(now);
  const todayName = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const todayRun = (snap.runs ?? []).find(r => key(r.date) === todayKey);
  const prescribed = !todayPlan ? 'unknown (no cached plan)'
    : todayPlan.intensity === 'rest' ? 'REST (no run prescribed today)'
    : `${todayPlan.sessionKind ?? todayPlan.intensity}${todayPlan.runMinutes ? ` ~${todayPlan.runMinutes}min` : ''}`;
  const completed = todayRun
    ? `✅ DONE — already logged ${LSHORT[todayRun.label ?? 'Unknown'] ?? 'run'} ${(todayRun.distance / 1000).toFixed(1)}km ${fdur(todayRun.duration)}${todayRun.workHR ? ` wHR${todayRun.workHR}` : ''}${(todayRun.workPower ?? 0) > 0 ? ` ${todayRun.workPower}W` : ''}`
    : (todayPlan?.intensity === 'rest' ? 'rest day — nothing to run' : '❌ NOT YET — no run logged today');
  const nextNote = todayPlan?.nextRunLabel ? ` · next run day: ${todayPlan.nextRunLabel}` : '';
  return `TODAY (${todayName}): prescribed ${prescribed} · status: ${completed}${nextNote}`;
}

function buildPrompt(snap: HealthSnapshot, todayPlan?: TodayPlanContext): string {
  return `You are an expert running coach. Write the report DIRECTLY — no deliberation, no preamble, no chain-of-thought.
wHR=work-only HR (excl. warm-up/recovery). HRV=RMSSD (sleep-stage-weighted).

${buildTodayStatus(snap, todayPlan)}

${buildDataBlock(snap)}

Write a structured report using EXACTLY these headers:

**Fitness Snapshot** — 2–3 sentences on current level (VO2Max + runs).
**What's Working** — 1–2 specific positives with numbers.
**Key Insight** — one important trend (pace, wHR efficiency, load, recovery).
**Today's Recovery** — interpret score + RMSSD in context. Flag: hard/easy/rest.
**This Week's Focus** — one actionable recommendation adjusted for recovery.
**Suggested Workout** — type, distance/duration, target pace or HR zone.
**Sleep Quality** — comment on duration and deep/REM balance.
**Watch Out For** — warning signs: overtraining, poor recovery, injury risk.

Rules: cite real numbers, 2–4 sentences per section, skip sections with no data. Per TODAY above: if today's run is already done, make Suggested Workout the NEXT session (not what's done); if today is rest/deferred, say so.`;
}

// ─── Chat system prompt ───────────────────────────────────────────────────────

// Program-design principles the coach reasons from (the app-mechanics / ToF-budget model now lives in the
// editable "Training Model" coaching file, injected via `knowledge` below — single editable source).
const PROGRAM_DESIGN = `## Program-design principles to reason from
- Polarised ~80/20: most volume easy (Z1–Z2), a minority hard; keep easy easy and hard hard. Recovery is where adaptation happens — don't stack quality days back-to-back.
- Periodise: progressive overload (~≤10%/wk volume) in build weeks, then a deload; keep ACWR in the safe zone (~0.8–1.3). Specificity + consistency beat heroics.
- Session purpose: long run → aerobic durability/fat-oxidation; tempo/threshold → lactate clearance; intervals (Z4–5) → VO2/economy; easy → volume + recovery. Taper into races. Sleep/HRV/RHR trends flag under-recovery before performance drops.
Ground every claim in the athlete's actual budget/plan/history/KPIs via the tools — cite the numbers, never invent them.`;

function buildChatSystemPrompt(
  snap:          HealthSnapshot,
  memoryNote?:   string,
  localContext?: string,   // e.g. "Location: Brussels · Thu 17 Apr 2026 13:04"
  aiWeeks = 10,
  runContext?:   string,   // invisible run-analysis data injected from the detail screen
  knowledge?:    string,   // the athlete's editable coaching files (schedule, zones, rules, Training Model, …)
): string {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });

  const timeHeader = localContext ? localContext : `Today: ${today}`;

  const maxRuns = Math.round(aiWeeks * 1.5);

  let prompt = `You are a personal running coach in a runner's iPhone app. ${timeHeader}.
Concise answers, phone-friendly. Cite numbers.
BREVITY IS A HARD REQUIREMENT, not a style note. Answer in at most ~250 words unless the runner explicitly \
asks for depth. Lead with the answer, then at most 3 supporting numbers. No preamble ("Got everything...", \
"Let me look at..."), no restating the question, no summary of what you just said, no section headers or \
tables unless the data genuinely needs a grid — a run-vs-recent comparison DOES. A run analysis compares \
this session against recent same-type runs using NORMALIZED efficiency ratios (never raw pace/watts, which \
aren't comparable) — LEAD with EC (HR-independent), then EF & SE — flags what improved or declined, then \
the verdict vs the plan and one next step. Weeks start on Monday. wHR=work-only HR (excl. warm-up/recovery/between-reps). Efficiency ratios (higher=better; compare THESE across runs): EC=speed÷power (running economy — HR-INDEPENDENT, trust it most), EF=power÷HR, SE=speed÷HR (both HR-based; on days yohimbine was taken HR is auto-corrected dose-dependently and marked "(yoh-HRcorr)"). HRV=RMSSD (sleep-stage-weighted: deep×3 REM×2 light×1).

${PROGRAM_DESIGN}
${knowledge && knowledge.trim() ? `\n## The athlete's coaching files (their own editable setup — schedule, zones, rules, Training Model). Follow these; the Training Model file explains how the ToF budget & load model work.\n${knowledge.trim()}\n` : ''}
${buildDataBlock(snap, maxRuns)}`;

  if (memoryNote && memoryNote.trim()) {
    prompt += `\n\n## Coaching memory (from previous conversations)\n${memoryNote.trim()}`;
  }

  if (runContext && runContext.trim()) {
    prompt += `\n\n## Run analysis context (use this data to answer). Give a STATISTICAL / EFFICIENCY comparison of this run against the recent same-type runs below, ALWAYS via the normalized efficiency ratios (never raw pace/watts, which aren't comparable across efforts). A compact markdown table (columns: EC=speed÷power · EF=power÷HR · SE=speed÷HR) comparing this run to those is welcome. EC is HR-INDEPENDENT — trust it most for the trend; EF/SE are HR-based and already yohimbine-corrected on flagged days. Then call out what improved or declined, the verdict vs the day's plan, and one concrete next step. Keep it focused (~300 words); don't re-list every raw row.\n${runContext.trim()}`;
  }

  return prompt;
}

// ─── Memory note updater ──────────────────────────────────────────────────────
// After each exchange, ask Claude to update a short running memory note so
// goals, patterns, and agreements persist across chat sessions.

const MEMORY_UPDATE_PROMPT = `Based on the conversation so far, write a short coaching memory note (max 150 words) that captures:
- The runner's stated goals and race targets
- Key patterns or insights identified about their training
- Any agreements, commitments, or advice given
- Anything they specifically asked you to remember

Write in second person ("The runner..."). Be concise — this note is injected into future sessions. If nothing significant was discussed, return an empty string.`;

// ─── New-run analysis block ───────────────────────────────────────────────────
// Builds a compact user message that auto-triggers run analysis when a new
// run is detected since the last chat session. Token-efficient: only includes
// fields that differ from the global data block.

// Yohimbine (+coffee) raises HR, which deflates the HR-based efficiency ratios; the caller passes a
// per-day bpm offset (dose-dependent, from the supplement log) that we subtract before EF/SE. The
// HR-INDEPENDENT ratio (EC = speed÷power) needs no correction — it's the robust comparator.
const dayKeyOf = (dt: any): string => { const d = new Date(dt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Normalized efficiency ratios so power & pace compare ACROSS runs (raw watts/pace don't). speed = m/min.
//   EC = speed ÷ power (running economy — HR-INDEPENDENT, listed first), EF = power ÷ HR, SE = speed ÷ HR.
// `hrCorr` bpm is subtracted from HR (yohimbine days) for the two HR-based ratios. Higher = better.
function effRatios(paceSec: number, power: number, hr: number, hrCorr = 0): string {
  const spd = paceSec > 0 ? 60000 / paceSec : 0;
  const h   = hr > 0 ? Math.max(1, hr - hrCorr) : 0;
  const out: string[] = [];
  if (spd > 0 && power > 0) out.push(`EC${(spd / power).toFixed(2)}`);   // HR-independent — primary comparator
  if (power > 0 && h > 0)   out.push(`EF${(power / h).toFixed(2)}`);
  if (spd > 0 && h > 0)     out.push(`SE${(spd / h).toFixed(2)}`);
  if (hrCorr > 0 && out.length > 1) out.push('(yoh-HRcorr)');
  return out.join(' ');
}

export function buildNewRunUserMessage(
  newRun:    RunWorkout,
  prevRuns:  RunWorkout[],
  kmSplits?: KmSplit[],
  isExplicit?: boolean,
  runDetail?: {
    cal:  number;
    hrUnreliable?: boolean;
    segs: { l: string; d: number; t: number; hr: number; cad: number; pwr: number }[];
    kms:  { km: number; t: number; p: number; hr: number; cad: number; pwr: number }[];
  },
  hrOffsetByDay?: Record<string, number>,   // dateISO → bpm to subtract (yohimbine dose + coffee) before EF/SE
): string {
  const lbl  = newRun.label ?? 'Unknown';
  const dist = (newRun.distance / 1000).toFixed(2);
  const pace = fp(newRun.workPace ?? newRun.pace);
  const hr   = newRun.workHR
    ? `wHR ${newRun.workHR}bpm`
    : newRun.avgHeartRate ? `HR ${Math.round(newRun.avgHeartRate)}bpm` : '';
  const pwr  = (newRun.workPower ?? 0) > 0 ? ` ${newRun.workPower}W` : '';
  // Normalized efficiency ratios (EC/EF/SE) so power & pace compare across runs; HR-based ones yohimbine-corrected.
  const newEff = effRatios(newRun.workPace ?? newRun.pace ?? 0, newRun.workPower ?? 0, newRun.workHR ?? 0, hrOffsetByDay?.[dayKeyOf(newRun.date)] ?? 0);
  const ef   = newEff ? ` · ${newEff}` : '';
  const cal  = (runDetail?.cal ?? 0) > 0 ? ` · ${runDetail!.cal}kcal` : (newRun.calories > 0 ? ` · ${Math.round(newRun.calories)}kcal` : '');

  const hrFlag = runDetail?.hrUnreliable ? ' ⚠️HR-unreliable' : (newRun.hrUnreliable ? ' ⚠️HR-unreliable' : '');
  const temp = newRun.tempC != null ? ` · ${newRun.tempC}°C` : '';
  const note = newRun.note ? `\nNote: ${newRun.note.replace(/\s+/g, ' ').trim()}` : '';
  let newBlock = `${lbl} · ${fd(newRun.date)} · ${dist}km · ${fdur(newRun.duration)} · @${pace} · ${hr}${pwr}${ef}${cal}${temp}${hrFlag}${note}`;

  const effectiveSegs = runDetail?.segs.length ? runDetail.segs : null;
  if (effectiveSegs) {
    const segStrs = effectiveSegs.map(s => {
      const sdist = s.d >= 1000 ? `${(s.d / 1000).toFixed(2)}km` : `${s.d}m`;
      const stime = `${Math.floor(s.t / 60)}:${(s.t % 60).toString().padStart(2, '0')}`;
      const spkm  = s.d > 0 ? s.t / (s.d / 1000) : 0;
      const sp    = spkm > 0 ? `@${fp(spkm)}` : '';
      const sh    = s.hr  > 0 ? `HR${s.hr}`   : '';
      const sw    = s.pwr > 0 ? `${s.pwr}W`   : '';
      const sc    = s.cad > 0 ? `${s.cad}spm` : '';
      return `  ${s.l}: ${sdist} ${stime} ${[sp,sh,sw,sc].filter(Boolean).join(' ')}`.trimEnd();
    });
    newBlock += '\n' + segStrs.join('\n');
  } else if (newRun.segments && newRun.segments.length > 0) {
    const segStrs = newRun.segments.map(s => {
      const sdist = s.distanceM >= 1000 ? `${(s.distanceM / 1000).toFixed(2)}km` : `${s.distanceM}m`;
      const stime = `${Math.floor(s.durationSec / 60)}:${(s.durationSec % 60).toString().padStart(2, '0')}`;
      const spkm  = s.distanceM > 0 ? s.durationSec / (s.distanceM / 1000) : 0;
      const sp    = spkm > 0 ? `@${fp(spkm)}` : '';
      const sh    = s.avgHR     > 0 ? `HR${s.avgHR}`        : '';
      const sw    = s.avgPower  > 0 ? `${s.avgPower}W`      : '';
      const sc    = s.cadenceSPM > 0 ? `${s.cadenceSPM}spm` : '';
      return `  ${s.label}: ${sdist} ${stime} ${[sp,sh,sw,sc].filter(Boolean).join(' ')}`.trimEnd();
    });
    newBlock += '\n' + segStrs.join('\n');
  } else if (newRun.intervals && newRun.intervals.length > 0) {
    const hrs   = newRun.intervals.map(i => i.avgHR).join('/');
    const paces = newRun.intervals.map(i => fp(i.avgPaceSecs)).filter(p => p !== '—').join('/');
    const pwrs  = newRun.intervals.some(i => (i.avgPowerW ?? 0) > 0)
      ? ` pwr:${newRun.intervals.map(i => i.avgPowerW > 0 ? `${i.avgPowerW}W` : '—').join('/')}`
      : '';
    newBlock += `\n  reps:${newRun.intervals.length} HR${hrs}${paces ? ` @${paces}` : ''}${pwrs}`;
  }

  const effectiveKms = runDetail?.kms.length ? runDetail.kms : null;
  if (effectiveKms) {
    const allHRZero    = effectiveKms.every(k => k.hr  === 0);
    const allPowerZero = effectiveKms.every(k => k.pwr === 0);
    const allCadZero   = effectiveKms.every(k => k.cad === 0);
    const kmLines = effectiveKms.map(k => {
      const hrPart  = (!allHRZero    && k.hr  > 0) ? ` HR${k.hr}`   : '';
      const cadPart = (!allCadZero   && k.cad > 0) ? ` ${k.cad}spm` : '';
      const pwrPart = (!allPowerZero && k.pwr > 0) ? ` ${k.pwr}W`   : '';
      return `  km${k.km}: @${fp(k.p)}${hrPart}${cadPart}${pwrPart}`;
    }).join('\n');
    newBlock += `\nKm splits:\n${kmLines}`;
  } else if (kmSplits && kmSplits.length > 0) {
    const allHRZero    = kmSplits.every(k => k.avgHR    === 0);
    const allPowerZero = kmSplits.every(k => k.avgPower === 0);
    const allCadZero   = kmSplits.every(k => k.avgCadence === 0);
    const kmLines = kmSplits.map(k => {
      const hrPart  = (!allHRZero    && k.avgHR      > 0) ? ` HR${k.avgHR}`      : '';
      const cadPart = (!allCadZero   && k.avgCadence > 0) ? ` ${k.avgCadence}spm` : '';
      const pwrPart = (!allPowerZero && k.avgPower   > 0) ? ` ${k.avgPower}W`    : '';
      return `  km${k.km}: @${fp(k.paceSecs)}${hrPart}${cadPart}${pwrPart}`;
    }).join('\n');
    newBlock += `\nKm splits:\n${kmLines}`;
  }

  const prevLines = prevRuns.slice(0, 10).map(r => {
    const d  = (r.distance / 1000).toFixed(2);
    const p  = fp(r.workPace ?? r.pace);
    const rh = r.workHR ? `wHR${r.workHR}` : (r.avgHeartRate ? `HR${Math.round(r.avgHeartRate)}` : '');
    const rp = (r.workPower ?? 0) > 0 ? ` ${r.workPower}W` : '';
    const rEff = effRatios(r.workPace ?? r.pace ?? 0, r.workPower ?? 0, r.workHR ?? 0, hrOffsetByDay?.[dayKeyOf(r.date)] ?? 0);
    const re = rEff ? ` ${rEff}` : '';
    const rc = r.calories > 0 ? ` ${Math.round(r.calories)}kcal` : '';
    const rt = r.tempC != null ? ` ${r.tempC}°C` : '';
    const rn = r.note ? ` note:"${r.note.replace(/\s+/g, ' ').trim().slice(0, 120)}"` : '';
    return `  ${fd(r.date)}: ${d}km ${fdur(r.duration)} @${p} ${rh}${rp}${re}${rc}${rt}${rn}`.trimEnd();
  }).join('\n') || '  (none yet)';

  const prevCount = prevRuns.slice(0, 10).filter(r => r.distance > 0).length;
  const prevLabel = prevCount > 0 ? `the ${prevCount} previous ${lbl} runs listed below` : 'my training history';
  // Ask for a STATISTICAL/EFFICIENCY comparison (pace · wHR · power · EF) vs the recent same-type runs — a
  // compact table is welcome — then the verdict + next step. Keep it focused (~300 words) so a verbose/
  // reasoning model doesn't sprawl; the system prompt + runContext header set the same bound. (Earlier this
  // was over-tightened to "5-8 lines, no tables" — too brief; the athlete wants the comparison back.)
  const intro = isExplicit
    ? `Analyze this ${lbl} run and compare it against ${prevLabel} using the efficiency ratios — EC (speed÷power, HR-independent) first, then EF (power÷HR) and SE (speed÷HR): what improved, what declined. A compact comparison table is welcome, then the verdict vs its plan and one next step. Keep it focused (~300 words).`
    : `I just finished a ${lbl} run. Compare it against ${prevLabel} using the efficiency ratios — EC (speed÷power, HR-independent) first, then EF and SE — flag what improved or declined, then the verdict vs plan and one next step. A compact table is welcome; keep it focused (~300 words).`;
  return `${intro}\n\nThis run:\n${newBlock}\n\nPrevious ${lbl} runs (most recent first):\n${prevLines}`;
}

// ─── Memory note updater ──────────────────────────────────────────────────────
// After each exchange, ask Claude to update a short running memory note so
// goals, patterns, and agreements persist across chat sessions.

export async function updateMemoryNote(
  history:        ChatMessage[],
  currentMemory:  string,
  snap:           HealthSnapshot,
  localContext?:  string,
  aiWeeks?:       number,
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) return currentMemory;
  // Only update if there are at least 2 exchanges (4 messages)
  if (history.length < 4) return currentMemory;

  try {
    const contextMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: MEMORY_UPDATE_PROMPT },
    ];
    const updated = await callLLM({
      system:    buildChatSystemPrompt(snap, currentMemory, localContext, aiWeeks),
      messages:  contextMessages,
      maxTokens: 1500,   // headroom for reasoning-model thinking before the ~150-word note (ceiling only)
    });
    return updated.trim().length > 10 ? updated.trim() : currentMemory;
  } catch {
    return currentMemory;
  }
}

// ─── Report API call ──────────────────────────────────────────────────────────

// Lightweight view of today's cached plan for the report's TODAY status (avoids importing CoachPlan/coach.ts).
export interface TodayPlanContext {
  intensity:    string;   // 'rest' | 'easy' | 'moderate' | 'hard'
  runMinutes?:  number;
  sessionKind?: string;   // canonical label (e.g. 'tempo', 'long', 'intervals', 'recovery')
  nextRunLabel?: string;  // when the cap defers the next run
}

export async function generateCoachingReport(snap: HealthSnapshot, todayPlan?: TodayPlanContext): Promise<CoachingReport> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key found. Add one in Settings first.');

  const content = await callLLM({
    // 1200 was too tight for a multi-section report once a reasoning model (e.g. DeepSeek deepseek-v4-pro)
    // is in play — its hidden thinking spent the whole budget, leaving no answer ("hit output-token limit").
    // max_tokens is a CEILING: flash/Claude stop when done, so a bigger number costs them nothing.
    messages:  [{ role: 'user', content: buildPrompt(snap, todayPlan) }],
    maxTokens: 8000,   // 4000 still got starved by a heavy reasoning model's thinking; 8000 is ~the provider cap (DeepSeek 8192). Ceiling only.
  });

  return {
    content,
    generatedAt: new Date().toISOString(),
    model: MODEL, // kept for type compat; actual model is in llm config
  };
}

// ─── Chat API call ────────────────────────────────────────────────────────────

export async function getChatResponse(
  snap:          HealthSnapshot,
  history:       ChatMessage[],
  memoryNote?:   string,
  localContext?: string,
  aiWeeks?:      number,
  runContext?:   string,
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key. Add one in Settings first.');

  // Agentic mode (when enabled + Anthropic) lets the model pull specific runs/metrics via tools; otherwise
  // this is the existing single-shot call. The snapshot is still passed as baseline context either way.
  // The athlete's editable coaching files (incl. the Training Model) are injected so the coach reasons from
  // the SAME knowledge the daily plan uses — one editable source of truth.
  // The APP MODEL (how ToF/cap/load/settings actually work) rides in front of the editable coaching files,
  // so the coach reasons from the real in-app logic instead of guessing about the app's own accounting.
  const [appModel, knowledge] = await Promise.all([
    buildAppModelPrompt().catch(() => ''),
    buildKnowledgePrompt().catch(() => ''),
  ]);
  setUsageFeature(runContext ? 'run-analysis' : 'chat');
  return agentComplete({
    system:    buildChatSystemPrompt(snap, memoryNote, localContext, aiWeeks, runContext, [appModel, knowledge].filter(Boolean).join('\n\n')),
    messages:  history,
    maxTokens: 8000,   // 1024 → 2500 → 4000 → 8000 (~provider cap). A CEILING, not a target: flash/Claude stop when done; the room is so a reasoning model's hidden thinking can't starve the answer ("hit output-token limit"). If it STILL truncates, the model is a heavy reasoner — use a non-reasoning one (deepseek-v4-flash).
    snap,
  });
}

// ── Training Recommendation ───────────────────────────────────────────────────

export interface TrainingRecommendation {
  type: 'Rest' | 'Easy' | 'Z2' | 'Tempo' | 'LongRun' | 'Intervals';
  duration: string;
  zone: string;
  structure?: string;     // concise run structure, e.g. "3× 10min @ 180–205W" or "60min @ 205W"
  reason: string;
  nextRunLabel?: string;  // when the volume cap blocks a run today: when the next one fits, e.g. "Thu 26 Jun"
  optional2nd?: boolean;   // this run is an OPTIONAL post-completion top-up (offered, not auto-pushed)
}

