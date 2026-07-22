import * as SecureStore from 'expo-secure-store';
import { HealthSnapshot, RunWorkout, ActivitySummary } from '../types';
import { fetchWorkoutDetail, fetchOurDailyComponents, fetchActivityHistory } from './healthkit';
import { computeWorkoutLoad, strainFromLoad, activityCategory, activityName } from './trainingLoad';
import { callLLM, callLLMTools, agenticSupported } from './llm';
// coach.ts pulls in claude.ts (getPowerZones) and claude.ts pulls in this file (agentComplete) → a require
// cycle. It's safe: every use of these imports is inside a tool `run` callback (call-time), never at module
// load, so the live bindings are fully initialised by the time they run.
import { assembleCoachSnapshot, loadCachedPlan, loadWeekPlanCache, getWeekPlan, formatWorkoutStructure, loadPrescriptionAt,
         savePendingPrescription, buildProposedWorkout, ensureBlockPower } from './coach';
import { addLifeEvent } from './timelineEvents';
import { getPowerZones } from './claude';
import { computeBodyBattery } from './bodyBattery';
import { buildKnowledgePrompt } from './coachFiles';

// ─── Agentic coach: give the LLM read-only TOOLS to pull data on demand ────────
// Instead of one fat snapshot → one answer, the model can call these tools to drill into specific runs
// and metric series, then reason over what it pulled. All tools are READ-ONLY and run against the
// in-memory snapshot + HealthKit detail; nothing mutates state or leaves the device beyond the LLM call.

const SK_AGENTIC = 'agentic_mode_v1';
// Default ON: the coach now has genuinely useful read-only tools (plan/budget, week plan, prescription
// history, KPI series, coaching files). It only engages on Anthropic (else it degrades to single-shot), and
// any tool error falls back silently — so on-by-default is safe. Explicitly turn it off → stored '0'.
export async function getAgenticMode(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(SK_AGENTIC)) !== '0'; } catch { return true; }
}
export async function setAgenticMode(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(SK_AGENTIC, on ? '1' : '0'); } catch { /* ignore */ }
}

interface AgentCtx {
  snap: HealthSnapshot;
  _cs?: Promise<any>;     // memoised CoachSnapshot (plan/ToF-budget/load context) — assembled once per turn
  _comps?: Promise<any>;  // memoised daily-components map (recovery/strain/sleep/... history)
  _acts?: Promise<ActivitySummary[]>;  // memoised full-window activity history (deeper than snap.activities)
}
interface AgentTool {
  name: string;
  description: string;
  input_schema: any;
  run: (input: any, ctx: AgentCtx) => Promise<any>;
}

