import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText } from 'react-native-svg';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { loadSnapshotCache, fetchTrainingLoadHistory } from '../src/services/healthkit';
import {
  freshnessCapFactor, assembleCoachSnapshot, getWeekPlan, synthesizeWorkout, ensureBlockPower, WeekPlanDay, accountingModeSync,
  loadWeekPlanCache, saveWeekPlanCache, getMinTSB, getShrinkToFit, setShrinkToFit,
  getPeriodization, weekCapMultiplier, cyclePhase, HEAT_CREDIT_MAX, BASE_WINDOWS,
} from '../src/services/coach';
import {
  estimateWorkoutLoad, strainFromLoad, estimateDayTrimp,
  calibrateTrimpRates, heatStrainFactor, TrimpRates,
} from '../src/services/trainingLoad';
import { getMorningForecast, DayForecast } from '../src/services/weather';
import { getRaceWeekPlan, RaceWeek, fmtTime } from '../src/services/racePlan';
import { recordForecast, recordActuals } from '../src/services/forecastLog';

type Row = WeekPlanDay & {
  strain: number; trimp: number; ctl: number; atl: number; tsb: number;
  adjMin: number; countedMin: number; heat: number; capped: boolean; tsbTrim: boolean; floorRest: boolean; taperRest: boolean; fc?: DayForecast; label: string; adjKm?: number;
};

