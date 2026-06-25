import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText } from 'react-native-svg';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { loadSnapshotCache } from '../src/services/healthkit';
import { assembleCoachSnapshot, getWeekPlan, synthesizeWorkout, WeekPlanDay } from '../src/services/coach';
import {
  estimateWorkoutLoad, strainFromLoad, estimateDayTrimp, rollLoadForward,
  calibrateTrimpRates, heatStrainFactor, TrimpRates,
} from '../src/services/trainingLoad';
import { getMorningForecast, DayForecast } from '../src/services/weather';

type Row = WeekPlanDay & {
  strain: number; trimp: number; ctl: number; atl: number; tsb: number;
  adjMin: number; heat: number; capped: boolean; fc?: DayForecast;
};
type Hist = { ctl: number; atl: number };

const INTENSITY: Record<string, { label: string; color: string }> = {
  rest:     { label: 'Rest',     color: '#7f8c8d' },
  easy:     { label: 'Easy',     color: '#27ae60' },
  moderate: { label: 'Moderate', color: '#e67e22' },
  hard:     { label: 'Hard',     color: '#e74c3c' },
};

function labelToIntensity(label?: string): 'easy' | 'moderate' | 'hard' {
  if (label === 'Intervals') return 'hard';
  if (label === 'Tempo' || label === 'LongRun') return 'moderate';
  return 'easy'; // Z2, Recovery, Easy, Unknown
}

