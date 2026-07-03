import * as SecureStore from 'expo-secure-store';
import { HealthSnapshot, RunWorkout } from '../types';
import { fetchWorkoutDetail } from './healthkit';
import { callLLM, callLLMTools, agenticSupported } from './llm';

// ─── Agentic coach: give the LLM read-only TOOLS to pull data on demand ────────
// Instead of one fat snapshot → one answer, the model can call these tools to drill into specific runs
// and metric series, then reason over what it pulled. All tools are READ-ONLY and run against the
// in-memory snapshot + HealthKit detail; nothing mutates state or leaves the device beyond the LLM call.

const SK_AGENTIC = 'agentic_mode_v1';
export async function getAgenticMode(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(SK_AGENTIC)) === '1'; } catch { return false; }
}
export async function setAgenticMode(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(SK_AGENTIC, on ? '1' : '0'); } catch { /* ignore */ }
}

interface AgentCtx { snap: HealthSnapshot }
interface AgentTool {
  name: string;
  description: string;
  input_schema: any;
  run: (input: any, ctx: AgentCtx) => Promise<any>;
}

const round = (n: number | undefined, d = 1) => { const f = 10 ** d; return Math.round(((n ?? 0)) * f) / f; };
const paceStr = (secPerKm?: number) =>
  secPerKm && secPerKm > 0 ? `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}` : null;
const day = (s?: string) => (s ?? '').slice(0, 10);

function runSummary(r: RunWorkout) {
  return {
    uuid: r.uuid,
    date: day(r.date),
    type: r.label ?? 'Run',
    distance_km: round((r.distance ?? 0) / 1000, 2),
    duration_min: Math.round((r.duration ?? 0) / 60),
    avg_pace_per_km: paceStr(r.pace),
    avg_hr: r.avgHeartRate ?? null,
    work_hr: r.workHR ?? null,
    work_pace_per_km: paceStr(r.workPace),
    work_power_w: r.workPower ?? null,
    work_min: r.workDuration ? Math.round(r.workDuration / 60) : null,
  };
}

const TOOLS: AgentTool[] = [
  {
    name: 'query_runs',
    description:
      "List the athlete's recent runs, most recent first, as summary rows (date, type, distance, duration, pace, HR, and work-segment pace/power). Optionally filter by session type and time window. Use get_run_detail afterwards for the intra-run trace of a specific run.",
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Filter by session type, matched loosely, e.g. "Z2", "Tempo", "Intervals", "Long", "Recovery", "Easy". Omit for all types.' },
        since_days: { type: 'number', description: 'Only include runs within this many days. Omit for no time limit.' },
        limit: { type: 'number', description: 'Max rows to return (default 10, max 30).' },
      },
    },
    run: async ({ label, since_days, limit }, ctx) => {
      let runs = [...(ctx.snap.runs ?? [])].sort((a, b) => (b.date > a.date ? 1 : -1));
      if (label) { const q = String(label).toLowerCase(); runs = runs.filter(r => (r.label ?? '').toLowerCase().includes(q)); }
      if (since_days) { const cut = Date.now() - Number(since_days) * 864e5; runs = runs.filter(r => new Date(r.date).getTime() >= cut); }
      runs = runs.slice(0, Math.max(1, Math.min(Number(limit) || 10, 30)));
      return { count: runs.length, runs: runs.map(runSummary) };
    },
  },
  {
    name: 'get_run_detail',
    description:
      'Detailed breakdown of ONE run: per-km splits (pace, HR, power), structured segments (warmup / work / recovery / cooldown with duration, HR and distance), and HR/power summary stats. Identify the run by uuid (from query_runs) or by date (YYYY-MM-DD). Defaults to the most recent run if neither is given.',
    input_schema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Run uuid from query_runs.' },
        date: { type: 'string', description: 'Run date, YYYY-MM-DD.' },
      },
    },
    run: async ({ uuid, date }, ctx) => {
      const runs = ctx.snap.runs ?? [];
      const run = uuid ? runs.find(r => r.uuid === uuid)
        : date ? runs.find(r => day(r.date) === day(String(date)))
        : runs[0];
      if (!run) return { error: 'No matching run found. Call query_runs to see available runs.' };
      let detail;
      try { detail = await fetchWorkoutDetail(run.date, run.duration); }
      catch (e: any) { return { ...runSummary(run), note: 'Intra-run detail unavailable: ' + (e?.message ?? 'fetch failed') }; }
      const stat = (arr: { v: number }[]) => arr.length
        ? { avg: Math.round(arr.reduce((s, x) => s + x.v, 0) / arr.length), max: Math.round(Math.max(...arr.map(x => x.v))), min: Math.round(Math.min(...arr.map(x => x.v))) }
        : null;
      return {
        ...runSummary(run),
        km_splits: (detail.kmSplits ?? []).map(k => ({ km: k.km, pace_per_km: paceStr(k.paceSecs), avg_hr: k.avgHR || null, avg_power_w: k.avgPower || null })),
        segments: (detail.activities ?? []).map(a => ({ phase: a.label, min: round((a.netDurationSec ?? 0) / 60, 1), avg_hr: a.avgHR || null, distance_m: a.distanceM ? Math.round(a.distanceM) : null })),
        hr_stats: stat(detail.hr ?? []),
        power_stats: stat(detail.power ?? []),
      };
    },
  },
  {
    name: 'get_metric_series',
    description:
      'Time series for a wellness or training-load metric over the last N days. metric = hrv (nightly RMSSD, ms), resting_hr (bpm), vo2max, sleep (hours), or ctl_atl_tsb (fitness / fatigue / form). Use to correlate wellness with performance.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['hrv', 'resting_hr', 'vo2max', 'sleep', 'ctl_atl_tsb'] },
        days: { type: 'number', description: 'Lookback window in days (default 30).' },
      },
      required: ['metric'],
    },
    run: async ({ metric, days }, ctx) => {
      const cut = Date.now() - (Number(days) || 30) * 864e5;
      const within = (d: string) => new Date(d).getTime() >= cut;
      const s = ctx.snap;
      switch (metric) {
        case 'hrv':
          return { metric, unit: 'ms RMSSD', series: (s.hrv ?? []).filter(x => within(x.date)).map(x => ({ date: day(x.date), value: round(x.value, 1) })) };
        case 'resting_hr':
          return { metric, unit: 'bpm', series: (s.restingHR ?? []).filter(x => within(x.date)).map(x => ({ date: day(x.date), value: Math.round(x.value) })) };
        case 'vo2max':
          return { metric, series: (s.vo2max ?? []).filter(x => within(x.date)).map(x => ({ date: day(x.date), value: round(x.value, 1) })) };
        case 'sleep':
          return { metric, unit: 'hours', series: (s.recentSleep ?? []).filter(x => within(x.date)).map(x => ({ date: day(x.date), hours: round((x.totalMinutes ?? 0) / 60, 1), deep_min: x.deepMinutes ?? null, rem_min: x.remMinutes ?? null })) };
        case 'ctl_atl_tsb':
          return { metric, series: (s.trainingLoad ?? []).filter(x => within(x.date)).map(x => ({ date: day(x.date), ctl: round(x.ctl, 1), atl: round(x.atl, 1), tsb: round(x.tsb, 1) })) };
        default:
          return { error: 'Unknown metric.' };
      }
    },
  },
];

