import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Switch, TextInput, Keyboard } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import Svg, { Polyline, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, updateStrength, routinesForDate, sessionsOn, estimateMinutes, muscleLoad,
  sessionsWithinDays, sessionTonnage, MUSCLE_LABEL, WEEKDAYS, localDateKey, newId, Routine,
  muscleEvents, muscleFreshness, muscularLoad, syncRecentSessionsToHealth, isWorkSet, MuscleFresh, GroupLoad, FRESH_COLOR, LOAD_COLOR, allExercises, Muscle, RunLike,
  exerciseStatLine, ExerciseStatLine, DEFAULT_DRILLS, exerciseById,
  plannedDay, plannedDone, DAILY_CUSTOM_ID, KITS, currentKit,
} from '../src/services/strength';
import { ensureStrengthPlan, ensureDailyCustom } from '../src/services/strengthPlan';
import { checkLocation, pickKit, setKitHere } from '../src/services/strengthLocation';
import { loadSnapshotCache } from '../src/services/healthkit';
import { importWatchStrengthLogs, pushStrengthToWatch } from '../src/services/watchStrength';
import { getEffectiveMaxHr } from '../src/services/claude';
import { ModeSwitcher } from '../src/components/ModeSwitcher';
import { ModeHeader } from '../src/components/ModeHeader';
import { BodyMap } from '../src/components/BodyMap';

// Muscle-map layout for the freshness panel (front / back / legs), Bevel-style colour bands.
const FRESH_ROWS: { label: string; muscles: Muscle[] }[] = [
  { label: 'Front', muscles: ['chest', 'front_delts', 'side_delts', 'biceps', 'forearms', 'abs'] },
  { label: 'Back', muscles: ['lats', 'upper_back', 'traps', 'rear_delts', 'triceps', 'lower_back'] },
  { label: 'Legs', muscles: ['quads', 'glutes', 'hamstrings', 'adductors', 'calves'] },
];

// Fitness mode = the strength module (Build 1): today's planned routine, routines, per-muscle load, history.
// "27.5 kg × 10 · e1RM 36 · ▲ 6% (8 wk) · 5×" — the exercise's numbers at a glance
function exLine(st: ExerciseStatLine, timed?: boolean): string {
  if (timed) return `${st.lastReps} s hold · ${st.sessions}×`;
  const tr = st.trendPct == null ? '' : ` · ${st.trendPct > 1 ? '▲' : st.trendPct < -1 ? '▼' : '▶'} ${Math.abs(st.trendPct)}% (8 wk)`;
  return `${st.lastTop < 0 ? `${-st.lastTop} kg assist` : `${st.lastTop} kg`} × ${st.lastReps}${st.e1rm ? ` · e1RM ${st.e1rm}` : ''}${tr} · ${st.sessions}×`;
}
// tiny e1RM sparkline (last ≤ 12 sessions), last point marked
function Spark({ vals, color }: { vals: number[]; color: string }) {
  const W = 54, H = 22, lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * (W - 4) + 2, H - 3 - ((v - lo) / sp) * (H - 6)]);
  return (
    <Svg width={W} height={H}>
      <Polyline points={xy.map(p => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1.8} />
      <Circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r={2.4} fill={color} />
    </Svg>
  );
}

