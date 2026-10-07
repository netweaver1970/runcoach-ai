import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemedStyles, Palette } from '../theme';
import { importWatchStrengthLogs, pushStrengthToWatch } from '../services/watchStrength';
import { syncRecentSessionsToHealth, loadStrength, routinesForDate, sessionsOn, estimateMinutes, sessionTonnage, localDateKey, Routine, StrengthStore } from '../services/strength';

/** Daily Coach card: today's planned strength routine(s) → Start, or ✅ once logged. Hidden when nothing is planned/done. */
export function StrengthToday() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [st, setSt] = useState<StrengthStore | null>(null);
  const opening = useRef(false);
  useFocusEffect(useCallback(() => {
    opening.current = false;
    loadStrength().then(x => setSt({ ...x })).catch(() => {});
    // quiet: import sessions logged on the watch, then save/link recent sessions in Apple Health
    importWatchStrengthLogs().catch(() => 0).then(n => { if (n) loadStrength().then(x => setSt({ ...x })).catch(() => {}); return syncRecentSessionsToHealth(); }).catch(() => {});
    pushStrengthToWatch().catch(() => {});   // today's routine + weights → the watch app
  }, []));
  if (!st) return null;
  const planned = routinesForDate(st);
  const done = sessionsOn(st, localDateKey());
  if (!planned.length && !done.length) return null;
  const doneIds = new Set(done.map(d => d.routineId));
  const start = (r: Routine) => {
    if (opening.current) return;   // double tap → one session screen
    opening.current = true;
    router.push({ pathname: '/strength-session' as any, params: { routine: r.id } });
  };
  return (
    <View style={s.card}>
      <TouchableOpacity onPress={() => router.push('/fitness' as any)}><Text style={s.title}>🏋️ Strength today ›</Text></TouchableOpacity>
      {done.map(x => <Text key={x.id} style={s.done}>✅ {x.routineName} · {sessionTonnage(st, x).toLocaleString()} kg{x.rpe ? ` · RPE ${x.rpe}` : ''}</Text>)}
      {planned.filter(r => !doneIds.has(r.id)).map(r => (
        <View key={r.id} style={s.row}>
          <Text style={s.name}>{r.name}<Text style={s.meta}>  {r.items.length} exercises · ~{estimateMinutes(r)} min</Text></Text>
          <TouchableOpacity style={s.btn} onPress={() => start(r)}><Text style={s.btnTxt}>Start</Text></TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card:   { backgroundColor: c.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  title:  { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  row:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  name:   { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  meta:   { color: c.textSub, fontSize: 13, fontWeight: '400' },
  done:   { color: c.text, fontSize: 14, marginBottom: 4 },
  btn:    { backgroundColor: c.accent, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10 },
  btnTxt: { color: c.onAccent, fontWeight: '800' },
});
