/**
 * Strength on the Apple Watch (Build 4).
 *  · pushStrengthToWatch: every routine (today's first, flagged) with today's suggested weight/reps per set → the
 *    watch app, over the QUEUED channel (never the application context, which holds the route/KPIs).
 *  · importWatchStrengthLogs: sessions logged on the watch arrive in a native pending file (runcoach-watchsync) →
 *    added to the strength store as finished sessions LINKED to the workout the watch recorded (hk.status 'exists',
 *    watch: true — no phone copy in Health), routine auto-update applied, then acknowledged.
 * Both are no-ops on a binary without the native functions.
 */
import { requireNativeModule } from 'expo-modules-core';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system';
import {
  StrengthSession, SetLog, loadStrength, updateStrength, routinesForDate, exerciseById, suggestWeight, lastSetsFor,
  repRange, weightStep, localDateKey, STRENGTH_FILE, baseRoutineId, isFeel, Feel, autoUpdatedRoutine, syncSessionToHealth, enrichSession, sessionPRs, sessionTonnage, isWorkSet,
} from './strength';

interface Native {
  isPaired(): Promise<boolean>;
  queue?(json: string): Promise<boolean>;
  pendingStrengthLogs?(): Promise<string>;
  ackStrengthLogs?(ids: string[]): Promise<void>;
  addListener?(ev: string, fn: (e: any) => void): any;
}
let W: Native | null = null;
try { W = requireNativeModule('RunCoachWatchSync'); } catch { W = null; }

let lastSig = '';   // the plan last handed to the watch (this app run) → unchanged plans aren't re-sent on every focus

// Pushes run ONE AT A TIME in call order: a push started before an import's auto-update must not land after the
// import's own (newer) push and hand the watch the old weights.
let pushChain: Promise<boolean> = Promise.resolve(true);
export function pushStrengthToWatch(): Promise<boolean> {
  const p = pushChain.then(pushOnce, pushOnce);
  pushChain = p.catch(() => false);
  return p;
}
async function pushOnce(): Promise<boolean> {
  if (!W?.queue) return false;
  if (!(await W.isPaired().catch(() => false))) return false;
  const st = await loadStrength();
  const todays = routinesForDate(st);   // the coach's TAILORED routine for today (auto-plan) or the weekday routines
  const todayIds = new Set(todays.map(r => r.id));
  const { fetchBodyMassHistory } = require('./healthkit') as typeof import('./healthkit');   // lazy (import cycle)
  const bodyKg = await fetchBodyMassHistory(3).then(w => (w as { value: number }[]).filter(x => x.value > 0).slice(-1)[0]?.value).catch(() => undefined);
  const routines = [...todays, ...st.routines.filter(r => !todayIds.has(r.id))]
    .filter(r => r.items.length)
    .map(r => ({
      id: r.id, name: r.name, today: todayIds.has(r.id),
      items: r.items.map(it => {
        const ex = exerciseById(st, it.exerciseId);
        const sug = suggestWeight(st, it);
        const last = lastSetsFor(st, it.exerciseId);
        const [lo, hi] = repRange(it);
        // the watch decodes reps/sets as integers — one stray decimal would reject the WHOLE plan, so round here
        const int = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : d);
        return {
          exId: it.exerciseId, name: ex?.name ?? it.exerciseId, rest: Number(it.restSec) || 0, lo: int(lo, 8), hi: int(hi, 10),
          bw: !!ex?.bodyweightFrac, step: weightStep(ex), ...(ex?.timed ? { timed: true } : {}),   // timed: reps = SECONDS
          sets: Array.from({ length: int(it.sets, 3) }, (_, k) => ({ kg: Number(sug.kg ?? it.weightKg ?? 0) || 0, reps: int(last[k]?.reps ?? hi, 10) })),
        };
      }),
    }));
  if (!routines.length) return false;
  const json = JSON.stringify({ type: 'strength', date: localDateKey(), ...(bodyKg ? { bodyKg } : {}), routines });
  if (json === lastSig) return true;
  const ok = await W.queue(json).catch(() => false);
  if (ok) lastSig = json;
  return ok;
}

let importing: Promise<number> | null = null;
let again = false;   // a log landed while an import was running (after its read) → one more pass
/** Import the watch's pending strength sessions. Resolves with how many were new. Single-flight. */
export function importWatchStrengthLogs(): Promise<number> {
  if (importing) { again = true; return importing; }
  importing = (async () => {
    let n = 0;
    do { again = false; n += await importOnce().catch(() => 0); } while (again);
    return n;
  })().finally(() => { importing = null; });
  return importing;
}

