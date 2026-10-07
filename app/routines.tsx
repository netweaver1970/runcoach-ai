import React, { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { LibraryWorkout, KIND_COLOR, describeWorkout, workoutMinutes, loadLibrary, saveLibrary, newWorkout } from '../src/services/workoutLibrary';
import { StrengthStore, Routine, loadStrength, updateStrength, estimateMinutes, WEEKDAYS, newId, exerciseById } from '../src/services/strength';

// One place for every routine — running (structured workouts) AND strength — Bevel-style "Routines". The two keep
// their own editors/stores; this is the shared entry point.
type Tab = 'all' | 'run' | 'strength';

export default function RoutinesScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [runs, setRuns] = useState<LibraryWorkout[] | null>(null);
  const [st, setSt] = useState<StrengthStore | null>(null);
  const busy = useRef(false);
  useFocusEffect(useCallback(() => {
    busy.current = false;
    loadLibrary().then(setRuns).catch(() => setRuns([]));
    loadStrength().then(x => setSt({ ...x })).catch(() => {});
  }, []));

  if (!runs || !st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;

  const openRun = (w: LibraryWorkout) => router.push({ pathname: '/workout-library' as any, params: { edit: w.id } });
  const openStrength = (r: Routine) => router.push({ pathname: '/strength-routine' as any, params: { id: r.id } });
  const newRun = async () => {
    if (busy.current) return; busy.current = true;
    const w = newWorkout();
    const latest = await loadLibrary().catch(() => runs);   // re-read: an edit saved after this screen loaded must survive
    await saveLibrary([w, ...latest]);
    openRun(w);
  };
  const newStrength = async () => {
    if (busy.current) return; busy.current = true;
    const r: Routine = { id: newId('rt'), name: 'New routine', days: [], items: [], updatedAt: Date.now() };
    await updateStrength(x => ({ ...x, routines: [...x.routines, r] }));
    openStrength(r);
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: 'Routines', headerBackTitle: 'Back' }} />
      <View style={s.tabs}>
        {([['all', 'All'], ['run', '🏃 Running'], ['strength', '🏋️ Strength']] as [Tab, string][]).map(([k, l]) => (
          <TouchableOpacity key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}>
            <Text style={[s.tabTxt, tab === k && s.tabTxtOn]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab !== 'run' && (
        <>
          <Text style={s.section}>Strength</Text>
          {st.routines.map(r => (
            <TouchableOpacity key={r.id} style={s.card} onPress={() => openStrength(r)}>
              <View style={s.head}>
                <View style={[s.dot, { backgroundColor: '#8e44ad' }]} />
                <Text style={s.name} numberOfLines={1}>{r.name}</Text>
                <Text style={s.min}>{estimateMinutes(r)}m</Text>
              </View>
              <Text style={s.desc} numberOfLines={2}>
                {r.days.length ? `${r.days.slice().sort().map(d => WEEKDAYS[d]).join(' · ')} — ` : ''}
                {r.items.map(i => exerciseById(st, i.exerciseId)?.name ?? i.exerciseId).join(', ') || 'no exercises yet'}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.add} onPress={newStrength}><Text style={s.addTxt}>＋ New strength routine</Text></TouchableOpacity>
        </>
      )}

      {tab !== 'strength' && (
        <>
          <Text style={s.section}>Running</Text>
          {runs.map(w => (
            <TouchableOpacity key={w.id} style={s.card} onPress={() => openRun(w)}>
              <View style={s.head}>
                <View style={[s.dot, { backgroundColor: KIND_COLOR[w.kind] }]} />
                <Text style={s.name} numberOfLines={1}>{w.name || 'Untitled'}</Text>
                <Text style={s.min}>{workoutMinutes(w)}m</Text>
              </View>
              <Text style={s.desc} numberOfLines={2}>{describeWorkout(w)}</Text>
            </TouchableOpacity>
          ))}
          {!runs.length && <Text style={s.desc}>No running workouts saved yet.</Text>}
          <TouchableOpacity style={s.add} onPress={newRun}><Text style={s.addTxt}>＋ New running workout</Text></TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  tabs:    { flexDirection: 'row', gap: 6, marginBottom: 8 },
  tab:     { flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: c.surfaceAlt, alignItems: 'center' },
  tabOn:   { backgroundColor: c.accent },
  tabTxt:  { color: c.textSub, fontWeight: '700' },
  tabTxtOn:{ color: c.onAccent },
  section: { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  card:    { backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 8 },
  head:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot:     { width: 10, height: 10, borderRadius: 5 },
  name:    { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  min:     { color: c.textSub, fontSize: 13, fontVariant: ['tabular-nums'] },
  desc:    { color: c.textSub, fontSize: 13, lineHeight: 18, marginTop: 4 },
  add:     { paddingVertical: 12, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border },
  addTxt:  { color: c.textSub, fontWeight: '700' },
});
