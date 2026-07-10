/**
 * Coaching knowledge files. The coach's rules and references live in editable
 * markdown files (not a hardcoded prompt), so the athlete can tune them, add their
 * own (preferred strength exercises, pre-run drills, a structured schedule…), import
 * / export them, and have the LLM enhance them in place. Every enabled file is
 * concatenated into the coach's system prompt.
 *
 * Storage: one markdown file per entry under <docDir>/coach-knowledge/, plus an
 * index.json with metadata (title, enabled, order, builtin).
 */
import * as FileSystem from 'expo-file-system';
import { callLLM } from './llm';

export interface KnowledgeMeta {
  id:          string;
  title:       string;
  description: string;
  enabled:     boolean;
  builtin:     boolean;   // a seeded default — can edit/disable/reset, but not delete
  order:       number;
}

const DIR    = `${FileSystem.documentDirectory}coach-knowledge/`;
const INDEX  = `${DIR}index.json`;
const pathOf = (id: string) => `${DIR}${id}.md`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

async function readIndex(): Promise<KnowledgeMeta[]> {
  try {
    const info = await FileSystem.getInfoAsync(INDEX);
    if (!info.exists) return [];
    return JSON.parse(await FileSystem.readAsStringAsync(INDEX)) as KnowledgeMeta[];
  } catch { return []; }
}

async function writeIndex(list: KnowledgeMeta[]): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(INDEX, JSON.stringify(list, null, 2));
}

// ─── Default (builtin) knowledge ──────────────────────────────────────────────

const DEFAULT_RULES = `# Coaching Rules (authoritative)

You are a STRICT, injury-prevention-FIRST endurance-running coach. Prime directive:
keep the athlete healthy and uninjured. When signals are borderline or conflict,
ALWAYS choose the more conservative option — less intensity, less volume, lower strain.

## Readiness
Readiness is multi-factor, not recovery alone: weigh HRV vs baseline, resting HR vs
baseline, respiratory rate, SpO₂, sleep quality + sleep debt, form (TSB) and the
acute:chronic workload ratio (ACWR). Default to easy; allow hard/moderate only when
ALL signals are clearly green.

## Session sequencing (no sequential long runs)
- NEVER schedule sequential longer / quality sessions. Alternate strictly:
  Quality → Recovery → Quality.
- If the previous 1–2 days were a quality, hard, or long run, today MUST be a genuine
  recovery day (short + easy) or rest — never a second longer or higher-volume run
  back-to-back. Use yesterdayStrain / yesterdayTofMin / recentTimeOnFeet to judge this.
- Recovery days stay SHORT and easy. Never let an easy day creep into a longer Z2 run.

## Rolling volume cap (+10%)
- 7-day rolling time-on-feet must not increase more than 10% week-over-week.
- Today's running minutes must NOT exceed tofBudgetTodayMin. If it is ~0, prescribe
  rest or cross-training/strength only. Never exceed the cap to chase a session.

## Environment (temperature & humidity)
- Heat and humidity raise heart rate and perceived effort, so the SAME run causes more
  strain. Use the provided weather (tempC, apparentC, humidity) to estimate the
  environmental load.
- The combined strain of the run PLUS the warm-up drills must stay within the
  calculated advisable strain range, and must never exceed the range ceiling by more
  than 10%. In hot/humid conditions, shorten or ease the run to compensate.

## Strength & guards
- Include leg-strength / injury-prevention work in EVERY plan (see the strength and
  drills files). Even rest days get light mobility + activation.
- ACWR sweet spot 0.8–1.3; >1.4 is a spike → pull right back. Negative TSB = fatigue →
  easy/recovery only. HRV below baseline, elevated resting/respiratory rate, a real SpO₂
  desaturation (below ~92% — brief overnight dips to 92–95% are normal and don't count),
  or sleep debt → reduce load and watch for illness. Keep ≥48h between hard efforts.

## Output
"strain" is a 0–100 daily-load score. Recommend a CONSERVATIVE strainLow–strainHigh
target; prefer the lower half of the advisable band on any doubt. Produce the runner's
DAILY OUTLOOK as the OUTCOME of these rules applied to all the data.`;

