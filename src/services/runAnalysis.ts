/**
 * Automatic post-run analysis.
 *
 * When a run finishes, this produces a prescription-aware coaching review of THAT run:
 * it loads the coach plan that was set for the run's day (built this morning from HRV,
 * recovery, load, time-on-feet budget and heat) and judges the run AGAINST that plan —
 * recognising the planned warm-up, drills, work reps and cool-down rather than inferring
 * structure from scratch. The result is cached (one analysis, replaced on the next run),
 * surfaced as a reduced iPhone notification, and shown in full on the Run Analysis screen.
 */
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import { HealthSnapshot, RunWorkout } from '../types';
import { callLLM } from './llm';
import { agentComplete } from './agent';
import { getApiKey, buildNewRunUserMessage } from './claude';
import { loadPrescriptionAt, CoachPlan } from './coach';
import { fetchHealthSnapshot, loadSnapshotCache, saveSnapshotCache } from './healthkit';

export interface RunAnalysis {
  runUUID:     string;
  runDate:     string;   // ISO start of the analysed run
  label:       string;   // run type at analysis time
  verdict:     string;   // ≤4 words, e.g. "On plan", "Overcooked it"
  headline:    string;   // ≤14 words — the notification one-liner
  full:        string;   // markdown — the full analysis
  hadPlan:     boolean;  // whether a prescription was available to judge against
  generatedAt: string;   // ISO
  model:       string;
}

const ANALYSIS_FILE = `${FileSystem.documentDirectory}run-analysis-latest.json`;

// ─── Cache (one analysis, replaced each run) ──────────────────────────────────

export async function loadLatestRunAnalysis(): Promise<RunAnalysis | null> {
  try {
    const info = await FileSystem.getInfoAsync(ANALYSIS_FILE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(ANALYSIS_FILE)) as RunAnalysis;
  } catch { return null; }
}

export async function saveLatestRunAnalysis(a: RunAnalysis): Promise<void> {
  try { await FileSystem.writeAsStringAsync(ANALYSIS_FILE, JSON.stringify(a)); } catch { /* ignore */ }
}
export async function clearRunAnalysisCache(): Promise<void> {
  try { await FileSystem.deleteAsync(ANALYSIS_FILE, { idempotent: true }); } catch { /* ignore */ }
}

// ─── Prescription formatting (shared with the chat-based analyze) ──────────────

/**
 * Render the coach plan that was prescribed for a run's day into a compact block the
 * LLM can judge the run against. Includes the structured watch workout (warm-up →
 * drills → work reps → cool-down) so the analysis recognises the planned structure.
 */
export function formatPrescription(plan: CoachPlan | null): string {
  if (!plan) return '';
  const lines: string[] = [];
  if (plan.session)   lines.push(`Session prescribed: ${plan.session}`);
  lines.push(`Intensity: ${plan.intensity} · prescribed run time-on-feet: ${plan.runMinutes} min · target strain ${plan.strainLow}–${plan.strainHigh}%`);
  if (plan.rationale) lines.push(`Coach rationale (already weighs HRV/recovery/load/heat): ${plan.rationale}`);
  if (plan.cautions)  lines.push(`Cautions: ${plan.cautions}`);
  if (plan.strength)  lines.push(`Strength prescribed: ${plan.strength}`);

  const w = plan.workout;
  if (w) {
    const struct: string[] = [`Warm-up ${w.warmupMeters}m`];
    if (w.drillsMinutes > 0) struct.push(`Drills ${w.drillsMinutes} min`);
    for (const b of w.blocks) {
      const zone = b.hrZone ? ` @${b.hrZone}` : '';
      const pw   = (b.powerLowWatts && b.powerHighWatts) ? ` (${b.powerLowWatts}–${b.powerHighWatts}W)` : '';
      const rest = b.restMinutes > 0 ? ` + ${b.restMinutes}min recovery` : '';
      const lbl  = b.label ? ` — ${b.label}` : '';
      struct.push(`${b.repeats}× ${b.workMinutes}min${zone}${pw}${rest}${lbl}`);
    }
    struct.push(`Cool-down ${w.cooldownMeters}m`);
    lines.push(`Planned structure (the watch workout pushed this morning):\n  ${struct.join('\n  ')}`);
  }
  return lines.join('\n');
}

