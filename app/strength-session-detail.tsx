import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Text as SvgText } from 'react-native-svg';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, sessionBreakdown, sessionPRs, strengthWindow, MUSCLE_LABEL, Muscle, FEEL_LABEL, sessionStrainLoad,
  Feel, setExerciseFeel, exerciseById, updateStrength,
} from '../src/services/strength';
import { fetchHrSamples, loadSnapshotCache } from '../src/services/healthkit';
import { getEffectiveMaxHr } from '../src/services/claude';
import { zoneStrainLoad, strainFromLoad } from '../src/services/trainingLoad';
import { BodyMap } from '../src/components/BodyMap';

// One strength session, broken down (Bevel activity details / JEFIT BodyMap): what it worked (a body map + bars of
// this session's muscle load), each exercise, the records it set, the heart-rate curve with a tick per set, and how
// the day's strain splits into cardio (heart rate) vs muscular (the logged sets).
const FEEL_COLOR: Record<Feel, string> = { easy: '#2f9e44', ok: '#8a8f98', hard: '#e5484d' };

export default function StrengthSessionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [st, setSt] = useState<StrengthStore | null>(null);
  // correct a logged set afterwards (e.g. a plank logged at the planned 45 s that was really held ~20 s)
  const editSet = (sessId: string, exId: string, setNo: number, timed: boolean, reps: number, kg: number, name: string) => {
    const save = (patch: { reps?: number; weightKg?: number }) => updateStrength(cur => ({ ...cur, sessions: cur.sessions.map(q => q.id !== sessId ? q
      : { ...q, sets: q.sets.map(l => (l.exerciseId === exId && l.set === setNo ? { ...l, ...patch } : l)) }) })).then(n => setSt({ ...n })).catch(() => {});
    Alert.prompt(`${name} · set ${setNo}`, timed ? 'Seconds held' : 'Reps', [
      { text: 'Cancel', style: 'cancel' },
      { text: timed ? 'Save' : 'Next: kg', onPress: (v?: string) => {
        const n = Math.round(Number(String(v ?? '').replace(',', '.')));
        const r = Number.isFinite(n) && n > 0 && n < 1000 ? n : reps;
        if (timed) { save({ reps: r }); return; }
        Alert.prompt(`${name} · set ${setNo}`, 'Weight (kg)', [
          { text: 'Cancel', style: 'cancel', onPress: () => save({ reps: r }) },
          { text: 'Save', onPress: (w?: string) => { const k = Number(String(w ?? '').replace(',', '.')); save({ reps: r, ...(Number.isFinite(k) && k > -200 && k < 1000 ? { weightKg: Math.round(k * 4) / 4 } : {}) }); } },
        ], 'plain-text', String(kg), 'decimal-pad');
      } },
    ], 'plain-text', String(reps), 'number-pad');
  };
  const [hr, setHr] = useState<{ t: number; bpm: number }[] | null>(null);
  const [split, setSplit] = useState<{ cardio: number; muscular: number } | null>(null);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      const store = await loadStrength().catch(() => null);
      if (cancelled || !store) return;
      setSt({ ...store });
      const x = store.sessions.find(q => q.id === id);
      if (!x?.finishedAt) return;
      const win = strengthWindow(x, store.routines.find(r => r.id === x.routineId));
      const [samples, snap, maxHr] = await Promise.all([
        fetchHrSamples(win.start, win.end).catch(() => []), loadSnapshotCache().catch(() => null), getEffectiveMaxHr().catch(() => 188),
      ]);
      if (cancelled) return;
      setHr(samples);
      const rest = snap?.restingHR?.slice(-1)[0]?.value ?? 55;
      const cardioLoad = samples.length >= 2 ? zoneStrainLoad(samples.map(p => ({ t: p.t, hr: p.bpm })), rest, maxHr || 188, [{ s: win.start, e: win.end }]) : 0;
      const muscLoad = sessionStrainLoad(x);
      setSplit({ cardio: strainFromLoad(cardioLoad), muscular: strainFromLoad(muscLoad) });
    })();
    return () => { cancelled = true; };
  }, [id]));

  if (!st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const x = st.sessions.find(q => q.id === id);
  const b = x ? sessionBreakdown(st, x.id) : null;
  if (!x || !b) return <View style={s.screen}><Stack.Screen options={{ title: 'Session' }} /><Text style={[s.meta, { padding: 16 }]}>Session not found.</Text></View>;
  const prs = sessionPRs(st, x.id);
  const mus = (Object.entries(b.muscles) as [Muscle, number][]).sort((a, z) => z[1] - a[1]);
  const maxU = Math.max(0.01, ...mus.map(m => m[1]));
  // body map tint: this session's load per muscle, relative to its most-worked muscle
  const tint = (m: Muscle) => { const u = b.muscles[m] ?? 0; return u <= 0 ? (c.mode === 'dark' ? '#3a3d46' : '#c9ccd3') : `#F97316${Math.round((0.3 + 0.7 * (u / maxU)) * 255).toString(16).padStart(2, '0')}`; };

  // HR chart with a tick per completed set
  const W = width - 32, H = 130, P = 22;
  const hrMin = hr?.length ? Math.min(...hr.map(p => p.bpm)) - 5 : 0, hrMax = hr?.length ? Math.max(...hr.map(p => p.bpm)) + 5 : 1;
  const t0 = hr?.length ? hr[0].t : 0, t1 = hr?.length ? hr[hr.length - 1].t : 1;
  const xOf = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const yOf = (v: number) => H - P - ((v - hrMin) / Math.max(1, hrMax - hrMin)) * (H - 2 * P);

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: x.routineName, headerBackTitle: 'Back' }} />
      <Text style={s.meta}>{new Date(x.startedAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · {new Date(x.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–{new Date(x.finishedAt!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{x.hk?.watch ? ' · ⌚ logged on the watch' : ''}</Text>
      <View style={s.tiles}>
        <View style={s.tile}><Text style={s.tileVal}>{b.workSets}</Text><Text style={s.tileLbl}>work sets</Text></View>
        <View style={s.tile}><Text style={s.tileVal}>{b.tonnage >= 1000 ? `${(b.tonnage / 1000).toFixed(1)} t` : b.tonnage}</Text><Text style={s.tileLbl}>kg lifted</Text></View>
        <View style={s.tile}><Text style={s.tileVal}>{b.minutes}</Text><Text style={s.tileLbl}>min</Text></View>
        <View style={s.tile}><Text style={s.tileVal}>{x.rpe ?? '–'}</Text><Text style={s.tileLbl}>RPE</Text></View>
      </View>

      {split ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>Strain: {split.cardio + split.muscular}</Text>
          <View style={s.splitBar}>
            <View style={{ flex: Math.max(0.01, split.cardio), backgroundColor: '#3B82F6' }} />
            <View style={{ flex: Math.max(0.01, split.muscular), backgroundColor: '#F97316' }} />
          </View>
          <Text style={s.meta}><Text style={{ color: '#3B82F6' }}>■ cardio {split.cardio}</Text> (heart rate) · <Text style={{ color: '#F97316' }}>■ muscular {split.muscular}</Text> (sets × effort)</Text>
        </View>
      ) : null}

      <Text style={s.section}>What it worked</Text>
      <BodyMap colorOf={tint} />
      {mus.slice(0, 8).map(([m, u]) => (
        <View key={m} style={s.barRow}>
          <Text style={s.barLbl}>{MUSCLE_LABEL[m]}</Text>
          <View style={s.track}><View style={[s.fill, { width: `${Math.max(3, (u / maxU) * 100)}%` }]} /></View>
          <Text style={s.barVal}>{u.toFixed(1)}</Text>
        </View>
      ))}
      <Text style={s.meta}>Hard sets per muscle, weighted by how much each exercise uses it (× session effort).</Text>

      <Text style={s.section}>Exercises — how did each feel?</Text>
      {b.exercises.map(e => {
        const ex = exerciseById(st, e.exerciseId);
        const sets = x.sets.filter(l => l.exerciseId === e.exerciseId && l.done && l.reps > 0);
        return (
          <View key={e.exerciseId} style={s.exCard}>
            <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center' }} onPress={() => router.push({ pathname: '/strength-exercise' as any, params: { id: e.exerciseId } })}>
              <Text style={[s.rowTitle, { flex: 1 }]}>{e.name}</Text>
              <Text style={s.meta}>records ›</Text>
            </TouchableOpacity>
            {/* every set: reps (or seconds) @ weight, warm-ups marked, RIR when rated */}
            {/* tap a set to correct it afterwards (reps / seconds held, then kg) */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {sets.map((l, k) => (
                <TouchableOpacity key={k} style={s.setChip} onPress={() => editSet(x.id, l.exerciseId, l.set, !!ex?.timed, l.reps, l.weightKg, ex?.name ?? '')}>
                  <Text style={s.setLine}>{`${l.warmup ? 'W ' : ''}${l.reps}${ex?.timed ? ' s' : ''}${ex?.timed && !l.weightKg ? '' : ` @ ${ex?.bodyweightFrac ? (l.weightKg === 0 ? 'BW' : `BW${l.weightKg > 0 ? '+' : '−'}${Math.abs(l.weightKg)}`) : `${l.weightKg} kg`}`}${l.rir != null ? ` (RIR ${l.rir >= 3 ? '3+' : l.rir})` : ''}`} ✎</Text>
                </TouchableOpacity>
              ))}
            </View>
            {!ex?.timed ? <Text style={s.meta}>{e.volume.toLocaleString()} kg volume</Text> : null}
            {/* the post-exercise feel, right here (Hard = this session doesn't count toward a raise) — tap again clears */}
            <View style={s.feelRow}>
              {(['easy', 'ok', 'hard'] as Feel[]).map(f => {
                const on = e.feel === f;
                return (
                  <TouchableOpacity key={f} style={[s.feel, on && { backgroundColor: FEEL_COLOR[f], borderColor: FEEL_COLOR[f] }]}
                    onPress={() => setExerciseFeel(x.id, e.exerciseId, on ? undefined : f).then(st2 => setSt({ ...st2 })).catch(() => {})}>
                    <Text style={[s.feelTxt, on && { color: '#fff' }]}>{FEEL_LABEL[f]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      })}

      {prs.length ? (
        <>
          <Text style={s.section}>🏆 Records</Text>
          {prs.map((p, i) => <Text key={i} style={s.pr}>{p.name}: {p.kind} {p.value}{p.kind === 'Set volume' ? '' : ' kg'} (was {p.prev})</Text>)}
        </>
      ) : null}

      <Text style={s.section}>Heart rate</Text>
      {hr == null ? <ActivityIndicator color={c.accent} /> : hr.length < 2 ? <Text style={s.meta}>No heart rate recorded in this session's window.</Text> : (
        <>
          <Svg width={W} height={H}>
            {b.ticks.filter(t => t >= t0 && t <= t1).map((t, i) => <Line key={i} x1={xOf(t)} y1={P - 6} x2={xOf(t)} y2={H - P} stroke="#F97316" strokeWidth={1} strokeDasharray="2,3" opacity={0.7} />)}
            <Polyline points={hr.map(p => `${xOf(p.t)},${yOf(p.bpm)}`).join(' ')} fill="none" stroke="#e5484d" strokeWidth={2} />
            <SvgText x={2} y={yOf(hrMax - 5) + 4} fill={c.textSub} fontSize={10}>{Math.round(hrMax - 5)}</SvgText>
            <SvgText x={2} y={yOf(hrMin + 5) + 4} fill={c.textSub} fontSize={10}>{Math.round(hrMin + 5)}</SvgText>
          </Svg>
          <Text style={s.meta}>Orange ticks = each set you ticked. Avg {Math.round(hr.reduce((a, p) => a + p.bpm, 0) / hr.length)} bpm · peak {Math.round(hrMax - 5)}.</Text>
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  meta:     { color: c.textSub, fontSize: 12.5, lineHeight: 17, marginTop: 4 },
  tiles:    { flexDirection: 'row', gap: 8, marginTop: 10 },
  tile:     { flex: 1, backgroundColor: c.surface, borderRadius: 12, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: c.border },
  tileVal:  { color: c.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tileLbl:  { color: c.textSub, fontSize: 11, marginTop: 2 },
  card:     { backgroundColor: c.surface, borderRadius: 14, padding: 12, marginTop: 12, borderWidth: 1, borderColor: c.border },
  cardTitle:{ color: c.text, fontSize: 15, fontWeight: '800' },
  splitBar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', marginTop: 8 },
  section:  { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 20, marginBottom: 8 },
  barRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  barLbl:   { color: c.text, fontSize: 13, width: 96 },
  track:    { flex: 1, height: 10, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden' },
  fill:     { height: 10, borderRadius: 5, backgroundColor: '#F97316' },
  barVal:   { color: c.textSub, fontSize: 12, width: 32, textAlign: 'right', fontVariant: ['tabular-nums'] },
  row:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  exCard:   { backgroundColor: c.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: c.border },
  setLine:  { color: c.text, fontSize: 13.5, lineHeight: 20, fontVariant: ['tabular-nums'] },
  setChip:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
  feelRow:  { flexDirection: 'row', gap: 8, marginTop: 8 },
  feel:     { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  feelTxt:  { color: c.textSub, fontWeight: '700', fontSize: 13 },
  pr:       { color: '#B8860B', fontSize: 14, fontWeight: '700', marginBottom: 4 },
});
