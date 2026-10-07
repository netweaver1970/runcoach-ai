import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, Keyboard, Alert, Linking, Vibration, AppState } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { fetchBodyMassHistory } from '../src/services/healthkit';
import {
  StrengthStore, StrengthSession, SetLog, loadStrength, updateStrength, exerciseById, suggestWeight, lastSetsFor,
  localDateKey, newId, sessionTonnage, repRange, sessionPRs, syncSessionToHealth, autoUpdatedRoutine, isWorkSet,
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
  const notifId = useRef<string | null>(null);
  const notifGen = useRef(0);      // bumps on every start/cancel → a schedule that resolves late is cancelled
  const buzzed = useRef(false);
  const sessRef = useRef<StrengthSession | null>(null);   // the LIVE session — every update applies to this
  const finishing = useRef(false);                          // a double-tapped Finish saves + alerts once

  // Load the store, then resume today's unfinished session of this routine or start a fresh one.
  useEffect(() => {
    (async () => {
      const st = await loadStrength();
      const r = st.routines.find(x => x.id === routineId);
      if (!r) { setStore({ ...st }); return; }
      const today = localDateKey();
      const open = st.sessions.find(x => x.routineId === r.id && x.date === today && !x.finishedAt);
      let session = open;
      if (!session) {
        const sets: SetLog[] = [];
        for (const it of r.items) {
          const sug = suggestWeight(st, it);
          const last = lastSetsFor(st, it.exerciseId);
          for (let k = 0; k < it.sets; k++) {
            sets.push({ exerciseId: it.exerciseId, set: k + 1, weightKg: sug.kg ?? it.weightKg ?? 0, reps: last[k]?.reps ?? repRange(it)[1], done: false });
          }
        }
        const kg = await fetchBodyMassHistory(3).then(w => (w as { value: number }[]).filter(x => x.value > 0).slice(-1)[0]?.value).catch(() => undefined);
        session = { id: newId('ss'), date: today, routineId: r.id, routineName: r.name, startedAt: Date.now(), bodyKg: kg, sets };
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
      if (Date.now() >= restEnd && !buzzed.current) { buzzed.current = true; Vibration.vibrate([0, 400, 200, 400]); }
    }, 500);
    return () => clearInterval(t);
  }, [restEnd]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => { if (st === 'active') setNow(Date.now()); });
    return () => sub.remove();
  }, []);
  const cancelRestNotif = useCallback(() => {
    notifGen.current++;
    if (notifId.current) { Notifications.cancelScheduledNotificationAsync(notifId.current).catch(() => {}); notifId.current = null; }
  }, []);
  useEffect(() => navigation.addListener('beforeRemove', () => { Keyboard.dismiss(); cancelRestNotif(); }), [navigation, cancelRestNotif]);

  // Apply a change to the LIVE session and write it into the latest store (never a stale full-store copy).
  const persist = (fn: (x: StrengthSession) => StrengthSession) => {
    if (!sessRef.current) return;
    const next = fn(sessRef.current);
    sessRef.current = next; setSess(next);
    updateStrength(cur => ({ ...cur, sessions: upsert(cur.sessions, next) })).then(st => setStore({ ...st }));
  };

  const startRest = async (sec: number) => {
    cancelRestNotif();
    if (sec <= 0) { setRestEnd(null); return; }
    buzzed.current = false;
    setRestEnd(Date.now() + sec * 1000); setNow(Date.now());
    const gen = notifGen.current;
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: '⏱ Rest done', body: 'Next set.', sound: true },
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
  const toggle = (idx: number, restSec: number) => {
    const done = !sessRef.current!.sets[idx].done;
    persist(x => ({ ...x, sets: x.sets.map((l, k) => k === idx ? { ...l, done, doneAt: done ? Date.now() : undefined } : l) }));
    if (done) startRest(restSec); else { cancelRestNotif(); setRestEnd(null); }
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
    cancelRestNotif();
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
    cancelRestNotif();
    const id = sessRef.current!.id;
    updateStrength(st => ({ ...st, sessions: st.sessions.filter(x => x.id !== id) })).then(() => router.back());
  };

  const restLeft = restEnd ? Math.ceil((restEnd - now) / 1000) : 0;
  const elapsedMin = Math.round((Date.now() - sess.startedAt) / 60000);
  // group the flat set list back into the routine's exercise order (by first appearance)
  const order: string[] = [];
  for (const l of sess.sets) if (!order.includes(l.exerciseId)) order.push(l.exerciseId);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: sess.routineName, headerBackTitle: 'Back' }} />
      {restEnd && (
        <View style={[s.restBar, restLeft <= 0 && { backgroundColor: '#2f9e44' }]}>
          <Text style={s.restTxt}>{restLeft > 0 ? `Rest ${fmt(restLeft)}` : 'Rest done — go!'}</Text>
          <TouchableOpacity onPress={() => startRest(Math.max(0, restLeft) + 30)} hitSlop={8}><Text style={s.restBtn}>+30 s</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => { cancelRestNotif(); setRestEnd(null); }} hitSlop={8}><Text style={s.restBtn}>{restLeft > 0 ? 'Skip' : 'OK'}</Text></TouchableOpacity>
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
                  <Text style={s.exName}>{String.fromCharCode(97 + ei)}. {ex?.name ?? exId} ›</Text>
                </TouchableOpacity>
                {ex?.video && <TouchableOpacity onPress={() => Linking.openURL(ex.video!.url)} hitSlop={8}><Text style={s.link}>▶ video</Text></TouchableOpacity>}
              </View>
              <Text style={s.meta}>
                {item ? `${item.sets} × ${repRange(item).join('–')}` : ''}{item?.tempo ? ` · tempo ${item.tempo}` : ''} · rest {fmt(restSec)}{ex?.bodyweightFrac ? ' · kg = added (− = assist)' : ''}
              </Text>
              {sug.why ? <Text style={s.sug}>💡 {sug.why}</Text> : null}
              {ex?.cue ? <Text style={s.cue}>{ex.cue}</Text> : null}
              {alts.map(a => (
                <TouchableOpacity key={a} onPress={() => swap(exId, a)}><Text style={s.link}>⇄ switch to {exerciseById(store, a)?.name ?? a}</Text></TouchableOpacity>
              ))}
              <View style={s.hdrRow}><Text style={[s.hdr, { width: 34 }]}>Set</Text><Text style={[s.hdr, { flex: 1 }]}>kg</Text><Text style={[s.hdr, { flex: 1 }]}>Reps</Text><Text style={[s.hdr, { width: 44 }]}>RIR</Text><View style={{ width: 52 }} /></View>
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
                        {/* reps in reserve: – → 0 → 1 → 2 → 3+ → – (optional effort) */}
                        <TouchableOpacity style={[s.rir, l.rir != null && s.rirOn]} disabled={!!l.warmup}
                          onPress={() => setAt(idx, { rir: l.rir == null ? 0 : l.rir >= 3 ? undefined : l.rir + 1 })}>
                          <Text style={[s.rirTxt, l.rir != null && { color: c.onAccent }]}>{l.warmup ? '' : l.rir == null ? '–' : l.rir >= 3 ? '3+' : l.rir}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[s.tick, l.done && s.tickOn]} onPress={() => { Keyboard.dismiss(); toggle(idx, l.warmup ? Math.min(60, restSec) : restSec); }}>
                          <Text style={[s.tickTxt, l.done && { color: '#fff' }]}>✓</Text>
                        </TouchableOpacity>
                      </View>
                      {p ? <Text style={s.prev}>last {p.weightKg} kg × {p.reps}{p.rir != null ? ` @ RIR ${p.rir >= 3 ? '3+' : p.rir}` : ''}</Text> : null}
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
  addSet:  { color: c.textSub, fontWeight: '700', marginTop: 8 },
  rpeRow:  { flexDirection: 'row', gap: 8, marginTop: 10 },
  rpe:     { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  rpeOn:   { backgroundColor: c.accent, borderColor: c.accent },
  rpeTxt:  { color: c.text, fontWeight: '800', fontSize: 15 },
  finish:  { marginTop: 18, backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  finishTxt:{ color: c.onAccent, fontWeight: '800', fontSize: 16 },
});
