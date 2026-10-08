import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemedStyles, Palette } from '../theme';
import { importWatchStrengthLogs, pushStrengthToWatch } from '../services/watchStrength';
import { syncRecentSessionsToHealth, loadStrength, routinesForDate, sessionsOn, estimateMinutes, sessionTonnage, localDateKey, plannedDay, plannedDone, Routine, StrengthStore, WEEKDAYS, DAILY_CUSTOM_ID } from '../services/strength';
import { ensureStrengthPlan, ensureDailyCustom } from '../services/strengthPlan';
import { checkLocation } from '../services/strengthLocation';
import { SessionVsPrevious } from './SessionVsPrevious';

/**
 * Daily Coach card: today's strength from the coach's auto-plan (a tailored routine, short prehab, or why not today)
 * → Start, or ✅ once logged, plus the next planned session. Without the auto-plan: the weekday routines; hidden when
 * nothing is planned or done.
 */
export function StrengthToday() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [st, setSt] = useState<StrengthStore | null>(null);
  const opening = useRef(false);
  useFocusEffect(useCallback(() => {
    opening.current = false;
    const reload = () => loadStrength().then(x => setSt({ ...x })).catch(() => {});
    reload();
    // quiet: import sessions logged on the watch, then save/link recent sessions in Apple Health
    importWatchStrengthLogs().catch(() => 0).then(n => { if (n) reload(); return syncRecentSessionsToHealth(); }).catch(() => {});
    // the coach's strength plan (AI-refined when a key works) — regenerates only when its inputs changed; pushes the watch
    pushStrengthToWatch().catch(() => {});   // deduped by signature → cheap; retries an earlier failed push
    ensureStrengthPlan({ ai: true }).then(p => { if (p) reload(); }).catch(() => {});
    // where are you → equipment (asks once per new place) → today's Daily custom for it
    checkLocation().catch(() => null).then(() => ensureDailyCustom()).then(() => reload()).catch(() => {});
  }, []));
  if (!st) return null;
  const today = localDateKey();
  const day = plannedDay(st);
  const planned = routinesForDate(st);
  const done = sessionsOn(st, today);
  if (!day && !planned.length && !done.length && !st.routines.some(r => r.id === DAILY_CUSTOM_ID && r.composedFor === today)) return null;

  const start = (r: Routine) => {
    if (opening.current) return;   // double tap → one session screen
    opening.current = true;
    router.push({ pathname: '/strength-session' as any, params: { routine: r.id } });
  };
  const next = st.autoPlan?.days.find(d => d.date > today && d.kind === 'session');
  const daily = st.routines.find(r => r.id === DAILY_CUSTOM_ID && r.items.length && r.composedFor === today);
  return (
    <View style={s.card}>
      <TouchableOpacity onPress={() => router.push('/fitness' as any)}>
        <Text style={s.title}>🏋️ Strength today{st.autoPlan?.ai ? '  ✨' : ''} ›</Text>
      </TouchableOpacity>
      {/* done → its analysis replaces the Start row: each exercise vs the last time */}
      {done.map(x => <SessionVsPrevious key={x.id} st={st} sess={x} />)}
      {planned.filter(r => !plannedDone(r, done)).map(r => (
        <View key={r.id} style={s.row}>
          <Text style={s.name}>{r.name}{day?.kind === 'prehab' ? ' (optional)' : ''}<Text style={s.meta}>  {r.items.length} exercises · ~{estimateMinutes(r)} min</Text></Text>
          <TouchableOpacity style={s.btn} onPress={() => start(r)}><Text style={s.btnTxt}>Start</Text></TouchableOpacity>
        </View>
      ))}
      {day && !day.done && <Text style={s.why}>{day.why}</Text>}
      {day?.changes?.length && !day.done ? <Text style={s.meta}>Tailored: {day.changes.join(' · ')}</Text> : null}
      {daily && !done.some(d => d.routineId === DAILY_CUSTOM_ID) && !planned.some(r => r.id === DAILY_CUSTOM_ID) && (
        <View style={[s.row, { marginTop: 4 }]}>
          <Text style={s.name}>🎲 Daily custom<Text style={s.meta}>  {daily.items.length} exercises · ~{estimateMinutes(daily)} min · or choose this</Text></Text>
          <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => start(daily)}><Text style={s.btnGhostTxt}>Start</Text></TouchableOpacity>
        </View>
      )}
      {next && <Text style={[s.meta, { marginTop: 6 }]}>Next: {WEEKDAYS[new Date(next.date + 'T12:00:00').getDay()]} · {next.name}{next.minutes ? ` ~${next.minutes} min` : ''}</Text>}
    </View>
  );
}

/** The daily plan's strength line: the auto-plan's today (it has its own card) replaces the generic leg-strength text. */
export function useAutoPlanOn(): boolean {
  const [on, setOn] = useState(false);
  useFocusEffect(useCallback(() => { loadStrength().then(x => setOn(x.autoPlanOn !== false && !!plannedDay(x))).catch(() => {}); }, []));
  return on;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card:   { backgroundColor: c.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  title:  { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  row:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  name:   { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  meta:   { color: c.textSub, fontSize: 13, fontWeight: '400' },
  why:    { color: c.text, fontSize: 13.5, lineHeight: 19, marginTop: 4 },
  done:   { color: c.text, fontSize: 14, marginBottom: 4 },
  btn:    { backgroundColor: c.accent, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10 },
  btnTxt: { color: c.onAccent, fontWeight: '800' },
  btnGhost:    { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.accent },
  btnGhostTxt: { color: c.accent, fontWeight: '800' },
});
