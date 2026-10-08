import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useThemedStyles, Palette } from '../theme';
import { caffeineHrv, cafHrvSummary, CafHrv, LATE_MG } from '../services/caffeineHrv';

/**
 * Daily Coach: last night's caffeine next to this morning's HRV, with the PERSONAL caffeine→HRV finding — so a low
 * HRV after a late coffee is read as (partly) caffeine, not only fatigue. Hidden when there's nothing to say.
 */
export function CaffeineNight({ date }: { date: string }) {
  const s = useThemedStyles(makeStyles);
  const [r, setR] = useState<CafHrv | null>(null);
  useFocusEffect(useCallback(() => { caffeineHrv().then(setR).catch(() => setR(null)); }, []));
  if (!r) return null;
  const ln = r.lastNight && r.lastNight.night === date ? r.lastNight : undefined;
  if (!ln && !r.ready) return null;
  const lateNight = !!ln && ln.atBed >= LATE_MG;
  return (
    <View style={[s.card, lateNight && s.warn]}>
      <Text style={s.title}>☕ Caffeine & last night's HRV</Text>
      {ln && <Text style={s.line}>{ln.atBed} mg caffeine still active at bedtime · HRV {Math.round(ln.hrv)} ms ({ln.z > 0 ? '+' : ''}{ln.z} SD vs your 30-night baseline){lateNight && ln.z < -0.5 ? ' — likely partly the caffeine, not only fatigue.' : '.'}</Text>}
      <Text style={s.meta}>{cafHrvSummary(r)}</Text>
    </View>
  );
}
const makeStyles = (c: Palette) => StyleSheet.create({
  card:  { backgroundColor: c.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  warn:  { borderColor: '#e67e22' },
  title: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  line:  { color: c.text, fontSize: 13.5, lineHeight: 19 },
  meta:  { color: c.textSub, fontSize: 12.5, lineHeight: 17, marginTop: 4 },
});
