import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText, Circle } from 'react-native-svg';
import { Stack, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { seasonPlanToIcs } from '../src/services/planIcs';
import { fetchTrainingLoadHistory } from '../src/services/healthkit';
import { getRaceConfig, RaceConfig, fmtTime } from '../src/services/racePlan';
import { getLoadCapPct, getPeriodization, Periodization } from '../src/services/coach';
import { buildSeasonPlan, SeasonPlan, Phase, PHASE_COLOR, raceLabel } from '../src/services/seasonPlan';
import { DailyLoad } from '../src/types';

const fmtShort = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const CTL_COL = '#3498db', ATL_COL = '#e84393';

export default function SeasonPlanScreen() {
  const s = useThemedStyles(styles);
  const { c } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const [hist, setHist] = useState<DailyLoad[] | null>(null);
  const [race, setRace] = useState<RaceConfig | null>(null);
  const [cfg, setCfg] = useState<{ capPct: number; per: Periodization } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [h, r, capPct, per] = await Promise.all([
          fetchTrainingLoadHistory(4), getRaceConfig(), getLoadCapPct(), getPeriodization(),
        ]);
        setHist(h); setRace(r); setCfg({ capPct, per });
      } catch (e: any) { setErr(e?.message ?? 'Could not load training history.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const plan: SeasonPlan | null = useMemo(
    () => (hist && race && cfg ? buildSeasonPlan(hist, race, { capPct: cfg.capPct, periodization: cfg.per }) : null),
    [hist, race, cfg],
  );

  // Export the block as a portable .ics calendar (imports into Apple/Google/Outlook — the interop that
  // makes sense; TP has no open plan-import format, see planIcs.ts).
  const exportIcs = async () => {
    if (!plan) return;
    const d = new Date(); const z = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}T${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
    const title = `${raceLabel(plan.race.km)} ${fmtShort(plan.race.date)}`;
    const uri = `${FileSystem.cacheDirectory}runcoach-season-plan.ics`;
    try {
      await FileSystem.writeAsStringAsync(uri, seasonPlanToIcs(plan, title, stamp));
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'text/calendar', dialogTitle: 'Add season plan to calendar', UTI: 'com.apple.ical.ics' });
    } catch { /* ignore */ }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.dim}>Reading your training history…</Text></View>;
  if (err)     return <View style={s.center}><Text style={s.err}>{err}</Text></View>;

  const noRace = !race?.date;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: 'Season Plan', headerBackTitle: 'Back' }} />

      {noRace ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>No race set</Text>
          <Text style={s.dim}>
            A season plan builds the whole periodized block — Base → Build → Peak → Taper — from now to a
            target race, ramping your fitness to a peak then tapering to arrive fresh. Set a race date and
            distance first.
          </Text>
          <TouchableOpacity style={s.cta} onPress={() => router.push('/settings' as any)}>
            <Text style={s.ctaTxt}>Set a race in Settings →</Text>
          </TouchableOpacity>
        </View>
      ) : !plan ? (
        <View style={s.center}><Text style={s.dim}>Not enough history — or the race date is in the past. Check the race date in Settings.</Text></View>
      ) : (
        <>
          <Text style={s.h1}>{raceLabel(plan.race.km)} · {fmtShort(plan.race.date)}</Text>
          <Text style={s.sub}>
            {plan.weeks.length} week{plan.weeks.length === 1 ? '' : 's'} to go
            {race?.goalTimeSec ? ` · goal ${fmtTime(race.goalTimeSec)}` : ''}
          </Text>

          {/* ── Forward PMC ─────────────────────────────────────────── */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Fitness & form to race day</Text>
            <PmcChart plan={plan} width={width - 64} c={c} />
            <View style={s.legend}>
              <Legend color={CTL_COL} label="CTL (fitness)" />
              <Legend color={ATL_COL} label="ATL (fatigue)" />
              <Legend color="#8e44ad" label="taper" square />
            </View>
          </View>

          {/* ── Race-day readout ────────────────────────────────────── */}
          <View style={s.card}>
            <View style={s.rdRow}>
              <RdStat label="Peak CTL" value={String(plan.peakCtl)} sub={`${plan.peakCtl - plan.startCtl >= 0 ? '+' : ''}${plan.peakCtl - plan.startCtl} vs now`} c={c} s={s} />
              <RdStat label="Race-day CTL" value={String(plan.race.ctl)} sub="fitness" c={c} s={s} />
              <RdStat label="Race-day form" value={`${plan.race.tsb >= 0 ? '+' : ''}${plan.race.tsb}`} sub="TSB" c={c} s={s}
                color={plan.race.tsb < 0 ? '#e74c3c' : plan.race.tsb <= 22 ? '#27ae60' : '#e67e22'} />
            </View>
            <Text style={s.note}>{plan.note}</Text>
          </View>

          {/* ── Week-by-week block ──────────────────────────────────── */}
          <View style={s.card}>
            <Text style={s.cardTitle}>The block, week by week</Text>
            <View style={s.tblHead}>
              <Text style={[s.th, { flex: 1.5, textAlign: 'left' }]}>Week</Text>
              <Text style={[s.th, { flex: 1.2, textAlign: 'left' }]}>Phase</Text>
              <Text style={s.th}>Load</Text>
              <Text style={s.th}>CTL</Text>
              <Text style={s.th}>TSB</Text>
            </View>
            {plan.weeks.map(w => (
              <View key={w.monday} style={[s.tblRow, w.weeksToRace === 0 && { backgroundColor: '#e74c3c11', borderRadius: 8 }]}>
                <Text style={[s.td, { flex: 1.5, textAlign: 'left', color: c.text, fontWeight: '600' }]}>
                  {fmtShort(w.monday)}{w.weeksToRace === 0 ? '  🏁' : ''}
                </Text>
                <View style={{ flex: 1.2, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <View style={[s.dot, { backgroundColor: PHASE_COLOR[w.phase] }]} />
                  <Text style={[s.phaseTxt, { color: PHASE_COLOR[w.phase] }]}>{w.phase}{w.deload ? ' ↓' : ''}</Text>
                </View>
                <Text style={s.td}>{w.loadTarget}</Text>
                <Text style={s.td}>{w.ctl}</Text>
                <Text style={[s.td, { color: w.tsb < -10 ? '#e74c3c' : w.tsb > 5 ? '#3498db' : c.textSub }]}>{w.tsb >= 0 ? '+' : ''}{w.tsb}</Text>
              </View>
            ))}
            <Text style={s.note}>
              "Load" = the week's training-load target (same units as CTL/ATL). Base builds the aerobic
              foundation, Build ramps it (↓ = a recovery/deload week), Peak holds the ceiling, then the Taper
              sheds fatigue so form (TSB) rises into race day. The 7-Day Plan executes the current week.
            </Text>
          </View>

          <TouchableOpacity style={s.exportBtn} onPress={exportIcs}>
            <Text style={s.exportTxt}>📅  Add to calendar (.ics)</Text>
          </TouchableOpacity>
          <Text style={s.exportHint}>
            Exports the block as a standard calendar file — imports into Apple / Google / Outlook (and any
            calendar-aware tool). TrainingPeaks has no open plan-import format, so a universal calendar is the
            portable way to take your plan with you.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function Legend({ color, label, square }: { color: string; label: string; square?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: square ? 10 : 14, height: square ? 10 : 3, borderRadius: 2, backgroundColor: square ? color + '55' : color }} />
      <Text style={{ fontSize: 11, color: '#8a8f98' }}>{label}</Text>
    </View>
  );
}

function RdStat({ label, value, sub, color, c, s }: { label: string; value: string; sub: string; color?: string; c: Palette; s: any }) {
  return (
    <View style={s.rdStat}>
      <Text style={[s.rdVal, color ? { color } : null]}>{value}</Text>
      <Text style={s.rdLabel}>{label}</Text>
      <Text style={s.rdSub}>{sub}</Text>
    </View>
  );
}

// ── Forward PMC: phase-banded CTL/ATL projection to race day ────────────────────
function PmcChart({ plan, width, c }: { plan: SeasonPlan; width: number; c: Palette }) {
  const H = 210, padL = 30, padR = 8, padT = 12, padB = 22;
  const plotW = width - padL - padR, plotH = H - padT - padB;
  const series = plan.series;
  if (series.length < 2) return <View style={{ height: H }} />;

  const t0 = new Date(series[0].date + 'T00:00:00').getTime();
  const t1 = new Date(plan.race.date + 'T00:00:00').getTime();
  const span = Math.max(1, t1 - t0);
  const vals = series.flatMap(d => [d.ctl, d.atl]);
  let yMin = Math.min(...vals), yMax = Math.max(...vals);
  const pad = Math.max(2, (yMax - yMin) * 0.15); yMin = Math.max(0, yMin - pad); yMax += pad;

  const X = (iso: string) => padL + ((new Date(iso + 'T00:00:00').getTime() - t0) / span) * plotW;
  const Y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  const pts = (key: 'ctl' | 'atl') => series.map(d => `${X(d.date).toFixed(1)},${Y(d[key]).toFixed(1)}`).join(' ');
  const yTicks = [yMin + (yMax - yMin) * 0.15, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.15].map(v => Math.round(v));
  const raceX = X(plan.race.date);

  // Phase background bands (each week clipped to the plotted window).
  const bands = plan.weeks.map(w => {
    const wStart = Math.max(t0, new Date(w.monday + 'T00:00:00').getTime());
    const wEndD = new Date(w.monday + 'T00:00:00'); wEndD.setDate(wEndD.getDate() + 7);
    const wEnd = Math.min(t1, wEndD.getTime());
    const xL = padL + ((wStart - t0) / span) * plotW;
    const xR = padL + ((wEnd - t0) / span) * plotW;
    return { x: xL, w: Math.max(0, xR - xL), color: PHASE_COLOR[w.phase] };
  }).filter(b => b.w > 0);

  return (
    <Svg width={width} height={H}>
      {bands.map((b, i) => <Rect key={`b${i}`} x={b.x} y={padT} width={b.w} height={plotH} fill={b.color} opacity={0.09} />)}
      {yTicks.map((v, i) => (
        <React.Fragment key={i}>
          <Line x1={padL} y1={Y(v)} x2={width - padR} y2={Y(v)} stroke={c.gridline} strokeWidth={0.5} />
          <SvgText x={padL - 4} y={Y(v) + 3} fill={c.textSub} fontSize={9} textAnchor="end">{v}</SvgText>
        </React.Fragment>
      ))}
      <Polyline points={pts('atl')} fill="none" stroke={ATL_COL} strokeWidth={1.6} />
      <Polyline points={pts('ctl')} fill="none" stroke={CTL_COL} strokeWidth={2.4} />
      <Circle cx={X(series[0].date)} cy={Y(series[0].ctl)} r={3} fill={c.text} />
      {/* race-day marker */}
      <Line x1={raceX} y1={padT} x2={raceX} y2={padT + plotH} stroke="#e74c3c" strokeWidth={1} strokeDasharray="3 3" />
      <SvgText x={Math.min(width - padR, raceX + 3)} y={padT + 9} fill="#e74c3c" fontSize={9} textAnchor={raceX > width - 50 ? 'end' : 'start'}>race</SvgText>
      <SvgText x={padL} y={H - 6} fill={c.textSub} fontSize={9} textAnchor="start">{fmtShort(series[0].date)}</SvgText>
      <SvgText x={width - padR} y={H - 6} fill={c.textSub} fontSize={9} textAnchor="end">{fmtShort(plan.race.date)}</SvgText>
    </Svg>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: 24, gap: 10 },
  dim:       { color: c.textSub, fontSize: 13.5, textAlign: 'center', lineHeight: 20 },
  err:       { color: '#c0392b', fontSize: 14, textAlign: 'center' },
  h1:        { color: c.text, fontSize: 20, fontWeight: '800' },
  sub:       { color: c.textSub, fontSize: 13, marginTop: 2, marginBottom: 4 },
  card:      { backgroundColor: c.surface, borderRadius: 16, marginTop: 14, padding: 16 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  note:      { color: c.textSub, fontSize: 11.5, lineHeight: 17, marginTop: 12 },
  cta:       { marginTop: 14, backgroundColor: c.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaTxt:    { color: '#fff', fontWeight: '700', fontSize: 14 },
  legend:    { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 8 },
  // race-day readout
  rdRow:     { flexDirection: 'row', gap: 8 },
  rdStat:    { flex: 1, alignItems: 'center', backgroundColor: c.bg, borderRadius: 12, paddingVertical: 12 },
  rdVal:     { color: c.text, fontSize: 24, fontWeight: '800' },
  rdLabel:   { color: c.textSub, fontSize: 11.5, fontWeight: '600', marginTop: 3 },
  rdSub:     { color: c.textFaint, fontSize: 10.5, marginTop: 1 },
  // week table
  tblHead:   { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  th:        { flex: 1, color: c.textSub, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  tblRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  td:        { flex: 1, color: c.text, fontSize: 14, textAlign: 'right' },
  dot:       { width: 8, height: 8, borderRadius: 4 },
  phaseTxt:  { fontSize: 12.5, fontWeight: '700' },
  exportBtn:  { backgroundColor: c.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
  exportTxt:  { color: c.accent, fontWeight: '700', fontSize: 14 },
  exportHint: { color: c.textFaint, fontSize: 11, lineHeight: 16, marginTop: 8, paddingHorizontal: 4 },
});
