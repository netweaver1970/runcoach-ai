/**
 * FOOD STATS (Food mode → 📈, like Strength / Running statistics): calories vs the watch's energy, macros, the energy
 * split, fibre, caffeine — per day over a window, with the window's averages. Only days with logged food count; days
 * you marked "fully logged" are the reliable ones (shown in the caption).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, LayoutChangeEvent } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { TChart, TPt, inWin } from '../src/components/TimeChart';
import { MacroRings, SplitBar, MACRO_COLOR, STD_DRINK_G } from '../src/components/NutritionViz';
import { loadDay, dayTotals, Nutr } from '../src/services/foodLog';
import { peekDailyComponents, fetchBodyMassHistory } from '../src/services/healthkit';
import { trainingDayKey } from '../src/services/trainingLoad';

const RANGES = [{ id: 14, label: '2 wk' }, { id: 30, label: '1 mo' }, { id: 90, label: '3 mo' }, { id: 365, label: '1 yr' }];
interface Day { date: string; t: number; n: Nutr & { waterMl: number }; burn?: number; complete: boolean }

export default function FoodStatsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [range, setRange] = useState(30);
  const [days, setDays] = useState<Day[] | null>(null);
  const [kg, setKg] = useState<number | null>(null);
  const [w, setW] = useState(0);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      const dc = (await peekDailyComponents().catch(() => ({ days: {} as Record<string, Record<string, number>> }))).days;
      const out: Day[] = [];
      const today = trainingDayKey(Date.now());
      for (let k = 365; k >= 0; k--) {
        const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - k);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const log = await loadDay(key).catch(() => null);
        if (!log || !log.entries.length) continue;
        out.push({ date: key, t: d.getTime(), n: dayTotals(log), burn: dc[key]?.totalEnergy > 0 ? dc[key].totalEnergy : undefined, complete: !!log.complete });
      }
      if (live) setDays(out);
      const bw = await fetchBodyMassHistory(3).then(x => (x as { value: number }[]).filter(v => v.value > 0).slice(-1)[0]?.value).catch(() => undefined);
      if (live && bw) setKg(bw);
    })().catch(() => live && setDays([]));
    return () => { live = false; };
  }, []));

  if (!days) return <View style={[s.screen, { justifyContent: 'center' }]}><Stack.Screen options={{ title: 'Food stats' }} /><ActivityIndicator color={c.accent} /></View>;
  const t1 = Date.now(), t0 = t1 - range * 86_400_000;
  const win = days.filter(d => d.t >= t0);
  const innerW = Math.max(0, w - 24);
  const avg = (f: (d: Day) => number | undefined) => { const v = win.map(f).filter((x): x is number => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  const avgN: Nutr = { kcal: avg(d => d.n.kcal), prot: avg(d => d.n.prot), carb: avg(d => d.n.carb), fat: avg(d => d.n.fat), fib: avg(d => d.n.fib), rs: avg(d => d.n.rs), alc: avg(d => d.n.alc) };
  const avgBurn = avg(d => d.burn);
  const series = (f: (d: Day) => number | undefined): TPt[] => win.filter(d => typeof f(d) === 'number').map(d => ({ t: d.t, v: Math.round(f(d)! * 10) / 10 }));
  const r0 = (v: number) => String(Math.round(v));
  const nComplete = win.filter(d => d.complete).length;
  const card = (title: string, body: React.ReactNode, cap?: string) => (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {body}
      {cap ? <Text style={s.cap}>{cap}</Text> : null}
    </View>
  );
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: 'Food stats' }} />
      <View style={s.ranges}>
        {RANGES.map(r => (
          <TouchableOpacity key={r.id} style={[s.seg, range === r.id && s.segOn]} onPress={() => setRange(r.id)}>
            <Text style={[s.segTxt, range === r.id && { color: c.onAccent }]}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
        {!win.length ? <Text style={s.cap}>No logged food in this window yet.</Text> : (
          <>
            {card(`Daily average · ${win.length} logged day${win.length > 1 ? 's' : ''}`, (
              <>
                <MacroRings n={avgN} burnKcal={avgBurn || null} />
                <View style={{ marginTop: 12 }}><SplitBar n={avgN} /></View>
              </>
            ), `${nComplete} of ${win.length} days marked fully logged — the others may miss items.${kg ? ` Protein ${(avgN.prot! / kg).toFixed(1)} g/kg body weight (${Math.round(kg)} kg).` : ''}${(avgN.rs ?? 0) > 0.5 ? ` Resistant starch ${r0(avgN.rs!)} g/day, not counted as carbs.` : ''}`)}
            {card('Calories vs energy burned', (
              <TChart pts={series(d => d.n.kcal)} t0={t0} t1={t1} color={c.accent} trend events={[]} showEvents={false} yfmt={r0} innerW={innerW}
                pts2={series(d => d.burn)} color2="#94a3b8" y2fmt={r0} y2label="watch kcal" />
            ), `Orange: eaten (resistant starch at 2 kcal/g). Grey: the watch's active + resting energy that day — ±15–20 %, so read the trend, not one day.`)}
            {card('Protein', (
              <TChart pts={series(d => d.n.prot)} t0={t0} t1={t1} color={MACRO_COLOR.prot} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
                {...(kg ? { refs: [{ y: 1.6 * kg, color: MACRO_COLOR.prot, dash: true }] } : {})} />
            ), kg ? `Dashed: 1.6 g/kg (${Math.round(1.6 * kg)} g) — the level that supports strength + endurance training.` : undefined)}
            {card('Carbs', (
              <TChart pts={series(d => d.n.carb)} t0={t0} t1={t1} color={MACRO_COLOR.carb} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
                pts2={series(d => d.n.rs)} color2={MACRO_COLOR.fib} y2fmt={v => `${r0(v)}g`} y2label="resist. starch" />
            ), 'Available carbs (resistant starch shown separately in green).')}
            {card('Fat', (
              <TChart pts={series(d => d.n.fat)} t0={t0} t1={t1} color={MACRO_COLOR.fat} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW} />
            ))}
            {card('Fibre', (
              <TChart pts={series(d => d.n.fib)} t0={t0} t1={t1} color={MACRO_COLOR.fib} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
                refs={[{ y: 30, color: MACRO_COLOR.fib, dash: true }]} />
            ), 'Dashed: 30 g/day (EFSA adequate intake for adults ≥ 25 g).')}
            {win.some(d => (d.n.alc ?? 0) > 0) && card('Alcohol', (
              <TChart pts={series(d => d.n.alc ? d.n.alc / STD_DRINK_G : 0)} t0={t0} t1={t1} color={MACRO_COLOR.alc} events={[]} showEvents={false} yfmt={v => v.toFixed(1)} innerW={innerW}
                refs={[{ y: 2, color: '#e67e22', dash: true }]} />
            ), `Standard drinks per day (10 g alcohol each) · window total ${(win.reduce((a, d) => a + (d.n.alc ?? 0), 0) / STD_DRINK_G).toFixed(1)} drinks, ${Math.round(win.reduce((a, d) => a + (d.n.alc ?? 0), 0) * 7)} kcal. Dashed: 2 a day — Belgian guidance is ≤ 10 a week with alcohol-free days.`)}
            {inWin(series(d => d.n.caf), t0, t1).some(p => p.v > 0) && card('Caffeine', (
              <TChart pts={series(d => d.n.caf)} t0={t0} t1={t1} color="#8B5E3C" events={[]} showEvents={false} yfmt={v => `${r0(v)}`} innerW={innerW}
                refs={[{ y: 400, color: '#e67e22', dash: true }]} />
            ), 'mg per day — dashed: the 400 mg EFSA daily level.')}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  ranges:    { flexDirection: 'row', gap: 6, marginBottom: 10 },
  seg:       { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  segOn:     { backgroundColor: c.accent, borderColor: c.accent },
  segTxt:    { color: c.text, fontWeight: '600', fontSize: 13 },
  card:      { backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  cap:       { color: c.textSub, fontSize: 12, lineHeight: 17, marginTop: 6 },
});
