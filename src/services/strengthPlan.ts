/**
 * STRENGTH AUTO-PLAN — the coach plans strength around the runs, a week ahead (Geert, 2026-10-08: "AI-fuelled,
 * fully context-aware strength routine pusher, running every day as part of the daily run coach… plan a week ahead,
 * as the runs"). Decisions: TAILOR his saved routines (Push / Pull / Legs / Upper / Runner Strength — progression
 * history stays continuous), ADAPTIVE frequency (2–4 sessions per 7 days).
 *
 *  1. DETERMINISTIC planner (always, keyless): reads today's coach plan (readiness, run) + the cached 7-day run plan
 *     + the strength history, picks the frequency, then places routines greedily under HARD rules:
 *       · leg-dominant work never the day before intervals / tempo / a long run, nor on a long-run day; best on the
 *         same day as a quality run (after it — "hard days hard") or before a rest day;
 *       · muscles rest by the RPE of the session that trained them (≤ 5 → 1 day, 6–7 → 2, ≥ 8 → 3, +1 if graded hard);
 *       · today: readiness < 20 → no lifting; 20–34 → at most a LIGHT upper session (extra); 35–49 → upper only, −1 set;
 *       · one session a day; sessions spread (no back-to-back unless 4/week).
 *     Then TAILORS each day: weights from the 3-stable-sessions progression (suggestWeight), −1 set on a low-readiness
 *     day, −1 set on leg moves with a run the next day. Short runner prehab on suitable non-lifting days.
 *  2. AI refinement (when an LLM key works): the model sees the same context + the draft and may re-pick routines /
 *     days, nudge sets ±1 and swap to a routine's own alternatives, with a "why" per day. Every AI choice is
 *     re-validated against the hard rules; an invalid day falls back to the draft.
 *
 * The plan lives in the strength store (autoPlan), so routinesForDate(), the watch push, the session screen, Fitness,
 * the Daily Coach card, the 7-day plan and the calendar all follow it. Regenerated when its inputs change (new day,
 * new coach/run plan, a logged session, readiness); the watch gets the result.
 */
import {
  loadStrength, updateStrength, StrengthStore, Routine, RoutineItem, Muscle, exerciseById, suggestWeight, estimateMinutes,
  localDateKey, isWorkSet, PlannedStrengthDay, StrengthSession, StrengthAutoPlan, WEEKDAYS, muscleEvents, muscleFreshness, MUSCLE_LABEL,
} from './strength';

const LEGS: Muscle[] = ['quads', 'glutes', 'hamstrings', 'calves', 'adductors'];
const QUALITY = new Set(['intervals', 'tempo', 'hard', 'race']);
const PREHAB_IDS = ['heel_drop', 'glute_bridge', 'clamshell', 'side_plank'];
const PREHAB_ROUTINE = 'runner_strength';
const MAX_PREHAB = 3;
const LEG_SHARE = 0.4;          // routine is "legs" when ≥ 40 % of its set-weighted involvement is legs
const MIN_GAP_DAYS = 2;         // a PLANNED session's muscles: ≥ 48 h (assumed RPE ~7) before the same muscles again
const NO_LIFT_READY = 20;       // readiness below this → no lifting today at all
const LIGHT_READY = 35;         // below this → only a LIGHT upper session today (−1 set, stop ~3 reps short, RPE ≤ 6)
/**
 * Recovery days a logged session's muscles need, from its RPE (Geert 2026-10-08: "take into account the RPE of the
 * previous strength trainings — my arms/chest are not that bad"): RPE ≤ 5 → 1 day, 6–7 → 2, ≥ 8 → 3; unknown → 2;
 * an exercise graded 'hard' adds a day for its muscles.
 */
const gapForRpe = (rpe?: number) => (rpe == null ? 2 : rpe <= 5 ? 1 : rpe <= 7 ? 2 : 3);
interface Trained { date: string; gap: number; rpe?: number }

interface RunDay { date: string; kind: string; runMin: number; commitment?: string; label: string }
interface Profile { primaries: Muscle[]; legShare: number }

const addDays = (key: string, n: number) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateKey(d); };
const dayDiff = (a: string, b: string) => Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000);
const wd = (key: string) => WEEKDAYS[new Date(key + 'T12:00:00').getDay()];

