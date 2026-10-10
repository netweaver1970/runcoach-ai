import { efficiencyTrend } from '../src/services/runStats';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, LayoutChangeEvent, Switch } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import Svg, { Polyline, Circle } from 'react-native-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { TimeWindowBar, useTimeWindow } from '../src/components/TimeWindowBar';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, allExercises, exerciseHistory, sessionStats, LOAD_GROUPS, MUSCLES, MUSCLE_LABEL, Muscle,
  muscleEvents, muscularLoadSeries, legLoadDaily, prTimeline, muscleSetsBetween, RunLike, LOAD_COLOR, LegDay,
  exerciseMetricSeries, ExMetric, EX_METRIC_LABEL, rirWeekly, RirWeek, legStrengthIndex,
} from '../src/services/strength';
import { loadSnapshotCache, fetchStrainHistory } from '../src/services/healthkit';
import { loadStatsRuns, mergeRuns } from '../src/services/statsRunsCache';
import { cached } from '../src/services/detailCache';
import * as SecureStore from 'expo-secure-store';
import { getEffectiveMaxHr } from '../src/services/claude';
import { BodyMap } from '../src/components/BodyMap';
import { CardHead, Note } from '../src/components/Notes';
import { TChart, TPt, WeeklyBars, weeklySum, inWin, trendDelta, signed } from '../src/components/TimeChart';

// Strength statistics — the cardio Statistics screen's building blocks (shared time window, weekly bars, the
// scrubbable time chart with its grey OLS trend line + the caption that quotes that same fit) applied to lifting.
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

const LAYOUT_KEY = 'strength_stats_layout_v1';
const DEFAULT_CARDS = ['volume', 'sets', 'areas', 'muscles', 'load', 'legs', 'e1rm', 'records', 'rir', 'strain', 'economy', 'rpe'];
const CARD_TITLE: Record<string, string> = {'volume': 'Weekly volume', 'sets': 'Weekly work sets', 'areas': 'Hard sets per area', 'muscles': 'Sets per muscle', 'load': 'Muscular load over time', 'legs': 'Legs: runs + strength', 'e1rm': 'Exercise progress', 'records': 'Records', 'rir': 'Effort per week (RIR)', 'strain': 'Daily strain composition', 'economy': 'Leg strength × speed per heartbeat', 'rpe': 'Session effort (RPE)'};
const EX_METRICS: ExMetric[] = ['e1rm', 'heaviest', 'volume', 'sets', 'reps', 'rel'];
const EX_METRIC_NOTE: Record<ExMetric, string> = {
  e1rm: 'Effort-adjusted Epley estimated 1RM per session (gold = a record; purple = heaviest kg)',
  heaviest: 'Heaviest work-set weight per session',
  volume: 'Session volume for this exercise (kg × reps, body-weight share included)',
  sets: 'Work sets per session',
  reps: 'Most reps in one work set per session',
  rel: 'Estimated 1RM ÷ your body weight (relative strength)',
};
const RIR_COLOR = { r0: '#e5484d', r1: '#e8590c', r2: '#2f9e44', r3: '#3B82F6' };
interface StrainDay { date: string; cardio: number; muscular: number; passive: number }

