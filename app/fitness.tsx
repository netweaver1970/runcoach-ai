import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, updateStrength, routinesForDate, sessionsOn, estimateMinutes, muscleLoad,
  sessionsWithinDays, sessionTonnage, MUSCLE_LABEL, WEEKDAYS, localDateKey, newId, Routine,
  muscleEvents, muscleFreshness, muscularLoad, syncRecentSessionsToHealth, isWorkSet, MuscleFresh, GroupLoad, FRESH_COLOR, LOAD_COLOR, allExercises, Muscle, RunLike,
} from '../src/services/strength';
import { loadSnapshotCache } from '../src/services/healthkit';
import { getEffectiveMaxHr } from '../src/services/claude';
import { ModeSwitcher } from '../src/components/ModeSwitcher';
import { BodyMap } from '../src/components/BodyMap';

// Muscle-map layout for the freshness panel (front / back / legs), Bevel-style colour bands.
const FRESH_ROWS: { label: string; muscles: Muscle[] }[] = [
  { label: 'Front', muscles: ['chest', 'front_delts', 'side_delts', 'biceps', 'forearms', 'abs'] },
  { label: 'Back', muscles: ['lats', 'upper_back', 'traps', 'rear_delts', 'triceps', 'lower_back'] },
  { label: 'Legs', muscles: ['quads', 'glutes', 'hamstrings', 'adductors', 'calves'] },
];

