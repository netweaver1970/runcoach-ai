import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText } from 'react-native-svg';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { loadSnapshotCache } from '../src/services/healthkit';
import {
  assembleCoachSnapshot, getWeekPlan, synthesizeWorkout, ensureBlockPower, WeekPlanDay,
  loadWeekPlanCache, saveWeekPlanCache, getMinTSB, getShrinkToFit, setShrinkToFit,
  getPeriodization, weekCapMultiplier, cyclePhase,
} from '../src/services/coach';
import {
  estimateWorkoutLoad, strainFromLoad, estimateDayTrimp,
  calibrateTrimpRates, heatStrainFactor, TrimpRates,
} from '../src/services/trainingLoad';
import { getMorningForecast, DayForecast } from '../src/services/weather';
import { getRaceWeekPlan, RaceWeek, fmtTime } from '../src/services/racePlan';

type Row = WeekPlanDay & {
  strain: number; trimp: number; ctl: number; atl: number; tsb: number;
  adjMin: number; heat: number; capped: boolean; tsbTrim: boolean; fc?: DayForecast; label: string; adjKm?: number;
};

// Derive the displayed label FROM the actual synthesized + cap-trimmed structure, so it always
// matches what's prescribed: Z4/Z5 reps → Interval, Z3 → Tempo, a long Z2 run → Long, a short Z2 →
// Recovery, otherwise Z2.
function labelFromWorkout(wk: any, min: number): string {
  if (!wk?.blocks?.length) return 'Rest';
  const zones: string[] = wk.blocks.map((b: any) => b.hrZone).filter(Boolean);
  if (zones.some(z => z === 'Z4' || z === 'Z5')) return 'Interval';
  if (zones.some(z => z === 'Z3')) return 'Tempo';
  if (min >= 50) return 'Long';
  if (min <= 22) return 'Recovery';
  return 'Z2';
}
type Hist = { ctl: number; atl: number };

const INTENSITY: Record<string, { label: string; color: string }> = {
  rest:     { label: 'Rest',     color: '#7f8c8d' },
  easy:     { label: 'Easy',     color: '#27ae60' },
  moderate: { label: 'Moderate', color: '#e67e22' },
  hard:     { label: 'Hard',     color: '#e74c3c' },
};
// Colour by session TYPE so each reads distinctly (Tempo ≠ Long, Z2 ≠ Recovery).
const LABEL_COLOR: Record<string, string> = {
  Interval: '#e74c3c', Tempo: '#e67e22', Long: '#2980b9', Z2: '#27ae60', Recovery: '#16a085', Rest: '#7f8c8d',
};

function labelToIntensity(label?: string): 'easy' | 'moderate' | 'hard' {
  if (label === 'Intervals') return 'hard';
  if (label === 'Tempo' || label === 'LongRun') return 'moderate';
  return 'easy'; // Z2, Recovery, Easy, Unknown
}

// The prescription as a POWER-target string (watts), NO heart-rate range. The standard 600m warm-up /
// cool-down jogs are open-goal and always there → omitted; we show only the REAL structure (a drills
// block if one's prescribed, plus the work blocks). So an easy day is just "28min @ 155–201W".
function structPower(w: any): string {
  if (!w?.blocks?.length) return '';
  const segs: string[] = [];
  if (w.drillsMinutes) segs.push(`${w.drillsMinutes}min drills`);
  for (const b of w.blocks) {
    const lo = b.powerLowWatts, hi = b.powerHighWatts;
    const pwr  = lo && hi ? (lo === hi ? `${lo}W` : `${lo}–${hi}W`) : (b.hrZone ?? '');
    const work = b.repeats > 1 ? `${b.repeats}× ${b.workMinutes}min` : `${b.workMinutes}min`;
    const jog  = b.repeats > 1 && b.restMinutes ? ` (${b.restMinutes}min jog)` : '';
    segs.push(`${work} @ ${pwr}${jog}`);
  }
  return segs.join(' + ');
}