const DEFAULT_STRENGTH = `# Preferred Strength Exercises

Pick 2–4 per plan, rotate, keep it leg/hip/foot focused for running durability:
- Eccentric calf raises / heel drops — 3×12 (straight + bent knee)
- Single-leg squats / pistol progressions — 3×8 per leg
- Step-downs (controlled) — 3×10 per leg
- Glute bridges / single-leg bridges — 3×12
- Clamshells & hip abduction — 2×15 per side
- Tibialis raises — 3×20
- Hamstring bridges / Nordic curls (assisted) — 3×6
- Copenhagen planks (adductors) — 2×20s per side

Notes: prioritise eccentric calf + hip work; quality over load; stop if sharp pain.`;

const DEFAULT_DRILLS = `# Pre-Run Drills (dynamic warm-up)

Do BEFORE every run (~8–10 min). These count toward today's strain budget:
- Leg swings (front/back, side/side) — 10 each
- Walking lunges with reach — 10
- A-skips — 2×20m
- High knees — 2×20m
- Butt kicks — 2×20m
- Ankle bounces / pogos — 2×15
- Strides (build-ups) — 4×15s AFTER easy jog, only on quality days

Cold conditions → extend the warm-up; hot conditions → shorten and hydrate first.`;

const DEFAULT_SCHEDULE = `# Preferred Weekly Structure

A flexible template — the daily readiness, the rolling volume cap, and re-entry after a break
always override this:
- Mon: Intervals (harder quality) — only if readiness allows
- Tue: Recovery run or rest
- Wed: Tempo run — only if readiness allows
- Thu: Recovery run or rest
- Fri: Long run
- Sat: Recovery run or rest
- Sun: Recovery run or rest

Never two quality/long days back-to-back. Keep ≥48h between hard sessions. After a week off
(holiday or illness) ignore the quality days and rebuild with easy Z2 runs gated by recovery.`;

const DEFAULT_PROFILE = `# Athlete Profile

Personal context for tailoring sessions (edit freely):

- HEAT-SENSITIVE: carries extra weight centrally (tummy/chest) and sweats heavily, so heat and humidity raise cardiovascular strain noticeably more than average. In warm/humid conditions apply the heat scaling firmly (lean to the conservative end of the range), shorten exposure, and assume a higher fluid/cooling need.
- ELEVATED RESTING AUTONOMIC LOAD: resting HR runs high and HRV-based "stress" reads high even at rest (e.g. ~83% sitting indoors with AC). So a high HR at a given effort partly reflects this baseline — not only fitness or fatigue. Don't over-restrict on a single high HR/stress reading; judge by trends.
- GOALS: build durable aerobic fitness while gradually reducing central weight. Favour sustainable, mostly-easy aerobic volume + leg strength; keep hard days genuinely hard but infrequent; avoid sessions that needlessly spike strain.`;

const DEFAULT_PRESCRIPTION_HISTORY = `# Prescription History

A running log of prescribed runs, newest first. \`✅ executed\` once the run is logged that
day, \`⬜ planned\` until then. Prune old entries freely — this is just a training record.
`;