// The full coaching context (today's plan inputs, the rolling ToF budget, CTL/ATL/TSB, readiness, strain
// band, next-run projection, weather) — the SAME snapshot the daily plan is built from. Memoised so several
// tools in one turn don't recompute it (assembleCoachSnapshot is imported statically; safe — call-time only).
async function coachSnap(ctx: AgentCtx): Promise<any> {
  return (ctx._cs ??= assembleCoachSnapshot(ctx.snap.strain ?? null, ctx.snap.activities, ctx.snap.runs));
}
// Per-day KPI components (recovery/strain/sleep score/sleep bank/resting HR·HRV/resp rate/SpO₂/CTL/ATL/TSB),
// ~4 months, window-invariant. Memoised per turn.
async function dailyComps(ctx: AgentCtx): Promise<Record<string, Record<string, number>>> {
  return (ctx._comps ??= fetchOurDailyComponents(4));
}
// Full-window workout history (all types) — deeper than the snapshot's 35-day `activities`. Memoised per turn.
async function activityHistory(ctx: AgentCtx): Promise<ActivitySummary[]> {
  return (ctx._acts ??= fetchActivityHistory(4));
}
const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
    name: 'query_activities',
    description:
      "List the athlete's NON-RUN sessions (dancing, cycling, strength, walks, swims, HIIT, yoga, rowing…) as rows: date, type, duration, per-session STRAIN %, kcal, avg HR, AND the NEXT-DAY recovery score (the morning AFTER the session — the recovery the session cost). This is the tool for ANALYSING HOW AN ACTIVITY TYPE IMPACTS RECOVERY — e.g. 'how does dancing affect my next-day recovery?', or gauging a session planned for tonight. Filter by `type` to isolate one activity (e.g. dance) then compare its strain/duration against the next-day recovery column. For RUNNING workouts use query_runs instead. Depth follows the synced history (~4 months).",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by activity type, matched loosely, e.g. "Dance", "Cycling", "Strength", "Walk", "Swim", "HIIT", "Yoga", "Rowing". Omit for all non-run activities.' },
        since_days: { type: 'number', description: 'Only include sessions within this many days. Omit for all available history.' },
        limit: { type: 'number', description: 'Max rows to return (default 30, max 100).' },
      },
    },
    run: async ({ type, since_days, limit }, ctx) => {
      let acts = (await activityHistory(ctx)).filter(a => activityCategory(a.activityType) !== 'Run'); // runs → query_runs
      if (type) { const q = String(type).toLowerCase(); acts = acts.filter(a => activityName(a.activityType).toLowerCase().includes(q) || (a.name ?? '').toLowerCase().includes(q)); }
      if (since_days) { const cut = Date.now() - Number(since_days) * 864e5; acts = acts.filter(a => new Date(a.date).getTime() >= cut); }
      acts = acts.slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)));
      const comps = await dailyComps(ctx);
      // The impact shows in the recovery measured the MORNING AFTER the session (date + 1 day), keyed local.
      const nextRecovery = (iso: string): number | null => {
        const d = new Date(iso); d.setDate(d.getDate() + 1);
        const v = comps[toKey(d)]?.recoveryScore;
        return v != null ? Math.round(v) : null;
      };
      return {
        count: acts.length,
        activities: acts.map(a => ({
          date: day(a.date),
          type: activityName(a.activityType),
          duration_min: Math.round(a.durationMin),
          strain_pct: strainFromLoad(computeWorkoutLoad(a)),
          kcal: a.kcal || null,
          avg_hr: a.avgHR || null,
          next_day_recovery: nextRecovery(a.date),
        })),
      };
    },
  },
  {
    name: 'get_run_detail',
    description:
      'Detailed breakdown of ONE run: per-km splits (pace, HR, power), structured segments (warmup / work / recovery / cooldown with duration, HR and distance), HR/power summary stats, AND `prescribed_at_start` = the plan that was live WHEN THIS RUN STARTED. To judge a run against its prescription, ALWAYS use `prescribed_at_start` from here — NOT get_plan_context (that returns TODAY\'s CURRENT plan, which often flips to "rest/recover" AFTER a run finishes, so using it makes a completed session look like it "ran on a rest day"). Identify the run by uuid (from query_runs) or by date (YYYY-MM-DD). Defaults to the most recent run if neither is given.',
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
      // The prescription that was LIVE WHEN THIS RUN STARTED (from the plan-log), so a run is judged against
      // the morning's plan — not today's current plan, which may have flipped to "rest/recover" after it.
      const rxPlan = await loadPrescriptionAt(day(run.date), new Date(run.date).getTime()).catch(() => null);
      const prescribed_at_start = rxPlan ? {
        session: rxPlan.session, intensity: rxPlan.intensity, prescribed_run_min: rxPlan.runMinutes,
        target_strain_pct: `${rxPlan.strainLow}-${rxPlan.strainHigh}`, rationale: rxPlan.rationale || null,
        structure: rxPlan.workout ? formatWorkoutStructure(rxPlan.workout) : null,
      } : 'No plan was in effect when this run started (run beat the day\'s plan) — judge it on its own merits; do NOT call it a rest-day violation.';
      let detail;
      try { detail = await fetchWorkoutDetail(run.date, run.duration); }
      catch (e: any) { return { ...runSummary(run), prescribed_at_start, note: 'Intra-run detail unavailable: ' + (e?.message ?? 'fetch failed') }; }
      const stat = (arr: { v: number }[]) => arr.length
        ? { avg: Math.round(arr.reduce((s, x) => s + x.v, 0) / arr.length), max: Math.round(Math.max(...arr.map(x => x.v))), min: Math.round(Math.min(...arr.map(x => x.v))) }
        : null;
      return {
        ...runSummary(run),
        prescribed_at_start,
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
      'Daily history for a wellness / training-load / KPI metric over the last N days. metric = hrv (nightly RMSSD, ms), resting_hr (bpm), vo2max, sleep (hours), ctl_atl_tsb (fitness/fatigue/form), recovery (0–100 score), strain (0–100 daily load %), sleep_score (0–100), sleep_bank (min vs need), respiratory_rate (br/min), or spo2 (%). Use to spot trends and correlate wellness with training.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['hrv', 'resting_hr', 'vo2max', 'sleep', 'ctl_atl_tsb', 'recovery', 'strain', 'sleep_score', 'sleep_bank', 'respiratory_rate', 'spo2'] },
        days: { type: 'number', description: 'Lookback window in days (default 30).' },
      },
      required: ['metric'],
    },
    run: async ({ metric, days }, ctx) => {
      const cut = Date.now() - (Number(days) || 30) * 864e5;
      const within = (d: string) => new Date(d).getTime() >= cut;
      const s = ctx.snap;
      // Sub-KPI series that live in the per-day components map (not on the snapshot).
      const COMP_KEY: Record<string, [string, string]> = {
        recovery: ['recoveryScore', 'score 0–100'], strain: ['strainScore', '% 0–100'],
        sleep_score: ['sleepScore', 'score 0–100'], sleep_bank: ['sleepBank', 'min vs need'],
        respiratory_rate: ['respiratoryRate', 'br/min'], spo2: ['oxygenSaturation', '%'],
      };
      if (COMP_KEY[metric]) {
        const [key, unit] = COMP_KEY[metric];
        const comps = await dailyComps(ctx);
        const series = Object.keys(comps).filter(within).sort()
          .map(d => ({ date: d, value: comps[d][key] })).filter(x => x.value != null).map(x => ({ date: x.date, value: round(x.value, 1) }));
        return { metric, unit, series };
      }
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
  {
    name: 'get_plan_context',
    description:
      "The live coaching state for TODAY — call this for ANY question about the plan, the volume budget, or how a run affects things (never guess these numbers). Returns today's CURRENT prescription, the ROLLING 7-DAY TIME-ON-FEET BUDGET (minutes used vs the +cap% ceiling and how much is left today — every running minute is deducted from it), CTL/ATL/TSB, readiness & its drivers, today's strain vs the advisable band, ACWR, the next meaningful-run day, current Body Battery, and weather/heat. NOTE: this is the CURRENT plan — after a run finishes it may read 'rest/recover' (session done). To judge a run that was ALREADY done, use get_run_detail's `prescribed_at_start`, NOT this.",
    input_schema: { type: 'object', properties: {} },
    run: async (_input, ctx) => {
      const cs = await coachSnap(ctx);
      const [plan, bb] = await Promise.all([
        loadCachedPlan(cs.date).catch(() => null),
        computeBodyBattery().catch(() => null),
      ]);
      return {
        date: cs.date,
        todays_plan: plan ? {
          headline: plan.headline, session: plan.session, intensity: plan.intensity, kind: plan.sessionKind,
          run_minutes: plan.runMinutes, run_km: plan.runKm ?? null,
          structure: formatWorkoutStructure(plan.workout) || (plan.intensity === 'rest' ? 'rest' : null),
        } : 'no plan cached yet today',
        tof_budget: {
          basis: cs.loadCapBasis, cap_pct: cs.loadCapPct,
          last_7d_min: cs.tof7d, prev_7d_min: cs.tofPrev7d,
          remaining_today_min: cs.tofBudgetTodayMin,
          next_meaningful_run: cs.tofNextRunLabel ?? null, next_run_in_days: cs.tofNextRunInDays ?? null,
          note: 'Every running minute (any zone) is deducted from this rolling +cap% 7-day time-on-feet budget.',
        },
        training_load: { ctl_fitness: cs.ctl, atl_fatigue: cs.atl, tsb_form: cs.tsb, acwr: cs.acwr },
        readiness: cs.readiness ?? null, recovery: cs.recovery ?? null, drivers: cs.drivers ?? null,
        strain_today: cs.strainReal ?? null, advisable_band: [cs.advisableLow ?? null, cs.advisableHigh ?? null],
        wellness: { hrv: cs.hrv ?? null, resting_hr: cs.rhr ?? null, resp_rate: cs.respRate ?? null, spo2: cs.spO2 ?? null, sleep_score: cs.sleepScore ?? null, sleep_min: cs.sleepMin ?? null, sleep_debt_min: cs.sleepDebtMin ?? null },
        body_battery: bb ? { current: Math.round(bb.current), stress: Math.round(bb.currentStress), trend_per_hour: round(bb.trendPerHour, 1), day_low: Math.round(bb.dayLow), day_high: Math.round(bb.dayHigh) } : null,
        weather: cs.weather ? { temp_c: cs.weather.tempC, apparent_c: cs.weather.apparentC, humidity: cs.weather.humidity, description: cs.weather.description } : null,
      };
    },
  },
  {
    name: 'get_week_plan',
    description:
      "The forward 7-day training schedule (today → +7): each day's session kind, intensity, prescribed minutes/km, structure and a short note. This is what the app has actually laid out — use it to answer 'what's my week', to reason about how today affects the rest of the week, or to critique/propose changes.",
    input_schema: { type: 'object', properties: {} },
    run: async (_input, ctx) => {
      const cs = await coachSnap(ctx);
      const cache = await loadWeekPlanCache(cs.date).catch(() => null);
      const days = cache?.days ?? await getWeekPlan(cs).catch(() => []);
      return {
        generated_for: cache?.date ?? cs.date,
        days: (days ?? []).map((d: any) => ({
          date: d.date, weekday: d.weekday, kind: d.kind ?? null, intensity: d.intensity,
          run_minutes: d.runMinutes, run_km: d.runKm ?? null, structure: d.structure, note: d.note,
        })),
      };
    },
  },
  {
    name: 'get_prescription_history',
    description:
      'What was PRESCRIBED each of the last N days vs what you actually RAN — so you can see plan adherence and how the coach has been progressing the athlete. Returns per day: the prescribed session (intensity/kind/minutes/structure) and the executed run minutes.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'How many days back (default 14, max 60).' } },
    },
    run: async ({ days }, ctx) => {
      const n = Math.max(1, Math.min(Number(days) || 14, 60));
      const ranByDay = new Map<string, number>();
      for (const r of ctx.snap.runs ?? []) {
        const k = day(r.date);
        ranByDay.set(k, (ranByDay.get(k) ?? 0) + Math.round(((r.workDuration ?? r.duration) ?? 0) / 60));
      }
      const now = new Date();
      const rows: any[] = [];
      for (let i = 0; i < n; i++) {
        const key = toKey(new Date(now.getTime() - i * 864e5));
        const plan = await loadCachedPlan(key).catch(() => null);
        const ran = ranByDay.get(key) ?? 0;
        if (!plan && !ran) continue;
        rows.push({
          date: key,
          prescribed: plan ? { intensity: plan.intensity, kind: plan.sessionKind ?? null, min: plan.runMinutes, structure: formatWorkoutStructure(plan.workout) || (plan.intensity === 'rest' ? 'rest' : null) } : null,
          executed_run_min: ran,
        });
      }
      return { days: rows };
    },
  },
  {
    name: 'get_coaching_files',
    description:
      "The athlete's OWN editable coaching setup — their weekly schedule template, Power & HR zones, drills, athlete profile and any coaching notes. Call this when designing or critiquing a program, discussing zones/pace targets, or when you need the athlete's actual training structure rather than generic advice.",
    input_schema: { type: 'object', properties: {} },
    run: async () => {
      const text = await buildKnowledgePrompt().catch(() => '');
      return { coaching_files: text || 'No coaching files configured yet.' };
    },
  },
  // ── WRITE TOOLS ────────────────────────────────────────────────────────────────────────────────────
  // The chat coach was structurally read-only: it could diagnose an issue and design a sensible modified
  // session, but nothing could reach the app — the insight died in the chat. These two close that loop.
  // log_health_event writes DIRECTLY (recording that something hurts is harmless; LOSING it is the real
  // risk — buildTimelineContext feeds the timeline into every future plan). propose_prescription only
  // PROPOSES: the athlete approves it on the Daily Coach. Nothing reaches the watch un-reviewed.
  {
    name: 'log_health_event',
    description:
      "RECORD a health/life event to the athlete's timeline so EVERY future plan accounts for it — an injury or niggle (e.g. Achilles tendon soreness), illness, travel, or a notable life stressor. Call this AS SOON AS the athlete mentions such a thing; otherwise it is forgotten the moment this chat ends and tomorrow's plan will prescribe as if nothing is wrong. Writes immediately (no approval needed). For a niggle, ALSO tell the athlete they can set status to Injured if they want running suppressed entirely.",
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Short label, e.g. "Achilles tendon soreness (right)".' },
        date:     { type: 'string', description: 'ISO date YYYY-MM-DD it started. Defaults to today.' },
        category: { type: 'string', description: 'One of: injury, illness, travel, life, other.' },
        note:     { type: 'string', description: 'Detail worth remembering — severity, what aggravates it, what the athlete and you agreed to change.' },
      },
      required: ['title'],
    },
    run: async ({ title, date, category, note }) => {
      const d = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
      await addLifeEvent({ title: String(title).slice(0, 120), date: d, category: category ? String(category) : 'injury', note: note ? String(note).slice(0, 500) : undefined });
      return { recorded: true, title, date: d, note: 'Saved to the timeline — it now feeds every future plan.' };
    },
  },
  {
    name: 'propose_prescription',
    description:
      "PROPOSE a replacement session for a given day. Use when you and the athlete have agreed the prescribed session should change (e.g. an Achilles niggle → capped power + WALK recoveries). This does NOT apply it: the athlete sees an Apply / Discard card on the Daily Coach, and only then does it reach the watch. Build `blocks` the way the watch workout works: each block is repeats × (workMinutes at hrZone, then restMinutes of recovery at recoveryZone). Use recoveryZone 'Z0'/'Z1' for a WALK/jog recovery, 'Z3' for a float. Recovery is capped at 5 min. Keep the session within the day's budget — check get_plan_context first.",
    input_schema: {
      type: 'object',
      properties: {
        session:    { type: 'string', description: 'One-line prose the athlete reads, e.g. "Modified intervals — 3× 3min @ 240-260W, 2min walk recoveries".' },
        rationale:  { type: 'string', description: 'WHY this differs from the original prescription (the clinical//training reason).' },
        intensity:  { type: 'string', description: 'rest | easy | moderate | hard.' },
        runMinutes: { type: 'number', description: 'Total time on feet for the session.' },
        date:       { type: 'string', description: 'ISO YYYY-MM-DD. Defaults to today.' },
        blocks: {
          type: 'array',
          description: 'Work blocks in order.',
          items: {
            type: 'object',
            properties: {
              repeats:      { type: 'number' },
              workMinutes:  { type: 'number' },
              restMinutes:  { type: 'number', description: 'Recovery between reps, minutes (max 5).' },
              hrZone:       { type: 'string', description: 'Z1..Z5 for the WORK.' },
              recoveryZone: { type: 'string', description: "Z0/Z1 = walk/jog recovery (rest — outside the time-on-feet budget). Z2/Z3 = FLOAT: easy running between reps, pushed to the watch as a WORK step at its own lower watts, so its minutes DO count toward the budget." },
              powerLowWatts:  { type: 'number' },
              powerHighWatts: { type: 'number' },
              label:        { type: 'string' },
            },
          },
        },
      },
      required: ['session', 'intensity', 'blocks'],
    },
    run: async ({ session, rationale, intensity, runMinutes, date, blocks }, ctx) => {
      const d = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10);
      const it = ['rest', 'easy', 'moderate', 'hard'].includes(String(intensity)) ? String(intensity) as any : 'easy';
      const mins = Math.max(0, Math.min(240, Number(runMinutes) || 0));
      // Route through the SAME validation the LLM daily plan uses: zone clamping by intensity, restMinutes
      // ≤5 (a hallucinated "30m jog" once ballooned a 35-min tempo to 122 min) and power-band widening
      // (a zero-width band once crash-looped the app via WorkoutKit). Never trust raw model output here.
      const pz = await getPowerZones().catch(() => undefined);
      const wo = it === 'rest' ? null
        : ensureBlockPower(buildProposedWorkout({ blocks }, it, 'Day'), pz);
      await savePendingPrescription({
        date: d, session: String(session).slice(0, 280),
        rationale: rationale ? String(rationale).slice(0, 400) : undefined,
        intensity: it, runMinutes: mins, workout: wo, source: 'chat-coach',
        createdAt: new Date().toISOString(),
      });
      return {
        proposed: true, date: d,
        structure: wo ? formatWorkoutStructure(wo) : 'rest',
        note: 'PROPOSED only — tell the athlete to open the Daily Coach and tap Apply to make it today\'s session and send it to the watch.',
      };
    },
  },
];