function profile(st: StrengthStore, r: Routine): Profile {
  const sum: Partial<Record<Muscle, number>> = {};
  for (const it of r.items) {
    const ex = exerciseById(st, it.exerciseId);
    for (const [m, v] of Object.entries(ex?.muscles ?? {})) sum[m as Muscle] = (sum[m as Muscle] ?? 0) + (v as number) * it.sets;
  }
  const tot = Object.values(sum).reduce((a, v) => a + (v ?? 0), 0) || 1;
  const leg = LEGS.reduce((a, m) => a + (sum[m] ?? 0), 0);
  const primaries = (Object.keys(sum) as Muscle[]).filter(m => (sum[m] ?? 0) / tot >= 0.1);
  return { primaries, legShare: leg / tot };
}
const itemIsLeg = (st: StrengthStore, it: RoutineItem) => {
  const m = exerciseById(st, it.exerciseId)?.muscles ?? {};
  const tot = Object.values(m).reduce((a, v) => a + (v ?? 0), 0) || 1;
  return LEGS.reduce((a, k) => a + (m[k] ?? 0), 0) / tot >= 0.5;
};

/** Last date each muscle took real work (≥ 0.6 involvement on a work set) in the last 14 days. */
function muscleLastTrained(st: StrengthStore, today: string): Partial<Record<Muscle, Trained>> {
  const out: Partial<Record<Muscle, Trained>> = {};
  const since = addDays(today, -14);
  for (const x of st.sessions) {
    if (!x.finishedAt || x.date < since) continue;
    const base = gapForRpe(x.rpe);
    for (const l of x.sets) {
      if (!isWorkSet(l)) continue;
      const gap = Math.min(3, base + (x.feel?.[l.exerciseId] === 'hard' ? 1 : 0));
      for (const [m, v] of Object.entries(exerciseById(st, l.exerciseId)?.muscles ?? {})) {
        if ((v as number) < 0.6) continue;
        const cur = out[m as Muscle];
        // the binding one = the latest "free again" date (date + gap)
        if (!cur || addDays(x.date, gap) > addDays(cur.date, cur.gap)) out[m as Muscle] = { date: x.date, gap, ...(x.rpe ? { rpe: x.rpe } : {}) };
      }
    }
  }
  return out;
}

interface Ctx {
  st: StrengthStore; today: string; days: RunDay[]; readiness?: number; avgReady?: number;
  routines: Routine[]; prof: Map<string, Profile>; lastDone: Map<string, string>; hourNow: number;
  lightDays?: Set<number>;        // days holding a LIGHT session (low-readiness today) → only a 1-day gap around them
}

/** Hard rules — shared by the deterministic placer and the AI validator. Returns a reason when NOT allowed. */
function blocked(c: Ctx, i: number, r: Routine, placed: Map<number, string>, trained: Partial<Record<Muscle, Trained>>, light = false): string | null {
  const day = c.days[i], next = c.days[i + 1];
  const p = c.prof.get(r.id)!;
  const legs = p.legShare >= LEG_SHARE;
  if (placed.has(i)) return 'one session a day';
  if (i === 0) {
    if (c.readiness != null && c.readiness < NO_LIFT_READY) return `readiness ${c.readiness}`;
    if (c.readiness != null && c.readiness < LIGHT_READY && !light) return `readiness ${c.readiness}: light session only`;
    if (c.readiness != null && c.readiness < 50 && legs) return `readiness ${c.readiness}: no leg day`;
    if (c.hourNow >= 21) return 'too late today';
  }
  if (legs) {
    if (day.kind === 'long') return 'long-run day';
    if (next && (QUALITY.has(next.kind) || next.kind === 'long')) return `${next.label} tomorrow`;
  }
  for (const m of p.primaries) {
    const last = trained[m];
    const since = last ? dayDiff(last.date, day.date) : 99;
    if (last && since >= 0 && since < last.gap) return `${MUSCLE_LABEL[m].toLowerCase()} trained ${since === 0 ? 'that day' : `${since} day${since > 1 ? 's' : ''} before`}${last.rpe ? ` at RPE ${last.rpe}` : ''} — needs ${last.gap} day${last.gap > 1 ? 's' : ''}`;
    // a planned session elsewhere in the week (placement isn't chronological): 48 h either side; a LIGHT one 24 h
    for (const [j, id] of placed) {
      if (j === i) continue;
      const need = light || c.lightDays?.has(j) ? 1 : MIN_GAP_DAYS;
      if (Math.abs(j - i) < need && c.prof.get(id)?.primaries.includes(m)) return `${MUSCLE_LABEL[m].toLowerCase()} also on ${wd(c.days[j].date)}`;
    }
  }
  if (!light && c.routines.length >= 3 && [...placed.values()].includes(r.id)) return 'already planned this week';
  return null;
}

