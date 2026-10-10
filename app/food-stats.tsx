/**
 * FOOD STATS (Food mode → 📈, like Strength / Running statistics): calories vs the watch's energy, the calorie DEFICIT
 * with body weight, macros, the energy split, fibre, alcohol, caffeine — per day over a window, with the window's
 * averages. Only days with logged food count; near-empty days are left out (see `partial`).
 * Same period bar as Statistics (1M · 3M · 6M · 1Y · 5Y · All, ◀ ▶ paging), pinned above the cards; ⚙︎ = choose and
 * order the cards (remembered).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, LayoutChangeEvent, Switch } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { TChart, TPt } from '../src/components/TimeChart';
import { TimeWindowBar, useTimeWindow } from '../src/components/TimeWindowBar';
import { MacroRings, SplitBar, MACRO_COLOR, STD_DRINK_G } from '../src/components/NutritionViz';
import { loadAllDays, dayTotals, Nutr } from '../src/services/foodLog';
import { foodByKey } from '../src/services/foodDb';
import { peekDailyComponents, fetchBodyMassHistory } from '../src/services/healthkit';

const GAP = 1.5 * 86_400_000;   // no line across days that weren't logged
const KCAL_PER_KG = 7700;       // ≈ energy in 1 kg of body fat
const WEIGHT_COLOR = '#a855f7';
interface Day { date: string; t: number; n: Nutr & { waterMl: number }; burn?: number; complete: boolean }

const CARDS = ['average', 'kcal', 'deficit', 'protein', 'carbs', 'fat', 'fibre', 'alcohol', 'caffeine'] as const;
type CardId = typeof CARDS[number];
const CARD_TITLE: Record<CardId, string> = {
  average: 'Daily average', kcal: 'Calories vs energy burned', deficit: 'Calorie deficit + weight', protein: 'Protein', carbs: 'Carbs',
  fat: 'Fat', fibre: 'Fibre', alcohol: 'Alcohol', caffeine: 'Caffeine',
};
const LAYOUT_KEY = 'food_stats_layout_v1';
type Layout = { id: CardId; on: boolean }[];
const DEFAULT_LAYOUT: Layout = CARDS.map(id => ({ id, on: true }));

export default function FoodStatsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [days, setDays] = useState<Day[] | null>(null);
  const [weights, setWeights] = useState<TPt[]>([]);
  const [w, setW] = useState(0);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const win8 = useTimeWindow('1M', days?.length ? days[0].t : null);
  const { t0, t1 } = win8;

  const saveLayout = (l: Layout) => { setLayout(l); SecureStore.setItemAsync(LAYOUT_KEY, JSON.stringify(l)).catch(() => {}); };
  const moveCard = (i: number, d: number) => { const l = [...layout]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); saveLayout(l); };

  useFocusEffect(useCallback(() => {
    let live = true;
    SecureStore.getItemAsync(LAYOUT_KEY).then(v => {
      if (!v || !live) return;
      const saved = JSON.parse(v) as Layout;
      const known = saved.filter(l => (CARDS as readonly string[]).includes(l.id));
      // cards added in a later version slot in (on) after their default predecessor
      const out = [...known];
      CARDS.forEach((id, i) => { if (!out.some(l => l.id === id)) { const p = i ? out.findIndex(l => l.id === CARDS[i - 1]) : -1; out.splice(p + 1, 0, { id, on: true }); } });
      setLayout(out);
    }).catch(() => {});
    (async () => {
      const dc = (await peekDailyComponents().catch(() => ({ days: {} as Record<string, Record<string, number>> }))).days;
      const out: Day[] = [];
      for (const log of await loadAllDays()) {
        if (!log.entries.length) continue;
        // caffeine / alcohol: a logged day without any is a real 0 (not "no data"); entries logged before caffeine was
        // stored get it from the food table (key × grams), as the day screen's caffeine card does
        const n = dayTotals(log);
        const fill = (k: 'caf' | 'alc') => log.entries.reduce((a, e) => a + (e.n[k] ?? (e.grams ? ((foodByKey(e.key)?.per100[k] ?? 0) * e.grams) / 100 : 0)), 0);
        n.caf = fill('caf'); n.alc = fill('alc');
        const t = new Date(log.date + 'T12:00:00').getTime();
        out.push({ date: log.date, t, n, burn: dc[log.date]?.totalEnergy > 0 ? dc[log.date].totalEnergy : undefined, complete: !!log.complete });
      }
      if (live) setDays(out);
      const wt = await fetchBodyMassHistory(60).catch(() => [] as unknown[]);
      if (live) setWeights((wt as { date: string; value: number }[]).filter(v => v.value > 0).map(v => ({ t: new Date(v.date).getTime(), v: Math.round(v.value * 10) / 10 })).sort((a, b) => a.t - b.t));
    })().catch(() => live && setDays([]));
    return () => { live = false; };
  }, []));

  const header = <Stack.Screen options={{ title: 'Food stats', headerRight: () => (
    <TouchableOpacity onPress={() => setEditing(e => !e)} hitSlop={10}><Text style={{ color: c.accent, fontSize: editing ? 15 : 20, fontWeight: '700' }}>{editing ? 'Done' : '⚙︎'}</Text></TouchableOpacity>
  ) }} />;
  if (!days) return <View style={[s.screen, { justifyContent: 'center' }]}>{header}<ActivityIndicator color={c.accent} /></View>;

  // a day with only a few items logged (not marked fully logged, under 60 % of what the watch says you burned — or under
  // 1000 kcal when that's unknown) isn't a day of eating: leave it out, or it drags every average and trend down
  const partial = (d: Day) => !d.complete && (d.n.kcal ?? 0) < (d.burn ? 0.6 * d.burn : 1000);
  const allWin = days.filter(d => d.t >= t0 && d.t <= t1);
  const win = allWin.filter(d => !partial(d));
  const nPartial = allWin.length - win.length;
  const innerW = Math.max(0, w - 24);
  const avg = (f: (d: Day) => number | undefined) => { const v = win.map(f).filter((x): x is number => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  const avgN: Nutr = { kcal: avg(d => d.n.kcal), prot: avg(d => d.n.prot), carb: avg(d => d.n.carb), fat: avg(d => d.n.fat), fib: avg(d => d.n.fib), rs: avg(d => d.n.rs), alc: avg(d => d.n.alc) };
  const avgBurn = avg(d => d.burn);
  const series = (f: (d: Day) => number | undefined): TPt[] => win.filter(d => typeof f(d) === 'number').map(d => ({ t: d.t, v: Math.round(f(d)! * 10) / 10 }));
  const r0 = (v: number) => String(Math.round(v));
  const nComplete = win.filter(d => d.complete).length;
  const wWin = weights.filter(p => p.t >= t0 && p.t <= t1);
  const kg = (wWin.length ? wWin[wWin.length - 1] : weights[weights.length - 1])?.v ?? null;
  const card = (title: string, body: React.ReactNode, cap?: string) => (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {body}
      {cap ? <Text style={s.cap}>{cap}</Text> : null}
    </View>
  );

  // DEFICIT = energy burned (watch) − eaten, on days that have both. Positive = a deficit (below what you burned).
  // only FULLY LOGGED days (a half-logged day fakes a deficit) and not today (its burn is only the day so far)
  const todayKey = new Date().toLocaleDateString('en-CA');
  const defDays = win.filter(d => d.complete && d.burn && d.n.kcal != null && d.date !== todayKey);
  const defAvg = defDays.length ? defDays.reduce((a, d) => a + (d.burn! - (d.n.kcal ?? 0)), 0) / defDays.length : null;
  const wChange = wWin.length >= 2 ? wWin[wWin.length - 1].v - wWin[0].v : null;
  const wWeeks = wWin.length >= 2 ? (wWin[wWin.length - 1].t - wWin[0].t) / (7 * 86_400_000) : 0;

  const CARD: Record<CardId, () => React.ReactNode> = {
    average: () => card(`Daily average · ${win.length} logged day${win.length > 1 ? 's' : ''}`, (
      <>
        <MacroRings n={avgN} burnKcal={avgBurn || null} />
        <View style={{ marginTop: 12 }}><SplitBar n={avgN} /></View>
      </>
    ), `${nComplete} of ${win.length} days marked fully logged — the others may miss items.${kg ? ` Protein ${(avgN.prot! / kg).toFixed(1)} g/kg body weight (${Math.round(kg)} kg).` : ''}${(avgN.rs ?? 0) > 0.5 ? ` Resistant starch ${r0(avgN.rs!)} g/day, not counted as carbs.` : ''}`),
    kcal: () => card('Calories vs energy burned', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.kcal)} t0={t0} t1={t1} color={c.accent} trend events={[]} showEvents={false} yfmt={r0} innerW={innerW}
        pts2={series(d => d.burn)} maxGapMs2={GAP} color2="#94a3b8" y2fmt={r0} y2label="watch kcal" />
    ), `Coloured line: eaten (resistant starch at 2 kcal/g). Grey: the watch's active + resting energy that day — ±15–20 %, so read the trend, not one day.`),
    deficit: () => card('Calorie deficit + weight', (
      <TChart maxGapMs={GAP} pts={defDays.map(d => ({ t: d.t, v: Math.round(d.burn! - (d.n.kcal ?? 0)), color: d.burn! - (d.n.kcal ?? 0) >= 0 ? '#16a34a' : '#dc2626' }))}
        t0={t0} t1={t1} color="#16a34a" trend events={[]} showEvents={false} yfmt={r0} innerW={innerW} refs={[{ y: 0, color: '#94a3b8', dash: true }]}
        pts2={wWin} color2={WEIGHT_COLOR} y2fmt={v => v.toFixed(1)} y2label="kg" />
    ), defAvg == null ? 'Needs days marked “fully logged” (before today) with the watch\'s energy burned.'
      : `Burned (watch) − eaten per day: green = a deficit, red = a surplus; purple = body weight (right axis). Average ${defAvg >= 0 ? 'deficit' : 'surplus'} ${r0(Math.abs(defAvg))} kcal/day ≈ ${(Math.abs(defAvg) * 7 / KCAL_PER_KG).toFixed(2)} kg/week ${defAvg >= 0 ? 'down' : 'up'} if it held every day.`
        + (wChange != null && wWeeks >= 1 ? ` Weight in this window: ${wChange >= 0 ? '+' : ''}${wChange.toFixed(1)} kg over ${Math.round(wWeeks)} week${Math.round(wWeeks) === 1 ? '' : 's'}.` : '')
        + ` Fully logged days only (${defDays.length}), today excluded (its burn isn't complete yet). Watch energy is ±15–20 % — trust weeks, not days.`),
    protein: () => card('Protein', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.prot)} t0={t0} t1={t1} color={MACRO_COLOR.prot} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
        {...(kg ? { refs: [{ y: 1.6 * kg, color: MACRO_COLOR.prot, dash: true }] } : {})} />
    ), kg ? `Dashed: 1.6 g/kg (${Math.round(1.6 * kg)} g) — the level that supports strength + endurance training.` : undefined),
    carbs: () => card('Carbs', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.carb)} t0={t0} t1={t1} color={MACRO_COLOR.carb} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
        pts2={series(d => d.n.rs)} maxGapMs2={GAP} color2={MACRO_COLOR.fib} y2fmt={v => `${r0(v)}g`} y2label="resist. starch" />
    ), 'Available carbs (resistant starch shown separately in green).'),
    fat: () => card('Fat', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.fat)} t0={t0} t1={t1} color={MACRO_COLOR.fat} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW} />
    )),
    fibre: () => card('Fibre', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.fib)} t0={t0} t1={t1} color={MACRO_COLOR.fib} trend events={[]} showEvents={false} yfmt={v => `${r0(v)}g`} innerW={innerW}
        refs={[{ y: 30, color: MACRO_COLOR.fib, dash: true }]} />
    ), 'Dashed: 30 g/day (EFSA adequate intake for adults ≥ 25 g).'),
    alcohol: () => card('Alcohol', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.alc ? d.n.alc / STD_DRINK_G : 0)} t0={t0} t1={t1} color={MACRO_COLOR.alc} events={[]} showEvents={false} yfmt={v => v.toFixed(1)} innerW={innerW}
        refs={[{ y: 2, color: '#e67e22', dash: true }]} />
    ), !win.some(d => (d.n.alc ?? 0) > 0) ? 'No alcohol logged in this window — every day at 0 standard drinks.' : `Standard drinks per day (10 g alcohol each) · window total ${(win.reduce((a, d) => a + (d.n.alc ?? 0), 0) / STD_DRINK_G).toFixed(1)} drinks, ${Math.round(win.reduce((a, d) => a + (d.n.alc ?? 0), 0) * 7)} kcal. Dashed: 2 a day — Belgian guidance is ≤ 10 a week with alcohol-free days.`),
    caffeine: () => card('Caffeine', (
      <TChart maxGapMs={GAP} pts={series(d => d.n.caf)} t0={t0} t1={t1} color="#8B5E3C" events={[]} showEvents={false} yfmt={v => `${r0(v)}`} innerW={innerW}
        refs={[{ y: 400, color: '#e67e22', dash: true }]} />
    ), `mg per day (0 on logged days without coffee / tea / cola) — dashed: the 400 mg EFSA daily level.${win.some(d => (d.n.caf ?? 0) > 0) ? '' : ' No caffeine logged in this window.'}`),
  };

  return (
    <View style={s.screen}>
      {header}
      {/* the period stays on screen: the bar sits OUTSIDE the scrolling cards */}
      <TimeWindowBar w={win8} />
      <ScrollView contentContainerStyle={{ padding: 12, paddingTop: 4, paddingBottom: 48 }}>
        <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
          {editing ? (
            <View style={s.card}>
              <Text style={s.cardTitle}>Cards</Text>
              {layout.map((l, i) => (
                <View key={l.id} style={s.editRow}>
                  <Text style={[s.editLbl, !l.on && { opacity: 0.4 }]}>{CARD_TITLE[l.id]}</Text>
                  <TouchableOpacity disabled={i === 0} onPress={() => moveCard(i, -1)} hitSlop={6}><Text style={[s.ctl, i === 0 && { opacity: 0.25 }]}>▲</Text></TouchableOpacity>
                  <TouchableOpacity disabled={i === layout.length - 1} onPress={() => moveCard(i, 1)} hitSlop={6}><Text style={[s.ctl, i === layout.length - 1 && { opacity: 0.25 }]}>▼</Text></TouchableOpacity>
                  <Switch value={l.on} onValueChange={v => saveLayout(layout.map(q => (q.id === l.id ? { ...q, on: v } : q)))} />
                </View>
              ))}
              <TouchableOpacity onPress={() => saveLayout(DEFAULT_LAYOUT)}><Text style={[s.cap, { marginTop: 10, color: c.accent }]}>Reset to default</Text></TouchableOpacity>
            </View>
          ) : (
            <>
              {nPartial > 0 && <Text style={[s.cap, { marginBottom: 8 }]}>{nPartial} day{nPartial > 1 ? 's' : ''} with only a few items logged {nPartial > 1 ? 'are' : 'is'} left out — log the whole day (or mark it “fully logged”) to count it. Lines break over days without food logged.</Text>}
              {!win.length ? <Text style={s.cap}>No fully logged day in this window yet.</Text>
                : layout.filter(l => l.on).map(l => <React.Fragment key={l.id}>{CARD[l.id]()}</React.Fragment>)}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  card:      { backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  cap:       { color: c.textSub, fontSize: 12, lineHeight: 17, marginTop: 6 },
  editRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  editLbl:   { flex: 1, color: c.text, fontSize: 14 },
  ctl:       { color: c.accent, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
});
