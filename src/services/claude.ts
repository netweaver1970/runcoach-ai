import * as SecureStore from 'expo-secure-store';
import { HealthSnapshot, CoachingReport, PowerZones, WorkoutLabel, RunWorkout, KmSplit } from '../types';

const API_KEY_KEY = 'anthropic_api_key';
export const MODEL      = 'claude-haiku-4-5-20251001';
export const CHAT_MODEL = 'claude-sonnet-4-6';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(API_KEY_KEY);
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

const VALID_MONTHS = [1, 3, 6, 12] as const;
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
  return `${d.getDate()}${MONTHS[d.getMonth()]}`;
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

  // ── Runs ──────────────────────────────────────────────────────────────────
  const runLines = runs.slice(0, maxRuns).map(r => {
    const lbl   = LSHORT[r.label ?? 'Unknown'] ?? '?';
    const dist  = (r.distance / 1000).toFixed(1);
    const pace  = fp(r.workPace ?? r.pace);
    const hr    = r.workHR ? `wHR${r.workHR}` : (r.avgHeartRate ? `HR${r.avgHeartRate}` : '');
    const power = (r.workPower ?? 0) > 0 ? ` ${r.workPower}W` : '';
    const hrFlag = r.hrUnreliable === true ? ' ⚠HR' : '';
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
    return `[${lbl}] ${fd(r.date)} ${dist}km ${fdur(r.duration)} ${pace} ${hr}${power}${hrFlag}${extra}`;
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

  // ── Timeline events ───────────────────────────────────────────────────────
  let timelineBlock = '';
  if (snap.timelineEvents && snap.timelineEvents.length > 0) {
    const evLines = snap.timelineEvents
      .slice(0, 20)
      .map(ev => {
        const shortDate = fd(ev.date + 'T00:00:00');
        if (ev.type === 'status') {
          return `  ${shortDate}: ${ev.status}${ev.note ? ` (${ev.note})` : ''}`;
        } else {
          return `  ${shortDate}: ${ev.supplement ?? ''} ${ev.action ?? ''}${ev.note ? ` (${ev.note})` : ''}`.trimEnd();
        }
      })
      .join('\n');
    timelineBlock = `\n\nTIMELINE (events):\n${evLines}`;
  }

  return `RUNS (4w, [type] date dist dur pace wHR):
${runLines}

TYPE STATS (wHR=work-only HR):
${typeLines}

WEEKLY KM (oldest→latest): ${kmLine}
VO2MAX (ml/kg/min, trend): ${vo2Line}
RHR (7d bpm): ${rhrLine}

RECOVERY: ${recBlock}

HRV+SLEEP (10 nights, MM-DD:rmssd|sleep):
${hrvLines}${timelineBlock}`;
}

// ─── Coaching report prompt ───────────────────────────────────────────────────

function buildPrompt(snap: HealthSnapshot): string {
  return `You are an expert running coach. Analyse this runner's data and write a structured coaching report.
wHR=work-only HR (excl. warm-up/recovery). HRV=RMSSD (sleep-stage-weighted).

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

Rules: cite real numbers, 2–4 sentences per section, skip sections with no data.`;
}

// ─── Chat system prompt ───────────────────────────────────────────────────────

function buildChatSystemPrompt(
  snap:          HealthSnapshot,
  memoryNote?:   string,
  localContext?: string,   // e.g. "Brussels · Thu 17 Apr 17:30"
  aiWeeks = 10,
): string {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });

  const timeHeader = localContext ? localContext : `Today: ${today}`;

  const maxRuns = Math.round(aiWeeks * 1.5);

  let prompt = `You are a personal running coach in a runner's iPhone app. ${timeHeader}.
Concise answers, phone-friendly. Cite numbers. wHR=work-only HR (excl. warm-up/recovery/between-reps). HRV=RMSSD (sleep-stage-weighted: deep×3 REM×2 light×1).

${buildDataBlock(snap, maxRuns)}`;

  if (memoryNote && memoryNote.trim()) {
    prompt += `\n\n## Coaching memory (from previous conversations)\n${memoryNote.trim()}`;
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

export function buildNewRunUserMessage(
  newRun:    RunWorkout,
  prevRuns:  RunWorkout[], // up to 5 previous of the same type
  kmSplits?: KmSplit[],
): string {
  const lbl  = newRun.label ?? 'Unknown';
  const dist = (newRun.distance / 1000).toFixed(2);
  const pace = fp(newRun.workPace ?? newRun.pace);
  const hr   = newRun.workHR
    ? `wHR ${newRun.workHR}bpm`
    : newRun.avgHeartRate ? `HR ${Math.round(newRun.avgHeartRate)}bpm` : '';
  const pwr  = (newRun.workPower ?? 0) > 0 ? ` ${newRun.workPower}W` : '';

  let newBlock = `${lbl} · ${fd(newRun.date)} · ${dist}km · ${fdur(newRun.duration)} · @${pace} · ${hr}${pwr}`;

  if (newRun.segments && newRun.segments.length > 0) {
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

  if (kmSplits && kmSplits.length > 0) {
    const allHRZero    = kmSplits.every(k => k.avgHR === 0);
    const allPowerZero = kmSplits.every(k => k.avgPower === 0);
    const kmLines = kmSplits.map(k => {
      const hrPart    = (!allHRZero    && k.avgHR    > 0) ? ` HR${k.avgHR}`    : '';
      const powerPart = (!allPowerZero && k.avgPower > 0) ? ` ${k.avgPower}W`  : '';
      return `  km${k.km}: @${fp(k.paceSecs)}${hrPart}${powerPart}`;
    }).join('\n');
    newBlock += `\nKm splits:\n${kmLines}`;
  }

  const prevLines = prevRuns.slice(0, 5).map(r => {
    const d  = (r.distance / 1000).toFixed(2);
    const p  = fp(r.workPace ?? r.pace);
    const rh = r.workHR ? `wHR${r.workHR}` : (r.avgHeartRate ? `HR${Math.round(r.avgHeartRate)}` : '');
    const rp = (r.workPower ?? 0) > 0 ? ` ${r.workPower}W` : '';
    return `  ${fd(r.date)}: ${d}km ${fdur(r.duration)} @${p} ${rh}${rp}`.trimEnd();
  }).join('\n') || '  (none yet)';

  return `I just finished a new ${lbl} run. Analyze it and compare with my previous ${lbl} runs:\n\nNew run:\n${newBlock}\n\nPrevious ${lbl} runs:\n${prevLines}`;
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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 300,
        system: buildChatSystemPrompt(snap, currentMemory, localContext, aiWeeks),
        messages: contextMessages,
      }),
    });
    if (!response.ok) return currentMemory;
    const data = await response.json();
    const updated = (data.content[0].text as string).trim();
    // If Claude says nothing significant, keep the old memory
    return updated.length > 10 ? updated : currentMemory;
  } catch {
    return currentMemory;
  }
}

// ─── Report API call ──────────────────────────────────────────────────────────

export async function generateCoachingReport(snap: HealthSnapshot): Promise<CoachingReport> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key found. Add your Anthropic API key in Settings first.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: buildPrompt(snap) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (response.status === 429) throw new Error('Rate limit hit. Try again in a moment.');
    throw new Error(`API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return {
    content: data.content[0].text as string,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}

// ─── Chat API call ────────────────────────────────────────────────────────────

export async function getChatResponse(
  snap:          HealthSnapshot,
  history:       ChatMessage[],
  memoryNote?:   string,
  localContext?: string,
  aiWeeks?:      number,
): Promise<string> {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key. Add it in Settings first.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: buildChatSystemPrompt(snap, memoryNote, localContext, aiWeeks),
      messages: history,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (response.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    let body: any = {};
    try { body = await response.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (msg.includes('credit') || msg.includes('quota') || msg.includes('balance')) {
      throw new Error('Anthropic credits exhausted. Top up at console.anthropic.com to continue chatting.');
    }
    throw new Error(`API error ${response.status}: ${msg || JSON.stringify(body)}`);
  }

  const data = await response.json();
  return data.content[0].text as string;
}