const DEFAULT_TRAINING_MODEL = `# Training Model (how this app's numbers work — read before answering budget questions)

## Volume: the rolling time-on-feet (ToF) budget
- Every running minute is deducted from a ROLLING +cap% 7-day time-on-feet budget. The rule: the trailing 7-day ToF total must stay ≤ (1 + cap%) × the ToF total of the 7 days BEFORE that. When a run won't fit, it is deferred to a later day.
- ToF counts WORK minutes (the run's work + drills, excluding warm-up / cool-down / recovery jogs) under the default "work" accounting regime — not raw elapsed time. So a structured tempo counts its work block, not the whole session.
- CRITICAL — it is a SLIDING window RECOMPUTED EVERY DAY, not a fixed pool:
  - Today's "remaining ≤ X min" is ONLY today's allowance. It is NOT a shared allowance for the next few days.
  - Each day the ceiling moves (the "previous 7 days" that sets the cap slides forward) AND the oldest day rolls off the trailing window (which frees budget back up).
  - So NEVER answer a multi-day question by subtracting a future day's run from today's remaining (e.g. "89 minus Thursday minus Friday"). That double-counts and ignores roll-off — it is WRONG.
  - For "does today's/tomorrow's run eat into a later run's budget", read the 7-DAY PLAN (get_week_plan): it already forward-projects this rolling cap day by day, so if a later day shows a full-length run, it ALREADY fits. Also use get_plan_context's next-run projection (when the next meaningful run fits as days roll off).

## Load & readiness
- CTL = fitness (Banister EWMA, tau about 42d), ATL = fatigue (tau about 7d), TSB = CTL minus ATL = form. ACWR = ATL/CTL (safe about 0.8 to 1.3).
- Readiness is recovery-anchored (HRV/RHR/sleep/resp/SpO2) and gates quality: green (>=60) allows a full session; below that it is eased to easy. Daily STRAIN is a TRIMP-based % kept inside an advisable band set by recovery + form.

## Prescription rules
- COMPLETION-AWARE: once today's prescribed session is done, no 2nd run is prescribed — recover. A 2nd run only ever completes a genuinely cut-short session, and only if every cap/TSB/heat/recovery gate still has room; it is always easy, never a 2nd quality session.
- Long runs may be delivered as two easy-Z2 parts (heat / injury / leisure). Heat trims prescribed minutes.

## Always ground answers in live data
Use get_plan_context for today's plan + the live ToF budget + load/readiness; get_week_plan for the forward schedule; get_prescription_history for adherence. Cite the real numbers — never invent or hand-derive a budget.`;

interface DefaultDef { id: string; title: string; description: string; content: string; }
const DEFAULTS: DefaultDef[] = [
  { id: 'athlete-profile',   title: 'Athlete Profile',       description: 'Personal physiology + goals the coach should tailor to', content: DEFAULT_PROFILE },
  { id: 'coaching-rules',    title: 'Coaching Rules',        description: 'Core injury-first rules the coach must follow', content: DEFAULT_RULES },
  { id: 'training-model',    title: 'Training Model',        description: 'How the ToF budget (rolling window) + load/readiness model work — so the coach answers budget questions correctly', content: DEFAULT_TRAINING_MODEL },
  { id: 'strength-exercises', title: 'Strength Exercises',   description: 'Preferred leg/hip/foot strength work',         content: DEFAULT_STRENGTH },
  { id: 'pre-run-drills',    title: 'Pre-Run Drills',        description: 'Dynamic warm-up drills before every run',      content: DEFAULT_DRILLS },
  { id: 'running-schedule',  title: 'Weekly Schedule',       description: 'Preferred structured running week',            content: DEFAULT_SCHEDULE },
  { id: 'prescription-history', title: 'Prescription History', description: 'Log of prescribed runs + whether they were executed', content: DEFAULT_PRESCRIPTION_HISTORY },
];

const HISTORY_ID  = 'prescription-history';
const HISTORY_CAP = 90;                                 // keep the last N entries (user prunes too)
const isEntry = (l: string) => l.startsWith('- 2');     // entry lines start with "- YYYY-…"

