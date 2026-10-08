import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { loadSnapshotCache } from '../src/services/healthkit';
import { loadStatsRuns, mergeRuns } from '../src/services/statsRunsCache';
import { loadStrength, StrengthStore, routinesForDate, sessionTonnage, isWorkSet, localDateKey } from '../src/services/strength';
import { loadWeekPlanCache, WeekPlanDay } from '../src/services/coach';

// One training calendar for runs + strength (Bevel Training Calendar / Hevy): a month grid where every day shows a
// dot per activity — colour = sport, size = load — done days filled, planned days (7-day plan runs + scheduled
// routines) hollow; a weekly streak; tap a day for its list.
type Kind = 'run' | 'strength' | 'other';
interface Item { kind: Kind; label: string; size: 1 | 2 | 3; planned?: boolean; sub?: string }
const KIND_COLOR: Record<Kind, string> = { run: '#3B82F6', strength: '#F97316', other: '#14B8A6' };
const FILTERS: { key: 'all' | Kind; label: string }[] = [{ key: 'all', label: 'All' }, { key: 'run', label: 'Runs' }, { key: 'strength', label: 'Strength' }, { key: 'other', label: 'Other' }];
const p2 = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const mondayOf = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

export default function TrainingCalendar() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [st, setSt] = useState<StrengthStore | null>(null);
  const [snap, setSnap] = useState<any>(null);
  const [plan, setPlan] = useState<WeekPlanDay[]>([]);
  const [month, setMonth] = useState(0);              // 0 = this month, −1 = last month, +1 = next
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [sel, setSel] = useState<string>(keyOf(new Date()));

  useFocusEffect(useCallback(() => {
    loadStrength().then(x => setSt({ ...x })).catch(() => setSt({ v: 1, routines: [], customExercises: [], sessions: [] }));
    // runs: the snapshot window (~3 months) + the durable grows-only run history, so older months and the streak hold
    Promise.all([loadSnapshotCache().catch(() => null), loadStatsRuns().catch(() => [])])
      .then(([sn, cached]) => setSnap({ ...(sn ?? {}), runs: mergeRuns(((sn as any)?.runs ?? []) as any, cached as any) }))
      .catch(() => setSnap({}));
    // planned runs: merge the cached 7-day plans of the last week, NEWEST first per date (today's own plan starts
    // tomorrow, so today's slot comes from an earlier plan — same as the daily coach reads it)
    (async () => {
      const byDate = new Map<string, WeekPlanDay>();
      for (let back = 0; back <= 7; back++) {
        const d = new Date(); d.setDate(d.getDate() - back);
        const cache = await loadWeekPlanCache(keyOf(d)).catch(() => null);
        for (const day of cache?.days ?? []) if (!byDate.has(day.date)) byDate.set(day.date, day);
      }
      setPlan([...byDate.values()]);
    })();
  }, []));

  // date → items (done + planned)
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    const add = (k: string, it: Item) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(it); };
    for (const r of (snap?.runs ?? []) as any[]) {
      const min = (r.duration ?? 0) / 60;
      add(keyOf(new Date(r.date)), { kind: 'run', label: r.label ? `Run · ${r.label}` : 'Run', size: min > 60 ? 3 : min > 30 ? 2 : 1,
        sub: `${Math.round(min)} min${r.distance ? ` · ${(r.distance / 1000).toFixed(1)} km` : ''}` });
    }
    const loggedDays = new Set((st?.sessions ?? []).filter(x => x.finishedAt).map(x => x.date));
    for (const a of (snap?.activities ?? []) as any[]) {
      if (a.activityType === 37) continue;                      // runs come from `runs`
      const k = keyOf(new Date(a.date)), min = a.durationMin ?? 0;
      if ([20, 50].includes(a.activityType)) {
        // strength comes from the Strength store; a Health strength workout with nothing logged that day still shows
        if (!loggedDays.has(k)) add(k, { kind: 'strength', label: a.name ?? 'Strength', size: min > 60 ? 3 : min > 30 ? 2 : 1, sub: `${Math.round(min)} min · from Health` });
        continue;
      }
      add(k, { kind: 'other', label: a.name ?? 'Workout', size: min > 60 ? 3 : min > 30 ? 2 : 1, sub: `${Math.round(min)} min` });
    }
    if (st) {
      for (const x of st.sessions.filter(q => q.finishedAt)) {
        const sets = x.sets.filter(isWorkSet).length;
        add(x.date, { kind: 'strength', label: x.routineName, size: sets > 18 ? 3 : sets > 10 ? 2 : 1,
          sub: `${sets} sets · ${sessionTonnage(st, x).toLocaleString()} kg${x.hk?.watch ? ' · ⌚' : ''}` });
      }
    }
    // planned: today onward — the 7-day plan's runs, and scheduled routines not yet done that day
    const today = localDateKey();
    for (const d of plan) {
      if (d.date < today || d.intensity === 'rest' || !(d.runMinutes > 0)) continue;
      if ((m.get(d.date) ?? []).some(i => i.kind === 'run' && !i.planned)) continue;   // already ran that day
      add(d.date, { kind: 'run', label: `Planned · ${d.kind ?? d.intensity}`, size: d.runMinutes > 60 ? 3 : d.runMinutes > 30 ? 2 : 1, planned: true, sub: `${d.runMinutes} min · ${d.structure}` });
    }
    if (st) {
      for (let k = 0; k < 42; k++) {
        const d = new Date(); d.setDate(d.getDate() + k);
        const key = keyOf(d);
        const doneSess = st.sessions.filter(x => x.date === key && x.finishedAt);
        if (doneSess.length && !doneSess.some(x => st.routines.some(r => r.id === x.routineId))) continue;   // an ad-hoc session did the day
        const done = new Set(doneSess.map(x => x.routineId));
        for (const r of routinesForDate(st, d)) if (!done.has(r.id)) add(key, { kind: 'strength', label: `Planned · ${r.name}`, size: 2, planned: true, sub: `${r.items.length} exercises` });
      }
    }
    return m;
  }, [st, snap, plan]);

  if (!st || !snap) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;

  const first = new Date(); first.setDate(1); first.setMonth(first.getMonth() + month); first.setHours(0, 0, 0, 0);
  const gridStart = mondayOf(first);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) { const x = new Date(gridStart); x.setDate(x.getDate() + w * 7 + d); row.push(x); }
    if (w > 0 && row[0].getMonth() !== first.getMonth()) break;
    weeks.push(row);
  }
  const shown = (k: string) => (byDay.get(k) ?? []).filter(i => filter === 'all' || i.kind === filter);
  // weekly streak: consecutive weeks (Mon–Sun) with ≥ 1 done session, counting back from this week (or last week
  // while this one is still empty)
  let streak = 0;
  {
    const wk = mondayOf(new Date());
    const has = (mon: Date) => { for (let i = 0; i < 7; i++) { const d = new Date(mon); d.setDate(d.getDate() + i); if (shown(keyOf(d)).some(x => !x.planned)) return true; } return false; };
    if (!has(wk)) wk.setDate(wk.getDate() - 7);
    while (has(wk) && streak < 260) { streak++; wk.setDate(wk.getDate() - 7); }
  }
  const monthDone = weeks.flat().filter(d => d.getMonth() === first.getMonth()).reduce((a, d) => a + shown(keyOf(d)).filter(x => !x.planned).length, 0);
  const todayKey = keyOf(new Date());
  // month navigation moves the selected day along (today in the current month, else the 1st)
  const go = (m: number) => {
    setMonth(m);
    const f = new Date(); f.setDate(1); f.setMonth(f.getMonth() + m);
    setSel(m === 0 ? todayKey : keyOf(f));
  };
  const selItems = shown(sel);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Training calendar', headerBackTitle: 'Back' }} />
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
        <View style={s.headRow}>
          <TouchableOpacity onPress={() => go(month - 1)} hitSlop={10}><Text style={s.nav}>‹</Text></TouchableOpacity>
          <Text style={s.month}>{first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</Text>
          <TouchableOpacity onPress={() => go(month + 1)} hitSlop={10}><Text style={s.nav}>›</Text></TouchableOpacity>
        </View>
        <Text style={s.meta}>🔥 {streak}-week streak · {monthDone} session{monthDone === 1 ? '' : 's'} this month</Text>
        <View style={s.filters}>
          {FILTERS.map(f => (
            <TouchableOpacity key={f.key} style={[s.chip, filter === f.key && s.chipOn]} onPress={() => setFilter(f.key)}>
              <Text style={[s.chipTxt, filter === f.key && { color: c.onAccent }]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={s.card}>
          <View style={s.week}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <Text key={i} style={s.dow}>{d}</Text>)}
          </View>
          {weeks.map((row, wi) => (
            <View key={wi} style={s.week}>
              {row.map(d => {
                const k = keyOf(d), items = shown(k), out = d.getMonth() !== first.getMonth();
                return (
                  <TouchableOpacity key={k} style={[s.cell, k === sel && s.cellSel, k === todayKey && s.cellToday]} onPress={() => setSel(k)}>
                    <Text style={[s.dayNum, out && { opacity: 0.35 }]}>{d.getDate()}</Text>
                    <View style={s.dots}>
                      {items.slice(0, 4).map((it, i) => {
                        const r = it.size === 3 ? 5 : it.size === 2 ? 4 : 3;
                        return <View key={i} style={{ width: r * 2, height: r * 2, borderRadius: r, margin: 1,
                          backgroundColor: it.planned ? 'transparent' : KIND_COLOR[it.kind], borderWidth: it.planned ? 1.5 : 0, borderColor: KIND_COLOR[it.kind], opacity: out ? 0.4 : 1 }} />;
                      })}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
          <Text style={[s.meta, { marginTop: 8 }]}>
            <Text style={{ color: KIND_COLOR.run }}>● run</Text>  <Text style={{ color: KIND_COLOR.strength }}>● strength</Text>  <Text style={{ color: KIND_COLOR.other }}>● other</Text>  ○ planned · bigger = longer / more sets
          </Text>
        </View>

        <Text style={s.section}>{new Date(sel + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
        {selItems.length ? selItems.map((it, i) => (
          <View key={i} style={s.row}>
            <View style={[s.rowDot, { backgroundColor: it.planned ? 'transparent' : KIND_COLOR[it.kind], borderColor: KIND_COLOR[it.kind] }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>{it.label}</Text>
              {it.sub ? <Text style={s.meta} numberOfLines={2}>{it.sub}</Text> : null}
            </View>
          </View>
        )) : <Text style={s.meta}>Nothing {sel > todayKey ? 'planned' : 'logged'} this day.</Text>}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  headRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  nav:      { color: c.accent, fontSize: 28, fontWeight: '700', paddingHorizontal: 12 },
  month:    { color: c.text, fontSize: 18, fontWeight: '800' },
  meta:     { color: c.textSub, fontSize: 12.5, lineHeight: 17, textAlign: 'left' },
  filters:  { flexDirection: 'row', gap: 6, marginVertical: 10 },
  chip:     { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border },
  chipOn:   { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:  { color: c.textSub, fontSize: 13, fontWeight: '700' },
  card:     { backgroundColor: c.surface, borderRadius: 16, padding: 8 },
  week:     { flexDirection: 'row' },
  dow:      { flex: 1, textAlign: 'center', color: c.textFaint, fontSize: 11, fontWeight: '700', paddingVertical: 4 },
  cell:     { flex: 1, aspectRatio: 0.82, alignItems: 'center', paddingTop: 3, borderRadius: 8 },
  cellSel:  { backgroundColor: c.surfaceAlt },
  cellToday:{ borderWidth: 1.5, borderColor: c.accent },
  dayNum:   { color: c.text, fontSize: 13, fontWeight: '700' },
  dots:     { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', marginTop: 2, paddingHorizontal: 2 },
  section:  { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 18, marginBottom: 8 },
  row:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  rowDot:   { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  rowTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
});