const TOOLS_HINT =
  '\n\nYou have TOOLS to pull data beyond the snapshot above: query_runs (list/filter runs), get_run_detail ' +
  '(one run\'s km-splits + segments + HR/power), get_metric_series (hrv, resting_hr, vo2max, sleep, ctl_atl_tsb). ' +
  'Call them when a precise answer needs data not already in context — e.g. comparing specific runs, inspecting ' +
  "intervals, or correlating wellness with performance. Don't ask the user for data you can fetch. Keep the final answer concise.";

/** Anthropic tool schemas (no run fn) sent to the API. */
const toolSchemas = () => TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

/**
 * Run the agentic loop: call the model with tools; whenever it emits tool_use blocks, execute the matching
 * tool against the snapshot, feed results back, and continue — until it produces a final text answer.
 * Anthropic-only (checked by the caller via agenticSupported); throws 'AGENTIC_UNSUPPORTED' otherwise so
 * the caller can fall back to a single-shot call.
 */
export async function runAgent(opts: {
  system:       string;
  messages:     { role: 'user' | 'assistant'; content: string }[];
  maxTokens:    number;
  snap:         HealthSnapshot;
  maxSteps?:    number;
  temperature?: number;
}): Promise<string> {
  const ctx: AgentCtx = { snap: opts.snap };
  const system = opts.system + TOOLS_HINT;
  const messages: any[] = opts.messages.map(m => ({ role: m.role, content: m.content }));
  const maxSteps = opts.maxSteps ?? 6;

  for (let step = 0; step < maxSteps; step++) {
    const res = await callLLMTools({ system, messages, tools: toolSchemas(), maxTokens: opts.maxTokens, temperature: opts.temperature });
    if (res.stopReason !== 'tool_use') return res.text;

    messages.push({ role: 'assistant', content: res.content });
    const toolUses = res.content.filter((b: any) => b.type === 'tool_use');
    const results = await Promise.all(toolUses.map(async (u: any) => {
      const tool = TOOLS.find(t => t.name === u.name);
      let out: any;
      try { out = tool ? await tool.run(u.input ?? {}, ctx) : { error: `Unknown tool ${u.name}` }; }
      catch (e: any) { out = { error: e?.message ?? 'tool failed' }; }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) };
    }));
    messages.push({ role: 'user', content: results });
  }

  // Out of steps → force a final answer with no more tools.
  const final = await callLLMTools({ system, messages, tools: [], maxTokens: opts.maxTokens, temperature: opts.temperature });
  return final.text || 'I pulled the data but ran out of steps to summarise — please ask again.';
}

/** Convenience: is the agentic path both enabled AND supported by the active provider? */
export async function agenticActive(): Promise<boolean> {
  return (await getAgenticMode()) && (await agenticSupported());
}

/**
 * Single entry point for the chat + run-analysis prompts: run the agentic tool loop when it's enabled and
 * supported, otherwise (or on ANY agentic failure) fall back to the existing single-shot call. Same output
 * shape (a text string) either way, so callers don't branch.
 */
export async function agentComplete(opts: {
  system:    string;
  messages:  { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  snap:      HealthSnapshot;
}): Promise<string> {
  if (await agenticActive()) {
    try {
      return await runAgent({ system: opts.system, messages: opts.messages, maxTokens: opts.maxTokens, snap: opts.snap });
    } catch { /* AGENTIC_UNSUPPORTED, network, or tool error → degrade to single-shot below */ }
  }
  return callLLM({ system: opts.system, messages: opts.messages, maxTokens: opts.maxTokens });
}