/** The full prescription context block + judging instructions injected into the prompt. */
export function buildPrescriptionContext(plan: CoachPlan | null): string {
  const block = formatPrescription(plan);
  if (!block) return '';
  return `PRESCRIBED BEFORE THIS RUN — this is the plan that was in effect when the athlete set off, from the pre-run HRV, recovery, training load, the +10% time-on-feet cap and heat. It is what drove the decision to train. Judge the run AGAINST THIS PLAN, not against generic mileage goals or the athlete's post-run state:
${block}

How to use the prescription:
1. Compare ACTUAL vs PRESCRIBED — duration, intensity and structure. If they hit the plan (e.g. 25 min easy prescribed → ~25 min easy run), that is ON PLAN — say so plainly.
2. The warm-up, drills, work reps and cool-down above are PLANNED blocks. Recognise them — refer to the drills as the prescribed drills block; never treat them as an unexplained anomaly.
3. Do NOT advise running more / longer / harder than prescribed — the prescription already accounts for recovery and the load cap. Only flag under-running if recovery clearly allowed more.
4. Do NOT list as a "decline", weakness or negative anything the athlete executed AS PRESCRIBED. Power within the prescribed watt window, duration matching the prescribed minutes, and intensity matching the plan are ON PLAN — frame them that way, never as a regression. A deliberately shorter or lower-power session (scaled down for heat or recovery) is the plan working as intended; comparing its absolute power/duration unfavourably against longer or harder past runs is WRONG. Reserve "watch-outs"/declines for genuine shortfalls vs the plan (e.g. fell out of the prescribed zone, cut the session short) or real physiological concerns (HRV trend, sleep debt) — never for following the prescription.`;
}

// ─── Prompt + one-shot LLM call ───────────────────────────────────────────────

function recoveryLoadContext(snap: HealthSnapshot): string {
  const rec = snap.todayRecovery;
  const recLine = rec && rec.weightedRMSSD > 0
    ? `Recovery ${rec.recoveryScore}/100 (${rec.label}) · RMSSD ${rec.weightedRMSSD}ms vs ${rec.baseline7Day}ms base`
    : 'Recovery: not synced';
  const load = snap.trainingLoad ?? [];
  const last = load.length ? load[load.length - 1] : null;
  const loadLine = last ? ` · Load CTL ${last.ctl} ATL ${last.atl} TSB ${last.tsb >= 0 ? '+' : ''}${last.tsb}` : '';
  return `CONTEXT: ${recLine}${loadLine}`;
}

const SYSTEM_PROMPT = `You are an elite running coach reviewing a single run the athlete just completed. You receive: the athlete's recovery/load context, the SESSION YOU PRESCRIBED for the day (with its planned structure), the run's actual data, and recent comparable runs.

Write a sharp, specific post-run review grounded in the numbers. Crucially:
• Judge the run against the PRESCRIPTION, not generic targets. If they were told 25 min easy and ran ~25 min easy, that's ON PLAN — say so; do not tell them to run more.
• Recognise the planned warm-up, drills, work reps and cool-down. Refer to the drills explicitly as the prescribed drills block.
• The prescription already accounts for HRV/recovery/load/heat — respect it. wHR = work-only HR.

Return ONLY minified JSON — no markdown fences — with EXACTLY these keys:
{"verdict": string (≤4 words, e.g. "On plan", "Overcooked it", "Easier than planned", "Solid tempo"),
 "headline": string (≤14 words — the single most useful takeaway, for a phone notification),
 "full": string (markdown, ~150–280 words, using these headers: "## Verdict vs plan", "## What stood out" with 2–4 number-rich bullets, "## Next" with one forward-looking cue; reference the prescription and the drills where relevant)}`;