export default function FitnessMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [store, setStore] = useState<StrengthStore | null>(null);
  const [win, setWin] = useState<7 | 28>(7);
  const [runs, setRuns] = useState<{ runs: RunLike[]; maxHr: number } | null>(null);
  const [showEx, setShowEx] = useState(false);
  const [exQ, setExQ] = useState('');            // search in the exercise list (name or muscle)
  const [drillAdd, setDrillAdd] = useState(false);
  const [drillQ, setDrillQ] = useState('');
  // the exercise list's stats rows — computed only while the list is open, and only when the store changes
  const exRows = useMemo(() => (showEx && store ? allExercises(store)
    .map(e => ({ e, st: exerciseStatLine(store, e.id) }))
    .sort((a, b) => (b.st?.lastAt ?? 0) - (a.st?.lastAt ?? 0) || a.e.name.localeCompare(b.e.name)) : []), [store, showEx]);
  const [selMuscle, setSelMuscle] = useState<Muscle | null>(null);
  // reps 0 = remove the move
  const setDrills = (i: number, reps: number) => {
    const target = (store?.drills ?? DEFAULT_DRILLS)[i];   // the item tapped (a queued double tap must not hit the next one)
    return updateStrength(st => {
    const list = [...(st.drills ?? DEFAULT_DRILLS)];
    const k = list.findIndex(d => d.exerciseId === target?.exerciseId);
    if (k < 0) return st;
    if (reps <= 0) list.splice(k, 1); else list[k] = { ...list[k], reps };
    return { ...st, drills: list };
  }).then(st => setStore({ ...st }));
  };

  const opening = useRef(false);   // a double-tapped Start must not open (and create) two sessions
  useFocusEffect(useCallback(() => {
    opening.current = false;
    loadStrength().then(st => setStore({ ...st })).catch(() => {});
    // watch-logged sessions first (they arrive linked to the watch's workout), then the Health backfill/reconcile
    importWatchStrengthLogs().catch(() => 0).then(() => syncRecentSessionsToHealth()).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {});
    pushStrengthToWatch().catch(() => {});   // routines + today's weights → the watch app
    // the coach's 7-day strength plan (AI-refined when a key works) — only regenerated when its inputs changed
    ensureStrengthPlan({ ai: true }).then(p => { if (p) loadStrength().then(st => setStore({ ...st })).catch(() => {}); }).catch(() => {});
    // today's "Daily custom" routine (recovered muscles, your exercises) — composed once a day
    // where are you → which equipment (asks once per new place), THEN today's Daily custom for that kit
    checkLocation().catch(() => null)
      .then(() => ensureDailyCustom()).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {});
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
  const todayPlan = plannedDay(store);   // the coach's auto-plan for today (why / tailoring)
  const daily = store.routines.find(r => r.id === DAILY_CUSTOM_ID && r.items.length);
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
      <Stack.Screen options={{ headerShown: false }} />
      {/* the shared mode header (Biology's) */}
      <ModeHeader title="Strength" actions={[
        { icon: '📅', onPress: () => router.push('/training-calendar' as any), label: 'Training calendar' },
        { icon: '📈', onPress: () => router.push('/strength-stats' as any), label: 'Strength stats' },
        { icon: '🗂', onPress: () => router.push('/routines' as any), label: 'Routines' },
      ]} />
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 96 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

      {/* Today */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Today</Text>
        <TouchableOpacity hitSlop={6} onPress={() => pickKit(store.here?.name ?? 'Merelbeke').then(k => (k ? setKitHere(k) : undefined)).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {})}>
          <Text style={[s.meta, { marginBottom: 6 }]}>📍 {store.here && Date.now() - store.here.at < 12 * 3_600_000 ? store.here.name : 'Merelbeke (assumed)'} · {KITS[currentKit(store)].label} <Text style={{ color: c.accent }}>change</Text></Text>
        </TouchableOpacity>
        {doneToday.map(x => (
          <Text key={x.id} style={s.done}>✅ {x.routineName} done · {sessionTonnage(store, x).toLocaleString()} kg</Text>
        ))}
        {planned.length ? planned.filter(r => !plannedDone(r, doneToday)).map(r => (
          <View key={r.id} style={s.todayRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.todayName}>{r.name}{todayPlan?.kind === 'prehab' ? ' (optional)' : ''}</Text>
              <Text style={s.meta}>{r.items.length} exercises · ~{estimateMinutes(r)} min</Text>
              {todayPlan && !todayPlan.done ? <Text style={[s.meta, { color: c.text, marginTop: 2 }]}>{todayPlan.why}</Text> : null}
              {todayPlan?.changes?.length && !todayPlan.done ? <Text style={s.meta}>Tailored: {todayPlan.changes.join(' · ')}</Text> : null}
            </View>
            <TouchableOpacity style={s.startBtn} onPress={() => start(r)}><Text style={s.startTxt}>Start</Text></TouchableOpacity>
          </View>
        )) : (
          <>
            {todayPlan && !todayPlan.done ? <Text style={[s.meta, { color: c.text, marginBottom: 4 }]}>{todayPlan.why}</Text> : null}
            <Text style={s.meta}>{todayPlan ? 'Start any routine anyway:' : 'Nothing planned for today — start any routine:'}</Text>
            <View style={s.chips}>
              {store.routines.map(r => (
                <TouchableOpacity key={r.id} style={s.chip} onPress={() => start(r)}><Text style={s.chipTxt}>▶ {r.name}</Text></TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </View>

      {/* Daily custom: a routine composed for TODAY from the recovered muscles, with your own exercises — choose / run */}
      {daily && (
        <View style={s.card}>
          <View style={s.todayRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.todayName}>🎲 Daily custom{daily.composedFor !== today ? ' (yesterday’s)' : ''}</Text>
              <Text style={s.meta}>{daily.items.length} exercises · ~{estimateMinutes(daily)} min</Text>
            </View>
            <TouchableOpacity style={s.startBtn} onPress={() => start(daily)}><Text style={s.startTxt}>Start</Text></TouchableOpacity>
          </View>
          {daily.source ? <Text style={s.meta}>{daily.source}</Text> : null}
          <Text style={[s.meta, { color: c.text, marginTop: 4 }]} numberOfLines={3}>
            {daily.items.map(it => `${allExercises(store).find(e => e.id === it.exerciseId)?.name ?? it.exerciseId} ${it.sets}×${it.repsLo}–${it.repsHi}${it.weightKg ? ` @${it.weightKg}` : ''}`).join(' · ')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 18, marginTop: 8 }}>
            <TouchableOpacity hitSlop={8} onPress={() => ensureDailyCustom({ force: true }).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {})}>
              <Text style={[s.meta, { color: c.accent }]}>↻ Recompose</Text>
            </TouchableOpacity>
            <TouchableOpacity hitSlop={8} onPress={() => router.push({ pathname: '/strength-routine' as any, params: { id: daily.id } })}>
              <Text style={[s.meta, { color: c.accent }]}>✎ Choose exercises</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity hitSlop={8} onPress={() => updateStrength(st => ({ ...st, dailyCustomOn: false })).then(() => ensureDailyCustom()).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {})}>
              <Text style={s.meta}>Turn off</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {store.dailyCustomOn === false && (
        <TouchableOpacity style={{ marginBottom: 12 }} onPress={() => updateStrength(st => ({ ...st, dailyCustomOn: true })).then(() => ensureDailyCustom({ force: true })).then(() => loadStrength()).then(st => setStore({ ...st })).catch(() => {})}>
          <Text style={[s.meta, { color: c.accent }]}>🎲 Turn on the Daily custom routine (composed each day from your recovered muscles)</Text>
        </TouchableOpacity>
      )}

      {/* The coach's strength week: tailored routines placed around the run plan (adaptive 2–4 sessions) */}
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>Coach's strength week{store.autoPlan?.ai ? '  ✨ AI' : ''}</Text>
            <Text style={s.meta}>Your routines, placed around the run plan and tailored per day. Also on the watch.</Text>
          </View>
          <Switch value={store.autoPlanOn !== false} onValueChange={v => updateStrength(st => ({ ...st, autoPlanOn: v })).then(st => {
            setStore({ ...st });
            if (v) ensureStrengthPlan({ ai: true, force: true }).then(() => loadStrength()).then(x => setStore({ ...x })).catch(() => {});
            else pushStrengthToWatch().catch(() => {});
          })} />
        </View>
        {store.autoPlanOn !== false && store.autoPlan && (
          <>
            <Text style={[s.meta, { marginTop: 8 }]}>{store.autoPlan.target} sessions · {store.autoPlan.targetWhy}</Text>
            {store.autoPlan.summary ? <Text style={[s.meta, { color: c.text, marginTop: 4 }]}>{store.autoPlan.summary}</Text> : null}
            {store.autoPlan.days.map(d => (
              <View key={d.date} style={{ flexDirection: 'row', paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border, marginTop: 4 }}>
                <Text style={[s.meta, { width: 44, color: d.date === today ? c.accent : c.textSub, fontWeight: '700' }]}>{d.date === today ? 'Today' : WEEKDAYS[new Date(d.date + 'T12:00:00').getDay()]}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[s.todayName, { fontSize: 14 }, d.kind === 'rest' && { color: c.textSub, fontWeight: '500' }]}>
                    {d.kind === 'session' ? `${d.done ? '✅ ' : '🏋️ '}${d.name}${d.minutes && !d.done ? ` · ~${d.minutes} min` : ''}` : d.kind === 'prehab' ? `🦵 Runner prehab · ~${d.minutes ?? 10} min (optional)` : 'No lifting'}
                    {d.run ? <Text style={[s.meta, { fontWeight: '400' }]}>{`   🏃 ${d.run}`}</Text> : null}
                  </Text>
                  {d.kind !== 'rest' || d.date === today ? <Text style={s.meta}>{d.why}</Text> : null}
                  {d.changes?.length && !d.done && d.kind === 'session' ? <Text style={s.meta}>Tailored: {d.changes.join(' · ')}</Text> : null}
                </View>
              </View>
            ))}
            <TouchableOpacity onPress={() => ensureStrengthPlan({ ai: true, force: true }).then(() => loadStrength()).then(x => setStore({ ...x })).catch(() => {})} hitSlop={8}>
              <Text style={[s.meta, { color: c.accent, marginTop: 8 }]}>↻ Re-plan the week</Text>
            </TouchableOpacity>
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
        <Text style={s.meta}>Recent load vs your longer-term level — weighted averages (7 d / 42 d) like your cardio load, so a break doesn't make the return look like a spike. Runs count for the legs.{groups[0]?.label.endsWith('*') ? ' * Whole body counts only areas with enough history — new areas join once they have a baseline.' : ''}{newStimulus ? ' Strength is a NEW stimulus — ratios run high for the first weeks until your 6-week average catches up.' : ''}</Text>
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

      {/* One calendar for runs + strength (done filled, planned hollow, weekly streak) */}
      <TouchableOpacity style={[s.card, { flexDirection: 'row', alignItems: 'center', marginTop: 12 }]} onPress={() => router.push('/training-calendar' as any)}>
        <Text style={[s.todayName, { flex: 1 }]}>📅 Training calendar</Text>
        <Text style={s.meta}>runs + strength · streak ›</Text>
      </TouchableOpacity>
      {/* Strength stats (the cardio Statistics' charts, for lifting) */}
      <TouchableOpacity style={[s.card, { flexDirection: 'row', alignItems: 'center', marginTop: 12 }]} onPress={() => router.push('/strength-stats' as any)}>
        <Text style={[s.todayName, { flex: 1 }]}>📈 Strength stats</Text>
        <Text style={s.meta}>volume · sets · e1RM trends ›</Text>
      </TouchableOpacity>

      {/* Exercise library: per exercise its stats at a glance (trained ones first, most recent on top) → detail */}
      <TouchableOpacity onPress={() => setShowEx(v => !v)}><Text style={s.section}>Exercises ({allExercises(store).length}) {showEx ? '▾' : '▸'}</Text></TouchableOpacity>
      {showEx && (
        <TextInput style={s.search} value={exQ} onChangeText={setExQ} placeholder="Search exercises or muscles…" placeholderTextColor="#999"
          clearButtonMode="while-editing" autoCorrect={false} returnKeyType="search" />
      )}
      {showEx && exRows.filter(({ e }) => {
        const q = exQ.trim().toLowerCase();
        return !q || e.name.toLowerCase().includes(q) || Object.keys(e.muscles).some(m => MUSCLE_LABEL[m as Muscle]?.toLowerCase().includes(q));
      }).map(({ e, st }) => (
          <TouchableOpacity key={e.id} style={s.exRow} onPress={() => router.push({ pathname: '/strength-exercise' as any, params: { id: e.id } })}>
            <View style={{ flex: 1 }}>
              <Text style={s.histName}>{e.name}{e.video ? <Text style={s.meta}>  ▶</Text> : null}</Text>
              <Text style={s.meta} numberOfLines={1}>{st ? exLine(st, e.timed) : 'not trained yet'}</Text>
            </View>
            {st && st.spark.length >= 2 ? <Spark vals={st.spark} color={st.trendPct != null && st.trendPct < -1 ? '#e5484d' : c.accent} /> : null}
            <Text style={s.meta}>›</Text>
          </TouchableOpacity>
        ))}

      {/* Pre-run drills: done before EVERY run → counted on each run (muscle freshness / muscular load / strain) */}
      <View style={[s.card, { marginTop: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={s.todayName}>Pre-run drills</Text>
            <Text style={s.meta}>Done before every run — counted on each run into the leg muscles (freshness, muscular load, strain).</Text>
          </View>
          <Switch value={store.drillsOn !== false} onValueChange={v => updateStrength(st => ({ ...st, drillsOn: v })).then(st => setStore({ ...st }))} />
        </View>
        {store.drillsOn !== false && (store.drills ?? DEFAULT_DRILLS).map((d, i) => (
          <View key={`${d.exerciseId}-${i}`} style={s.drillRow}>
            <Text style={[s.histName, { flex: 1 }]}>{exerciseById(store, d.exerciseId)?.name ?? d.exerciseId}</Text>
            <TouchableOpacity hitSlop={8} onPress={() => setDrills(i, Math.max(1, d.reps - 5))}><Text style={s.drillBtn}>−</Text></TouchableOpacity>
            <Text style={s.drillReps}>{d.reps}{exerciseById(store, d.exerciseId)?.timed ? ' s' : '×'}</Text>
            <TouchableOpacity hitSlop={8} onPress={() => setDrills(i, d.reps + 5)}><Text style={s.drillBtn}>＋</Text></TouchableOpacity>
            <TouchableOpacity hitSlop={8} onPress={() => setDrills(i, 0)}><Text style={[s.drillBtn, { color: '#e5484d' }]}>✕</Text></TouchableOpacity>
          </View>
        ))}
        {store.drillsOn !== false && (drillAdd ? (
          <View>
            <TextInput style={s.search} value={drillQ} onChangeText={setDrillQ} placeholder="Add a drill move…" placeholderTextColor="#999" autoCorrect={false} autoFocus />
            {allExercises(store).filter(e => drillQ.trim() && e.name.toLowerCase().includes(drillQ.trim().toLowerCase())).slice(0, 6).map(e => (
              <TouchableOpacity key={e.id} style={s.drillRow} onPress={() => {
                updateStrength(st => ({ ...st, drills: [...(st.drills ?? DEFAULT_DRILLS), { exerciseId: e.id, reps: e.timed ? 30 : 10 }] })).then(st => setStore({ ...st }));
                setDrillAdd(false); setDrillQ(''); Keyboard.dismiss();
              }}><Text style={s.histName}>＋ {e.name}</Text></TouchableOpacity>
            ))}
          </View>
        ) : <TouchableOpacity onPress={() => setDrillAdd(true)}><Text style={[s.meta, { color: c.accent, marginTop: 6 }]}>＋ add a drill move</Text></TouchableOpacity>)}
      </View>

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
        <TouchableOpacity key={x.id} style={s.histRow} onPress={() => router.push({ pathname: '/strength-session-detail' as any, params: { id: x.id } })}>
          <Text style={s.histDate}>{x.date.slice(5)}</Text>
          <Text style={s.histName}>{x.routineName}</Text>
          <Text style={s.meta}>{x.sets.filter(isWorkSet).length} sets · {sessionTonnage(store, x).toLocaleString()} kg{x.rpe ? ` · RPE ${x.rpe}` : ''}{x.hk?.watch ? ' · ⌚' : ''}{x.hk?.status === 'saved' || x.hk?.status === 'exists' ? ' · ❤️' : ''}</Text>
        </TouchableOpacity>
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
  search:    { backgroundColor: c.surfaceAlt, color: c.text, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15, marginBottom: 6, marginTop: 4 },
  drillRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  drillBtn:  { color: c.accent, fontSize: 18, fontWeight: '800', paddingHorizontal: 4 },
  drillReps: { color: c.text, fontSize: 15, fontWeight: '700', minWidth: 42, textAlign: 'center', fontVariant: ['tabular-nums'] },
  exRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
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