function score(c: Ctx, i: number, r: Routine, placed: Map<number, string>): number {
  const day = c.days[i], next = c.days[i + 1];
  const legs = c.prof.get(r.id)!.legShare >= LEG_SHARE;
  const last = [...placed].filter(([, id]) => id === r.id).map(([j]) => c.days[j].date).concat(c.lastDone.get(r.id) ?? []).sort().pop();
  let sc = last ? Math.min(10, Math.abs(dayDiff(last, day.date))) : 7;           // the most "due" routine first
  if (r.id === PREHAB_ROUTINE) sc -= 2;                                             // the full runner session is the extra, not the backbone
  if (legs) {
    if (QUALITY.has(day.kind)) sc += 3;                                             // hard day hard: legs after the quality run
    if (!next || next.kind === 'rest') sc += 2;
    else if (next.runMin > 0) sc -= 2;
    const after = c.days[i + 2];
    if (after && (QUALITY.has(after.kind) || after.kind === 'long')) sc -= 2;      // still sore 48 h later
  } else {
    if (day.kind === 'rest' || day.kind === 'easy') sc += 1;
    if (day.kind === 'long') sc -= 1;
  }
  if (day.commitment) sc -= 1;
  const near = [...placed.keys()].some(j => Math.abs(j - i) === 1);
  if (near) sc -= placed.size + 1 >= 4 ? 0.5 : 2;
  if (i === 0) sc += c.readiness != null && c.readiness >= 50 ? 0.5 : -1;
  sc -= i * 0.05;                                                                   // tie-break: sooner
  return sc;
}

function adaptiveTarget(c: Ctx, prevWeekRunMin: number): { target: number; why: string } {
  let t = 3;
  const why: string[] = [];
  const runWeek = c.days.reduce((a, d) => a + d.runMin, 0);
  if (c.avgReady != null && c.avgReady < 45) { t--; why.push(`recovery averaged ${Math.round(c.avgReady)} this week`); }
  if (prevWeekRunMin > 0 && runWeek > prevWeekRunMin * 1.15) { t--; why.push(`run volume up ${Math.round((runWeek / prevWeekRunMin - 1) * 100)}%`); }
  const done14 = c.st.sessions.filter(x => x.finishedAt && x.tailored !== 'prehab' && x.date >= addDays(c.today, -14)).length;
  const hardRecently = c.st.sessions.filter(x => x.finishedAt).slice(-3).some(x => Object.values(x.feel ?? {}).includes('hard'));
  if (t === 3 && (c.avgReady ?? 0) >= 65 && done14 >= 5 && !hardRecently && runWeek <= prevWeekRunMin * 1.05) { t = 4; why.push('recovery good, lifting consistent, runs steady'); }
  t = Math.max(2, Math.min(4, t));
  return { target: t, why: why.length ? why.join(' · ') : 'standard: 3 sessions alongside the runs' };
}

function tailor(c: Ctx, i: number, r: Routine, kind: 'session' | 'prehab'): { items: RoutineItem[]; changes: string[] } {
  const changes: string[] = [];
  let items: RoutineItem[] = r.items.map(it => ({ ...it, weightKg: suggestWeight(c.st, it).kg ?? it.weightKg }));
  if (kind === 'prehab') {
    items = items.filter(it => PREHAB_IDS.includes(it.exerciseId)).map(it => ({ ...it, sets: Math.min(it.sets, 2) }));
    return { items, changes: ['short: 2 sets of the calf / hip moves'] };
  }
  if (i === 0 && c.readiness != null && c.readiness < 50) {
    items = items.map(it => ({ ...it, sets: it.sets > 2 ? it.sets - 1 : it.sets }));
    changes.push(c.readiness < LIGHT_READY ? `light: −1 set each, stop ~3 reps short (RPE ≤ 6) — readiness ${c.readiness}` : `−1 set each: readiness ${c.readiness}`);
  }
  const next = c.days[i + 1];
  if (next && next.runMin > 0 && c.prof.get(r.id)!.legShare >= 0.2) {
    let n = 0;
    items = items.map(it => (itemIsLeg(c.st, it) && it.sets > 2 ? (n++, { ...it, sets: it.sets - 1 }) : it));
    if (n) changes.push(`−1 set on ${n} leg move${n > 1 ? 's' : ''}: run tomorrow`);
  }
  return { items, changes };
}

function whyFor(c: Ctx, i: number, r: Routine, legs: boolean): string {
  const day = c.days[i], next = c.days[i + 1];
  const last = c.lastDone.get(r.id);
  const due = last ? `last done ${Math.abs(dayDiff(last, day.date))} days before` : 'not done recently';
  if (legs) {
    if (QUALITY.has(day.kind)) return `Legs on the ${day.label.toLowerCase()} day — after the run, so the easy days stay easy (${due}).`;
    if (!next || next.kind === 'rest') return `Legs before a rest day — fresh again for the next quality run (${due}).`;
    return `Legs with no hard run within the next day (${due}).`;
  }
  const when = day.kind === 'rest' ? 'Rest day from running' : day.kind === 'long' ? 'After the long run' : QUALITY.has(day.kind) ? `After the ${day.label.toLowerCase()}` : day.runMin ? 'Easy-run day' : 'Free day';
  return `${when} — upper body doesn't tax the running legs (${due}).`;
}

