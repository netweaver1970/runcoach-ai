/**
 * Segmented tab bar to switch between the three KPI detail screens (Strain / Recovery / Sleep), carrying
 * the currently-viewed day so you stay on the same date when switching metric. Replaces the old
 * swipe-to-switch-KPI gesture (left/right swipe now moves day-by-day — see useDetailSwipe).
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useThemedStyles, Palette } from '../theme';

type Kpi = 'strain' | 'recovery' | 'sleep';
const TABS: { key: Kpi; label: string; route: string }[] = [
  { key: 'strain',   label: 'Strain',   route: '/strain-detail' },
  { key: 'recovery', label: 'Recovery', route: '/recovery-detail' },
  { key: 'sleep',    label: 'Sleep',    route: '/sleep-detail' },
];

export function KpiTabs({ current, params }: { current: Kpi; params: Record<string, string | undefined> }) {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const go = (route: string, key: Kpi) => {
    if (key === current) return;
    // Carry rec/str/date so today's HR-aware snapshot (matching the home cards) stays consistent across KPIs,
    // and the viewed day is preserved when switching metric.
    router.replace({ pathname: route as any, params });
  };
  return (
    <View style={s.row}>
      {TABS.map((t) => {
        const active = t.key === current;
        return (
          <TouchableOpacity
            key={t.key}
            style={[s.tab, active && s.tabActive]}
            onPress={() => go(t.route, t.key)}
            activeOpacity={0.7}
          >
            <Text style={[s.txt, active && s.txtActive]}>{t.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 3, marginHorizontal: 14, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: c.surface },
  txt: { fontSize: 14, fontWeight: '600', color: c.textSub },
  txtActive: { color: c.text, fontWeight: '700' },
});