// Upsert today's prescription into the history log (newest first). Preserves an existing
// ✅ executed mark, so re-generating a plan the same day doesn't wipe the "done" status.
export async function recordPrescription(date: string, structure: string): Promise<void> {
  try {
    await seed();
    const raw    = (await readKnowledgeContent(HISTORY_ID)) || DEFAULT_PRESCRIPTION_HISTORY;
    const lines  = raw.split('\n');
    const detail = structure?.trim() || 'rest';
    const at     = lines.findIndex(l => l.startsWith(`- ${date} `));
    if (at >= 0) {
      // Don't let a same-day "rest" downgrade erase a real run already logged for the day. The
      // completion-aware plan flips to "session done → recover" (a rest plan) AFTER the run, and saving
      // that must NOT clobber the morning's long/quality prescription in this human-readable history.
      const existingIsRest = lines[at].startsWith(`- ${date} · rest · `);
      if (detail === 'rest' && !existingIsRest) return;
      const done = lines[at].includes('✅');
      lines[at]  = `- ${date} · ${detail} · ${done ? '✅ executed' : '⬜ planned'}`;
    } else {
      const first = lines.findIndex(isEntry);
      lines.splice(first >= 0 ? first : lines.length, 0, `- ${date} · ${detail} · ⬜ planned`);
    }
    let n = 0;
    const capped = lines.filter(l => !isEntry(l) || ++n <= HISTORY_CAP);
    await writeKnowledgeContent(HISTORY_ID, capped.join('\n'));
  } catch { /* ignore */ }
}

// Flip a day's entry to ✅ once the prescribed run is logged.
export async function markPrescriptionExecuted(date: string): Promise<void> {
  try {
    const raw = await readKnowledgeContent(HISTORY_ID);
    if (!raw) return;
    const lines = raw.split('\n');
    const at = lines.findIndex(l => l.startsWith(`- ${date} `));
    if (at < 0 || lines[at].includes('✅')) return;
    lines[at] = lines[at].replace('⬜ planned', '✅ executed');
    await writeKnowledgeContent(HISTORY_ID, lines.join('\n'));
  } catch { /* ignore */ }
}

const defaultContent = (id: string) => DEFAULTS.find(d => d.id === id)?.content ?? '';
export const isBuiltinId = (id: string) => DEFAULTS.some(d => d.id === id);

async function seed(): Promise<void> {
  await ensureDir();
  const idx = await readIndex();
  if (idx.length === 0) {
    for (const d of DEFAULTS) await FileSystem.writeAsStringAsync(pathOf(d.id), d.content);
    await writeIndex(DEFAULTS.map((d, i) => ({
      id: d.id, title: d.title, description: d.description, enabled: true, builtin: true, order: i,
    })));
    return;
  }
  // Migration: add any builtin introduced after this install was first seeded, WITHOUT
  // touching the user's existing (possibly edited) files or their order.
  const have = new Set(idx.map(m => m.id));
  let nextOrder = idx.length ? Math.max(...idx.map(m => m.order)) + 1 : 0;
  let added = false;
  for (const d of DEFAULTS) {
    if (have.has(d.id)) continue;
    await FileSystem.writeAsStringAsync(pathOf(d.id), d.content);
    idx.push({ id: d.id, title: d.title, description: d.description, enabled: true, builtin: true, order: nextOrder++ });
    added = true;
  }
  if (added) await writeIndex(idx);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listKnowledge(): Promise<KnowledgeMeta[]> {
  await seed();
  return (await readIndex()).sort((a, b) => a.order - b.order);
}

export async function readKnowledgeContent(id: string): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(pathOf(id));
    if (!info.exists) return '';
    return await FileSystem.readAsStringAsync(pathOf(id));
  } catch { return ''; }
}

export async function writeKnowledgeContent(id: string, content: string): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(pathOf(id), content);
}

export async function setKnowledgeEnabled(id: string, enabled: boolean): Promise<void> {
  const idx = await readIndex();
  const m = idx.find(x => x.id === id);
  if (m) { m.enabled = enabled; await writeIndex(idx); }
}

export async function createKnowledge(title: string, description: string, content = ''): Promise<KnowledgeMeta> {
  const idx = await readIndex();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'note';
  const id = `${slug}-${Date.now().toString(36)}`;
  const meta: KnowledgeMeta = {
    id, title: title || 'Untitled', description, enabled: true, builtin: false,
    order: idx.length ? Math.max(...idx.map(m => m.order)) + 1 : 0,
  };
  await writeKnowledgeContent(id, content);
  await writeIndex([...idx, meta]);
  return meta;
}