function runLabel(kind: string, min: number): string {
  if (kind === 'rest' || !min) return 'Rest';
  const k = kind === 'long' ? 'Long run' : kind === 'intervals' ? 'Intervals' : kind === 'tempo' ? 'Tempo' : kind === 'hard' ? 'Hard run' : 'Easy run';
  return `${k} ${Math.round(min)} min`;
}

/**
 * Prehab (eccentric heel drops, bridges, clamshells, side plank) is light but not nothing: not on / the day before a
 * quality or long run, not next to a planned leg session (48 h), not today when it's late.
 */
function prehabOk(c: Ctx, i: number, placed: Map<number, string>): boolean {
  const day = c.days[i], next = c.days[i + 1];
  if (QUALITY.has(day.kind) || day.kind === 'long') return false;
  if (next && (QUALITY.has(next.kind) || next.kind === 'long')) return false;
  if (i === 0 && c.hourNow >= 21) return false;
  for (const [j, id] of placed) if (Math.abs(j - i) <= 1 && (c.prof.get(id)?.legShare ?? 0) >= LEG_SHARE) return false;
  return true;
}

/** Deterministic 7-day plan. */
function draftPlan(c: Ctx, target: number): PlannedStrengthDay[] {
  const trained = muscleLastTrained(c.st, c.today);
  const placed = new Map<number, string>();
  const out: (PlannedStrengthDay | null)[] = c.days.map(() => null);
  // today already lifted → that IS today's session (counts toward the target)
  const doneToday = c.st.sessions.filter(x => x.finishedAt && x.date === c.today && x.tailored !== 'prehab');
  const prehabToday = c.st.sessions.some(x => x.finishedAt && x.date === c.today && x.tailored === 'prehab');
  if (doneToday.length) {
    const x = doneToday[doneToday.length - 1];
    placed.set(0, x.routineId);
    out[0] = { date: c.today, kind: 'session', routineId: x.routineId, name: x.routineName, done: true, why: 'Done today ✅', run: c.days[0].label };
  }
  const pool = c.routines;
  // LOW readiness today (20–34): the whole body isn't ready for a full session, but muscles that recovered (by their
  // last session's RPE) can still take a LIGHT upper session — an extra on top of the week's target, not instead of it
  let extra = 0;
  // (also at 35–49: a below-par day gets a lighter upper session today rather than nothing — at 26 it did, at 45 it didn't)
  if (!placed.has(0) && c.readiness != null && c.readiness >= NO_LIFT_READY && c.readiness < 50 && c.hourNow < 21 && !QUALITY.has(c.days[0].kind)) {
    c.lightDays = new Set([0]);
    let best: { r: Routine; sc: number } | null = null;
    for (const r of pool) {
      if (r.id === PREHAB_ROUTINE || blocked(c, 0, r, placed, trained, true)) continue;
      const sc = score(c, 0, r, placed);
      if (!best || sc > best.sc) best = { r, sc };
    }
    if (best) {
      placed.set(0, best.r.id); extra = 1;
      const t = tailor(c, 0, best.r, 'session');
      const fresh = c.prof.get(best.r.id)!.primaries.map(m => trained[m]).filter((x): x is Trained => !!x && x.date !== c.today);
      const rpeNote = fresh.length ? ` — its muscles have had their recovery (last trained at RPE ${Math.max(...fresh.map(f => f.rpe ?? 7))})` : '';
      out[0] = { date: c.today, kind: 'session', routineId: best.r.id, name: best.r.name, items: t.items, changes: t.changes,
        minutes: estimateMinutes({ ...best.r, items: t.items }), why: `${c.readiness < LIGHT_READY ? 'Light session only' : 'Lighter session'}: readiness ${c.readiness}${rpeNote}. ${c.readiness < LIGHT_READY ? 'Keep every set ~3 reps short of failure; skip it if you feel worse once warm.' : 'One set fewer each; stop if the warm-up feels heavy.'}`, run: c.days[0].label };
    } else c.lightDays = undefined;
  }
  while (placed.size - extra < target) {
    let best: { i: number; r: Routine; sc: number } | null = null;
    for (let i = 0; i < c.days.length; i++) for (const r of pool) {
      if (blocked(c, i, r, placed, trained)) continue;
      const sc = score(c, i, r, placed);
      if (!best || sc > best.sc) best = { i, r, sc };
    }
    if (!best) break;
    placed.set(best.i, best.r.id);
    const legs = c.prof.get(best.r.id)!.legShare >= LEG_SHARE;
    const t = tailor(c, best.i, best.r, 'session');
    out[best.i] = { date: c.days[best.i].date, kind: 'session', routineId: best.r.id, name: best.r.name, items: t.items, changes: t.changes,
      minutes: estimateMinutes({ ...best.r, items: t.items }), why: whyFor(c, best.i, best.r, legs), run: c.days[best.i].label };
  }
  // prehab on suitable non-lifting days (not quality days; not today when readiness < 35)
  const prehabBase = c.st.routines.find(r => r.id === PREHAB_ROUTINE && r.items.some(it => PREHAB_IDS.includes(it.exerciseId)));
  let nPre = 0;
  return out.map((d, i) => {
    if (d) return d;
    const day = c.days[i];
    const noLiftWhy = i === 0 && c.readiness != null && c.readiness < NO_LIFT_READY
      ? `No lifting — readiness ${c.readiness}. Rest; the plan moves strength to a fresher day.`
      : i === 0 && c.readiness != null && c.readiness < LIGHT_READY
      ? `No lifting today — readiness ${c.readiness}, and the muscles of every routine still need recovery from their last session.`
      : null;
    if (i === 0 && prehabToday) return { date: day.date, kind: 'prehab', routineId: prehabBase?.id, name: 'Runner prehab', done: true, why: 'Done today ✅', run: day.label };
    if (!noLiftWhy && prehabBase && nPre < MAX_PREHAB && prehabOk(c, i, placed)) {
      nPre++;
      const t = tailor(c, i, prehabBase, 'prehab');
      return { date: day.date, kind: 'prehab', routineId: prehabBase.id, name: 'Runner prehab', items: t.items, changes: t.changes,
        minutes: estimateMinutes({ ...prehabBase, items: t.items }), why: 'Optional ~10 min: calves, hips, core — runner durability, no soreness.', run: day.label };
    }
    return { date: day.date, kind: 'rest', why: noLiftWhy ?? (QUALITY.has(day.kind) ? `${day.label} — keep the legs for it.` : 'No lifting planned.'), run: day.label };
  });
}