export default function WeekPlan() {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [rows, setRows]   = useState<Row[] | null>(null);
  const [hist, setHist]   = useState<Hist[]>([]);
  const [seed, setSeed]   = useState<{ ctl: number; atl: number } | null>(null);
  const [rates, setRates] = useState<TrimpRates | null>(null);
  const [weekCap, setWeekCap] = useState<{ capPct: number; cappedDays: number } | null>(null);
  const [err, setErr]     = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);

  const build = useCallback(async () => {
    setBusy(true); setErr(null); setRows(null);
    try {
      const snap = await loadSnapshotCache();
      if (!snap) { setErr('No data yet — open the home screen first to sync.'); return; }

      // Seed from TODAY's real CTL/ATL (the training-load series already includes today's runs).
      const tl = snap.trainingLoad ?? [];
      const todayLoad = tl.length ? tl[tl.length - 1] : null;
      const ctl0 = todayLoad?.ctl ?? 0, atl0 = todayLoad?.atl ?? 0;
      setSeed({ ctl: ctl0, atl: atl0 });

      // Rolling per-intensity TRIMP/min calibration — computed continuously by the app during
      // every health sync (snap.trimpRates). Fall back to computing it here for older caches.
      const loadByDate = new Map(tl.map(d => [d.date, d.load]));
      const cal: TrimpRates = snap.trimpRates ?? calibrateTrimpRates((snap.runs ?? []).map(r => ({
        intensity: labelToIntensity(r.label),
        minutes: ((r as any).workDuration ?? r.duration) / 60,
        dayLoad: loadByDate.get(r.date.slice(0, 10)) ?? 0,
        daysAgo: (Date.now() - new Date(r.date).getTime()) / 86_400_000,
      })));
      setRates(cal);

      const coach = await assembleCoachSnapshot(snap.strain ?? null, snap.activities);
      const forecast = await getMorningForecast(7);
      const fxBy = new Map(forecast.map(f => [f.date, f]));

      const days = await getWeekPlan(coach, forecast);

      // Backward-looking ROLLING cap: each future run's trailing-7-day time-on-feet must not
      // exceed the 7-day window a week earlier by more than the cap %. Seed with the last 14 days
      // of ACTUAL time-on-feet and append each planned day, so the cap compounds across the week
      // and accounts for runs already done.
      const capPct = coach.loadCapPct ?? 10;
      const capMul = 1 + capPct / 100;
      const tof = (coach.recentTimeOnFeet ?? []).map(d => d.min);
      while (tof.length < 14) tof.unshift(0);                 // pad if short
      tof.splice(0, tof.length - 14);                          // keep the last 14 (offsets today-13…today)

      // Heat-cut the minutes, then clamp to the rolling cap. strain + TRIMP track the final minutes.
      const prelim = days.map((d) => {
        const fc = fxBy.get(d.date);
        const heat = fc ? heatStrainFactor({ tempC: fc.tempC, apparentC: fc.apparentC, humidity: fc.humidity }) : 1;
        const heatMin = d.intensity === 'rest' ? 0 : Math.max(8, Math.round(d.runMinutes / heat));
        const j = tof.length;
        const ref7   = tof.slice(j - 13, j - 6).reduce((a, b) => a + b, 0); // 7 days ending a week ago
        const prior6 = tof.slice(j - 6, j).reduce((a, b) => a + b, 0);      // 6 days right before this
        const allowance = ref7 > 0 ? Math.max(0, Math.round(ref7 * capMul - prior6)) : heatMin;
        const finalMin = d.intensity === 'rest' ? 0 : Math.min(heatMin, allowance);
        tof.push(finalMin);

        const strain = d.intensity === 'rest'
          ? 20
          : Math.max(20, Math.round(strainFromLoad(estimateWorkoutLoad(
              synthesizeWorkout(d.intensity, finalMin, d.weekday, coach.powerZones)) * heat)));
        const trimp = estimateDayTrimp(d.intensity, finalMin, cal);
        return { ...d, fc, heat, adjMin: finalMin, capped: finalMin < heatMin, strain, trimp };
      });

      const proj = rollLoadForward(ctl0, atl0, prelim.map(p => p.trimp));
      setRows(prelim.map((p, i) => ({ ...p, ...proj[i] })));
      // Chart context: actual CTL/ATL for the last ~21 days (today is the last point → the seed).
      setHist(tl.slice(-21).map(d => ({ ctl: d.ctl, atl: d.atl })));

      setWeekCap({ capPct, cappedDays: prelim.filter(p => p.capped).length });
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to build the week plan.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { build(); }, [build]);

  const totalRunMin = rows?.reduce((a, r) => a + r.adjMin, 0) ?? 0;
  const runDays     = rows?.filter(r => r.intensity !== 'rest').length ?? 0;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
      <Text style={s.intro}>
        Next 7 days from your weekly schedule — capped, recovery-aware, and heat-adjusted to the
        morning forecast. Strain + CTL/ATL/TSB are forward estimates; recovery on the day will still
        drive the real intensity, duration and which days you run.
      </Text>

      {seed && (
        <Text style={s.startLine}>
          From today's history: CTL {seed.ctl.toFixed(0)} · ATL {seed.atl.toFixed(0)} · TSB {(seed.ctl - seed.atl).toFixed(0)}
          {rates ? `   ·   TRIMP/min E${rates.easy} M${rates.moderate} H${rates.hard}` : ''}
        </Text>
      )}

      {busy && !rows && (
        <View style={s.center}><ActivityIndicator size="large" color="#FF6B35" /><Text style={s.dim}>Planning your week…</Text></View>
      )}

      {err && (
        <View style={s.center}>
          <Text style={s.errText}>{err}</Text>
          <TouchableOpacity style={s.btn} onPress={build}><Text style={s.btnText}>Retry</Text></TouchableOpacity>
        </View>
      )}

      {rows && seed && (
        <>
          <ProjChart hist={hist} rows={rows} c={c} />

          <View style={s.legend}>
            <Legend color="#3498db" label="CTL (fitness)" />
            <Legend color="#e84393" label="ATL (fatigue)" />
            <Legend color="#e67e2266" label="strain" square />
          </View>

          {rows.map((r) => {
            const day = Number(r.date.slice(8, 10));
            const it  = INTENSITY[r.intensity] ?? INTENSITY.rest;
            const reduced = r.intensity !== 'rest' && r.adjMin < r.runMinutes;
            return (
              <View key={r.date} style={s.row}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={s.dayLine}>
                    <Text style={s.weekday}>{r.weekday} {day}</Text>
                    {'  '}<Text style={[s.tag, { color: it.color }]}>{it.label}</Text>
                  </Text>
                  <Text style={s.struct} numberOfLines={1}>
                    {r.intensity === 'rest' ? 'Rest' : r.structure}
                    {reduced ? `  → ${r.adjMin}min ${r.capped ? '(cap)' : '(heat)'}` : ''}
                  </Text>
                  {!!r.fc && (
                    <Text style={s.note} numberOfLines={1}>
                      🌡 {r.fc.apparentC}° · {r.fc.humidity}% · {r.fc.description}{r.heat > 1.05 ? ` (×${r.heat.toFixed(2)})` : ''}
                    </Text>
                  )}
                </View>
                <Text style={[s.num, s.strain, { color: it.color }]}>{r.strain}</Text>
                <Text style={[s.num, s.val]}>{r.ctl.toFixed(0)}</Text>
                <Text style={[s.num, s.val]}>{r.atl.toFixed(0)}</Text>
                <Text style={[s.num, s.val, { color: r.tsb < -10 ? '#e74c3c' : r.tsb > 5 ? '#3498db' : c.textSub }]}>
                  {r.tsb > 0 ? '+' : ''}{r.tsb.toFixed(0)}
                </Text>
              </View>
            );
          })}

          <View style={s.headRow}>
            <Text style={[s.h, { flex: 1 }]}> </Text>
            <Text style={[s.h, s.num]}>Strain</Text><Text style={[s.h, s.num]}>CTL</Text>
            <Text style={[s.h, s.num]}>ATL</Text><Text style={[s.h, s.num]}>TSB</Text>
          </View>

          <Text style={[s.footer, !!weekCap && weekCap.cappedDays > 0 && { color: '#e67e22' }]}>
            {runDays} run day{runDays === 1 ? '' : 's'} · {totalRunMin} run-min (work) this week
            {weekCap ? (weekCap.cappedDays > 0
              ? `  ·  ${weekCap.cappedDays} day${weekCap.cappedDays === 1 ? '' : 's'} trimmed to the +${weekCap.capPct}%/wk work cap`
              : `  ·  within the +${weekCap.capPct}%/wk work cap ✓`) : ''}
          </Text>

          <TouchableOpacity style={[s.btn, busy && { opacity: 0.5 }]} onPress={build} disabled={busy}>
            <Text style={s.btnText}>{busy ? 'Re-planning…' : '↻ Regenerate'}</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

function Legend({ color, label, square }: { color: string; label: string; square?: boolean }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.legendItem}>
      <View style={[square ? s.legendSq : s.legendDot, { backgroundColor: color }]} />
      <Text style={s.legendTxt}>{label}</Text>
    </View>
  );
}

// Actual CTL/ATL history (solid, ~21 days) flowing into the 7-day forecast (dashed), with
// per-day strain bars. The full history sits behind the projection so it's in context, not
// seeded from a bare number. Same y-scale — CTL/ATL (TRIMP) and strain share a similar range.
function ProjChart({ hist, rows, c }: { hist: Hist[]; rows: Row[]; c: Palette }) {
  if (!hist.length) return null;
  const W = 320, H = 175, L = 26, R = 8, T = 8, B = 20;
  const ctl = [...hist.map(h => h.ctl), ...rows.map(r => r.ctl)];
  const atl = [...hist.map(h => h.atl), ...rows.map(r => r.atl)];
  const N = ctl.length, hN = hist.length;          // join (today) = index hN-1
  const yMax = Math.max(10, ...ctl, ...atl, ...rows.map(r => r.strain)) * 1.1;
  const xAt = (i: number) => L + ((W - L - R) / (N - 1)) * i;
  const yAt = (v: number) => H - B - (v / yMax) * (H - B - T);
  const poly = (arr: number[], from: number, to: number) =>
    arr.slice(from, to).map((v, k) => `${xAt(from + k).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const barW = Math.min(15, (W - L - R) / N * 0.6);
  const todayX = xAt(hN - 1);

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      {[0, 0.5, 1].map((f, k) => {
        const y = T + (H - B - T) * f;
        return <Line key={k} x1={L} y1={y} x2={W - R} y2={y} stroke={c.border} strokeWidth={0.5} />;
      })}
      <SvgText x={2} y={yAt(yMax) + 4} fontSize={9} fill={c.textFaint}>{Math.round(yMax)}</SvgText>
      <SvgText x={2} y={yAt(0)} fontSize={9} fill={c.textFaint}>0</SvgText>
      <Line x1={todayX} y1={T} x2={todayX} y2={H - B} stroke={c.textFaint} strokeWidth={1} strokeDasharray="2 3" />
      <SvgText x={todayX} y={H - 6} fontSize={9} fill={c.textFaint} textAnchor="middle">today</SvgText>
      {/* strain bars for the forecast days */}
      {rows.map((r, i) => {
        const x = xAt(hN + i) - barW / 2, y = yAt(r.strain);
        return <Rect key={r.date} x={x} y={y} width={barW} height={H - B - y} fill="#e67e2233" rx={1.5} />;
      })}
      {/* history (solid) → forecast (dashed) for CTL + ATL */}
      <Polyline points={poly(ctl, 0, hN)} fill="none" stroke="#3498db" strokeWidth={2} />
      <Polyline points={poly(atl, 0, hN)} fill="none" stroke="#e84393" strokeWidth={2} />
      <Polyline points={poly(ctl, hN - 1, N)} fill="none" stroke="#3498db" strokeWidth={2} strokeDasharray="3 3" />
      <Polyline points={poly(atl, hN - 1, N)} fill="none" stroke="#e84393" strokeWidth={2} strokeDasharray="3 3" />
    </Svg>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  intro:    { fontSize: 12.5, color: c.textSub, lineHeight: 18, marginBottom: 8 },
  startLine:{ fontSize: 12.5, fontWeight: '700', color: c.text, marginBottom: 10 },
  center:   { alignItems: 'center', paddingVertical: 40, gap: 10 },
  dim:      { color: c.textSub, fontSize: 13 },
  errText:  { color: '#e74c3c', fontSize: 13, textAlign: 'center', paddingHorizontal: 10 },
  legend:   { flexDirection: 'row', gap: 14, marginTop: 4, marginBottom: 8, justifyContent: 'center' },
  legendItem:{ flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:{ width: 14, height: 3, borderRadius: 2 },
  legendSq: { width: 10, height: 10, borderRadius: 2 },
  legendTxt:{ fontSize: 11, color: c.textSub },
  headRow:  { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 4 },
  h:        { fontSize: 10, fontWeight: '700', color: c.textFaint, letterSpacing: 0.4, textTransform: 'uppercase' },
  row:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border },
  dayLine:  { fontSize: 14 },
  weekday:  { fontSize: 14, fontWeight: '800', color: c.text },
  tag:      { fontSize: 12, fontWeight: '700' },
  struct:   { fontSize: 13, color: c.text, marginTop: 2 },
  note:     { fontSize: 11, color: c.textSub, marginTop: 1 },
  num:      { width: 46, textAlign: 'right' },
  strain:   { fontSize: 16, fontWeight: '800' },
  val:      { fontSize: 14, fontWeight: '600', color: c.textSub },
  footer:   { fontSize: 12.5, color: c.textSub, marginTop: 12, fontWeight: '600' },
  btn:      { backgroundColor: '#FF6B35', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  btnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },
});