/** Generate the analysis for one run. Throws on LLM/auth errors. */
export async function analyzeRun(
  snap: HealthSnapshot,
  run: RunWorkout,
  plan: CoachPlan | null,
  prevRuns: RunWorkout[],
): Promise<RunAnalysis> {
  const prescription = plan
    ? buildPrescriptionContext(plan)
    : `NO SESSION WAS PRESCRIBED before this run — today's plan had not been generated when the run started, so there is no prescription to judge against. Do NOT assume it was a rest day or that the athlete should not have run, and do NOT produce a "ran on a rest day / should have rested" verdict. Analyse the run purely on its own merits and recent trends.`;
  const runBlock = buildNewRunUserMessage(run, prevRuns, run.kmSplits, true);
  const userMsg = [recoveryLoadContext(snap), prescription, runBlock].filter(Boolean).join('\n\n');

  // Same shape as Chat, only the SYSTEM_PROMPT differs: run through agentComplete so agentic mode (when on)
  // can pull prior runs / metric series via tools to ground the analysis; else single-shot.
  const raw = await agentComplete({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }], maxTokens: 950, snap });

  let verdict = '', headline = '', full = '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]);
      verdict  = String(o.verdict ?? '').trim();
      headline = String(o.headline ?? '').trim();
      full     = String(o.full ?? '').trim();
    } catch { /* fall through to raw */ }
  }
  if (!full) {
    // Couldn't parse JSON — treat the whole response as the body.
    full = raw.trim();
    headline = headline || full.split('\n').find(l => l.trim())?.replace(/[#*]/g, '').trim().slice(0, 90) || 'Run analysed';
    verdict = verdict || 'Reviewed';
  }

  return {
    runUUID:     run.uuid,
    runDate:     run.date,
    label:       run.label ?? 'Run',
    verdict:     verdict || 'Reviewed',
    headline:    headline || 'Run analysed',
    full,
    hadPlan:     !!plan,
    generatedAt: new Date().toISOString(),
    model:       '', // configured model; kept for display compatibility
  };
}

// ─── Orchestration: analyse the latest run (idempotent, fresh-runs only) ───────

let analyzing = false;

/**
 * Analyse the most recent run if it hasn't been analysed yet. Idempotent (keyed on the
 * run UUID) and bounded to recently-finished runs so updating the app never back-fills a
 * stale review. Pass a fresh `snap` (e.g. from the home refresh) to reuse it; otherwise a
 * light snapshot is fetched so a just-synced run is included.
 */
export async function maybeAnalyzeLatestRun(opts: {
  snap?:    HealthSnapshot | null;
  months?:  number;
  notify?:  boolean;
  force?:   boolean;
  maxAgeH?: number;
} = {}): Promise<RunAnalysis | null> {
  if (analyzing && !opts.force) return null;
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  // Fresh snapshot so a just-synced run is present (cache may predate it).
  let snap = opts.snap ?? null;
  if (!snap) {
    try {
      snap = await fetchHealthSnapshot({ months: opts.months ?? 3, light: true });
      saveSnapshotCache(snap).catch(() => {});
    } catch {
      snap = await loadSnapshotCache();
    }
  }
  const run = snap?.runs?.[0];
  if (!snap || !run) return null;

  const existing = await loadLatestRunAnalysis();
  if (!opts.force && existing?.runUUID === run.uuid) {
    // Already analysed this run WITH a prescription → keep it.
    if (existing.hadPlan) return existing;
    // The cached analysis was made before today's plan existed (run beat the plan) → it
    // judged off recovery alone. Re-analyse only once a prescription is actually available.
    const planNow = await loadPrescriptionAt(run.date.slice(0, 10), new Date(run.date).getTime());
    if (!planNow) return existing;
    // else fall through and regenerate against the now-available prescription
  }

  // Only auto-analyse recently-finished runs (avoids back-filling old runs on first launch).
  // Re-analysing a run we already have (the prescription-less self-heal) is exempt.
  const ageH = (Date.now() - new Date(run.date).getTime()) / 3.6e6;
  const reanalysing = existing?.runUUID === run.uuid;
  if (!opts.force && !reanalysing && ageH > (opts.maxAgeH ?? 18)) return null;

  if (analyzing && !opts.force) return null;
  analyzing = true;
  try {
    const plan = await loadPrescriptionAt(run.date.slice(0, 10), new Date(run.date).getTime()).catch(() => null);
    const prevRuns = snap.runs.filter(r => r.uuid !== run.uuid && r.label === run.label).slice(0, 8);
    const analysis = await analyzeRun(snap, run, plan, prevRuns);
    await saveLatestRunAnalysis(analysis);
    if (opts.notify !== false) await notifyRunAnalyzed(analysis);
    return analysis;
  } finally {
    analyzing = false;
  }
}

async function notifyRunAnalyzed(a: RunAnalysis): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `🏃 Run analysed — ${a.verdict}`,
        body:  a.headline,
        data:  { screen: 'run-analysis', runUUID: a.runUUID, tag: 'run-analysis' },
      },
      trigger: null, // immediate
    });
  } catch { /* notifications not granted — the home card still surfaces it */ }
}