// Derive the displayed label FROM the actual synthesized + cap-trimmed structure, so it always
// matches what's prescribed: Z4/Z5 reps → Interval, Z3 → Tempo, a long Z2 run → Long, a short Z2 →
// Recovery, otherwise Z2.
function labelFromWorkout(wk: any, min: number, kind?: string): string {
  if (!wk?.blocks?.length) return 'Rest';
  // The PLANNER's decision wins. Deriving the badge from duration alone inverted the week: a 56min easy
  // Z2 was badged "Long" just for clearing 50min, while the real long run — trimmed to 41min by the cap —
  // was badged "Z2". That read as two long runs on days the plan never scheduled one.
  if (kind === 'long') return 'Long';
  if (kind === 'intervals') return 'Interval';
  if (kind === 'tempo') return 'Tempo';
  const zones: string[] = wk.blocks.map((b: any) => b.hrZone).filter(Boolean);
  if (zones.some(z => z === 'Z4' || z === 'Z5')) return 'Interval';
  if (zones.some(z => z === 'Z3')) return 'Tempo';
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
  const [seed, setSeed]   = useState<{ ctl: number; atl: number; strain: number } | null>(null);
  const [rates, setRates] = useState<TrimpRates | null>(null);
  const [weekCap, setWeekCap] = useState<{ capPct: number; cappedDays: number; forcedDays: number; floorRestDays: number; taperDays: number; minTSB: number } | null>(null);
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

      // Seed from TODAY's real CTL/ATL. Recompute the series FRESH (current max-HR etc.) rather than the
      // CACHED snapshot.trainingLoad, which lags stale when the observed-max-HR anchor just moved (the scan
      // computes trainingLoad before it updates the anchor) — that showed a plan CTL 44 vs a live +
      // HealthFit-confirmed ~40. Falls back to the cached series if the fetch fails.
      const tl = (await fetchTrainingLoadHistory(1).catch(() => null)) ?? snap.trainingLoad ?? [];
      const todayLoad = tl.length ? tl[tl.length - 1] : null;
      const ctl0 = todayLoad?.ctl ?? 0, atl0 = todayLoad?.atl ?? 0;
      // Today's strain (from today's realised load) — for the "Today" anchor row that bridges the header to
      // the forecast, so the first forward day's drop (a rest-day decay) reads as continuous, not a mismatch.
      setSeed({ ctl: ctl0, atl: atl0, strain: Math.max(20, Math.round(strainFromLoad(todayLoad?.load ?? 0))) });

      // Rolling per-intensity TRIMP/min calibration — computed continuously by the app during
      // every health sync (snap.trimpRates). Fall back to computing it here for older caches.
      const loadByDate = new Map(tl.map(d => [d.date, d.load]));
      const cal: TrimpRates = snap.trimpRates ?? calibrateTrimpRates((snap.runs ?? []).map(r => ({
        intensity: labelToIntensity(r.label),
        minutes: r.duration / 60,   // TOTAL run minutes (match the projection's run-minute basis) — NOT work-only, which inflated the rate ~1.8× (see healthkit.ts)
        dayLoad: loadByDate.get(r.date.slice(0, 10)) ?? 0,
        daysAgo: (Date.now() - new Date(r.date).getTime()) / 86_400_000,
      })));
      setRates(cal);

      const coach = await assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs);
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
      // Seed 28 days (dates kept) so this re-trim grows off the SAME base as getWeekPlan / the daily engine:
      // MAX of the last BASE_WINDOWS heat-credited weeks (a hot/sick week can't erode it). Without this the
      // screen re-trimmed against the raw single prior week and silently undid the anti-erosion fix.
      const HIST = 28;
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const isoOf = (dt: Date) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
      const histSrc = (coach.recentTof28 && coach.recentTof28.length ? coach.recentTof28 : (coach.recentTimeOnFeet ?? []));
      const tof = histSrc.map(d => d.min);
      const tofDate = histSrc.map(d => d.date);
      while (tof.length < HIST) {
        tof.unshift(0);
        const f = tofDate.length ? new Date(tofDate[0] + 'T00:00:00') : new Date();
        f.setDate(f.getDate() - 1);
        tofDate.unshift(isoOf(f));
      }
      tof.splice(0, tof.length - HIST); tofDate.splice(0, tofDate.length - HIST);
      const heatBy = coach.heatByDate ?? {};
      const clampCredit = (fac?: number) => Math.min(Math.max(1, fac ?? 1), HEAT_CREDIT_MAX);

      // Project CTL/ATL/TSB forward. Two passes:
      //   1. Per-day TSB floor — "protect the long, cap the rest". Only the LONG is protected THROUGH the floor
      //      (its own day may dip, held at ≥ LONG_FLOOR); every other day yields — trimmed to hold form ≥ minTSB,
      //      RESTED if even a minimal dose would breach it.
      //   2. Taper — a per-day floor still lets a run the DAY BEFORE the long leave form at −10, so the protected
      //      long then compounds far past the floor (that's what drove it to −20). So if the long still dips more
      //      than LONG_DIP_MARGIN below minTSB, REST the run days immediately before it (up to 2) to bank
      //      freshness, re-projecting until the long's dip is shallow. This is the "tighten the days around the
      //      long" the user asked for. Race mode fully bypasses (the LLM owns that block's load).
      const minTSB = await getMinTSB();
      // Same freshness modulation the planner uses (computed PER-DAY inside walk so a build week relaxes it),
      // so this re-trim can't undo the planner's build-week ceiling.
      const La = 1 - Math.exp(-1 / 7), Lc = 1 - Math.exp(-1 / 42);   // ATL/CTL EWMA weights (τ 7 / 42)
      const MIN_QUALITY = 15;      // a quality trimmed shorter than this isn't worth holding → rest instead
      const LONG_FLOOR = 45;       // the long is never trimmed into a recovery jog, even below the floor
      const LONG_DIP_MARGIN = 3;   // the protected long may sit up to this far below minTSB before we taper into it
      const tof0 = [...tof];       // snapshot of actual ToF history — each projection pass replays from the same base
      const tofDate0 = [...tofDate];

      const walk = (taperSet: Set<number>): { rows: Row[]; cappedDays: number } => {
        const tofW = [...tof0];
        const tofDateW = [...tofDate0];
        const creditedAt = (idx: number) => (tofW[idx] ?? 0) * clampCredit(heatBy[tofDateW[idx]]);
        let ctl = ctl0, atl = atl0, cappedDays = 0;
        const rows = days.map((d, i) => {
          const fc = fxBy.get(d.date);
          const heat = fc ? heatStrainFactor({ tempC: fc.tempC, apparentC: fc.apparentC, humidity: fc.humidity }) : 1;
          const heatMin = d.intensity === 'rest' ? 0 : Math.max(8, Math.round(d.runMinutes / heat));
          const j = tofW.length;
          // Base = MAX over the last BASE_WINDOWS heat-credited 7-day blocks (matches getWeekPlan / the daily
          // engine); consumption (prior6) stays raw. This is what makes the plan reflect the anti-erosion cap.
          let baseRef = 0;
          for (let w = 0; w < BASE_WINDOWS; w++) { let s = 0; for (let idx = j - 13 - 7 * w; idx <= j - 7 - 7 * w; idx++) s += creditedAt(idx); baseRef = Math.max(baseRef, s); }
          const prior6 = tofW.slice(j - 6, j).reduce((a, b) => a + b, 0);      // 6 days right before this
          const dDate = new Date(d.date + 'T00:00:00');
          const buildDay = per.on && cyclePhase(dDate, per).phase === 'build';
          const freshDay = freshnessCapFactor(coach.tsb, coach.acwr, buildDay);
          const allowance = baseRef > 0 ? Math.max(0, Math.round(baseRef * weekCapMultiplier(dDate, per, capPct, BASE_WINDOWS > 1) * freshDay - prior6)) : heatMin;
          const isLongDay = d.forced && d.kind === 'long';
          const volMin = d.intensity === 'rest' ? 0 : ((d.forced || raceMode) ? heatMin : Math.min(heatMin, allowance));

          let mins = volMin;
          let floorRested = false;
          let taperRested = false;
          if (taperSet.has(i) && !isLongDay) {                     // pass 2: taper into the long → rest to bank freshness
            mins = 0; taperRested = true;
          } else if (mins > 0 && !raceMode) {
            const floor = isLongDay ? LONG_FLOOR : MIN_QUALITY;
            const tMax = (ctl * (1 - Lc) - atl * (1 - La) - minTSB) / (La - Lc); // max trimp that holds TSB ≥ minTSB
            // Trim toward the floor while the session would push form below minTSB (never trimming below the floor).
            for (let k = 0; k < 6 && mins > floor; k++) {
              const tr = estimateDayTrimp(d.intensity, mins, cal);
              if (tr <= tMax) break;
              const next = Math.floor(mins * Math.max(0, tMax / tr));
              mins = next < mins ? Math.max(floor, next) : Math.max(floor, mins - 5); // progress, but hold the floor
            }
            // If even the floored dose STILL breaches minTSB, the long is protected (holds LONG_FLOOR, accepts the
            // dip) while every other day yields and RESTS — so the floor genuinely holds on all but the long's day.
            if (estimateDayTrimp(d.intensity, mins, cal) > tMax) {
              if (isLongDay) mins = LONG_FLOOR;
              else { mins = 0; floorRested = true; }
            }
          }
          const isRun = mins > 0;
          const intensity = isRun ? d.intensity : ('rest' as typeof d.intensity);
          const volCapped = isRun && !d.forced && volMin < heatMin; // trimmed by the volume cap
          const tsbTrim   = isRun && mins < volMin;                 // trimmed by the form floor (forced days too now)
          // Build the session FIRST so the cap counts the SAME work the row prints.
          // Match the daily plan's true-work-minutes cap so the week's interval/tempo days render the same
          // ramped structure (intervals +1 rep, tempo +cap%) rather than an uncapped synthesis.
          const rqw = d.kind === 'intervals' ? coach.recentQualityWork?.intervals
                    : d.kind === 'tempo'     ? coach.recentQualityWork?.tempo : undefined;
          const wk = !isRun ? null
            : ensureBlockPower(synthesizeWorkout(intensity, mins, d.weekday, coach.powerZones, d.kind as any, rqw, coach.loadCapPct), coach.powerZones);
          // Counted time-on-feet for the +cap% budget + footer. WORK accounting counts only what the session
          // prescribes AS work — drills + work blocks — leaving warm-up/cool-down (open) and interval recovery
          // jogs (recovery) OUT, matching the work-only historical base. FULL counts the whole session.
          const workBlockMin = wk ? wk.blocks.reduce((a, b) => a + b.workMinutes * (b.repeats || 1), 0) : 0;
          const countedMin = !isRun ? 0
            : accountingModeSync() === 'full' ? mins
            : (wk?.drillsMinutes || 0) + workBlockMin;
          tofW.push(countedMin); tofDateW.push(d.date);   // keep the date array aligned for the max-window base
          const structure = wk ? (structPower(wk) || d.structure) : 'Rest';
          const label = isLongDay && isRun ? 'Long' : labelFromWorkout(wk, mins, d.kind);
          const strain = wk ? Math.max(20, Math.round(strainFromLoad(estimateWorkoutLoad(wk) * heat))) : 20;
          // NB: do NOT price this from prescribedTrimp(wk). That integrates the PRESCRIBED zones, which
          // assumes the athlete's HR actually reaches them. Checked against Geert's real runs (07-22):
          // an intervals day prescribed at Z4 259–265 W was executed at 256 W — on target — yet work HR
          // reached only 134 (HR-reserve 0.56, i.e. Z2), so prescribedTrimp read 90 against a measured
          // day-load of 38. Projecting off prescribed zones would over-state every quality day ~2.4x and
          // make the coach trim against fatigue that never arrives. Measured rates keep this honest.
          const trimp = estimateDayTrimp(intensity, mins, cal);

          atl += La * (trimp - atl);
          ctl += Lc * (trimp - ctl);
          if (volCapped || tsbTrim) cappedDays++;
          const adjKm = (coach.loadUnit === 'km' && coach.paceMinPerKm && mins > 0)
            ? Math.round((mins / coach.paceMinPerKm) * 10) / 10 : undefined;
          return {
            ...d, intensity, structure, label, fc, heat, adjKm,
            adjMin: mins, countedMin, capped: volCapped, tsbTrim, floorRest: floorRested, taperRest: taperRested, strain, trimp,
            ctl: Math.round(ctl * 10) / 10, atl: Math.round(atl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10,
          };
        });
        return { rows, cappedDays };
      };

      const taperSet = new Set<number>();
      let res = walk(taperSet);
      const longIdx = days.findIndex(d => d.forced && d.kind === 'long');
      if (longIdx > 0) {
        for (let back = 1; back <= 2 && (longIdx - back) >= 0; back++) {
          if (res.rows[longIdx].tsb >= minTSB - LONG_DIP_MARGIN) break; // long's dip already shallow enough
          if (res.rows[longIdx - back].intensity === 'rest') continue;  // already easy/rest → nothing to bank here
          taperSet.add(longIdx - back);
          res = walk(taperSet);
        }
      }
      const builtRows = res.rows;
      setRows(builtRows);
      // Log the projected trajectory (+ today's realised load) so projected-vs-realised TSB can be
      // calibrated later — the −10 form gate over-projects fatigue vs what materialises.
      recordForecast(builtRows, todayKey).catch(() => {});
      recordActuals(tl.map(d => ({ date: d.date, ctl: d.ctl, atl: d.atl, tsb: d.tsb, load: d.load }))).catch(() => {});
      // Chart context: actual CTL/ATL for the last ~21 days (today is the last point → the seed).
      setHist(tl.slice(-21).map(d => ({ ctl: d.ctl, atl: d.atl })));
      const forcedDays = days.filter(d => d.forced).length;
      const floorRestDays = builtRows.filter(r => r.floorRest).length;
      const taperDays = builtRows.filter(r => r.taperRest).length;
      setWeekCap({ capPct, cappedDays: res.cappedDays, forcedDays, floorRestDays, taperDays, minTSB });
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to build the week plan.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { build(); }, [build]);

  const totalRunMin = rows?.reduce((a, r) => a + r.countedMin, 0) ?? 0;
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

          {/* TODAY anchor — where fitness/fatigue stand NOW (= the header). The forecast below builds from
              here, so the first forward day's drop reads as a one-day decay, not a mismatch with the header. */}
          <View style={[s.row, { opacity: 0.6 }]}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={s.dayLine} numberOfLines={1}>
                <Text style={s.weekday}>Today</Text>{'  '}<Text style={[s.tag, { color: c.textFaint }]}>done · from your history</Text>
              </Text>
            </View>
            <Text style={[s.numS, s.strain, { color: c.textFaint }]}>{seed.strain}</Text>
            <Text style={[s.num, s.val]}>{seed.ctl.toFixed(0)}</Text>
            <Text style={[s.num, s.val]}>{seed.atl.toFixed(0)}</Text>
            <Text style={[s.num, s.val, { color: (seed.ctl - seed.atl) < -10 ? '#e74c3c' : (seed.ctl - seed.atl) > 5 ? '#3498db' : c.textSub }]}>
              {(seed.ctl - seed.atl) > 0 ? '+' : ''}{(seed.ctl - seed.atl).toFixed(0)}
            </Text>
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
                    {r.intensity === 'rest'
                      ? (r.taperRest ? 'Rest — tapering into tomorrow’s long' : r.floorRest ? 'Rest — held to your form floor' : 'Rest')
                      : r.structure}
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

          <Text style={s.axisNote}>
            Strain = each session's acute stress (a short, hard interval scores high). CTL/ATL = accumulated load —
            a 60-min easy long run adds more load than a 12-min interval block even though it feels easier, so it lifts ATL more.
          </Text>

          <Text style={[s.footer, !!weekCap && (weekCap.cappedDays > 0 || weekCap.floorRestDays > 0 || weekCap.taperDays > 0) && { color: '#e67e22' }]}>
            {runDays} run day{runDays === 1 ? '' : 's'} · {totalRunMin} run-min ({accountingModeSync() === 'full' ? 'incl. warm-up/cool-down' : 'work'}) this week
            {weekCap ? ((weekCap.floorRestDays + weekCap.taperDays) > 0
              ? `  ·  ${weekCap.floorRestDays + weekCap.taperDays} day${(weekCap.floorRestDays + weekCap.taperDays) === 1 ? '' : 's'} rested for your ${weekCap.minTSB} TSB floor${weekCap.taperDays > 0 ? ' + long taper' : ''} (long protected)`
              : weekCap.cappedDays > 0
                ? `  ·  ${weekCap.cappedDays} day${weekCap.cappedDays === 1 ? '' : 's'} trimmed to the +${weekCap.capPct}%/wk cap or ${weekCap.minTSB} TSB floor`
                : `  ·  within the +${weekCap.capPct}%/wk cap + ${weekCap.minTSB} TSB floor ✓`) : ''}
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
      <SvgText x={2} y={yAt(yMax) + 4} fontSize={9} fill={c.textSub} fontWeight="600">{Math.round(yMax)}</SvgText>
      <SvgText x={2} y={yAt(0)} fontSize={9} fill={c.textSub} fontWeight="600">0</SvgText>
      <Line x1={todayX} y1={T} x2={todayX} y2={H - B} stroke={c.textFaint} strokeWidth={1} strokeDasharray="2 3" />
      <SvgText x={todayX} y={H - 6} fontSize={9} fill={c.textSub} fontWeight="600" textAnchor="middle">today</SvgText>
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
  axisNote: { fontSize: 11, color: c.textFaint, lineHeight: 16, marginTop: 12 },
  footer:   { fontSize: 12.5, color: c.textSub, marginTop: 12, fontWeight: '600' },
  genLine:  { fontSize: 11.5, color: c.textFaint, marginTop: 14, textAlign: 'center' },
  btn:      { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  btnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },
});