export async function renameKnowledge(id: string, title: string, description: string): Promise<void> {
  const idx = await readIndex();
  const m = idx.find(x => x.id === id);
  if (m) { m.title = title; m.description = description; await writeIndex(idx); }
}

export async function deleteKnowledge(id: string): Promise<void> {
  if (isBuiltinId(id)) return; // builtins can be disabled, not deleted
  const idx = await readIndex();
  await writeIndex(idx.filter(m => m.id !== id));
  try { await FileSystem.deleteAsync(pathOf(id), { idempotent: true }); } catch { /* ignore */ }
}

/** Create-or-update a knowledge file with a fixed id (e.g. the singleton zones file). */
export async function upsertKnowledge(id: string, title: string, description: string, content: string): Promise<void> {
  await ensureDir();
  await writeKnowledgeContent(id, content);
  const idx = await readIndex();
  const m = idx.find(x => x.id === id);
  if (m) { if (!m.title) m.title = title; if (!m.description) m.description = description; }
  else idx.push({ id, title, description, enabled: true, builtin: false, order: idx.length ? Math.max(...idx.map(k => k.order)) + 1 : 0 });
  await writeIndex(idx);
}

export async function knowledgeExists(id: string): Promise<boolean> {
  return (await readIndex()).some(m => m.id === id);
}

/** Restore a builtin file to its shipped default content. */
export async function resetKnowledge(id: string): Promise<string> {
  const content = defaultContent(id);
  if (content) await writeKnowledgeContent(id, content);
  return content;
}

/** Concatenate every ENABLED file into the coach's knowledge block. */
export async function buildKnowledgePrompt(): Promise<string> {
  const list = (await listKnowledge()).filter(m => m.enabled);
  const parts: string[] = [];
  for (const m of list) {
    const content = (await readKnowledgeContent(m.id)).trim();
    if (content) parts.push(content);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Ask the LLM to improve/expand a knowledge file. NON-DESTRUCTIVE: returns the
 * proposed text only — it does NOT write to disk. The caller shows it for review and
 * the user must explicitly Save to keep it, so a file is never overwritten by the AI.
 */
export async function enhanceKnowledge(id: string, instruction?: string): Promise<string> {
  const list = await listKnowledge();
  const meta = list.find(m => m.id === id);
  const current = await readKnowledgeContent(id);
  const system =
    `You maintain a running coach's knowledge file titled "${meta?.title ?? id}". ` +
    `Improve and expand it: practical, concise, well-structured markdown, injury-prevention oriented. ` +
    `Preserve the athlete's intent and any specific numbers/exercises they listed. ` +
    `Return ONLY the improved file content — no preamble, no code fences.`;
  const user =
    `Current content:\n"""\n${current}\n"""\n\n` +
    (instruction
      ? `Apply this instruction: ${instruction}`
      : `Refine, deduplicate and add clearly useful, widely-accepted specifics. Keep it focused.`);
  const out = (await callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 1400 })).trim();
  return out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

// ─── Whole-bundle export/import (used by the global settings backup) ───────────

export interface KnowledgeBundle { meta: KnowledgeMeta[]; contents: Record<string, string>; }

export async function exportKnowledgeBundle(): Promise<KnowledgeBundle> {
  const meta = await listKnowledge();
  const contents: Record<string, string> = {};
  for (const m of meta) contents[m.id] = await readKnowledgeContent(m.id);
  return { meta, contents };
}

export async function importKnowledgeBundle(bundle: KnowledgeBundle): Promise<number> {
  if (!bundle?.meta) return 0;
  await ensureDir();
  let n = 0;
  for (const m of bundle.meta) {
    await FileSystem.writeAsStringAsync(pathOf(m.id), bundle.contents?.[m.id] ?? '');
    n++;
  }
  await writeIndex(bundle.meta);
  return n;
}