async function importOnce(): Promise<number> {
  if (!W?.pendingStrengthLogs || !W.ackStrengthLogs) return 0;
  const raw = JSON.parse((await W.pendingStrengthLogs()) || '[]') as any[];
  if (!Array.isArray(raw) || !raw.length) return 0;
  const ids: string[] = [];
  const bad: string[] = [];
  const added: { id: string; linked: boolean }[] = [];
  const st = await updateStrength(cur => {
    let sessions = cur.sessions;
    let next = cur;
    for (const l of raw) {
      const id = String(l?.id ?? '');
      if (!id) continue;
      ids.push(id);
      if (sessions.some(x => x.id === id)) continue;   // delivered twice / ack lost → already in
      // one malformed log must not block every later one: it's skipped (and acked) instead of throwing the batch
      if (!Array.isArray(l.sets) || l.sets.some((x: any) => !x || typeof x !== 'object')) { bad.push(id); continue; }
      const sets: SetLog[] = (l.sets as any[]).map((x: any) => ({
        exerciseId: String(x.exId), set: Number(x.set) || 1, reps: Math.max(0, Math.round(Number(x.reps) || 0)),
        weightKg: Number(x.kg) || 0, done: true, doneAt: Number(x.doneAt) || undefined,
      })).filter((x: SetLog) => x.reps > 0);
      const startedAt = Number(l.startedAt), finishedAt = Number(l.finishedAt);
      if (!sets.length || !startedAt || !finishedAt) { bad.push(id); continue; }   // nothing usable → ack, don't re-read forever
      const date = localDateKey(new Date(startedAt));
      // the auto-plan's prehab day travels as "<routine>~prehab" → log it under the routine, tagged (see strength.ts)
      const rawRid = String(l.routineId ?? '');
      const routineId = baseRoutineId(rawRid);
      const pd = cur.autoPlan?.days.find(d => d.date === date);
      const tailored: StrengthSession['tailored'] = rawRid !== routineId ? 'prehab'
        : pd?.kind === 'session' && pd.routineId === routineId && pd.changes?.length ? 'reduced' : undefined;
      // the same routine opened on the phone today but never ticked = an abandoned duplicate of this workout → drop it
      sessions = sessions.filter(x => !(x.routineId === routineId && x.date === date && !x.finishedAt && !x.sets.some(s => s.done) && (x.tailored === 'prehab') === (tailored === 'prehab')));
      const uuid = typeof l.uuid === 'string' && l.uuid ? l.uuid : undefined;
      const sess: StrengthSession = {
        id, date, routineId, routineName: String(l.routineName ?? 'Strength'), startedAt, finishedAt,
        ...(Number(l.bodyKg) > 0 ? { bodyKg: Number(l.bodyKg) } : {}),
        ...(Number(l.rpe) > 0 ? { rpe: Math.round(Number(l.rpe)) } : {}),
        ...(l.feel && typeof l.feel === 'object' ? { feel: Object.fromEntries(Object.entries(l.feel).filter(([, v]) => isFeel(v))) as Partial<Record<string, Feel>> } : {}),
        sets,
        // the watch recorded it in Health → link it; no uuid = the watch's save failed → the phone saves a copy below
        ...(uuid ? { hk: { status: 'exists' as const, uuid, watch: true,
          // the watch related the RPE as Effort itself → nothing left for the phone to add
          ...(l.effort === 'ok' ? { enriched: { uuid, effort: 'ok', hr: 'watch', at: Date.now() } } : {}) } } : {}),
        note: '⌚ Logged on Apple Watch',
        ...(tailored ? { tailored } : {}),
      };
      sessions = [...sessions, sess];
      added.push({ id, linked: !!uuid });
    }
    next = { ...cur, sessions };
    // Bevel-style auto-update, as after a phone Finish
    for (const a of added) {
      const upd = autoUpdatedRoutine(next, a.id);
      if (upd) next = { ...next, routines: next.routines.map(r => r.id === upd.routine.id ? upd.routine : r) };
    }
    return next;
  });
  // ack only what is really ON DISK: updateStrength swallows a failed file write (e.g. protected data while the
  // phone is locked), and an ack deletes the native copy — then the session would vanish at the next cold start
  const onDisk = await FileSystem.readAsStringAsync(STRENGTH_FILE).then(t => new Set<string>((JSON.parse(t).sessions ?? []).map((x: any) => x.id))).catch(() => new Set<string>());
  const ackIds = [...ids.filter(id => onDisk.has(id)), ...bad];
  if (ackIds.length) await W.ackStrengthLogs(ackIds).catch(() => {});
  for (const a of added) {
    if (st.saveToHealth === false) break;
    if (a.linked) enrichSession(a.id).catch(() => {});   // the RPE → Apple's Effort, if the watch couldn't
    else syncSessionToHealth(a.id).catch(() => {});
  }
  if (added.length) {
    if (AppState.currentState !== 'active') notifyImported(st, added.map(a => a.id)).catch(() => {});   // in-app: the screen shows it
    lastSig = '';                               // weights moved (auto-update) → re-send the plan
    pushStrengthToWatch().catch(() => {});
  }
  return added.length;
}

async function notifyImported(st: Awaited<ReturnType<typeof loadStrength>>, ids: string[]): Promise<void> {
  const Notifications = require('expo-notifications') as typeof import('expo-notifications');
  for (const id of ids) {
    const x = st.sessions.find(s => s.id === id);
    if (!x) continue;
    const prs = sessionPRs(st, id);
    const body = `${x.sets.filter(isWorkSet).length} sets · ${sessionTonnage(st, x).toLocaleString()} kg · ${Math.round((x.finishedAt! - x.startedAt) / 60000)} min`
      + (prs.length ? `\n🏆 ${prs.map(p => `${p.name} ${p.kind}`).join(', ')}` : '');
    await Notifications.scheduleNotificationAsync({ content: { title: `⌚ ${x.routineName} logged on your watch`, body }, trigger: null });
  }
}

// Logs that land while the app is running are imported right away (cold starts: the focus hooks import them).
try { W?.addListener?.('onStrengthLog', () => { void importWatchStrengthLogs(); }); } catch { /* old binary */ }