// ── context ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function buildContext(st: StrengthStore): Promise<{ c: Ctx; prevWeekRunMin: number; sigParts: string[] }> {
  const coach = require('./coach') as typeof import('./coach');       // lazy: coach.ts is large and imports healthkit
  const hk = require('./healthkit') as typeof import('./healthkit');
  const today = localDateKey();
  const plan = await coach.loadCachedPlan(today).catch(() => null);
  // the run plan for tomorrow → +6: the newest cached 7-day plan covering each date
  const caches: Awaited<ReturnType<typeof coach.loadWeekPlanCache>>[] = [];
  for (let back = 0; back <= 7; back++) caches.push(await coach.loadWeekPlanCache(addDays(today, -back)).catch(() => null));
  const days: RunDay[] = [];
  const todayKind = !plan ? 'easy' : plan.intensity === 'rest' ? 'rest' : (plan.sessionKind === 'recovery' ? 'easy' : plan.sessionKind ?? (plan.intensity === 'hard' ? 'hard' : 'easy'));
  days.push({ date: today, kind: todayKind, runMin: plan?.runMinutes ?? 0, label: runLabel(todayKind, plan?.runMinutes ?? 0) });
  for (let k = 1; k <= 6; k++) {
    const date = addDays(today, k);
    const slot = caches.map(cc => cc?.days.find(d => d.date === date)).find(Boolean);
    const kind = !slot ? 'easy' : slot.intensity === 'rest' || !slot.runMinutes ? 'rest' : slot.kind ?? (slot.intensity === 'hard' ? 'hard' : 'easy');
    days.push({ date, kind, runMin: slot?.runMinutes ?? 0, ...(slot?.commitment ? { commitment: slot.commitment } : {}), label: slot ? runLabel(kind, slot.runMinutes) : 'Run plan not made yet' });
  }
  // readiness: today's + the week's average (from the cached daily plans)
  const ready: number[] = [];
  for (let back = 0; back < 7; back++) { const p = back === 0 ? plan : await coach.loadCachedPlan(addDays(today, -back)).catch(() => null); if (p?.genReadiness != null) ready.push(p.genReadiness); }
  const snap = await hk.loadSnapshotCache().catch(() => null);
  const since28 = addDays(today, -28);
  const prevWeekRunMin = ((snap?.runs ?? []) as { date: string; duration: number }[])
    .filter(r => localDateKey(new Date(r.date)) >= since28 && localDateKey(new Date(r.date)) < today).reduce((a, r) => a + r.duration / 60, 0) / 4;
  const routines = st.routines.filter(r => r.items.length);
  const prof = new Map(routines.map(r => [r.id, profile(st, r)]));
  const lastDone = new Map<string, string>();
  for (const x of st.sessions) if (x.finishedAt && x.tailored !== 'prehab' && (!lastDone.get(x.routineId) || lastDone.get(x.routineId)! < x.date)) lastDone.set(x.routineId, x.date);
  const c: Ctx = { st, today, days, readiness: plan?.genReadiness, avgReady: ready.length ? ready.reduce((a, v) => a + v, 0) / ready.length : undefined,
    routines, prof, lastDone, hourNow: new Date().getHours() };
  const sigParts = [today, plan?.generatedAt ?? '-', caches[0]?.generatedAt ?? caches.find(Boolean)?.generatedAt ?? '-',
    String(st.sessions.filter(x => x.finishedAt).length), String(Math.max(0, ...st.routines.map(r => r.updatedAt ?? 0))), c.hourNow >= 21 ? 'late' : 'day'];
  return { c, prevWeekRunMin, sigParts };
}