export default function WeekPlan() {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [rows, setRows]   = useState<Row[] | null>(null);
  const [hist, setHist]   = useState<Hist[]>([]);
  const [seed, setSeed]   = useState<{ ctl: number; atl: number } | null>(null);
  const [rates, setRates] = useState<TrimpRates | null>(null);
  const [weekCap, setWeekCap] = useState<{ capPct: number; cappedDays: number; forcedDays: number } | null>(null);
  const [genAt, setGenAt] = useState<string | null>(null);
  const [periodLabel, setPeriodLabel] = useState('');
  const [raceWeek, setRaceWeek] = useState<RaceWeek | null>(null);
  const [shrink, setShrink] = useState(false);
  useEffect(() => { getShrinkToFit().then(setShrink); }, []);
  const [err, setErr]     = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);

  const build = useCallback(async (forceRegen = false) => {
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

      // Stable prescription: reuse today's cached week plan unless a new run finished since it
      // was made or the user forces a regenerate. Only the LLM-chosen sessions are frozen — the
      // strain/CTL-ATL projection below is always recomputed from today's real fitness.
      const todayKey = coach.date;
      const lastRunDate = (snap.runs ?? []).reduce((m, r) => (r.date > m ? r.date : m), '');
      let days: WeekPlanDay[];
      const cached = forceRegen ? null : await loadWeekPlanCache(todayKey);
      // Regenerate if the cache predates the type-aware `kind` (so the fixed structures show without ↻).
      if (cached && cached.lastRunDate === lastRunDate && cached.days?.some(d => d.kind)) {
        days = cached.days;
        setGenAt(cached.generatedAt);
      } else {
        days = await getWeekPlan(coach, forecast);
        const generatedAt = new Date().toISOString();
        await saveWeekPlanCache({ date: todayKey, generatedAt, lastRunDate, days });
        setGenAt(generatedAt);
      }

      // Backward-looking ROLLING cap: each future run's trailing-7-day time-on-feet must not
      // exceed the 7-day window a week earlier by more than the cap %. Seed with the last 14 days
      // of ACTUAL time-on-feet and append each planned day, so the cap compounds across the week
      // and accounts for runs already done.
      const capPct = coach.loadCapPct ?? 10;
      const per = await getPeriodization();          // periodized per-week cap multiplier (build/deload)
      setPeriodLabel(per.on ? cyclePhase(new Date(), per).label : '');
      const rw = await getRaceWeekPlan(coach); setRaceWeek(rw);  // race mode → the LLM race week IS the plan
      const raceMode = !!rw;                                     // → skip the cap/TSB re-trim below
      const tof = (coach.recentTimeOnFeet ?? []).map(d => d.min);
      while (tof.length < 14) tof.unshift(0);                 // pad if short
      tof.splice(0, tof.length - 14);                          // keep the last 14 (offsets today-13…today)

      // Walk the week day-by-day: heat-cut → volume cap → TSB floor — projecting CTL/ATL/TSB forward as
      // we go, so the form floor (minTSB) can trim a session that would otherwise push fatigue too deep.
      const minTSB = await getMinTSB();
      const La = 1 - Math.exp(-1 / 7), Lc = 1 - Math.exp(-1 / 42);   // ATL/CTL EWMA weights (τ 7 / 42)
      let ctl = ctl0, atl = atl0, cappedDays = 0;
      const builtRows: Row[] = days.map((d) => {
        const fc = fxBy.get(d.date);
        const heat = fc ? heatStrainFactor({ tempC: fc.tempC, apparentC: fc.apparentC, humidity: fc.humidity }) : 1;
        const heatMin = d.intensity === 'rest' ? 0 : Math.max(8, Math.round(d.runMinutes / heat));
        const j = tof.length;
        const ref7   = tof.slice(j - 13, j - 6).reduce((a, b) => a + b, 0); // 7 days ending a week ago
        const prior6 = tof.slice(j - 6, j).reduce((a, b) => a + b, 0);      // 6 days right before this
        const allowance = ref7 > 0 ? Math.max(0, Math.round(ref7 * weekCapMultiplier(new Date(d.date + 'T00:00:00'), per, capPct) - prior6)) : heatMin;
        // Shrink-to-fit force-placed this short quality on its day. It bypasses the VOLUME cap (that's the
        // whole point — hold the structure over the +cap% ToF ceiling), but it must STILL respect the TSB
        // FLOOR: the volume cap limits weekly VOLUME, the form floor limits acute FATIGUE (a safety limit
        // shrink shouldn't blow through — that's what drove form to −15). So a forced day is trimmed toward
        // minTSB like any other, but is NEVER rested — it holds a real (if short) quality touch (FORCED_MIN)
        // so the week keeps its shape. Race mode still fully bypasses (the LLM owns that block's load).
        const FORCED_MIN = 15;
        const volMin = d.intensity === 'rest' ? 0 : ((d.forced || raceMode) ? heatMin : Math.min(heatMin, allowance));

        // TSB floor: trim the run so the projected form (ctl'−atl') doesn't fall below minTSB.
        let mins = volMin;
        if (mins > 0 && !raceMode) {
          const floor = d.forced ? FORCED_MIN : 20;               // forced quality shrinks smaller before it stops
          const tMax = (ctl * (1 - Lc) - atl * (1 - La) - minTSB) / (La - Lc); // max trimp that holds TSB ≥ floor
          for (let k = 0; k < 5 && mins >= floor; k++) {
            const tr = estimateDayTrimp(d.intensity, mins, cal);
            if (tr <= tMax) break;
            const next = Math.floor(mins * Math.max(0, tMax / tr));
            mins = next < mins ? next : mins - 5;                 // ensure progress toward the floor
          }
          if (mins < floor) mins = d.forced ? FORCED_MIN : 0;     // forced: hold a short quality; else rest under the floor
        }
        const isRun = mins > 0;
        const intensity = isRun ? d.intensity : ('rest' as typeof d.intensity);
        const volCapped = isRun && !d.forced && volMin < heatMin; // trimmed by the volume cap
        const tsbTrim   = isRun && mins < volMin;                 // trimmed by the form floor (forced days too now)
        tof.push(mins);

        const wk = !isRun ? null
          : ensureBlockPower(synthesizeWorkout(intensity, mins, d.weekday, coach.powerZones, d.kind as any), coach.powerZones);
        const structure = wk ? (structPower(wk) || d.structure) : 'Rest';
        const label = labelFromWorkout(wk, mins);
        const strain = wk ? Math.max(20, Math.round(strainFromLoad(estimateWorkoutLoad(wk) * heat))) : 20;
        const trimp = estimateDayTrimp(intensity, mins, cal);

        atl += La * (trimp - atl);
        ctl += Lc * (trimp - ctl);
        if (volCapped || tsbTrim) cappedDays++;
        const adjKm = (coach.loadUnit === 'km' && coach.paceMinPerKm && mins > 0)
          ? Math.round((mins / coach.paceMinPerKm) * 10) / 10 : undefined;
        return {
          ...d, intensity, structure, label, fc, heat, adjKm,
          adjMin: mins, capped: volCapped, tsbTrim, strain, trimp,
          ctl: Math.round(ctl * 10) / 10, atl: Math.round(atl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10,
        };
      });
      setRows(builtRows);
      // Chart context: actual CTL/ATL for the last ~21 days (today is the last point → the seed).
      setHist(tl.slice(-21).map(d => ({ ctl: d.ctl, atl: d.atl })));
      const forcedDays = days.filter(d => d.forced).length;
      setWeekCap({ capPct, cappedDays, forcedDays });
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
      {seed && (
        <Text style={s.startLine}>
          From today's history: CTL {seed.ctl.toFixed(0)} · ATL {seed.atl.toFixed(0)} · TSB {(seed.ctl - seed.atl).toFixed(0)}
          {rates ? `   ·   TRIMP/min E${rates.easy} M${rates.moderate} H${rates.hard}` : ''}
        </Text>
      )}
      {periodLabel ? <Text style={s.periodLine}>🗓  {periodLabel}</Text> : null}
      {raceWeek ? (
        <View style={s.raceBanner}>
          <Text style={s.raceTitle}>🏁  {raceWeek.phase} · {raceWeek.weeksToRace} wk to race</Text>
          <Text style={[s.raceFeas, {
            color: raceWeek.feasibility.verdict === 'achievable' ? '#27ae60'
                 : raceWeek.feasibility.verdict === 'ambitious' ? '#e67e22'
                 : raceWeek.feasibility.verdict === 'unrealistic' ? '#e74c3c' : c.textFaint,
          }]}>
            {raceWeek.feasibility.verdict !== 'unknown' ? `Goal ${raceWeek.feasibility.verdict}` : 'Feasibility'}
            {raceWeek.feasibility.note ? ` — ${raceWeek.feasibility.note}` : ''}
          </Text>
          {raceWeek.weekVolume !== '—' ? <Text style={s.raceVol}>Week ~{raceWeek.weekVolume} · long {raceWeek.longRun}</Text> : null}
        </View>
      ) : null}

      {busy && !rows && (
        <View style={s.center}><ActivityIndicator size="large" color={c.accent} /><Text style={s.dim}>Planning your week…</Text></View>
      )}

      {err && (
        <View style={s.center}>
          <Text style={s.errText}>{err}</Text>
          <TouchableOpacity style={s.btn} onPress={() => build()}><Text style={s.btnText}>Retry</Text></TouchableOpacity>
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

          <View style={s.headRow}>
            <Text style={[s.h, { flex: 1 }]}> </Text>
            <Text style={[s.h, s.numS]}>Strain</Text><Text style={[s.h, s.num]}>CTL</Text>
            <Text style={[s.h, s.num]}>ATL</Text><Text style={[s.h, s.num]}>TSB</Text>
          </View>

          {rows.map((r) => {
            const day = Number(r.date.slice(8, 10));
            const it  = INTENSITY[r.intensity] ?? INTENSITY.rest;
            const col = LABEL_COLOR[r.label] ?? it.color;
            const reduced = r.intensity !== 'rest' && r.adjMin < r.runMinutes;
            return (
              <View key={r.date} style={s.row}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={s.dayLine} numberOfLines={1}>
                    <Text style={s.weekday}>{r.weekday} {day}</Text>
                    {'  '}<Text style={[s.tag, { color: col }]}>{r.label}</Text>
                    {!!r.fc && <Text style={s.dayWx}>{'   '}{r.fc.apparentC}°·{r.fc.humidity}%</Text>}
                  </Text>
                  <Text style={s.struct} numberOfLines={3}>
                    {r.intensity === 'rest' ? 'Rest' : r.structure}
                    {r.adjKm != null && r.intensity !== 'rest' ? `  ·  ${r.adjKm} km` : ''}
                    {reduced ? `  → ${r.adjMin}min ${r.tsbTrim ? '(form)' : r.capped ? '(cap)' : '(heat)'}` : ''}
                  </Text>
                </View>
                <Text style={[s.numS, s.strain, { color: col }]}>{r.strain}</Text>
                <Text style={[s.num, s.val]}>{r.ctl.toFixed(0)}</Text>
                <Text style={[s.num, s.val]}>{r.atl.toFixed(0)}</Text>
                <Text style={[s.num, s.val, { color: r.tsb < -10 ? '#e74c3c' : r.tsb > 5 ? '#3498db' : c.textSub }]}>
                  {r.tsb > 0 ? '+' : ''}{r.tsb.toFixed(0)}
                </Text>
              </View>
            );
          })}

          <Text style={[s.footer, !!weekCap && (weekCap.cappedDays > 0 || weekCap.forcedDays > 0) && { color: '#e67e22' }]}>
            {runDays} run day{runDays === 1 ? '' : 's'} · {totalRunMin} run-min (work) this week
            {weekCap ? (weekCap.forcedDays > 0
              ? `  ·  ${weekCap.forcedDays} quality held on its day, shortened — over the +${weekCap.capPct}%/wk cap (shrink-to-fit)`
              : weekCap.cappedDays > 0
                ? `  ·  ${weekCap.cappedDays} day${weekCap.cappedDays === 1 ? '' : 's'} trimmed to the +${weekCap.capPct}%/wk cap or TSB floor`
                : `  ·  within the +${weekCap.capPct}%/wk cap + TSB floor ✓`) : ''}
          </Text>

          {genAt && (
            <Text style={s.genLine}>
              Planned {new Date(genAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
              {' '}· stays fixed until a new run or ↻
            </Text>
          )}

          <TouchableOpacity
            style={[s.btn, { backgroundColor: shrink ? '#27ae60' : undefined }, busy && { opacity: 0.5 }]}
            onPress={async () => { const v = !shrink; setShrink(v); await setShrinkToFit(v); build(true); }}
            disabled={busy}
          >
            <Text style={s.btnText}>{shrink ? '✓ Shrink-to-fit: ON' : 'Shrink-to-fit: OFF'}</Text>
          </TouchableOpacity>
          <Text style={s.genLine}>
            {shrink ? 'Tight weeks: tempo/intervals shorten to hold their day; the long run is protected.'
                    : 'Tight weeks: a quality that won’t fit is deferred to a later day.'}
          </Text>

          <TouchableOpacity style={[s.btn, busy && { opacity: 0.5 }]} onPress={() => build(true)} disabled={busy}>
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
  const W = 320, H = 132, L = 26, R = 8, T = 8, B = 20;
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
  periodLine:{ fontSize: 13, fontWeight: '800', color: c.accent, marginTop: -4, marginBottom: 10 },
  raceBanner:{ backgroundColor: c.surface, borderRadius: 12, padding: 12, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: c.accent },
  raceTitle: { fontSize: 14, fontWeight: '800', color: c.text, marginBottom: 3 },
  raceFeas:  { fontSize: 12.5, fontWeight: '600', marginBottom: 2 },
  raceVol:   { fontSize: 11.5, color: c.textFaint },
  center:   { alignItems: 'center', paddingVertical: 40, gap: 10 },
  dim:      { color: c.textSub, fontSize: 13 },
  errText:  { color: '#e74c3c', fontSize: 13, textAlign: 'center', paddingHorizontal: 10 },
  legend:   { flexDirection: 'row', gap: 14, marginTop: 4, marginBottom: 8, justifyContent: 'center' },
  legendItem:{ flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:{ width: 14, height: 3, borderRadius: 2 },
  legendSq: { width: 10, height: 10, borderRadius: 2 },
  legendTxt:{ fontSize: 11, color: c.textSub },
  headRow:  { flexDirection: 'row', alignItems: 'flex-end', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border },
  h:        { fontSize: 9, fontWeight: '700', color: c.textFaint, letterSpacing: 0.2, textTransform: 'uppercase' },
  row:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border },
  dayLine:  { fontSize: 14 },
  weekday:  { fontSize: 14, fontWeight: '800', color: c.text },
  tag:      { fontSize: 12, fontWeight: '700' },
  struct:   { fontSize: 13, color: c.text, marginTop: 2 },
  dayWx:    { fontSize: 11.5, fontWeight: '500', color: c.textFaint }, // concise temp·humidity, inline on line 1
  note:     { fontSize: 11, color: c.textSub, marginTop: 1 },
  num:      { width: 36, textAlign: 'right' },
  numS:     { width: 44, textAlign: 'right' }, // strain column — a touch wider so "Strain" fits on one line
  strain:   { fontSize: 15, fontWeight: '800' },
  val:      { fontSize: 13, fontWeight: '600', color: c.textSub },
  footer:   { fontSize: 12.5, color: c.textSub, marginTop: 12, fontWeight: '600' },
  genLine:  { fontSize: 11.5, color: c.textFaint, marginTop: 14, textAlign: 'center' },
  btn:      { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  btnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },
});