// weekly stacked bars of work sets by reps in reserve
function RirBars({ weeks, innerW }: { weeks: RirWeek[]; innerW: number }) {
  const { c } = useTheme();
  const tot = (w: RirWeek) => w.r0 + w.r1 + w.r2 + w.r3 + w.none;
  if (!weeks.some(w => tot(w) > 0) || innerW <= 0) return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 16 }}>No sets in the last 12 weeks.</Text>;
  const max = Math.max(1, ...weeks.map(tot)), H = 100;
  const parts: [keyof RirWeek, string][] = [['none', c.textFaint], ['r3', RIR_COLOR.r3], ['r2', RIR_COLOR.r2], ['r1', RIR_COLOR.r1], ['r0', RIR_COLOR.r0]];
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap: 3, marginTop: 8 }}>
        {weeks.map(w => (
          <View key={w.wk} style={{ flex: 1, justifyContent: 'flex-end', height: H }}>
            {parts.map(([k, col]) => (w[k] as number) > 0 ? <View key={k} style={{ height: ((w[k] as number) / max) * H, backgroundColor: col, opacity: k === 'none' ? 0.5 : 1 }} /> : null)}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
        {[0, weeks.length - 1].map(i => <Text key={i} style={{ fontSize: 9, color: c.textFaint }}>{new Date(weeks[i].wk).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>)}
      </View>
    </View>
  );
}

// daily strain stacked: cardio / muscular / everyday movement
function StrainBars({ days, innerW }: { days: StrainDay[]; innerW: number }) {
  const { c } = useTheme();
  if (!days.length || innerW <= 0) return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 16 }}>No strain history yet.</Text>;
  const max = Math.max(1, ...days.map(d => d.cardio + d.muscular + d.passive)), H = 100;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: H, gap: 2, marginTop: 8 }}>
        {days.map(d => (
          <View key={d.date} style={{ flex: 1, justifyContent: 'flex-end', height: H }}>
            <View style={{ height: (d.muscular / max) * H, backgroundColor: '#F97316' }} />
            <View style={{ height: (d.cardio / max) * H, backgroundColor: '#3B82F6' }} />
            <View style={{ height: (d.passive / max) * H, backgroundColor: '#94a3b8' }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 }}>
        {[0, days.length - 1].map(i => <Text key={i} style={{ fontSize: 9, color: c.textFaint }}>{new Date(days[i].date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>)}
      </View>
    </View>
  );
}

export default function StrengthStatsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [st, setSt] = useState<StrengthStore | null>(null);
  const tw = useTimeWindow('3M', null);   // same periods + ◀ ▶ paging as Statistics / Food stats
  const [exId, setExId] = useState<string | null>(null);
  const [w, setW] = useState(0);
  const [musWin, setMusWin] = useState<7 | 30>(7);
  const [area, setArea] = useState('legs');
  const [selMuscle, setSelMuscle] = useState<Muscle | null>(null);
  const [runs, setRuns] = useState<{ runs: (RunLike & { label?: string })[]; maxHr: number } | null>(null);
  const [exMetric, setExMetric] = useState<ExMetric>('e1rm');
  const [strainParts, setStrainParts] = useState<StrainDay[] | null>(null);
  const [econRuns, setEconRuns] = useState<{ t: number; v: number }[]>([]);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<{ id: string; on: boolean }[]>(DEFAULT_CARDS.map(id => ({ id, on: true })));
  const saveLayout = (l: { id: string; on: boolean }[]) => { setLayout(l); SecureStore.setItemAsync(LAYOUT_KEY, JSON.stringify(l)).catch(() => {}); };
  // strain parts per day (cardio / muscular / everyday): a month of heart rate → cached 30 min, and only fetched
  // while the card is shown (repeated JS-thread HR crunching is the CPU-watchdog risk)
  const strainOn = layout.some(l => l.id === 'strain' && l.on);
  useEffect(() => {
    if (!strainOn || strainParts) return;
    cached('strainparts:1', () => fetchStrainHistory(1))
      .then(h => setStrainParts(h.slice(-28).map(d => ({ date: d.date, cardio: d.cardio ?? 0, muscular: d.muscular ?? 0, passive: d.passive ?? 0 }))))
      .catch(() => setStrainParts([]));
  }, [strainOn, strainParts]);
  const moveCard = (i: number, d: number) => { const l = [...layout]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); saveLayout(l); };
  const router = useRouter();
  useFocusEffect(useCallback(() => {
    loadStrength().then(x => setSt({ ...x })).catch(() => {});
    // runs load the legs too (leg timeline + muscular load) — from the cached snapshot, no HealthKit query
    SecureStore.getItemAsync(LAYOUT_KEY).then(v => {
      const saved = v ? JSON.parse(v) as { id: string; on: boolean }[] : null;
      if (!Array.isArray(saved)) return;
      // keep the saved order; cards added in a later version are appended (on)
      const known = saved.filter(l => DEFAULT_CARDS.includes(l.id));
      setLayout([...known, ...DEFAULT_CARDS.filter(id => !known.some(l => l.id === id)).map(id => ({ id, on: true }))]);
    }).catch(() => {});
    // speed per heartbeat: the durable run history (beyond the snapshot window)
    Promise.all([loadSnapshotCache().catch(() => null), loadStatsRuns().catch(() => [])]).then(([sn, cached]) => {
      const rr = mergeRuns(((sn as any)?.runs ?? []) as any, cached as any) as any[];
      // EASY, non-hot runs with a trustworthy HR — speed per heartbeat depends on intensity and heat
      // the despiked SE points of the Statistics SE card (HR dropouts filtered), easy + non-hot runs only
      setEconRuns(efficiencyTrend(rr).filter(p => p.se > 0 && !p.hot && (p.label === 'Z2' || p.label === 'Recovery' || p.label === 'LongRun'))
        .map(p => ({ t: new Date(p.date + 'T12:00:00').getTime(), v: p.se })));
    }).catch(() => {});
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
  const t1 = tw.t1;
  const t0 = tw.days ? tw.t0 : Math.min(t1 - 7 * 86_400_000, stats[0]?.t ?? t1);
  const innerW = Math.max(0, w - 24);
  const onLay = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const tonnage = weeklySum(stats.map(x => ({ t: x.t, v: x.tonnage })), t0, t1);
  const sets = weeklySum(stats.map(x => ({ t: x.t, v: x.sets })), t0, t1);
  const sel = trained.find(x => x.e.id === exId) ?? trained[0];
  const prSess = new Set(prs.filter(p => p.exerciseId === sel?.e.id && p.kind === 'e1RM').map(p => p.sessionId));   // gold = an e1RM record
  const top: TPt[] = sel ? sel.h.map(x => ({ t: x.at, v: x.topKg })) : [];
  const rpe: TPt[] = stats.filter(x => x.rpe).map(x => ({ t: x.t, v: x.rpe! }));
  // hard sets per area: average of the last 4 COMPLETED weeks vs the 4 before
  const areas = LOAD_GROUPS.filter(g => g.key !== 'body').map(g => {
    const wk = weeklySum(stats.map(x => ({ t: x.t, v: x.areaSets[g.key] ?? 0 })), t1 - 63 * 86_400_000, t1);
    const avg = (a: typeof wk) => (a.length ? a.reduce((q, x) => q + x.v, 0) / a.length : 0);
    const full = wk.filter(x => !x.inProgress);   // completed weeks only (a half week would read as a drop)
    return { g, now: avg(full.slice(-4)), prev: avg(full.slice(-8, -4)) };
  });

  // exercise metric chart (e1RM / heaviest / volume / sets / reps / × body weight)
  const mPts: TPt[] = sel ? exerciseMetricSeries(st, sel.e.id, exMetric).map(p => ({ t: p.t, v: p.v, ...(exMetric === 'e1rm' && prSess.has(p.sessionId) ? { color: GOLD } : {}) })) : [];
  const mWin = inWin(mPts, t0, t1).map(p => p.v);
  const mD = trendDelta(mWin);
  const mFmt = (v: number) => (exMetric === 'rel' ? `${v.toFixed(2)}×` : exMetric === 'volume' ? kgFmt(v) : `${Math.round(v)}`);
  const rir = rirWeekly(st, 12);
  const legIdxAll: TPt[] = legStrengthIndex(st);
  // SPEED PER HEARTBEAT (SE = speed ÷ work HR) on easy, non-hot runs — the aerobic-efficiency signal. NOT speed÷power:
  // Apple Watch power is modelled from speed + slope + weight, so that ratio is ≈ constant by construction (2026-10-10).
  // Both lines as % of their own baseline IN the window = the median of the first 3 points, so one odd run can't set it.
  const ecAll = econRuns.filter(r => r.t >= t0 && r.t <= t1).map(r => ({ t: r.t, v: r.v, easy: true }));
  const med3 = (a: number[]) => { const x = a.slice(0, 3).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : 0; };
  const ecBase = med3((ecAll.filter(r => r.easy).length >= 3 ? ecAll.filter(r => r.easy) : ecAll).map(r => r.v));
  const ecPts: TPt[] = ecBase > 0 ? ecAll.map(r => ({ t: r.t, v: Math.round((r.v / ecBase) * 1000) / 10 })) : [];
  const legWin = legIdxAll.filter(p => p.t >= t0 && p.t <= t1);
  const legBase = med3(legWin.map(p => p.v));
  const legIdx: TPt[] = legBase > 0 ? legWin.map(p => ({ t: p.t, v: Math.round((p.v / legBase) * 1000) / 10 })) : [];

  const CARD: Record<string, () => React.ReactNode> = {
    volume: () => (
      <>
        <View style={s.card}>
          <CardHead title="Weekly volume" titleStyle={s.cardTitle}>Tonnage = kg × reps over all work sets (body-weight moves include your body-weight share)</CardHead>
          <WeeklyBars weeks={tonnage} innerW={innerW} fmt={kgFmt} unit="kg" />
        </View>
      </>
    ),
    sets: () => (
      <>
        <View style={s.card}>
          <Text style={s.cardTitle}>Weekly work sets</Text>
          <WeeklyBars weeks={sets} innerW={innerW} fmt={v => String(Math.round(v))} unit="sets" />
        </View>
      </>
    ),
    areas: () => (
      <>
        <View style={s.card}>
          <CardHead title="Hard sets per area" titleStyle={s.cardTitle}>Per week, last 4 completed weeks vs the 4 before (per area — ~10–20 hard sets per MUSCLE per week is the usual growth range)</CardHead>
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
      </>
    ),
    muscles: () => (
      <>
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
                <Text style={s.meta}>Hard sets per week · grey none · amber &lt;10 · green 10–20 · red &gt;20</Text>
                <Note>Weighted by how much each exercise uses the muscle. ~10–20 hard sets per muscle per week is the usual growth range.</Note>
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
      </>
    ),
    load: () => (
      <>
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
                <Note>Last ~7 days vs your usual ~6-week level (rolling averages; ×1.0 = as usual). Green band = Productive (×1.0–1.3); below the blue line = Detraining, above the red one = Overtraining. Runs load the legs.</Note>
              </>
            ) : <Text style={s.meta}>Calibrating — this area needs a few weeks of history.</Text>;
          })()}
        </View>
      </>
    ),
    legs: () => (
      <>
        {/* Leg-load timeline: runs + leg days on one axis, leg freshness, quality runs marked */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Legs: runs + strength</Text>
          <Text style={s.meta}>Last 4 weeks · <Text style={{ color: '#3B82F6' }}>■ runs</Text> · <Text style={{ color: '#F97316' }}>■ strength</Text> · <Text style={{ color: '#2f9e44' }}>— leg freshness</Text> · ⚡ quality run</Text>
          <View style={{ marginTop: 6 }}><LegLoadChart days={legDays} quality={quality} innerW={innerW} /></View>
          {legDays.length ? <Text style={s.caption}>Leg freshness now {legDays[legDays.length - 1].fresh}%</Text> : null}
          <Note>A quality run is best on a day the green leg-freshness line is high, i.e. not straight after a heavy leg day.</Note>
        </View>
      </>
    ),
    records: () => (
      <>
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
      </>
    ),
    rpe: () => (
      <>
        <View style={s.card}>
          <Text style={s.cardTitle}>Session effort (RPE)</Text>
          <TChart pts={rpe} t0={t0} t1={t1} color="#e8590c" trend events={[]} showEvents={false} yfmt={v => v.toFixed(1)} innerW={innerW} />
        </View>
      </>
    ),
    e1rm: () => (
      <>
        <View style={s.card}>
          <Text style={s.cardTitle}>Exercise progress</Text>
          {trained.length ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }} contentContainerStyle={{ gap: 6 }}>
                {trained.map(x => (
                  <TouchableOpacity key={x.e.id} style={[s.chip, sel?.e.id === x.e.id && s.chipOn]} onPress={() => setExId(x.e.id)}>
                    <Text style={[s.chipTxt, sel?.e.id === x.e.id && { color: c.onAccent }]} numberOfLines={1}>{x.e.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }} contentContainerStyle={{ gap: 6 }}>
                {EX_METRICS.map(m => (
                  <TouchableOpacity key={m} style={[s.seg, { marginLeft: 0 }, exMetric === m && s.segOn]} onPress={() => setExMetric(m)}>
                    <Text style={[s.segTxt, exMetric === m && { color: c.onAccent }]}>{EX_METRIC_LABEL[m]}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TChart pts={mPts} t0={t0} t1={t1} color={c.accent} trend events={[]} showEvents={false} yfmt={mFmt} innerW={innerW}
                {...(exMetric === 'e1rm' ? { pts2: top, color2: '#a855f7', y2fmt: (v: number) => `${Math.round(v)}`, y2label: 'kg top' } : {})} />
              <Text style={s.caption}>
                {EX_METRIC_NOTE[exMetric]}{mD != null && mWin.length ? ` · trend ${signed(mD, exMetric === 'rel' ? 2 : 1)}${exMetric === 'rel' ? '×' : exMetric === 'sets' || exMetric === 'reps' ? '' : ' kg'} ${mWin[0] > 0 ? ` (${signed((mD / mWin[0]) * 100, 1)}%)` : ''} over this window` : ''}
              </Text>
            </>
          ) : <Text style={s.meta}>Appears once an exercise has 2 sessions.</Text>}
        </View>
      </>
    ),
    rir: () => (
      <>
        {/* Effort distribution: weekly work sets by reps in reserve */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Effort per week (reps in reserve)</Text>
          <Text style={s.meta}><Text style={{ color: RIR_COLOR.r0 }}>■ 0 failure</Text> · <Text style={{ color: RIR_COLOR.r1 }}>■ 1</Text> · <Text style={{ color: RIR_COLOR.r2 }}>■ 2</Text> · <Text style={{ color: RIR_COLOR.r3 }}>■ 3+</Text> · <Text style={{ color: c.textFaint }}>■ not rated</Text></Text>
          <Note>Mostly 1–2 reps in reserve = productive; lots of 0 = grinding, lots of 3+ = too light.</Note>
          <RirBars weeks={rir} innerW={innerW} />
        </View>
      </>
    ),
    strain: () => (
      <>
        {/* Daily strain composition: cardio · muscular · everyday (the strain model's parts) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Daily strain: what it's made of</Text>
          <Text style={s.meta}><Text style={{ color: '#3B82F6' }}>■ cardio (workout heart rate)</Text> · <Text style={{ color: '#F97316' }}>■ muscular (logged sets)</Text> · <Text style={{ color: '#94a3b8' }}>■ everyday movement</Text> · last 4 weeks</Text>
          {strainParts ? <StrainBars days={strainParts} innerW={innerW} /> : <ActivityIndicator color={c.accent} style={{ marginVertical: 16 }} />}
        </View>
      </>
    ),
    economy: () => (
      <>
        {/* Is lifting making me a better runner? Leg strength vs running economy, both as % of their start */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Leg strength × speed per heartbeat</Text>
          {legIdx.length >= 2 ? (
            <>
              <TChart pts={legIdx} t0={t0} t1={t1} color="#F97316" trend events={[]} showEvents={false} yfmt={v => `${Math.round(v)}%`} innerW={innerW}
                pts2={ecPts} color2="#3B82F6" y2fmt={v => `${Math.round(v)}%`} y2label="speed/beat" />
              <Note>Orange: leg strength (leg-exercise e1RMs). Blue: speed per heartbeat on easy, cooler runs (aerobic efficiency). Both as % of their level at the start of this window. Judge it over ~3 months — one block is too short to tell.</Note>
            </>
          ) : <Text style={s.meta}>Appears after 2 sessions with leg exercises; meaningful after ~3 months.</Text>}
        </View>
      </>
    ),
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Strength stats', headerBackTitle: 'Back', headerRight: () => (
        <TouchableOpacity onPress={() => setEditing(e => !e)} hitSlop={10}><Text style={{ color: c.accent, fontSize: 15, fontWeight: '700' }}>{editing ? 'Done' : '⚙︎'}</Text></TouchableOpacity>
      ) }} />
      <TimeWindowBar w={tw} />
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
        <View onLayout={onLay}>
        {!stats.length && <Text style={s.meta}>No finished strength sessions yet — the charts fill in as you log.</Text>}
        {editing ? (
          // ⚙︎ Customise: order + show/hide the cards (remembered), like the cardio Statistics screen
          <View style={s.card}>
            <Text style={s.cardTitle}>Cards</Text>
            {layout.map((l, i) => (
              <View key={l.id} style={s.areaRow}>
                <Text style={[s.areaLbl, !l.on && { opacity: 0.4 }]}>{CARD_TITLE[l.id]}</Text>
                <TouchableOpacity disabled={i === 0} onPress={() => moveCard(i, -1)} hitSlop={6}><Text style={[s.ctl, i === 0 && { opacity: 0.25 }]}>▲</Text></TouchableOpacity>
                <TouchableOpacity disabled={i === layout.length - 1} onPress={() => moveCard(i, 1)} hitSlop={6}><Text style={[s.ctl, i === layout.length - 1 && { opacity: 0.25 }]}>▼</Text></TouchableOpacity>
                <Switch value={l.on} onValueChange={v => saveLayout(layout.map(q => (q.id === l.id ? { ...q, on: v } : q)))} />
              </View>
            ))}
            <TouchableOpacity onPress={() => saveLayout(DEFAULT_CARDS.map(id => ({ id, on: true })))}><Text style={[s.meta, { marginTop: 10, color: c.accent }]}>Reset to default</Text></TouchableOpacity>
          </View>
        ) : layout.filter(l => l.on).map(l => <React.Fragment key={l.id}>{CARD[l.id]?.()}</React.Fragment>)}
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
  ctl:      { color: c.accent, fontSize: 16, fontWeight: '800', paddingHorizontal: 8 },
  seg:      { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, marginLeft: 6 },
  segOn:    { backgroundColor: c.accent, borderColor: c.accent },
  segTxt:   { color: c.textSub, fontSize: 12, fontWeight: '700' },
  track:    { flex: 1, height: 10, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden', justifyContent: 'center' },
  band:     { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#2f9e4433' },
  fill:     { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 5 },
  areaDelta:{ fontSize: 12, fontWeight: '700', width: 92, textAlign: 'right' },
});