// ── AI refinement ─────────────────────────────────────────────────────────────────────────────────────────────────
async function aiRefine(c: Ctx, draft: PlannedStrengthDay[], target: number, targetWhy: string, maxHr: number): Promise<{ days: PlannedStrengthDay[]; target: number; summary?: string } | null> {
  const { callLLM, getLLMStatus, extractJsonObject, setUsageFeature } = require('./llm') as typeof import('./llm');
  const status = await getLLMStatus().catch(() => ({ hasKey: false, reachable: false }));
  if (!status.hasKey || !status.reachable) return null;
  const hk = require('./healthkit') as typeof import('./healthkit');
  const snap = await hk.loadSnapshotCache().catch(() => null);
  const fresh = muscleFreshness(muscleEvents(c.st, ((snap?.runs ?? []) as any[]), maxHr))
    .filter(f => f.state === 'Fatigued' || f.state === 'Depleted').map(f => `${MUSCLE_LABEL[f.muscle]} ${f.state.toLowerCase()} (${f.pct}%)`);
  const recent = c.st.sessions.filter(x => x.finishedAt && x.date >= addDays(c.today, -21)).slice(-8).map(x => ({
    date: x.date, routine: x.routineName, rpe: x.rpe, hard: Object.entries(x.feel ?? {}).filter(([, f]) => f === 'hard').map(([id]) => exerciseById(c.st, id)?.name ?? id),
  }));
  const input = {
    today: c.today, readinessToday: c.readiness ?? null, readinessWeekAvg: c.avgReady != null ? Math.round(c.avgReady) : null,
    runPlan: c.days.map(d => ({ date: d.date, weekday: wd(d.date), run: d.label, kind: d.kind, ...(d.commitment ? { commitment: d.commitment } : {}) })),
    fatiguedMuscles: fresh, recentSessions: recent,
    routines: c.routines.map(r => ({ id: r.id, name: r.name, legDominant: (c.prof.get(r.id)?.legShare ?? 0) >= LEG_SHARE, lastDone: c.lastDone.get(r.id) ?? null,
      exercises: r.items.map(it => ({ id: it.exerciseId, name: exerciseById(c.st, it.exerciseId)?.name ?? it.exerciseId, sets: it.sets, reps: `${it.repsLo}-${it.repsHi}`, ...(it.altIds?.length ? { alternatives: it.altIds } : {}) })) })),
    draftTarget: target, draftTargetWhy: targetWhy,
    draft: draft.map(d => ({ date: d.date, kind: d.kind, routineId: d.routineId ?? null, done: !!d.done, why: d.why })),
  };
  const system = `You are the strength coach inside a running-coach app. The athlete is a runner (the run plan is FIXED; strength fits around it) who lifts with his own saved routines. Plan the next 7 days of strength (today first).
Rules (hard — a violation is discarded):
- Use ONLY the given routine ids. kind "session" = a full routine; "prehab" = the short runner prehab (routineId "${PREHAB_ROUTINE}"); "rest" = no lifting.
- Leg-dominant routines: never on a long-run day, never the day before intervals/tempo/hard/long. Best the same day as a quality run (after it) or before a rest day.
- Muscle recovery follows the RPE of the session that trained them: RPE ≤ 5 → 1 day, 6–7 → 2 days, ≥ 8 → 3 days (+1 day for an exercise graded hard); planned sessions need 2 days between the same muscles. One session per day. Days marked done stay as they are.
- Today: no lifting if readiness < ${NO_LIFT_READY}; ${NO_LIFT_READY}–${LIGHT_READY - 1} → at most a LIGHT upper session (muscles recovered by the RPE rule; it's extra, on top of the week's count); ${LIGHT_READY}–49 → upper body only.
- 2–4 sessions in the 7 days (adaptive: fewer when recovery is low or running is building, more when recovery is good and lifting is consistent).
Tailoring per session day (optional): setsDelta per exercise id (-1 or +1 only), swap an exercise ONLY to one of its listed alternatives.
Return ONLY JSON: {"target":n,"summary":"≤40 words, the week's strength logic","days":[{"date":"YYYY-MM-DD","kind":"session|prehab|rest","routineId":"id or null","setsDelta":{"exId":-1},"swap":{"exId":"altId"},"why":"≤20 words, specific to that day"}]} — exactly the 7 dates given.`;
  setUsageFeature('strength-plan');
  const txt = await callLLM({ system, messages: [{ role: 'user', content: JSON.stringify(input) }], maxTokens: 1400, temperature: 0.2 });
  const js = extractJsonObject(txt);
  if (!js) return null;
  const o = JSON.parse(js);
  if (!Array.isArray(o?.days)) return null;
  // validate day by day, chronologically, against the hard rules
  const trained = muscleLastTrained(c.st, c.today);
  const placed = new Map<number, string>();
  draft.forEach((d, i) => { if (d.done && d.routineId) placed.set(i, d.routineId); });
  const outDays: PlannedStrengthDay[] = draft.map(d => ({ ...d }));
  const prehabBase = c.st.routines.find(r => r.id === PREHAB_ROUTINE && r.items.some(it => PREHAB_IDS.includes(it.exerciseId)));
  let nPreAi = 0;
  for (let i = 0; i < c.days.length; i++) {
    if (draft[i].done) continue;
    const a = (o.days as any[]).find(x => x?.date === c.days[i].date);
    if (!a) continue;
    const why = typeof a.why === 'string' && a.why.trim() ? a.why.trim().slice(0, 160) : undefined;
    if (a.kind === 'rest') { outDays[i] = { date: c.days[i].date, kind: 'rest', why: why ?? 'No lifting planned.', run: c.days[i].label }; continue; }
    if (a.kind === 'prehab' && prehabBase && nPreAi < MAX_PREHAB && prehabOk(c, i, placed) && !(i === 0 && c.readiness != null && c.readiness < NO_LIFT_READY)) {
      nPreAi++;
      const t = tailor(c, i, prehabBase, 'prehab');
      if (t.items.length) outDays[i] = { date: c.days[i].date, kind: 'prehab', routineId: prehabBase.id, name: 'Runner prehab', items: t.items, changes: t.changes, minutes: estimateMinutes({ ...prehabBase, items: t.items }), why: why ?? 'Optional ~10 min runner prehab.', run: c.days[i].label };
      continue;
    }
    if (a.kind !== 'session') continue;
    const r = c.routines.find(x => x.id === a.routineId);
    if (!r || placed.size >= 4) continue;                    // ≤ 4 sessions in the 7 days, whatever the model says
    // validate against what the AI has placed so far + the rest of the DRAFT's sessions it keeps
    const others = new Map(placed);
    const lightI = i === 0 && c.readiness != null && c.readiness < LIGHT_READY;
    if (lightI) c.lightDays = new Set([0]);
    if (blocked(c, i, r, others, trained, lightI)) continue;  // invalid → keep the draft's day
    placed.set(i, r.id);
    const t = tailor(c, i, r, 'session');
    let items = t.items; const changes = [...t.changes];
    if (a.setsDelta && typeof a.setsDelta === 'object') {
      items = items.map(it => { const dl = Number(a.setsDelta[it.exerciseId]); if (dl === -1 || dl === 1) { const n = Math.max(1, Math.min(6, it.sets + dl)); if (n !== it.sets) changes.push(`${dl > 0 ? '+' : '−'}1 set ${exerciseById(c.st, it.exerciseId)?.name ?? it.exerciseId}`); return { ...it, sets: n }; } return it; });
    }
    if (a.swap && typeof a.swap === 'object') {
      items = items.map(it => { const to = a.swap[it.exerciseId]; if (typeof to === 'string' && it.altIds?.includes(to) && exerciseById(c.st, to)) { changes.push(`${exerciseById(c.st, it.exerciseId)?.name} → ${exerciseById(c.st, to)?.name}`); const sw = { ...it, exerciseId: to, altIds: [it.exerciseId, ...(it.altIds ?? []).filter(x => x !== to)] }; return { ...sw, weightKg: suggestWeight(c.st, sw).kg }; } return it; });
    }
    outDays[i] = { date: c.days[i].date, kind: 'session', routineId: r.id, name: r.name, items, changes, minutes: estimateMinutes({ ...r, items }), why: why ?? whyFor(c, i, r, (c.prof.get(r.id)?.legShare ?? 0) >= LEG_SHARE), run: c.days[i].label };
  }
  // the AI's own choices must still respect each other (it placed chronologically, but a kept draft day may clash)
  const sessIdx = outDays.map((d, i) => (d.kind === 'session' ? i : -1)).filter(i => i >= 0);
  for (const i of sessIdx) {
    const d = outDays[i];
    if (d.done) continue;
    const rest = new Map(sessIdx.filter(j => j !== i).map(j => [j, outDays[j].routineId!] as [number, string]));
    const r = c.routines.find(x => x.id === d.routineId);
    if (!r || blocked(c, i, r, rest, trained, i === 0 && c.readiness != null && c.readiness < LIGHT_READY)) outDays[i] = { date: d.date, kind: 'rest', why: 'No lifting planned.', run: d.run };
  }
  // prehab next to a (kept or AI) leg session → drop it; and never more than 4 sessions overall
  const legIdx = outDays.map((d, i) => (d.kind === 'session' && (c.prof.get(d.routineId ?? '')?.legShare ?? 0) >= LEG_SHARE ? i : -1)).filter(i => i >= 0);
  outDays.forEach((d, i) => { if (d.kind === 'prehab' && !d.done && legIdx.some(j => Math.abs(j - i) <= 1)) outDays[i] = { date: d.date, kind: 'rest', why: 'No lifting planned.', run: d.run }; });
  let kept = 0;
  outDays.forEach((d, i) => { if (d.kind === 'session') { kept++; if (kept > 4 && !d.done) outDays[i] = { date: d.date, kind: 'rest', why: 'No lifting planned.', run: d.run }; } });
  const n = outDays.filter(d => d.kind === 'session').length;
  if (n < 2 && draft.filter(d => d.kind === 'session').length >= 2) return null;   // the AI under-planned → keep the draft
  return { days: outDays, target: Math.max(2, Math.min(4, Number(o.target) || n)), summary: typeof o.summary === 'string' ? o.summary.slice(0, 300) : undefined };
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────────────────────────
let inflight: Promise<StrengthAutoPlan | null> | null = null;
let inflightOpts: { ai?: boolean; force?: boolean } = {};
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
/**
 * Make sure today's strength plan is current (regenerates when its inputs changed). `ai` = also try the LLM
 * refinement (foreground callers); the background morning flow passes false. Pushes the result to the watch.
 */
export function ensureStrengthPlan(opts: { ai?: boolean; force?: boolean } = {}): Promise<StrengthAutoPlan | null> {
  // a STRONGER request (AI after a background draft run, or a forced re-plan) waits for the running one, then runs itself
  if (inflight) return opts.force || (opts.ai && !inflightOpts.ai) ? inflight.then(() => ensureStrengthPlan(opts), () => ensureStrengthPlan(opts)) : inflight;
  inflightOpts = opts;
  inflight = (async () => {
    try {
      const st = await loadStrength();
      if (st.autoPlanOn === false) return null;
      const { c, prevWeekRunMin, sigParts } = await buildContext(st);
      const sig = sigParts.join('|');
      const cur = st.autoPlan;
      if (!opts.force && cur && cur.sig === sig && (!opts.ai || cur.ai || cur.aiTried)) return cur;
      if (!c.routines.length) return null;
      const { target, why } = adaptiveTarget(c, prevWeekRunMin);
      let days = draftPlan(c, target);
      let plan: StrengthAutoPlan = { date: c.today, generatedAt: Date.now(), sig, target, targetWhy: why, days };
      if (opts.ai) {
        plan.aiTried = true;
        const { getEffectiveMaxHr } = require('./claude') as typeof import('./claude');
        const maxHr = await getEffectiveMaxHr().catch(() => 188);
        const ai = await withTimeout(aiRefine(c, days, target, why, maxHr || 188).catch(() => null), 45_000);
        if (ai) { days = ai.days; plan = { ...plan, days, target: ai.target, ai: true, summary: ai.summary }; }
      }
      const saved = plan;
      await updateStrength(s => ({ ...s, autoPlan: saved }));
      const { pushStrengthToWatch } = require('./watchStrength') as typeof import('./watchStrength');
      pushStrengthToWatch().catch(() => {});
      return saved;
    } catch { return null; }
    finally { inflight = null; }
  })();
  return inflight;
}

/** One line for notifications / the coach: today's strength. */
export function strengthTodayLine(plan: StrengthAutoPlan | null | undefined): string | null {
  const d = plan?.days.find(x => x.date === localDateKey());
  if (!d) return null;
  if (d.kind === 'session') return d.done ? `🏋️ ${d.name} ✅` : `🏋️ ${d.name}${d.minutes ? ` ~${d.minutes} min` : ''}`;
  if (d.kind === 'prehab') return `🦵 prehab ~${d.minutes ?? 10} min`;
  return null;
}

/** Harness hooks (harness/strengthplantest.mjs) — not used by the app. */
export const __test = { draftPlan, adaptiveTarget, profile, blocked, runLabel };
