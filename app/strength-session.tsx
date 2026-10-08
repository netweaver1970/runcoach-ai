import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, Keyboard, Alert, Linking, Vibration, AppState } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { fetchBodyMassHistory } from '../src/services/healthkit';
import {
  StrengthStore, StrengthSession, SetLog, loadStrength, updateStrength, exerciseById, suggestWeight, lastSetsFor,
  localDateKey, newId, sessionTonnage, repRange, sessionPRs, syncSessionToHealth, autoUpdatedRoutine, isWorkSet, Feel, FEEL_LABEL, routinesForDate, plannedDay, baseRoutineId, DAILY_CUSTOM_ID,
} from '../src/services/strength';

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec % 60)).padStart(2, '0')}`;

/**
 * Weight / reps cell. Commits on EVERY change that parses (so tapping ✓ / Finish / Back straight from the field
 * can't lose the value — onBlur arrives too late for those), while keeping its own text so "22." survives typing.
 */
function Cell({ value, onCommit, decimal, style }: { value: number; onCommit: (n: number) => void; decimal?: boolean; style: any }) {
  const [t, setT] = useState(String(value));
  const mine = useRef(value);   // the last value WE committed → don't overwrite the text while it's ours
  useEffect(() => { if (value !== mine.current) { mine.current = value; setT(String(value)); } }, [value]);
  const parse = (x: string) => (decimal ? parseFloat(x.replace(',', '.')) : parseInt(x, 10));
  return <TextInput style={style} value={t} selectTextOnFocus keyboardType={decimal ? 'numbers-and-punctuation' : 'number-pad'} returnKeyType="done"
    onChangeText={x => { setT(x); const n = parse(x); if (Number.isFinite(n)) { mine.current = n; onCommit(n); } }}
    onBlur={() => { if (!Number.isFinite(parse(t))) setT(String(value)); }} />;
}

// Replace this session in the store — or put it back if something removed it meanwhile (a watch-logged workout of
// the same routine drops an untouched phone session; ticking here afterwards must not log into nothing).
// The set to do next: the next open set of the exercise just worked on, else the first open set in the (re-orderable)
// session order. -1 = everything ticked.
function nextSetIdx(x: StrengthSession, focusExId?: string | null): number {
  const f = focusExId ? x.sets.findIndex(l => l.exerciseId === focusExId && !l.done) : -1;
  return f >= 0 ? f : x.sets.findIndex(l => !l.done);
}
// "Chest Press, set 2 of 4, 10 reps, 27.5 kilos" (body-weight moves: "body weight plus 5 kilos" / "assisted, 20 kilos")
function describeSet(st: StrengthStore, x: StrengthSession, idx: number): string {
  const l = x.sets[idx];
  if (!l) return '';
  const ex = exerciseById(st, l.exerciseId);
  const work = x.sets.filter(q => q.exerciseId === l.exerciseId && !q.warmup);
  const k = work.indexOf(l) + 1;
  const kg = Math.round(l.weightKg * 100) / 100;
  const w = ex?.bodyweightFrac ? (kg > 0 ? `body weight plus ${kg} kilos` : kg < 0 ? `assisted, ${-kg} kilos` : 'body weight') : `${kg} kilos`;
  if (ex?.timed) return `${ex.name}, ${l.warmup ? 'warm-up set' : `set ${k} of ${work.length}`}, ${l.reps} seconds${kg > 0 ? `, plus ${kg} kilos` : ''}`;
  return `${ex?.name ?? l.exerciseId}, ${l.warmup ? 'warm-up set' : `set ${k} of ${work.length}`}, ${l.reps} reps, ${w}`;
}
// Spoken on the phone through the native voice path (ducks music, hands it back); no-op on an older binary.
function say(text: string) {
  if (!text) return;
  try { (require('../modules/runcoach-watchsync').default as { speak?: (t: string) => Promise<boolean> } | null)?.speak?.(text).catch(() => {}); } catch { /* old binary */ }
}

const upsert = (list: StrengthSession[], x: StrengthSession) => (list.some(q => q.id === x.id) ? list.map(q => (q.id === x.id ? x : q)) : [...list, x]);

export default function StrengthSessionScreen() {
  const { routine: routineId } = useLocalSearchParams<{ routine: string }>();
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const navigation = useNavigation();
  const [store, setStore] = useState<StrengthStore | null>(null);
  const [sess, setSess] = useState<StrengthSession | null>(null);
  const [restEnd, setRestEnd] = useState<number | null>(null);   // epoch ms the current rest ends
  const [now, setNow] = useState(Date.now());
  const [rpe, setRpe] = useState<number | undefined>();
  const focusEx = useRef<string | null>(null);   // exercise of the set ticked last → its next set comes first
  // TIMED holds (planks): the running hold → countdown + spoken cues ("Hold, 30 seconds … 10 seconds … 3, 2, 1 … Done")
  // the held set is identified by exercise + set number (Do next / Later can MOVE indices during a hold)
  const [hold, setHold] = useState<{ idx: number; exerciseId: string; set: number; start: number; target: number; restSec: number } | null>(null);
  const holdNotif = useRef<string | null>(null);   // "hold done" notification → a locked phone still hears the end
  const holdCues = useRef<Set<string>>(new Set());
  const announced = useRef(false);               // the opening set was announced (once per screen)
  const storeRef = useRef<StrengthStore | null>(null);
  storeRef.current = store;
  const notifId = useRef<string | null>(null);
  const notifGen = useRef(0);      // bumps on every start/cancel → a schedule that resolves late is cancelled
  const buzzed = useRef(false);
  const sessRef = useRef<StrengthSession | null>(null);   // the LIVE session — every update applies to this
  const finishing = useRef(false);                          // a double-tapped Finish saves + alerts once

  // Load the store, then resume today's unfinished session of this routine or start a fresh one.
  useEffect(() => {
    (async () => {
      const st = await loadStrength();
      // today's coach-TAILORED version of the routine (sets / weights / swaps for the day) when it's the planned one
      const planned = routinesForDate(st).find(x => x.id === routineId);
      const r = planned ?? st.routines.find(x => x.id === routineId);
      if (!r) { setStore({ ...st }); return; }
      const today = localDateKey();
      // the prehab day is "<routine>~prehab": logged under the real routine, tagged, so the full routine stays separate
      const baseId = baseRoutineId(r.id);
      const day = plannedDay(st);
      // the Daily custom mixes exercises at its own set counts → tagged like a trimmed session, so a lighter set count
      // there never breaks that exercise's progression streak in its home routine
      const tailored: StrengthSession['tailored'] = r.id !== baseId ? 'prehab'
        : baseId === DAILY_CUSTOM_ID || (planned && day?.routineId === baseId && day.changes?.length) ? 'reduced' : undefined;
      const open = st.sessions.find(x => x.routineId === baseId && x.date === today && !x.finishedAt && (x.tailored === 'prehab') === (tailored === 'prehab'));
      let session = open;
      if (!session) {
        const sets: SetLog[] = [];
        for (const it of r.items) {
          const sug = suggestWeight(st, it);
          const last = lastSetsFor(st, it.exerciseId);
          for (let k = 0; k < it.sets; k++) {
            // holds: never prefill BELOW the target (an early stop last time mustn't shrink this session's countdown)
            const hi = repRange(it)[1], timed = !!exerciseById(st, it.exerciseId)?.timed;
            sets.push({ exerciseId: it.exerciseId, set: k + 1, weightKg: sug.kg ?? it.weightKg ?? 0, reps: timed ? Math.max(last[k]?.reps ?? hi, hi) : (last[k]?.reps ?? hi), done: false });
          }
        }
        const kg = await fetchBodyMassHistory(3).then(w => (w as { value: number }[]).filter(x => x.value > 0).slice(-1)[0]?.value).catch(() => undefined);
        session = { id: newId('ss'), date: today, routineId: baseId, routineName: r.name, startedAt: Date.now(), bodyKg: kg, sets, ...(tailored ? { tailored } : {}) };
        const created = session;
        const next = await updateStrength(cur => ({ ...cur, sessions: [...cur.sessions, created] }));
        sessRef.current = session; setStore({ ...next }); setSess(session);
        return;
      }
      sessRef.current = session; setStore({ ...st }); setSess(session);
    })();
  }, [routineId]);

  // 1 s tick only while resting; buzz when the rest ends (a local notification covers a locked phone).
  useEffect(() => {
    if (!restEnd) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= restEnd && !buzzed.current) { buzzed.current = true; Vibration.vibrate([0, 400, 200, 400]); announceNext(); }
    }, 500);
    return () => clearInterval(t);
  }, [restEnd]);
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => {
      const el = (Date.now() - hold.start) / 1000, left = Math.ceil(hold.target - el);
      setNow(Date.now());
      const cue = (k: string, text: string) => { if (!holdCues.current.has(k)) { holdCues.current.add(k); if (voiceOn()) say(text); } };
      if (hold.target >= 30 && el >= hold.target / 2) cue('half', 'Halfway');
      if (hold.target >= 20 && left <= 10 && left > 3) cue('10', '10 seconds');
      if (left <= 3 && left > 0) cue('321', '3, 2, 1');
      if (left <= 0) { if (!holdCues.current.has('done')) Vibration.vibrate([0, 300, 150, 300]); cue('done', 'Done'); finishHold(hold.target); }
    }, 250);
    return () => clearInterval(t);
  }, [hold]);
  // announce the first set once the session is on screen (voice on)
  useEffect(() => {
    if (sess && store && !announced.current) { announced.current = true; announceNext(); }
  }, [sess, store]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => { if (st === 'active') setNow(Date.now()); });
    return () => sub.remove();
  }, []);
  const cancelRestNotif = useCallback(() => {
    notifGen.current++;
    if (notifId.current) { Notifications.cancelScheduledNotificationAsync(notifId.current).catch(() => {}); notifId.current = null; }
  }, []);
  useEffect(() => navigation.addListener('beforeRemove', () => {
    Keyboard.dismiss(); cancelRestNotif();
    if (holdNotif.current) { Notifications.cancelScheduledNotificationAsync(holdNotif.current).catch(() => {}); holdNotif.current = null; }
  }), [navigation, cancelRestNotif]);

  // Apply a change to the LIVE session and write it into the latest store (never a stale full-store copy).
  const persist = (fn: (x: StrengthSession) => StrengthSession) => {
    if (!sessRef.current || finishing.current) return;   // after Finish: nothing may overwrite the saved session
    const next = fn(sessRef.current);
    sessRef.current = next; setSess(next);
    updateStrength(cur => ({ ...cur, sessions: upsert(cur.sessions, next) })).then(st => setStore({ ...st }));
  };

  // only while this session is live and the app is in front (never after Finish, never under a run in the background)
  const voiceOn = () => storeRef.current?.voice !== false && !finishing.current && AppState.currentState === 'active';
  const announceNext = () => {
    const x = sessRef.current, st = storeRef.current;
    if (!x || !st || !voiceOn()) return;
    const i = nextSetIdx(x, focusEx.current);
    if (i >= 0) say(describeSet(st, x, i));
  };
  // Machine free → "Do next": the exercise goes in front of everything still open and becomes the next set (even if
  // another exercise is half done); machine taken → "Later": to the end. The display order, the NEXT tag, the voice
  // and the rest notification follow.
  const moveBlock = (exId: string, where: 'next' | 'later') => {
    persist(x => {
      const mine = x.sets.filter(l => l.exerciseId === exId), rest = x.sets.filter(l => l.exerciseId !== exId);
      if (where === 'later') return { ...x, sets: [...rest, ...mine] };
      const open = rest.findIndex(l => !l.done);
      // in front of the whole block holding the first open set (never between a half-done exercise's sets)
      const at = open < 0 ? -1 : rest.findIndex(l => l.exerciseId === rest[open].exerciseId);
      return { ...x, sets: at < 0 ? [...rest, ...mine] : [...rest.slice(0, at), ...mine, ...rest.slice(at)] };
    });
    if (where === 'next') focusEx.current = exId;
    else if (focusEx.current === exId) focusEx.current = null;
    if (restEnd && Date.now() < restEnd) startRest(Math.ceil((restEnd - Date.now()) / 1000));   // re-word the rest-done notification
    else announceNext();
  };

  const nextLine = () => {
    const x = sessRef.current, st = storeRef.current;
    const i = x && st ? nextSetIdx(x, focusEx.current) : -1;
    return i >= 0 ? describeSet(st!, x!, i) : '';
  };
  const startRest = async (sec: number) => {
    cancelRestNotif();
    if (sec <= 0) { setRestEnd(null); return; }
    buzzed.current = false;
    setRestEnd(Date.now() + sec * 1000); setNow(Date.now());
    const gen = notifGen.current;
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: '⏱ Rest done', body: nextLine() || 'Next set.', sound: true },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: sec },
      });
      if (gen !== notifGen.current) Notifications.cancelScheduledNotificationAsync(id).catch(() => {});   // superseded meanwhile
      else notifId.current = id;
    } catch { /* notifications off → the in-app vibration still fires */ }
  };

  if (!store || !sess) {
    return <View style={[s.screen, { justifyContent: 'center' }]}><Stack.Screen options={{ title: 'Session' }} />
      {store ? <Text style={[s.meta, { textAlign: 'center' }]}>Routine not found.</Text> : <ActivityIndicator color={c.accent} />}</View>;
  }
  const r = store.routines.find(x => x.id === sess.routineId);

  // Editing a set's WEIGHT also moves the later, not-yet-done sets of that exercise that still had the SAME weight
  // (prefilled followers) — a deliberately different later weight (pyramid) is left alone.
  const setAt = (idx: number, p: Partial<SetLog>) => persist(x => {
    const old = x.sets[idx];
    return { ...x, sets: x.sets.map((l, k) => {
      if (k === idx) return { ...l, ...p };
      if (p.weightKg != null && k > idx && !l.done && !l.warmup && !old.warmup && l.exerciseId === old.exerciseId && l.weightKg === old.weightKg) return { ...l, weightKg: p.weightKg };
      return l;
    }) };
  });
  const startHold = (idx: number, restSec: number) => {
    const l = sessRef.current!.sets[idx];
    holdCues.current = new Set();
    focusEx.current = l.exerciseId;
    cancelRestNotif(); setRestEnd(null);
    if (voiceOn()) say(`Hold, ${l.reps} seconds`);
    const target = Math.max(1, l.reps);
    setHold({ idx, exerciseId: l.exerciseId, set: l.set, start: Date.now(), target, restSec });
    // the phone may lock mid-plank (JS timers stop) → a notification marks the end
    Notifications.scheduleNotificationAsync({ content: { title: '⏱ Hold done', body: `${target} s — next set.`, sound: true },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: target } })
      .then(id => { holdNotif.current = id; }).catch(() => {});
  };
  const cancelHold = () => {
    if (holdNotif.current) { Notifications.cancelScheduledNotificationAsync(holdNotif.current).catch(() => {}); holdNotif.current = null; }
    setHold(null);
  };
  // the hold ended (time up, or ■ early → the seconds actually held) → tick the set with them + start the rest
  const finishHold = (secs: number) => {
    const h = hold; if (!h || holdCues.current.has('fin') || finishing.current) return;   // once; never after Finish
    holdCues.current.add('fin');
    cancelHold();
    const held = Math.max(1, Math.round(secs));
    persist(x => {
      // find the held set by identity (indices may have moved), fall back to the recorded index
      let k0 = x.sets.findIndex(l => l.exerciseId === h.exerciseId && l.set === h.set && !l.done);
      if (k0 < 0) k0 = x.sets[h.idx]?.exerciseId === h.exerciseId ? h.idx : -1;
      return k0 < 0 ? x : { ...x, sets: x.sets.map((l, k) => k === k0 ? { ...l, reps: held, done: true, doneAt: Date.now() } : l) };
    });
    startRest(h.restSec); if (h.restSec <= 0) announceNext();
  };
  const toggle = (idx: number, restSec: number) => {
    if (hold?.idx === idx) cancelHold();   // ✓ on the held set ends the hold (the typed seconds stand)
    const done = !sessRef.current!.sets[idx].done;
    if (done) focusEx.current = sessRef.current!.sets[idx].exerciseId;
    persist(x => ({ ...x, sets: x.sets.map((l, k) => k === idx ? { ...l, done, doneAt: done ? Date.now() : undefined } : l) }));
    if (done) { startRest(restSec); if (restSec <= 0) announceNext(); } else { cancelRestNotif(); setRestEnd(null); }
  };
  // switch to the alternative exercise for the sets NOT yet done
  const swap = (fromId: string, toId: string) => persist(x => ({ ...x, sets: x.sets.map(l => l.exerciseId === fromId && !l.done ? { ...l, exerciseId: toId } : l) }));
  const finish = () => {
    if (finishing.current) return;
    const cur = sessRef.current!;
    if (!cur.sets.some(l => l.done)) {
      Alert.alert('No sets ticked', 'Discard this session instead?', [{ text: 'Keep logging', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: discard }]);
      return;
    }
    finishing.current = true;
    cancelRestNotif(); setRestEnd(null); cancelHold();
    const fin = { ...cur, finishedAt: Date.now(), rpe };
    sessRef.current = fin;
    let routineChanges: string[] = [];
    updateStrength(st => {
      const withFin = { ...st, sessions: upsert(st.sessions, fin) };
      // Bevel-style auto-update: the routine's planned weights move to the suggested next ones (unless switched off)
      const upd = autoUpdatedRoutine(withFin, fin.id);
      routineChanges = upd?.changes ?? [];
      return upd ? { ...withFin, routines: withFin.routines.map(r => r.id === upd.routine.id ? upd.routine : r) } : withFin;
    }).then(async st => {
      const prs = sessionPRs(st, fin.id);
      const updLine = routineChanges.length ? `\n\n📈 Next time:\n${routineChanges.join('\n')}` : '';
      // never let a slow HealthKit hold the confirmation (Finish is already locked): ≤ 5 s, then the backfill finishes it
      const hk = await Promise.race([syncSessionToHealth(fin.id).catch(() => null), new Promise<null>(r => setTimeout(() => r(null), 5000))]);
      const hkLine = !hk ? '' : hk.status === 'saved' ? '\n❤️ Saved to Apple Health (heart rate + effort attach in the background)' : hk.status === 'exists' ? '\n❤️ Linked to your watch workout in Health' : '\n⚠ Not saved to Apple Health';
      const sum = `${fin.sets.filter(isWorkSet).length} sets · ${sessionTonnage(st, fin).toLocaleString()} kg · ${Math.round((fin.finishedAt! - fin.startedAt) / 60000)} min`;
      Alert.alert(prs.length ? '🏆 New personal records' : '✅ Session saved',
        (prs.length ? `${prs.map(p => `${p.name}: ${p.kind} ${p.value}${p.kind === 'Set volume' ? '' : ' kg'} (was ${p.prev})`).join('\n')}\n\n${sum}` : sum) + hkLine + updLine,
        [{ text: 'OK', onPress: () => router.back() }]);
    });
  };
  const discard = () => {
    cancelRestNotif(); setRestEnd(null); cancelHold(); finishing.current = true;
    const id = sessRef.current!.id;
    updateStrength(st => ({ ...st, sessions: st.sessions.filter(x => x.id !== id) })).then(() => router.back());
  };

  const restLeft = restEnd ? Math.ceil((restEnd - now) / 1000) : 0;
  const elapsedMin = Math.round((Date.now() - sess.startedAt) / 60000);
  // group the flat set list back into the routine's exercise order (by first appearance)
  const order: string[] = [];
  for (const l of sess.sets) if (!order.includes(l.exerciseId)) order.push(l.exerciseId);
  const nextIdx = nextSetIdx(sess, focusEx.current);
  const nextEx = nextIdx >= 0 ? sess.sets[nextIdx].exerciseId : null;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: sess.routineName, headerBackTitle: 'Back', headerRight: () => (
        // spoken set announcements on/off (remembered)
        <TouchableOpacity hitSlop={10} onPress={() => updateStrength(cur => ({ ...cur, voice: cur.voice === false })).then(st => {
          storeRef.current = st; setStore({ ...st }); if (st.voice !== false) announceNext();   // ref first: announceNext reads it
        })}>
          <Text style={{ fontSize: 20 }}>{store.voice === false ? '🔇' : '🔊'}</Text>
        </TouchableOpacity>
      ) }} />
      {restEnd && (
        <View style={[s.restBar, restLeft <= 0 && { backgroundColor: '#2f9e44' }]}>
          <Text style={s.restTxt}>{restLeft > 0 ? `Rest ${fmt(restLeft)}` : 'Rest done — go!'}</Text>
          <TouchableOpacity onPress={() => startRest(Math.max(0, restLeft) + 30)} hitSlop={8}><Text style={s.restBtn}>+30 s</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => { cancelRestNotif(); setRestEnd(null); if (restLeft > 0) announceNext(); }} hitSlop={8}><Text style={s.restBtn}>{restLeft > 0 ? 'Skip' : 'OK'}</Text></TouchableOpacity>
        </View>
      )}
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Text style={s.meta}>{sess.sets.filter(isWorkSet).length}/{sess.sets.length} sets · {elapsedMin} min · {sessionTonnage(store, sess).toLocaleString()} kg lifted</Text>

        {order.map((exId, ei) => {
          const ex = exerciseById(store, exId);
          const item = r?.items.find(i => i.exerciseId === exId || i.altIds?.includes(exId));
          const restSec = item?.restSec ?? 90;
          const sug = item ? suggestWeight(store, { ...item, exerciseId: exId }) : {};
          const alts = item ? [item.exerciseId, ...(item.altIds ?? [])].filter(a => a !== exId) : [];
          return (
            <View key={exId} style={s.ex}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push({ pathname: '/strength-exercise' as any, params: { id: exId } })}>
                  <Text style={s.exName}>{String.fromCharCode(97 + ei)}. {ex?.name ?? exId} ›{exId === nextEx ? <Text style={s.nextTag}>  NEXT</Text> : null}</Text>
                </TouchableOpacity>
                {ex?.video && <TouchableOpacity onPress={() => Linking.openURL(ex.video!.url)} hitSlop={8}><Text style={s.link}>▶ video</Text></TouchableOpacity>}
              </View>
              <Text style={s.meta}>
                {item ? `${item.sets} × ${repRange(item).join('–')}` : ''}{item?.tempo ? ` · tempo ${item.tempo}` : ''} · rest {fmt(restSec)}{ex?.bodyweightFrac ? ' · kg = added (− = assist)' : ''}
              </Text>
              {sug.why ? <Text style={s.sug}>💡 {sug.why}</Text> : null}
              {ex?.cue ? <Text style={s.cue}>{ex.cue}</Text> : null}
              {/* machine free / taken → change the order */}
              {sess.sets.some(l => l.exerciseId === exId && !l.done) && (
                <View style={{ flexDirection: 'row', gap: 18, marginTop: 4 }}>
                  {exId !== nextEx && <TouchableOpacity onPress={() => moveBlock(exId, 'next')}><Text style={s.link}>⤴ Do next</Text></TouchableOpacity>}
                  {ei < order.length - 1 && <TouchableOpacity onPress={() => moveBlock(exId, 'later')}><Text style={s.link}>⤵ Later</Text></TouchableOpacity>}
                </View>
              )}
              {alts.map(a => (
                <TouchableOpacity key={a} onPress={() => swap(exId, a)}><Text style={s.link}>⇄ switch to {exerciseById(store, a)?.name ?? a}</Text></TouchableOpacity>
              ))}
              <View style={s.hdrRow}><Text style={[s.hdr, { width: 34 }]}>Set</Text><Text style={[s.hdr, { flex: 1 }]}>kg</Text><Text style={[s.hdr, { flex: 1 }]}>{ex?.timed ? 'Sec' : 'Reps'}</Text><Text style={[s.hdr, { width: 44 }]}>{ex?.timed ? 'Hold' : 'RIR'}</Text><View style={{ width: 52 }} /></View>
              {(() => {
                const prev = lastSetsFor(store, exId);   // last session's WORK sets → shown inline per set
                let work = 0;
                return sess.sets.map((l, idx) => {
                  if (l.exerciseId !== exId) return null;
                  const wi = l.warmup ? -1 : work++;
                  const p = wi >= 0 ? prev[wi] : undefined;
                  return (
                    <View key={idx}>
                      <View style={[s.setRow, l.done && s.setDone]}>
                        {/* tap the set number to mark / unmark it as a WARM-UP (excluded from load, records, progression) */}
                        <TouchableOpacity style={{ width: 34 }} onPress={() => setAt(idx, { warmup: !l.warmup })} hitSlop={6}>
                          <Text style={[s.setNo, l.warmup && { color: c.accent }]}>{l.warmup ? 'W' : wi + 1}</Text>
                        </TouchableOpacity>
                        <Cell decimal style={[s.cell, { flex: 1 }]} value={l.weightKg} onCommit={n => setAt(idx, { weightKg: n })} />
                        <Cell style={[s.cell, { flex: 1 }]} value={l.reps} onCommit={n => setAt(idx, { reps: Math.max(0, n) })} />
                        {ex?.timed ? (
                          // a HOLD: ▶ starts the countdown (spoken cues), ■ stops early and logs the seconds actually held
                          <TouchableOpacity style={[s.rir, hold?.idx === idx && s.rirOn]} disabled={hold?.idx === idx ? false : (l.done || !!hold)}
                            onPress={() => { Keyboard.dismiss(); if (hold?.idx === idx) finishHold((Date.now() - hold.start) / 1000); else startHold(idx, l.warmup ? Math.min(60, restSec) : restSec); }}>
                            <Text style={[s.rirTxt, hold?.idx === idx && { color: c.onAccent }]}>
                              {hold?.idx === idx ? Math.max(0, Math.ceil(hold.target - (now - hold.start) / 1000)) : l.done ? '' : '▶'}
                            </Text>
                          </TouchableOpacity>
                        ) : (
                          /* reps in reserve: – → 0 → 1 → 2 → 3+ → – (optional effort) */
                          <TouchableOpacity style={[s.rir, l.rir != null && s.rirOn]} disabled={!!l.warmup}
                            onPress={() => setAt(idx, { rir: l.rir == null ? 0 : l.rir >= 3 ? undefined : l.rir + 1 })}>
                            <Text style={[s.rirTxt, l.rir != null && { color: c.onAccent }]}>{l.warmup ? '' : l.rir == null ? '–' : l.rir >= 3 ? '3+' : l.rir}</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={[s.tick, l.done && s.tickOn]} onPress={() => { Keyboard.dismiss(); toggle(idx, l.warmup ? Math.min(60, restSec) : restSec); }}>
                          <Text style={[s.tickTxt, l.done && { color: '#fff' }]}>✓</Text>
                        </TouchableOpacity>
                      </View>
                      {p ? <Text style={s.prev}>{ex?.timed ? `last ${p.reps} s${p.weightKg ? ` @ ${p.weightKg} kg` : ''}` : `last ${p.weightKg} kg × ${p.reps}${p.rir != null ? ` @ RIR ${p.rir >= 3 ? '3+' : p.rir}` : ''}`}</Text> : null}
                    </View>
                  );
                });
              })()}
              <View style={{ flexDirection: 'row', gap: 18 }}>
                <TouchableOpacity onPress={() => persist(x => {
                  let at = -1;
                  x.sets.forEach((l, k) => { if (l.exerciseId === exId) at = k; });
                  if (at < 0) return x;
                  const sets = [...x.sets]; sets.splice(at + 1, 0, { ...x.sets[at], set: x.sets[at].set + 1, done: false, warmup: false, rir: undefined });
                  return { ...x, sets };
                })}><Text style={s.addSet}>＋ set</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => persist(x => {
                  const first = x.sets.findIndex(l => l.exerciseId === exId);
                  if (first < 0) return x;
                  const w = x.sets.find(l => l.exerciseId === exId && !l.warmup)?.weightKg ?? x.sets[first].weightKg;
                  const sets = [...x.sets];
                  sets.splice(first, 0, { exerciseId: exId, set: 0, reps: 10, weightKg: w > 0 ? Math.round(w * 0.5 * 2) / 2 : w - 10, done: false, warmup: true });   // assisted: MORE assistance
                  return { ...x, sets };
                })}><Text style={s.addSet}>＋ warm-up set</Text></TouchableOpacity>
              </View>
              {/* optional: how did this exercise feel? 'Hard' = this session doesn't count toward a raise. Tap again to clear. */}
              <View style={s.feelRow}>
                <Text style={s.feelLbl}>Felt</Text>
                {(['easy', 'ok', 'hard'] as Feel[]).map(f => {
                  const on = sess.feel?.[exId] === f;
                  return (
                    <TouchableOpacity key={f} style={[s.feel, on && s.feelOn]} onPress={() => persist(x => {
                      const fl = { ...(x.feel ?? {}) };
                      if (on) delete fl[exId]; else fl[exId] = f;
                      return { ...x, feel: fl };
                    })}>
                      <Text style={[s.feelTxt, on && { color: c.onAccent }]}>{FEEL_LABEL[f]}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        })}

        <View style={s.ex}>
          <Text style={s.exName}>How hard was it? (RPE, optional)</Text>
          <View style={s.rpeRow}>
            {[5, 6, 7, 8, 9, 10].map(n => (
              <TouchableOpacity key={n} style={[s.rpe, rpe === n && s.rpeOn]} onPress={() => setRpe(rpe === n ? undefined : n)}>
                <Text style={[s.rpeTxt, rpe === n && { color: c.onAccent }]}>{n}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <TouchableOpacity style={s.finish} onPress={finish}><Text style={s.finishTxt}>Finish session</Text></TouchableOpacity>
        <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 12 }} onPress={() => Alert.alert('Discard session?', 'Nothing from this session will be kept.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: discard }])}>
          <Text style={{ color: '#e5484d', fontWeight: '700' }}>Discard</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  meta:    { color: c.textSub, fontSize: 13, lineHeight: 18 },
  restBar: { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: c.accent, paddingHorizontal: 16, paddingVertical: 12 },
  restTxt: { color: '#fff', fontSize: 20, fontWeight: '800', flex: 1, fontVariant: ['tabular-nums'] },
  restBtn: { color: '#fff', fontSize: 15, fontWeight: '800' },
  ex:      { backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, marginTop: 12 },
  exName:  { color: c.text, fontSize: 16, fontWeight: '700', flex: 1 },
  link:    { color: c.accent, fontWeight: '700', fontSize: 14, marginTop: 4 },
  sug:     { color: c.text, fontSize: 13, marginTop: 6 },
  cue:     { color: c.textFaint, fontSize: 12, lineHeight: 17, marginTop: 4 },
  hdrRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 2 },
  hdr:     { color: c.textFaint, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  setRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderRadius: 8 },
  setDone: { opacity: 0.6 },
  setNo:   { color: c.textSub, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  cell:    { backgroundColor: c.surfaceAlt, color: c.text, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingVertical: 8, fontSize: 17, textAlign: 'center', fontVariant: ['tabular-nums'] },
  tick:    { width: 52, height: 40, borderRadius: 10, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  tickOn:  { backgroundColor: '#2f9e44', borderColor: '#2f9e44' },
  tickTxt: { color: c.textSub, fontSize: 20, fontWeight: '800' },
  rir:     { width: 44, height: 40, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  rirOn:   { backgroundColor: c.accent, borderColor: c.accent },
  rirTxt:  { color: c.textSub, fontSize: 15, fontWeight: '800' },
  prev:    { color: c.textFaint, fontSize: 11, marginLeft: 42, marginTop: -2, marginBottom: 2 },
  feelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  feelLbl: { color: c.textFaint, fontSize: 12, fontWeight: '700', width: 34 },
  feel:    { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  feelOn:  { backgroundColor: c.accent, borderColor: c.accent },
  feelTxt: { color: c.textSub, fontWeight: '700', fontSize: 13 },
  nextTag: { color: '#2f9e44', fontSize: 12, fontWeight: '800' },
  addSet:  { color: c.textSub, fontWeight: '700', marginTop: 8 },
  rpeRow:  { flexDirection: 'row', gap: 8, marginTop: 10 },
  rpe:     { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  rpeOn:   { backgroundColor: c.accent, borderColor: c.accent },
  rpeTxt:  { color: c.text, fontWeight: '800', fontSize: 15 },
  finish:  { marginTop: 18, backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  finishTxt:{ color: c.onAccent, fontWeight: '800', fontSize: 16 },
});
