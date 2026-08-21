import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText, Circle } from 'react-native-svg';
import { Stack } from 'expo-router';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { fetchTrainingLoadHistory } from '../src/services/healthkit';
import { DailyLoad } from '../src/types';
import { projectTravel, TravelProjection, TravelScenario, ctlOn } from '../src/services/travelProjection';

const DAY = 86_400_000;
const dstr = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const fmtShort = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const SC_META: Record<TravelScenario, { label: string; color: string; sub: string }> = {
  continue: { label: 'Train through', color: '#2e9e5b', sub: 'full load, as if home' },
  maintain: { label: 'Maintain',      color: '#2f6fed', sub: '~3 short easy runs/wk' },
  rest:     { label: 'Mostly rest',   color: '#8a8f98', sub: 'sightseeing / NEAT' },
};

export default function TravelProjectionScreen() {
  const s = useThemedStyles(styles);
  const { c } = useTheme();
  const { width } = useWindowDimensions();

  const [hist, setHist]       = useState<DailyLoad[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);
  const [startInDays, setStartInDays] = useState(23);  // ≈ mid-Sept from late Aug; user-adjustable
  const [tripDays, setTripDays]       = useState(14);

  useEffect(() => {
    (async () => {
      try { setHist(await fetchTrainingLoadHistory(4)); }
      catch (e: any) { setErr(e?.message ?? 'Could not load training history.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const proj: TravelProjection | null = useMemo(() => {
    if (!hist?.length) return null;
    const today = new Date(hist[hist.length - 1].date + 'T00:00:00');
    const tripStart = new Date(today.getTime() + startInDays * DAY);
    return projectTravel(hist, tripStart, tripDays, 21);
  }, [hist, startInDays, tripDays]);

  const step = useCallback((setter: React.Dispatch<React.SetStateAction<number>>, delta: number, min: number, max: number) =>
    setter(v => Math.max(min, Math.min(max, v + delta))), []);

  if (loading) return <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.dim}>Reading your training history…</Text></View>;
  if (err)     return <View style={s.center}><Text style={s.err}>{err}</Text></View>;
  if (!proj)   return <View style={s.center}><Text style={s.dim}>Not enough training history yet to project.</Text></View>;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingBottom: 40 }}>
      <Stack.Screen options={{ title: 'Travel Projection', headerBackTitle: 'Back' }} />

      <Text style={s.lede}>
        Where your fitness (CTL) lands across a trip, under three training scenarios. Detraining is slow —
        CTL is a 42-day average — so the lines show both the dip and how fast it rebuilds after.
      </Text>

      {/* ── Trip controls ─────────────────────────────────────────── */}
      <View style={s.card}>
        <View style={s.ctrlRow}>
          <Text style={s.ctrlLabel}>Trip starts</Text>
          <View style={s.stepper}>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setStartInDays, -7, 1, 120)}><Text style={s.stepTxt}>−1w</Text></TouchableOpacity>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setStartInDays, -1, 1, 120)}><Text style={s.stepTxt}>−1d</Text></TouchableOpacity>
            <Text style={s.ctrlVal}>{fmtShort(proj.tripStart)}</Text>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setStartInDays, +1, 1, 120)}><Text style={s.stepTxt}>+1d</Text></TouchableOpacity>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setStartInDays, +7, 1, 120)}><Text style={s.stepTxt}>+1w</Text></TouchableOpacity>
          </View>
        </View>
        <View style={s.ctrlRow}>
          <Text style={s.ctrlLabel}>Trip length</Text>
          <View style={s.stepper}>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setTripDays, -1, 2, 60)}><Text style={s.stepTxt}>−1d</Text></TouchableOpacity>
            <Text style={s.ctrlVal}>{tripDays} days</Text>
            <TouchableOpacity style={s.stepBtn} onPress={() => step(setTripDays, +1, 2, 60)}><Text style={s.stepTxt}>+1d</Text></TouchableOpacity>
          </View>
        </View>
        <Text style={s.ctrlNote}>Away {fmtShort(proj.tripStart)} → {fmtShort(proj.tripEnd)} · today CTL {proj.today.ctl.toFixed(0)} · sustaining ~{proj.normalDailyLoad} load/day</Text>
      </View>

      {/* ── CTL chart ─────────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Fitness (CTL) projection</Text>
        <CtlChart proj={proj} width={width - 64} palette={c} />
        <View style={s.legend}>
          {(['continue', 'maintain', 'rest'] as TravelScenario[]).map(k => (
            <View key={k} style={s.legItem}>
              <View style={[s.legDot, { backgroundColor: SC_META[k].color }]} />
              <Text style={s.legTxt}>{SC_META[k].label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* ── Summary table ─────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Where you land</Text>
        <View style={s.tblHead}>
          <Text style={[s.th, { flex: 1.4 }]}>Scenario</Text>
          <Text style={s.th}>Trip end</Text>
          <Text style={s.th}>+3 wk</Text>
          <Text style={s.th}>vs now</Text>
        </View>
        {(['continue', 'maintain', 'rest'] as TravelScenario[]).map(k => {
          const endCtl  = ctlOn(proj.scenarios[k], proj.tripEnd) ?? proj.today.ctl;
          const horizCtl = ctlOn(proj.scenarios[k], proj.horizonEnd) ?? endCtl;
          const delta = horizCtl - proj.today.ctl;
          return (
            <View key={k} style={s.tblRow}>
              <View style={{ flex: 1.4 }}>
                <View style={s.legItem}>
                  <View style={[s.legDot, { backgroundColor: SC_META[k].color }]} />
                  <Text style={s.tdName}>{SC_META[k].label}</Text>
                </View>
                <Text style={s.tdSub}>{SC_META[k].sub}</Text>
              </View>
              <Text style={s.td}>{endCtl.toFixed(0)}</Text>
              <Text style={s.td}>{horizCtl.toFixed(0)}</Text>
              <Text style={[s.td, { color: delta >= 0 ? '#2e9e5b' : '#c0392b', fontWeight: '700' }]}>{delta >= 0 ? '+' : ''}{delta.toFixed(0)}</Text>
            </View>
          );
        })}
        <Text style={s.tblNote}>
          "+3 wk" = three weeks after you're back, once fitness rebuilds. Even mostly resting, the loss is
          small and comes back fast — protect the base with 2–3 easy runs/week and you barely dip.
        </Text>
      </View>
    </ScrollView>
  );
}

// ── SVG multi-line CTL chart ───────────────────────────────────────────────
function CtlChart({ proj, width, palette }: { proj: TravelProjection; width: number; palette: any }) {
  const H = 210, padL = 30, padR = 8, padT = 12, padB = 22;
  const plotW = width - padL - padR, plotH = H - padT - padB;

  const series = proj.scenarios;
  const all = [...series.continue, ...series.maintain, ...series.rest];
  if (!all.length) return null;

  const t0 = new Date(proj.today.date + 'T00:00:00').getTime();
  const t1 = new Date(proj.horizonEnd + 'T00:00:00').getTime();
  const span = Math.max(1, t1 - t0);
  const ctls = all.map(d => d.ctl);
  let yMin = Math.min(...ctls), yMax = Math.max(...ctls);
  const padY = Math.max(2, (yMax - yMin) * 0.15); yMin -= padY; yMax += padY;
  if (yMax - yMin < 4) { yMax += 2; yMin -= 2; }

  const X = (iso: string) => padL + ((new Date(iso + 'T00:00:00').getTime() - t0) / span) * plotW;
  const Y = (v: number)   => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const pts = (arr: DailyLoad[]) => arr.map(d => `${X(d.date).toFixed(1)},${Y(d.ctl).toFixed(1)}`).join(' ');

  const tripX0 = X(proj.tripStart), tripX1 = X(proj.tripEnd);
  const yTicks = [yMin + (yMax - yMin) * 0.15, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.15].map(v => Math.round(v));

  return (
    <Svg width={width} height={H}>
      {/* trip window */}
      <Rect x={tripX0} y={padT} width={Math.max(1, tripX1 - tripX0)} height={plotH} fill={palette.accent} opacity={0.08} />
      <SvgText x={(tripX0 + tripX1) / 2} y={padT + 10} fill={palette.textSub} fontSize={9} textAnchor="middle">away</SvgText>
      {/* y grid + labels */}
      {yTicks.map((v, i) => (
        <React.Fragment key={i}>
          <Line x1={padL} y1={Y(v)} x2={width - padR} y2={Y(v)} stroke={palette.gridline} strokeWidth={0.5} />
          <SvgText x={padL - 4} y={Y(v) + 3} fill={palette.textSub} fontSize={9} textAnchor="end">{v}</SvgText>
        </React.Fragment>
      ))}
      {/* scenario lines */}
      <Polyline points={pts(series.rest)}     fill="none" stroke={SC_META.rest.color}     strokeWidth={2} />
      <Polyline points={pts(series.maintain)} fill="none" stroke={SC_META.maintain.color} strokeWidth={2} />
      <Polyline points={pts(series.continue)} fill="none" stroke={SC_META.continue.color} strokeWidth={2.5} />
      {/* today marker */}
      <Circle cx={X(proj.today.date)} cy={Y(proj.today.ctl)} r={3} fill={palette.text} />
      {/* x labels */}
      <SvgText x={padL} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="start">{fmtShort(proj.today.date)}</SvgText>
      <SvgText x={(tripX0 + tripX1) / 2} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="middle">{fmtShort(proj.tripEnd)}</SvgText>
      <SvgText x={width - padR} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="end">{fmtShort(proj.horizonEnd)}</SvgText>
    </Svg>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: 24, gap: 10 },
  dim:       { color: c.textSub, fontSize: 14, textAlign: 'center' },
  err:       { color: '#c0392b', fontSize: 14, textAlign: 'center' },
  lede:      { color: c.textSub, fontSize: 13, lineHeight: 19, paddingHorizontal: 20, paddingTop: 14 },
  card:      { backgroundColor: c.surface, borderRadius: 16, marginHorizontal: 16, marginTop: 14, padding: 16 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  ctrlRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  ctrlLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  stepper:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn:   { backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  stepTxt:   { color: c.accent, fontSize: 13, fontWeight: '700' },
  ctrlVal:   { color: c.text, fontSize: 13, fontWeight: '700', minWidth: 58, textAlign: 'center' },
  ctrlNote:  { color: c.textSub, fontSize: 11.5, marginTop: 2 },
  legend:    { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 8 },
  legItem:   { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legDot:    { width: 9, height: 9, borderRadius: 5 },
  legTxt:    { color: c.textSub, fontSize: 12 },
  tblHead:   { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  th:        { flex: 1, color: c.textSub, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  tblRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  tdName:    { color: c.text, fontSize: 13.5, fontWeight: '600' },
  tdSub:     { color: c.textSub, fontSize: 10.5, marginLeft: 14 },
  td:        { flex: 1, color: c.text, fontSize: 15, textAlign: 'right' },
  tblNote:   { color: c.textSub, fontSize: 11.5, lineHeight: 17, marginTop: 10 },
});