// Fitness mode = the strength module (Build 1): today's planned routine, routines, per-muscle load, history.
export default function FitnessMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [store, setStore] = useState<StrengthStore | null>(null);
  const [win, setWin] = useState<7 | 28>(7);
  const [runs, setRuns] = useState<{ runs: RunLike[]; maxHr: number } | null>(null);
  const [showEx, setShowEx] = useState(false);
  const [selMuscle, setSelMuscle] = useState<Muscle | null>(null);

  const opening = useRef(false);   // a double-tapped Start must not open (and create) two sessions
  useFocusEffect(useCallback(() => {
    opening.current = false;
    loadStrength().then(st => setStore({ ...st })).catch(() => {});
    syncRecentSessionsToHealth().then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {});
    // runs load the legs too (freshness + load status) — from the cached health snapshot, no HealthKit query
    Promise.all([loadSnapshotCache(), getEffectiveMaxHr().catch(() => 188)])
      .then(([sn, mx]) => setRuns({ runs: (sn?.runs ?? []) as RunLike[], maxHr: mx || 188 })).catch(() => setRuns({ runs: [], maxHr: 188 }));
  }, []));

  // freshness walks 42 days × events × muscles — compute once per data change, not on every render
  const model = useMemo(() => {
    const events = store ? muscleEvents(store, runs?.runs ?? [], runs?.maxHr ?? 188) : [];
    return { fresh: new Map<Muscle, MuscleFresh>(muscleFreshness(events).map(f => [f.muscle, f])), groups: muscularLoad(events) as GroupLoad[] };
  }, [store, runs]);

  if (!store) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;

  const today = localDateKey();
  const planned = routinesForDate(store);
  const doneToday = sessionsOn(store, today);
  const load = muscleLoad(store, sessionsWithinDays(store, win));
  const maxSets = Math.max(1, ...load.map(l => l.hardSets));
  const { fresh, groups } = model;
  const firstStrength = Math.min(...store.sessions.filter(x => x.finishedAt).map(x => x.finishedAt!), Infinity);
  const newStimulus = firstStrength !== Infinity && Date.now() - firstStrength < 21 * 86_400_000;
  const recent = store.sessions.filter(x => x.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 8);
  const start = (r: Routine) => {
    if (opening.current) return;
    opening.current = true;
    router.push({ pathname: '/strength-session' as any, params: { routine: r.id } });
  };
  const addRoutine = async () => {
    if (opening.current) return;
    opening.current = true;
    const r: Routine = { id: newId('rt'), name: 'New routine', days: [], items: [], updatedAt: Date.now() };
    await updateStrength(st => ({ ...st, routines: [...st.routines, r] }));
    router.push({ pathname: '/strength-routine' as any, params: { id: r.id } });
  };

  return (
    <View style={s.screen}>
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: 96 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠  Home</Text></TouchableOpacity>
      <Text style={s.h1}>🏋️ Strength</Text>

      {/* Today */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Today</Text>
        {doneToday.map(x => (
          <Text key={x.id} style={s.done}>✅ {x.routineName} done · {sessionTonnage(store, x).toLocaleString()} kg</Text>
        ))}
        {planned.length ? planned.map(r => (
          <View key={r.id} style={s.todayRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.todayName}>{r.name}</Text>
              <Text style={s.meta}>{r.items.length} exercises · ~{estimateMinutes(r)} min</Text>
            </View>
            <TouchableOpacity style={s.startBtn} onPress={() => start(r)}><Text style={s.startTxt}>Start</Text></TouchableOpacity>
          </View>
        )) : (
          <>
            <Text style={s.meta}>Nothing planned for today — start any routine:</Text>
            <View style={s.chips}>
              {store.routines.map(r => (
                <TouchableOpacity key={r.id} style={s.chip} onPress={() => start(r)}><Text style={s.chipTxt}>▶ {r.name}</Text></TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </View>

      {/* Muscle freshness (Bevel-style): per muscle, recovered / fatigued / depleted — runs count for the legs */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Muscle freshness</Text>
        <BodyMap fresh={fresh} selected={selMuscle} onSelect={m => setSelMuscle(cur => (cur === m ? null : m))} />
        {selMuscle && (() => { const f = fresh.get(selMuscle); return (
          <Text style={[s.selLine, { color: FRESH_COLOR[f?.state ?? 'Calibrating'] }]}>
            {MUSCLE_LABEL[selMuscle]}: {f?.state === 'Calibrating' ? 'calibrating (needs 3 sessions)' : `${f?.pct}% · ${f?.state}`}
          </Text>); })()}
        {FRESH_ROWS.map(row => (
          <View key={row.label} style={{ marginBottom: 6 }}>
            <Text style={s.freshRowLbl}>{row.label}</Text>
            <View style={s.freshRow}>
              {row.muscles.map(m => {
                const f = fresh.get(m);
                const col = FRESH_COLOR[f?.state ?? 'Calibrating'];
                return (
                  <View key={m} style={[s.freshCell, { borderColor: col, backgroundColor: col + '22' }]}>
                    <Text style={s.freshName} numberOfLines={1}>{MUSCLE_LABEL[m]}</Text>
                    <Text style={[s.freshPct, { color: col }]}>{f?.state === 'Calibrating' ? '…' : `${f?.pct ?? 100}%`}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        ))}
        <Text style={s.meta}>🟢 recovered ≥75% · 🟡 fatigued · 🔴 depleted &lt;35% · … calibrating (needs 3 sessions in 6 weeks). Runs load calves, quads, hamstrings &amp; glutes.</Text>
      </View>

      {/* Muscular load status: last 7 days vs your 6-week average */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Muscular load</Text>
        {groups.map(g => (
          <View key={g.key} style={s.loadRow}>
            <Text style={s.loadLbl}>{g.label}</Text>
            <View style={[s.pill, { backgroundColor: LOAD_COLOR[g.status] }]}><Text style={s.pillTxt}>{g.status}</Text></View>
            <Text style={s.loadVal}>{g.ratio != null ? `×${g.ratio.toFixed(2)}` : `${g.days}/${g.key === 'body' ? 10 : 6} d`}</Text>
          </View>
        ))}
        <Text style={s.meta}>Recent load vs your longer-term level — weighted averages (7 d / 42 d) like your cardio load, so a break doesn't make the return look like a spike. Runs count for the legs.{newStimulus ? ' Strength is a NEW stimulus — ratios run high for the first weeks until your 6-week average catches up.' : ''}</Text>
      </View>

      {/* Routines */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text style={[s.section, { flex: 1 }]}>Routines</Text>
        <TouchableOpacity onPress={() => router.push('/routines' as any)}><Text style={s.link}>All routines (run + strength) ›</Text></TouchableOpacity>
      </View>
      {store.routines.map(r => (
        <TouchableOpacity key={r.id} style={s.card} activeOpacity={0.7} onPress={() => router.push({ pathname: '/strength-routine' as any, params: { id: r.id } })}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
            <Text style={[s.todayName, { flex: 1 }]}>{r.name}</Text>
            <Text style={s.meta}>{r.days.length ? r.days.slice().sort().map(d => WEEKDAYS[d]).join(' · ') : 'not planned'}</Text>
          </View>
          <Text style={s.meta} numberOfLines={2}>{r.items.length} exercises · ~{estimateMinutes(r)} min{r.source ? ` · ${r.source}` : ''}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={s.addBtn} onPress={addRoutine}><Text style={s.addTxt}>＋ New routine</Text></TouchableOpacity>

      {/* Muscle load */}
      <View style={[s.card, { marginTop: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[s.cardTitle, { flex: 1, marginBottom: 0 }]}>Muscle load</Text>
          {([7, 28] as const).map(w => (
            <TouchableOpacity key={w} onPress={() => setWin(w)} style={[s.seg, win === w && s.segOn]}>
              <Text style={[s.segTxt, win === w && s.segTxtOn]}>{w} d</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[s.meta, { marginBottom: 8 }]}>Hard sets per muscle (weighted by how much the exercise uses it) · tonnage = kg × reps</Text>
        {load.length ? load.map(l => (
          <View key={l.muscle} style={s.barRow}>
            <Text style={s.barLbl}>{MUSCLE_LABEL[l.muscle]}</Text>
            <View style={s.barTrack}><View style={[s.barFill, { width: `${Math.max(4, (l.hardSets / maxSets) * 100)}%` }]} /></View>
            <Text style={s.barVal}>{l.hardSets} · {l.tonnageKg >= 1000 ? `${(l.tonnageKg / 1000).toFixed(1)} t` : `${l.tonnageKg} kg`}</Text>
          </View>
        )) : <Text style={s.meta}>No sessions in the last {win} days yet.</Text>}
      </View>

      {/* Exercise library → per-exercise records + e1RM chart */}
      <TouchableOpacity onPress={() => setShowEx(v => !v)}><Text style={s.section}>Exercises ({allExercises(store).length}) {showEx ? '▾' : '▸'}</Text></TouchableOpacity>
      {showEx && allExercises(store).map(e => (
        <TouchableOpacity key={e.id} style={s.histRow} onPress={() => router.push({ pathname: '/strength-exercise' as any, params: { id: e.id } })}>
          <Text style={s.histName}>{e.name}</Text>
          <Text style={s.meta}>{e.video ? '▶ ' : ''}records ›</Text>
        </TouchableOpacity>
      ))}

      {/* Apple Health */}
      <View style={[s.card, { flexDirection: 'row', alignItems: 'center', marginTop: 12 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.todayName}>Save sessions to Apple Health</Text>
          <Text style={s.meta}>As a Traditional Strength Training workout. If your watch already recorded one at the same time, it's linked instead (no duplicate).</Text>
        </View>
        <Switch value={store.saveToHealth !== false} onValueChange={v => updateStrength(st => ({ ...st, saveToHealth: v })).then(st => setStore({ ...st }))} />
      </View>

      {/* History */}
      {recent.length > 0 && <Text style={s.section}>Recent sessions</Text>}
      {recent.map(x => (
        <View key={x.id} style={s.histRow}>
          <Text style={s.histDate}>{x.date.slice(5)}</Text>
          <Text style={s.histName}>{x.routineName}</Text>
          <Text style={s.meta}>{x.sets.filter(isWorkSet).length} sets · {sessionTonnage(store, x).toLocaleString()} kg{x.rpe ? ` · RPE ${x.rpe}` : ''}{x.hk?.status === 'saved' || x.hk?.status === 'exists' ? ' · ❤️' : ''}</Text>
        </View>
      ))}
    </ScrollView>
    <ModeSwitcher current="strength" />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  homeBtn:   { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, marginBottom: 14 },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 16 },
  h1:        { color: c.text, fontSize: 26, fontWeight: '800', marginBottom: 12 },
  section:   { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  card:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, marginBottom: 10 },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  todayRow:  { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  todayName: { color: c.text, fontSize: 16, fontWeight: '700' },
  meta:      { color: c.textSub, fontSize: 13, lineHeight: 18 },
  done:      { color: c.text, fontSize: 14, marginBottom: 6 },
  startBtn:  { backgroundColor: c.accent, paddingVertical: 9, paddingHorizontal: 18, borderRadius: 10 },
  startTxt:  { color: c.onAccent, fontWeight: '800', fontSize: 15 },
  chips:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip:      { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: c.accent },
  chipTxt:   { color: c.accent, fontWeight: '700' },
  addBtn:    { paddingVertical: 12, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border },
  addTxt:    { color: c.textSub, fontWeight: '700' },
  seg:       { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, marginLeft: 6, backgroundColor: c.surfaceAlt },
  segOn:     { backgroundColor: c.accent },
  segTxt:    { color: c.textSub, fontWeight: '700', fontSize: 12 },
  segTxtOn:  { color: c.onAccent },
  barRow:    { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  barLbl:    { color: c.text, fontSize: 13, width: 86 },
  barTrack:  { flex: 1, height: 10, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden', marginHorizontal: 8 },
  barFill:   { height: 10, borderRadius: 5, backgroundColor: c.accent },
  barVal:    { color: c.textSub, fontSize: 12, width: 84, textAlign: 'right', fontVariant: ['tabular-nums'] },
  histRow:   { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  histDate:  { color: c.textFaint, fontSize: 13, width: 44, fontVariant: ['tabular-nums'] },
  histName:  { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  link:      { color: c.accent, fontWeight: '700', fontSize: 13 },
  selLine:   { fontSize: 15, fontWeight: '800', textAlign: 'center', marginVertical: 6 },
  freshRowLbl:{ color: c.textFaint, fontSize: 11, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase' },
  freshRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  freshCell: { width: '31.5%', borderWidth: 1, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 8 },
  freshName: { color: c.text, fontSize: 12, fontWeight: '600' },
  freshPct:  { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  loadRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  loadLbl:   { color: c.text, fontSize: 14, flex: 1 },
  pill:      { paddingVertical: 3, paddingHorizontal: 9, borderRadius: 10 },
  pillTxt:   { color: '#fff', fontWeight: '800', fontSize: 12 },
  loadVal:   { color: c.textSub, fontSize: 12, width: 58, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
