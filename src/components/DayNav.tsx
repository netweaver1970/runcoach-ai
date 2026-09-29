/**
 * Reliable day stepper for the KPI detail screens: ‹ previous · <date> · next › (next disabled at today).
 * Uses router.setParams({ date }) — the same in-place update the swipe does, but as tappable buttons so it
 * works even where the PanResponder swipe is swallowed by the ScrollView.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemedStyles, Palette } from '../theme';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `todayKey` lets a screen with a different day boundary (Food: 4 am training day) define which day is "Today". */
export function DayNav({ date, todayKey }: { date?: string; todayKey?: string }) {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const today = todayKey ? new Date(todayKey + 'T00:00:00') : new Date(); today.setHours(0, 0, 0, 0);
  const cur = date ? new Date(date + 'T00:00:00') : new Date(today);
  const isToday = cur.getTime() >= today.getTime();
  const label = isToday ? 'Today' : cur.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const go = (delta: number) => {
    // calendar arithmetic, not ±24 h: across a DST change ±24 h lands on the same date (stuck) or skips one
    const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + delta);
    if (next.getTime() > today.getTime()) return;
    // Landing on today clears the param — restores the screens' rich today-only sections (see useDetailSwipe).
    router.setParams({ date: next.getTime() >= today.getTime() ? '' : iso(next) });
  };
  return (
    <View style={s.row}>
      <TouchableOpacity onPress={() => go(-1)} hitSlop={14} style={s.btn}><Text style={s.arrow}>‹</Text></TouchableOpacity>
      <Text style={s.label}>{label}</Text>
      <TouchableOpacity onPress={() => go(1)} hitSlop={14} disabled={isToday} style={s.btn}>
        <Text style={[s.arrow, isToday && s.arrowDim]}>›</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 8 },
  btn: { paddingHorizontal: 12, paddingVertical: 1 },
  arrow: { fontSize: 28, fontWeight: '700', color: c.accent, lineHeight: 30 },
  arrowDim: { color: c.border },
  label: { fontSize: 14, fontWeight: '600', color: c.textSub, minWidth: 128, textAlign: 'center' },
});
