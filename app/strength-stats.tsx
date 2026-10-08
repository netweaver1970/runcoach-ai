import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, LayoutChangeEvent } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import Svg, { Polyline, Circle } from 'react-native-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, allExercises, exerciseHistory, sessionStats, LOAD_GROUPS, MUSCLES, MUSCLE_LABEL, Muscle,
  muscleEvents, muscularLoadSeries, legLoadDaily, prTimeline, muscleSetsBetween, RunLike, LOAD_COLOR, LegDay,
} from '../src/services/strength';
import { loadSnapshotCache } from '../src/services/healthkit';
import { getEffectiveMaxHr } from '../src/services/claude';
import { BodyMap } from '../src/components/BodyMap';
import { TChart, TPt, WeeklyBars, weeklySum, inWin, trendDelta, signed } from '../src/components/TimeChart';

// Strength statistics — the cardio Statistics screen's building blocks (shared time window, weekly bars, the
// scrubbable time chart with its grey OLS trend line + the caption that quotes that same fit) applied to lifting.
type Range = '1M' | '3M' | '6M' | '1Y' | 'All';
const RANGES: Range[] = ['1M', '3M', '6M', '1Y', 'All'];
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, All: 0 };
const AREA_COLOR: Record<string, string> = { legs: '#2f9e44', push: '#e8590c', pull: '#1c7ed6', core: '#ae3ec9' };
const kgFmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${Math.round(v)}`);
const GOLD = '#F5B400';
const QUALITY = new Set(['Tempo', 'Intervals', 'LongRun', 'Threshold']);
// sets per muscle per WEEK → colour: none grey · < 10 (below the usual growth range) amber · 10–20 green · > 20 red
const setsColor = (perWk: number, dark: boolean) => perWk <= 0.05 ? (dark ? '#3a3d46' : '#c9ccd3') : perWk < 10 ? '#e8a317cc' : perWk <= 20 ? '#2f9e44dd' : '#e5484ddd';

// Leg-load timeline: per day the legs' load from RUNS (blue) and STRENGTH (orange) stacked, the legs' freshness line
// (green, 0–100 %), and a ⚡ over quality-run days — "did Tuesday's leg day hurt Thursday's intervals?"
function LegLoadChart({ days, quality, innerW }: { days: LegDay[]; quality: Set<string>; innerW: number }) {
  const { c } = useTheme();
  if (!days.length || innerW <= 0) return null;
  const H = 110, n = days.length, gap = 2, cw = (innerW - gap * (n - 1)) / n;
  const max = Math.max(1, ...days.map(d => d.run + d.strength));
  const key = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const pts = days.map((d, i) => `${i * (cw + gap) + cw / 2},${H - (d.fresh / 100) * H}`).join(' ');
  return (
    <View>
      <View style={{ height: 14 }}>
        {days.map((d, i) => quality.has(key(d.t))
          ? <View key={i} style={{ position: 'absolute', left: i * (cw + gap) + cw / 2 - 6 }}><MaterialCommunityIcons name="lightning-bolt" size={12} color="#e8590c" /></View>
          : null)}
      </View>
      <View style={{ height: H, flexDirection: 'row', alignItems: 'flex-end', gap }}>
        {days.map((d, i) => (
          <View key={i} style={{ width: cw, justifyContent: 'flex-end', height: H }}>
            <View style={{ height: (d.strength / max) * H * 0.85, backgroundColor: '#F97316', borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
            <View style={{ height: (d.run / max) * H * 0.85, backgroundColor: '#3B82F6' }} />
          </View>
        ))}
        <Svg width={innerW} height={H} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
          <Polyline points={pts} fill="none" stroke="#2f9e44" strokeWidth={2} />
          <Circle cx={(n - 1) * (cw + gap) + cw / 2} cy={H - (days[n - 1].fresh / 100) * H} r={3} fill="#2f9e44" />
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
        {[0, Math.floor(n / 2), n - 1].map(i => (
          <Text key={i} style={{ fontSize: 9, color: c.textFaint }}>{new Date(days[i].t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>
        ))}
      </View>
    </View>
  );
}

export default function StrengthStatsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [st, setSt] = useState<StrengthStore | null>(null);
  const [range, setRange] = useState<Range>('3M');
  const [exId, setExId] = useState<string | null>(null);
  const [w, setW] = useState(0);
  const [musWin, setMusWin] = useState<7 | 30>(7);
  const [area, setArea] = useState('legs');
  const [selMuscle, setSelMuscle] = useState<Muscle | null>(null);
  const [runs, setRuns] = useState<{ runs: (RunLike & { label?: string })[]; maxHr: number } | null>(null);
  const router = useRouter();
  useFocusEffect(useCallback(() => {
    loadStrength().then(x => setSt({ ...x })).catch(() => {});
    // runs load the legs too (leg timeline + muscular load) — from the cached snapshot, no HealthKit query
    Promise.all([loadSnapshotCache(), getEffectiveMaxHr().catch(() => 188)])
      .then(([sn, mx]) => setRuns({ runs: (sn?.runs ?? []) as any[], maxHr: mx || 188 })).catch(() => setRuns({ runs: [], maxHr: 188 }));
  }, []));

  const stats = useMemo(() => (st ? sessionStats(st) : []), [st]);
  // exercises with an e1RM history (≥ 2 sessions), most-trained first → the chips of the e1RM card
  const trained = useMemo(() => (st ? allExercises(st)
    .map(e => ({ e, h: exerciseHistory(st, e.id).filter(x => x.bestE1rm != null) }))
    .filter(x => x.h.length >= 2).sort((a, b) => b.h.length - a.h.length) : []), [st]);

  // the over-time models (memoised: they scan 150 days of events)
  const events = useMemo(() => (st && runs ? muscleEvents(st, runs.runs, runs.maxHr) : []), [st, runs]);
  const loadSeries = useMemo(() => muscularLoadSeries(events, 90), [events]);
  const legDays = useMemo(() => legLoadDaily(events, 28), [events]);
  const prs = useMemo(() => (st ? prTimeline(st) : []), [st]);
  const quality = useMemo(() => new Set((runs?.runs ?? []).filter(r => QUALITY.has(r.label ?? '')).map(r => {
    const d = new Date(r.date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })), [runs]);

  if (!st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const t1 = Date.now();
  const t0 = RANGE_DAYS[range] ? t1 - RANGE_DAYS[range] * 86_400_000 : Math.min(t1 - 7 * 86_400_000, stats[0]?.t ?? t1);
  const innerW = Math.max(0, w - 24);
  const onLay = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const tonnage = weeklySum(stats.map(x => ({ t: x.t, v: x.tonnage })), t0, t1);
  const sets = weeklySum(stats.map(x => ({ t: x.t, v: x.sets })), t0, t1);
  const sel = trained.find(x => x.e.id === exId) ?? trained[0];
  const prSess = new Set(prs.filter(p => p.exerciseId === sel?.e.id && p.kind === 'e1RM').map(p => p.sessionId));   // gold = an e1RM record
  const e1: TPt[] = sel ? sel.h.map(x => ({ t: x.at, v: x.bestE1rm!, ...(prSess.has(x.sessionId) ? { color: GOLD } : {}) })) : [];   // gold = a PR session
  const top: TPt[] = sel ? sel.h.map(x => ({ t: x.at, v: x.topKg })) : [];
  const e1Win = inWin(e1, t0, t1).map(p => p.v);
  const d = trendDelta(e1Win);
  const rpe: TPt[] = stats.filter(x => x.rpe).map(x => ({ t: x.t, v: x.rpe! }));
  // hard sets per area: average of the last 4 COMPLETED weeks vs the 4 before
  const areas = LOAD_GROUPS.filter(g => g.key !== 'body').map(g => {
    const wk = weeklySum(stats.map(x => ({ t: x.t, v: x.areaSets[g.key] ?? 0 })), t1 - 63 * 86_400_000, t1);
    const avg = (a: typeof wk) => (a.length ? a.reduce((q, x) => q + x.v, 0) / a.length : 0);
    const full = wk.filter(x => !x.inProgress);   // completed weeks only (a half week would read as a drop)
    return { g, now: avg(full.slice(-4)), prev: avg(full.slice(-8, -4)) };
  });

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Strength stats', headerBackTitle: 'Back' }} />
      <View style={s.ctrlRow}>
        {RANGES.map(r => (
          <TouchableOpacity key={r} style={[s.tab, range === r && s.tabOn]} onPress={() => setRange(r)}>
            <Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
        {!stats.length && <Text style={s.meta}>No finished strength sessions yet — the charts fill in as you log.</Text>}

        <View style={s.card} onLayout={onLay}>
          <Text style={s.cardTitle}>Weekly volume</Text>
          <Text style={s.meta}>Tonnage = kg × reps over all work sets (body-weight moves include your body-weight share)</Text>
          <WeeklyBars weeks={tonnage} innerW={innerW} fmt={kgFmt} unit="kg" />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Weekly work sets</Text>
          <WeeklyBars weeks={sets} innerW={innerW} fmt={v => String(Math.round(v))} unit="sets" />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Hard sets per area</Text>
          <Text style={s.meta}>Per week, last 4 completed weeks vs the 4 before (per area — ~10–20 hard sets per MUSCLE per week is the usual growth range)</Text>
          {areas.map(a => (
            <View key={a.g.key} style={s.areaRow}>
              <View style={[s.dot, { backgroundColor: AREA_COLOR[a.g.key] ?? c.accent }]} />
              <Text style={s.areaLbl}>{a.g.label}</Text>
              <Text style={s.areaVal}>{a.now.toFixed(1)}/wk</Text>
              <Text style={[s.areaDelta, { color: a.now > a.prev + 0.5 ? '#2f9e44' : a.now < a.prev - 0.5 ? '#e5484d' : c.textSub }]}>
                {a.prev > 0 || a.now > 0 ? `${a.now >= a.prev ? '▲' : '▼'} from ${a.prev.toFixed(1)}` : '—'}
              </Text>
            </View>
          ))}
        </View>

        {/* Sets per muscle: body map + per-muscle rate per week vs the 10–20 growth range (Bevel Muscle Map / Hevy) */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.cardTitle, { flex: 1 }]}>Sets per muscle</Text>
            {([7, 30] as const).map(d => (
              <TouchableOpacity key={d} style={[s.seg, musWin === d && s.segOn]} onPress={() => setMusWin(d)}>
                <Text style={[s.segTxt, musWin === d && { color: c.onAccent }]}>{d} d</Text>
              </TouchableOpacity>
            ))}
          </View>
          {(() => {
            const sets = muscleSetsBetween(st, t1 - musWin * 86_400_000, t1);
            const perWk = (m: Muscle) => ((sets[m] ?? 0) * 7) / musWin;
            const rows = MUSCLES.map(m => ({ m, v: perWk(m) })).sort((a, b) => b.v - a.v);
            const max = Math.max(22, ...rows.map(r => r.v));
            return (
              <>
                <Text style={s.meta}>Hard sets per week (weighted by how much each exercise uses the muscle) · grey none · amber &lt;10 · green 10–20 · red &gt;20</Text>
                <View style={{ marginTop: 8 }}>
                  <BodyMap colorOf={m => setsColor(perWk(m), c.mode === 'dark')} onSelect={m => setSelMuscle(sm => (sm === m ? null : m))} selected={selMuscle} />
                </View>
                {rows.filter(r => r.v > 0.05 || r.m === selMuscle).map(r => (
                  <View key={r.m} style={[s.areaRow, r.m === selMuscle && { backgroundColor: c.surfaceAlt }]}>
                    <Text style={[s.areaLbl, { flex: 0, width: 92 }]} numberOfLines={1}>{MUSCLE_LABEL[r.m]}</Text>
                    <View style={s.track}>
                      <View style={[s.band, { left: `${(10 / max) * 100}%`, width: `${(10 / max) * 100}%` }]} />
                      <View style={[s.fill, { width: `${Math.max(2, (r.v / max) * 100)}%`, backgroundColor: setsColor(r.v, c.mode === 'dark') }]} />
                    </View>
                    <Text style={s.areaVal}>{r.v.toFixed(1)}</Text>
                  </View>
                ))}
                {rows.every(r => r.v <= 0.05) ? <Text style={s.meta}>No strength sets in the last {musWin} days.</Text> : null}
              </>
            );
          })()}
        </View>

        {/* Muscular load over time (the strength PMC): 7-day vs 6-week ratio per area, Productive band shaded */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Muscular load over time</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }} contentContainerStyle={{ gap: 6 }}>
            {loadSeries.map(g => (
              <TouchableOpacity key={g.key} style={[s.chip, area === g.key && s.chipOn]} onPress={() => setArea(g.key)}>
                <Text style={[s.chipTxt, area === g.key && { color: c.onAccent }]}>{g.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {(() => {
            const g = loadSeries.find(x => x.key === area) ?? loadSeries[0];
            const pts: TPt[] = (g?.pts ?? []).filter(p => p.ratio != null).map(p => ({ t: p.t, v: p.ratio! }));
            return pts.length >= 2 ? (
              <>
                <TChart pts={pts} t0={Math.max(t0, t1 - 90 * 86_400_000)} t1={t1} color={LOAD_COLOR.Productive} band={[1.0, 1.3]}
                  refs={[{ y: 0.8, color: LOAD_COLOR.Detraining, dash: true }, { y: 1.5, color: LOAD_COLOR.Overtraining, dash: true }]}
                  events={[]} showEvents={false} yfmt={v => `×${v.toFixed(2)}`} innerW={innerW} />
                <Text style={s.caption}>Last ~7 days vs your usual ~6-week level (rolling averages; ×1.0 = as usual). Green band = Productive (×1.0–1.3); below the blue line = Detraining, above the red one = Overtraining. Runs load the legs.</Text>
              </>
            ) : <Text style={s.meta}>Calibrating — this area needs a few weeks of history.</Text>;
          })()}
        </View>

        {/* Leg-load timeline: runs + leg days on one axis, leg freshness, quality runs marked */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Legs: runs + strength</Text>
          <Text style={s.meta}>Last 4 weeks · <Text style={{ color: '#3B82F6' }}>■ runs</Text> · <Text style={{ color: '#F97316' }}>■ strength</Text> · <Text style={{ color: '#2f9e44' }}>— leg freshness</Text> · ⚡ quality run</Text>
          <View style={{ marginTop: 6 }}><LegLoadChart days={legDays} quality={quality} innerW={innerW} /></View>
          {legDays.length ? <Text style={s.caption}>Leg freshness now {legDays[legDays.length - 1].fresh}% — a quality run is best on a day the green line is high, i.e. not straight after a heavy leg day.</Text> : null}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Estimated 1RM</Text>
          {trained.length ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }} contentContainerStyle={{ gap: 6 }}>
                {trained.map(x => (
                  <TouchableOpacity key={x.e.id} style={[s.chip, sel?.e.id === x.e.id && s.chipOn]} onPress={() => setExId(x.e.id)}>
                    <Text style={[s.chipTxt, sel?.e.id === x.e.id && { color: c.onAccent }]} numberOfLines={1}>{x.e.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TChart pts={e1} t0={t0} t1={t1} color={c.accent} trend events={[]} showEvents={false} yfmt={v => `${Math.round(v)}`} innerW={innerW}
                pts2={top} color2="#a855f7" y2fmt={v => `${Math.round(v)}`} y2label="kg top" />
              <Text style={s.caption}>
                Effort-adjusted Epley e1RM per session (purple: heaviest kg){d != null && e1Win.length
                  ? ` · trend ${signed(d, 1)} kg (${signed((d / e1Win[0]) * 100, 1)}%) over this window` : ''}
              </Text>
            </>
          ) : <Text style={s.meta}>Appears once an exercise has 2 sessions.</Text>}
        </View>

        {/* Records: every PR, newest first (gold dots on the e1RM chart above) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>🏆 Records</Text>
          {prs.length ? prs.slice().reverse().slice(0, 15).map((p, i) => (
            <TouchableOpacity key={i} style={s.areaRow} onPress={() => router.push({ pathname: '/strength-exercise' as any, params: { id: p.exerciseId } })}>
              <Text style={[s.meta, { width: 52 }]}>{new Date(p.t).toLocaleDateString('en-GB', new Date(p.t).getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' })}</Text>
              <Text style={[s.areaLbl]} numberOfLines={1}>{p.name}</Text>
              <Text style={[s.areaVal, { color: GOLD }]}>{p.kind} {p.value}{p.kind === 'Set volume' ? '' : ' kg'}</Text>
              <Text style={[s.meta, { marginLeft: 6 }]}>was {p.prev}</Text>
            </TouchableOpacity>
          )) : <Text style={s.meta}>Records appear from your second session of an exercise.</Text>}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Session effort (RPE)</Text>
          <TChart pts={rpe} t0={t0} t1={t1} color="#e8590c" trend events={[]} showEvents={false} yfmt={v => v.toFixed(1)} innerW={innerW} />
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  ctrlRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  tab:      { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:   { color: c.textSub, fontSize: 14, fontWeight: '700' },
  tabTxtOn: { color: c.onAccent },
  card:     { backgroundColor: c.surface, borderRadius: 16, padding: 12, marginBottom: 12 },
  cardTitle:{ color: c.text, fontSize: 15, fontWeight: '800', marginBottom: 2 },
  meta:     { color: c.textSub, fontSize: 12, lineHeight: 16 },
  caption:  { color: c.textSub, fontSize: 11.5, marginTop: 8, lineHeight: 16 },
  chip:     { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: c.border, maxWidth: 180 },
  chipOn:   { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:  { color: c.textSub, fontSize: 12.5, fontWeight: '700' },
  areaRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  dot:      { width: 8, height: 8, borderRadius: 4 },
  areaLbl:  { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  areaVal:  { color: c.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  seg:      { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, marginLeft: 6 },
  segOn:    { backgroundColor: c.accent, borderColor: c.accent },
  segTxt:   { color: c.textSub, fontSize: 12, fontWeight: '700' },
  track:    { flex: 1, height: 10, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden', justifyContent: 'center' },
  band:     { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#2f9e4433' },
  fill:     { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 5 },
  areaDelta:{ fontSize: 12, fontWeight: '700', width: 92, textAlign: 'right' },
});