const TOOLS_HINT =
  '\n\nYou have READ-ONLY TOOLS to pull the athlete\'s real data on demand — use them instead of guessing, and ' +
  'NEVER ask the user for a number you can fetch yourself:\n' +
  '• get_plan_context — today\'s prescription + the rolling 7-day time-on-feet BUDGET (used vs cap, remaining), ' +
  'CTL/ATL/TSB, readiness, strain vs band, next-run day, Body Battery, weather. Call this for ANY plan/budget/' +
  '"does this run fit" question — those numbers are NOT in the snapshot above.\n' +
  '• get_week_plan — the forward 7-day schedule (kinds, minutes, structure) the app has laid out.\n' +
  '• get_prescription_history — prescribed vs executed per day (adherence / how you\'ve been progressing them).\n' +
  '• get_metric_series — daily history for hrv, resting_hr, vo2max, sleep, ctl_atl_tsb, recovery, strain, ' +
  'sleep_score, sleep_bank, respiratory_rate, spo2.\n' +
  '• query_runs / get_run_detail — list/filter runs; one run\'s km-splits + segments + HR/power.\n' +
  '• query_activities — NON-run sessions (dance/bike/strength/swim…) with per-session strain + NEXT-DAY recovery; ' +
  'the tool for "how does <activity> affect my recovery?" and planning around a session tonight.\n' +
  '• get_coaching_files — the athlete\'s OWN weekly schedule, Power/HR zones, drills & profile (call before ' +
  'designing/critiquing a program or discussing zones/paces).\n' +
  'Chain tools freely (e.g. get_plan_context then get_week_plan) before answering. Keep the final answer concise and cite the numbers you pulled.\n' +
  'You also have TWO WRITE tools — the chat is no longer read-only:\n' +
  '• log_health_event — call this IMMEDIATELY when the athlete mentions an injury/niggle (e.g. Achilles), ' +
  'illness, travel or a big life stressor. It writes straight to the timeline, which feeds EVERY future plan. ' +
  'If you don\'t log it, it is forgotten when this chat ends and tomorrow\'s plan ignores it.\n' +
  '• propose_prescription — when you and the athlete agree today\'s session should change, PROPOSE the new ' +
  'one. It does NOT auto-apply: the athlete taps Apply on the Daily Coach, which then sends it to the watch. ' +
  'Check get_plan_context first so the proposal respects the day\'s budget, and say plainly that it is ' +
  'waiting for their approval.';

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
