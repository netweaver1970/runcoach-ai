import * as SecureStore from 'expo-secure-store';
import { HealthSnapshot, CoachingReport } from '../types';

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

export async function getBodyMassKg(): Promise<number> {
  const raw = await SecureStore.getItemAsync(BODY_MASS_KEY);
  const parsed = raw ? parseFloat(raw) : NaN;
  return isNaN(parsed) || parsed <= 0 ? DEFAULT_BODY_MASS_KG : parsed;
}
export async function saveBodyMassKg(kg: number): Promise<void> {
  return SecureStore.setItemAsync(BODY_MASS_KEY, String(Math.round(kg)));
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

function buildDataBlock(snap: HealthSnapshot): string {
  const { runs, vo2max, restingHR, weeklyMileage, todayRecovery,
          recentNightlyHRV, recentSleep, workoutTypeStats } = snap;

  // ── Runs ──────────────────────────────────────────────────────────────────
  const runLines = runs.slice(0, 10).map(r => {
    const lbl   = LSHORT[r.label ?? 'Unknown'] ?? '?';
    const dist  = (r.distance / 1000).toFixed(1);
    const pace  = fp(r.workPace ?? r.pace);
    const hr    = r.workHR ? `wHR${r.workHR}` : (r.avgHeartRate ? `HR${r.avgHeartRate}` : '');
    const power = (r.workPower ?? 0) > 0 ? ` ${r.workPower}W` : '';
    let extra   = '';
    if (r.intervals && r.intervals.length > 0) {
      const hrs    = r.intervals.map(i => i.avgHR).join('/');
      const paces  = r.intervals.map(i => fp(i.avgPaceSecs)).filter(p => p !== '—').join('/');
      const powers = r.intervals.some(i => (i.avgPowerW ?? 0) > 0)
        ? ` pwr:${r.intervals.map(i => i.avgPowerW > 0 ? `${i.avgPowerW}W` : '—').join('/')}`
        : '';
      extra = ` reps:${r.intervals.length} HR${hrs}${paces ? ` @${paces}` : ''}${powers}`;
    }
    return `[${lbl}] ${fd(r.date)} ${dist}km ${fdur(r.duration)} ${pace} ${hr}${power}${extra}`;
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

  return `RUNS (4w, [type] date dist dur pace wHR):
${runLines}

TYPE STATS (wHR=work-only HR):
${typeLines}

WEEKLY KM (oldest→latest): ${kmLine}
VO2MAX (ml/kg/min, trend): ${vo2Line}
RHR (7d bpm): ${rhrLine}

RECOVERY: ${recBlock}

HRV+SLEEP (10 nights, MM-DD:rmssd|sleep):
${hrvLines}`;
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

function buildChatSystemPrompt(snap: HealthSnapshot): string {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });

  return `You are a personal running coach in a runner's iPhone app. Today: ${today}.
Concise answers, phone-friendly. Cite numbers. wHR=work-only HR (excl. warm-up/recovery/between-reps). HRV=RMSSD (sleep-stage-weighted: deep×3 REM×2 light×1).

${buildDataBlock(snap)}`;
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
  snap: HealthSnapshot,
  history: ChatMessage[],
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
      max_tokens: 800,
      system: buildChatSystemPrompt(snap),
      messages: history,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (response.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    throw new Error(`API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.content[0].text as string;
}
