import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DayStrain } from '../src/types';
import { useThemedStyles, Palette } from '../src/theme';
import { SubKPICard, buildHistories } from '../src/components/SubKPICard';
import { fetchOurDailyComponents, fetchDailyDurationHistory, loadSnapshotCache } from '../src/services/healthkit';
import { strainStatus, strainFromLoad, estimateWorkoutLoad, heatStrainFactor, computeWorkoutLoad, trainingDayKey, estimateDayTrimp } from '../src/services/trainingLoad';
import { getCoachPlan, deterministicCoachPlan, loadCachedPlan, saveCachedPlan, buildCapContext, CapContext, getLoadCapPct, getCtlRampTarget, getLoadCapBasis, synthesizeWorkout, mergeWorkoutPower, planNeedsRefresh, shrinkWantsQualityToday, CoachPlan } from '../src/services/coach';
import { useLLMReady } from '../src/hooks/useLLMReady';
import { ensureZonesFile } from '../src/services/zones';
import { weekdaySlot } from '../src/services/watchWorkout';
import { getLocalWeather, weatherSummary, WeatherNow } from '../src/services/weather';
import { toDateKey } from '../src/services/dayView';
import { useDetailSwipe } from '../src/components/useDetailSwipe';
import { KpiTabs } from '../src/components/KpiTabs';
import { DayNav } from '../src/components/DayNav';
import { cached } from '../src/services/detailCache';
import { pushWorkoutToWatch, watchModuleAvailable } from '../src/services/watchWorkout';
import { getPowerZones } from '../src/services/claude';

/** Label + colour for a strain score on a PAST day (the readiness band lives on today's DayStrain only). */
function strainVisual(v: number): { label: string; color: string } {
  if (v >= 60) return { label: 'High',     color: '#e74c3c' };
  if (v >= 35) return { label: 'Moderate', color: '#f39c12' };
  if (v >= 20) return { label: 'Light',    color: '#27ae60' };
  return { label: 'Rest', color: '#3498db' };
}

const INTENSITY_COLOR: Record<string, string> = {
  rest: '#3498db', easy: '#27ae60', moderate: '#f39c12', hard: '#e74c3c',
};

// Compact icon per HealthKit workout type for the strain-buildup list.
function actEmoji(type: number, distanceKm: number): string {
  switch (type) {
    case 37: return '🏃';           // running
    case 52: return '🚶';           // walking
    case 24: return '🥾';           // hiking
    case 13: return '🚴';           // cycling
    case 46: return '🏊';           // swimming
    case 63: return '🧘';           // yoga
    case 44: case 50: return '💪';  // functional / traditional strength
    case 35: return '🚣';           // rowing
    case 16: return '🕺';           // dance
  }
  return distanceKm > 0 ? '🏃' : '💪';
}

export default function StrainDetailScreen() {
  const { str, rec, date } = useLocalSearchParams<{ str?: string; rec?: string; date?: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeStyles);
  const strain = str ? JSON.parse(str) as DayStrain : null;
  const swipe = useDetailSwipe('/strain-detail', { rec, str, date });
  const dateLbl = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) : '';
  const dayLabel = dateLbl || new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

  const [comps, setComps] = useState<Record<string, Record<string, number>>>({});
  const [dur, setDur] = useState<{ date: string; value: number }[]>([]);
  const [weather, setWeather] = useState<WeatherNow | null>(null);
  const [loadingH, setLoadingH] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [plan, setPlan] = useState<CoachPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);   // deterministic (fast) generate/regenerate
  const [proseLoading, setProseLoading] = useState(false); // on-request LLM coach's-notes
  const [planError, setPlanError] = useState<string | null>(null);
  const llm = useLLMReady();
  const [watchSending, setWatchSending] = useState(false);
  const [watchMsg, setWatchMsg] = useState<string | null>(null);

  const [powerZones, setPowerZones] = useState<any>(undefined);
  const [runAdj, setRunAdj] = useState<number | null>(null); // user override of prescribed run minutes
  // Sync zones (mirrors the calibrated file → getPowerZones) BEFORE reading, so a re-synthesized
  // adjusted workout carries real watts even on the first launch after install.
  useEffect(() => { ensureZonesFile().then(() => getPowerZones()).then(setPowerZones).catch(() => {}); }, []);

  const sendToWatch = async () => {
    if (!watchWorkout) return;
    setWatchSending(true); setWatchMsg(null);
    try {
      if (!watchModuleAvailable()) { setWatchMsg('Watch module not in this build.'); return; }
      const ok = await pushWorkoutToWatch(watchWorkout);
      setWatchMsg(ok ? '✓ Sent — open the Workout app on your watch.' : 'Could not send (needs iOS 17+ and permission).');
      // Record what was ACTUALLY pushed (incl. any ± edit) as the live prescription, so the post-run
      // analysis judges the run against the structure that went to the watch — not yesterday's plan or
      // a pre-edit version.
      if (ok && plan && targetIsToday) {
        const pushed: CoachPlan = { ...plan, runMinutes: effRunMin, workout: watchWorkout, generatedAt: new Date().toISOString() };
        await saveCachedPlan(targetDate, pushed);
        setPlan(pushed);
      }
    } catch (e: any) {
      setWatchMsg(e?.message ?? 'Send failed.');
    } finally { setWatchSending(false); }
  };

  // Load a window that COVERS the viewed day: 3 months by default (same `comps:3` key as Recovery detail, pre-warmed
  // by the home), widened a month at a time when DayNav pages further back. The old fixed 0.3-month (~9 day) load
  // left an older day missing from `comps`, and the screen then silently showed TODAY's numbers under that date.
  const histMonths = useMemo(() => {
    if (!date) return 3;
    const daysBack = Math.ceil((Date.now() - new Date(date + 'T00:00:00').getTime()) / 86_400_000);
    // Round UP to 3/6/12/24 months: stepping per 30 days recomputed the whole window (and cached one more big
    // `comps:N` entry) at every month boundary while paging back.
    return [3, 6, 12, 24].find(m => m * 30 >= daysBack + 1) ?? Math.ceil((daysBack + 1) / 30);
  }, [date]);
  const loadSeq = useRef(0);   // only the LATEST load may update state (a faster earlier one flashed "no data")
  const loadHistory = useCallback((months: number, isRefresh = false) => {
    const seq = ++loadSeq.current;
    if (isRefresh) setRefreshing(true); else setLoadingH(true);
    // Cached so tab-switches don't re-query HealthKit; pull-to-refresh forces a recompute (ttl 0 → re-cached).
    const compsP = cached(`comps:${months}`, () => fetchOurDailyComponents(months, undefined, isRefresh), isRefresh ? 0 : undefined);
    const durP   = isRefresh ? fetchDailyDurationHistory()      : cached('dur', () => fetchDailyDurationHistory());
    Promise.all([compsP, durP])
      .then(([c, d]) => { if (seq !== loadSeq.current) return; setComps(c); setDur(d); })
      .catch(() => {})
      .finally(() => { if (seq !== loadSeq.current) return; setLoadingH(false); setRefreshing(false); });
  }, []);
  useEffect(() => { loadHistory(histMonths); }, [loadHistory, histMonths]);
  useEffect(() => { getLocalWeather().then(setWeather).catch(() => {}); }, []);
  const onRefresh = useCallback(() => loadHistory(histMonths, true), [loadHistory, histMonths]);

  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  // Sub-KPI values for the VIEWED day (target is defined below; this closure runs in render).
  const last = (k: string) => { const v = target[k]; return v != null ? v : null; };

  // The screen renders the VIEWED day (the `date` param; none = today). NEVER fall back to another day when that
  // day has no row: the old fallback (last day with data ≈ today) put today's numbers under a past date. A
  // missing day renders the explicit "no data for this day" state below instead.
  const dates      = Object.keys(comps).sort();
  const targetDate = date || toDateKey(new Date());
  const target     = comps[targetDate] ?? {};
  const targetIsToday = targetDate === toDateKey(new Date());
  // Histories END at the viewed day, so a past day's sparklines + badges aren't today's.
  const hist = useMemo(
    () => buildHistories(comps, ['strainScore', 'exerciseDuration', 'daytimeHR', 'totalEnergy', 'stepCount', 'cardioLoad'], targetDate),
    [comps, targetDate],
  );

  // Strain value + status: today's DayStrain (str, with the readiness band) applies ONLY when the viewed
  // day IS today — the day-swipe keeps rec/str params, so without this gate a past day rendered TODAY's
  // hero number and readiness band. Past days render from the stored per-day components.
  const strainToday = targetIsToday ? strain : null;
  const real   = strainToday?.real ?? Math.round((target.strainScore as number) ?? 0);
  const status = strainToday ? strainStatus(strainToday) : strainVisual(real);
  // "est." readiness: viewing today but there's no overnight recovery for last night (watch not worn)
  // → the recovery/readiness shown is the last-known estimate, not today's. (History days have data.)
  const realTodayKey = toDateKey(new Date());
  const wantToday = !date || date === realTodayKey;
  const todayRec = comps[realTodayKey];
  const recoveryStale = wantToday && dates.length > 0 && (!todayRec || (!todayRec.timeAsleep && todayRec.restingHrv == null));

  // The workout to show/push: the coach's, or a synthesized one on any run-day plan
  // (covers stale cached plans + LLM omissions, so the watch box always appears on run days).
  // runAdj lets the user nudge the prescribed run minutes ± before pushing to the watch.
  const baseRunMin   = plan?.runMinutes ?? 0;
  const effRunMin    = Math.max(0, runAdj ?? baseRunMin);
  // Distance-basis display: derive km from the plan's km↔min ratio (the ± adjust stays minute-based).
  const kmPerMin     = plan?.runKm != null && plan.runMinutes ? plan.runKm / plan.runMinutes : null;
  const effKm        = kmPerMin != null ? Math.round(effRunMin * kmPerMin * 10) / 10 : null;
  const effDose      = effKm != null ? `${effKm} km` : `${effRunMin}m`;
  const watchWorkout = plan && plan.intensity !== 'rest'
    ? ((runAdj != null || !plan.workout)
        ? mergeWorkoutPower(
            synthesizeWorkout(plan.intensity, effRunMin, weekdaySlot(new Date(targetDate + 'T00:00:00')), powerZones),
            plan.workout)   // re-synth on ± adjust: inherit the original plan's per-zone watts (duration-only change)
        : plan.workout)
    : null;

  // Projected strain the prescribed (or adjusted) run will add → today's resulting total vs the band.
  const planHeatFactor = heatStrainFactor(targetIsToday && weather
    ? { tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity } : null);
  const runLoad         = watchWorkout ? estimateWorkoutLoad(watchWorkout) : 0;
  // additive like computeDayStrain (per-activity strains + passive are SUMMED): today so far + the run's own strain
  const projectedStrain = watchWorkout ? real + strainFromLoad(runLoad * planHeatFactor) : real;
  const runStrain       = Math.max(0, projectedStrain - real);

  // Rolling progression cap as of the viewed day, honouring the user's % + basis settings.
  const [capCtx, setCapCtx] = useState<CapContext | null>(null);
  useEffect(() => {
    if (!dur.length) { setCapCtx(null); return; }
    let cancelled = false;
    (async () => {
      const [pct, basis] = await Promise.all([getLoadCapPct(), getLoadCapBasis()]);
      const ctx = await buildCapContext(dur, new Date(targetDate + 'T00:00:00'), pct, basis);
      if (!cancelled) setCapCtx(ctx);
    })();
    return () => { cancelled = true; };
  }, [dur, targetDate]);
  const tof = capCtx?.tof ?? null;
  // Strain history up to and including the viewed day (for recent/yesterday context).
  const strainHistUpTo = dates.filter(d => d <= targetDate)
    .map(d => comps[d].strainScore).filter((v): v is number => v !== undefined);

  // Single source of truth for the displayed band + drivers: the readiness carried on
  // the viewed day's DayStrain — the ring, hero, this card and the coach all agree.
  const readiness = {
    readiness: strainToday?.readiness ?? 0,
    acwr:      strainToday?.acwr ?? 0,
    drivers:   strainToday?.drivers ?? [],
    safeLow:   strainToday?.safeLow ?? 0,
    safeHigh:  strainToday?.safeHigh ?? 0,
  };

  // Coach plan moved to app/daily-coach.tsx — this screen no longer loads/generates/pushes a plan.
  // `plan` stays null, so the disabled coach block never renders and the auto-refresh effect early-returns.
  const staleRegenRef = useRef(false);
  useEffect(() => { staleRegenRef.current = false; }, [targetDate]);

  // Strain buildup: the individual activities that produced the viewed day's strain, each with its load
  // contribution (same computeWorkoutLoad the training-load model uses). Sourced from the snapshot cache.
  const [dayActs, setDayActs] = useState<{ name: string; min: number; load: number; hr: number; emoji: string }[]>([]);
  useEffect(() => {
    loadSnapshotCache().then((snap: any) => {
      if (!snap) { setDayActs([]); return; }
      const maxHR = snap.estimatedMaxHR || 190;
      const restHR = snap.todayRecovery?.overnightHR || 50;
      const acts = (snap.activities ?? [])
        .filter((a: any) => a.date && trainingDayKey(a.date) === targetDate) // 4am boundary — matches the strain model's day attribution
        .map((a: any) => ({
          name: a.name || 'Activity', min: Math.round(a.durationMin || 0),
          load: computeWorkoutLoad(a, maxHR, restHR), hr: Math.round(a.avgHR || 0),
          emoji: actEmoji(a.activityType, a.distanceKm || 0),
        }))
        .filter((a: any) => a.load > 0)
        .sort((x: any, y: any) => y.load - x.load);
      setDayActs(acts);
    }).catch(() => setDayActs([]));
  }, [targetDate]);

  // useLLM=false → fast DETERMINISTIC plan (the default: morning prep, auto-refresh, ↻ Regenerate).
  // useLLM=true  → on-request LLM prose (the "Coach's notes" button), the ONLY path that hits the model.
  const requestPlan = async (useLLM = false) => {
    if (useLLM) setProseLoading(true); else setPlanLoading(true);
    setPlanError(null);
    try {
      const cs = {
        date:         targetDate,
        recovery:     target.recoveryScore,
        hrv:          target.restingHrv,
        rhr:          target.restingHr,
        respRate:     target.respiratoryRate,
        spO2:         target.oxygenSaturation,
        sleepScore:   target.sleepScore,
        sleepMin:     target.timeAsleep,
        sleepDebtMin: target.sleepBank,
        ctl:          target.ctl,
        atl:          target.cardioLoad,
        tsb:          target.tsb,
        acwr:         readiness.acwr || undefined,
        strainReal:   real,
        advisableLow:  strainToday?.safeLow,
        advisableHigh: strainToday?.safeHigh,
        readiness:    readiness.readiness,
        drivers:      readiness.drivers,
        recentStrain: strainHistUpTo.slice(-10),
        recentTimeOnFeet:  tof?.series14,
        tof7d:             tof?.tof7d,
        tofPrev7d:         tof?.tofPrev7d,
        tofBudgetTodayMin: capCtx?.budgetMin,
        tofNextRunLabel:   capCtx?.cap.nextRunLabel,
        tofNextRunInDays:  capCtx?.cap.nextRunInDays,
        yesterdayTofMin:   tof?.yesterdayMin,
        loadCapBasis:      capCtx?.capBasis,
        loadCapPct:        capCtx?.capPct,
        loadBudgetToday:   capCtx?.cap.budgetTodayMin,
        rampBudget:        capCtx?.ramp,   // fitness ramp → the load budget (cap-rest text + LLM ramp note)
        loadUnit:          capCtx?.loadUnit,
        ctlRampTarget:     targetIsToday ? (await getCtlRampTarget().catch(() => null)) ?? undefined : undefined,   // honour ramp-grown week slots
        yesterdayStrain:   strainHistUpTo.length >= 2 ? strainHistUpTo[strainHistUpTo.length - 2] : undefined,
        powerZones,
        // Live weather only makes sense for today; past days had different conditions.
        weather: (targetIsToday && weather) ? {
          tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
          windKmh: weather.windKmh, description: weather.description, place: weather.place,
        } : undefined,
      };
      const p = useLLM ? await getCoachPlan(cs) : await deterministicCoachPlan(cs);
      // Guarantee the SAVED prescription carries the EXACT workout we push — the run analysis + segment
      // labels read this structure back, so the logged phases must equal what the watch runs. Synthesize
      // one if the plan lacks it on a run day, and save THAT (not the workout-less plan).
      const wk = p.intensity === 'rest' ? null
        : (p.workout ?? synthesizeWorkout(p.intensity, p.runMinutes, weekdaySlot(new Date(targetDate + 'T00:00:00')), powerZones));
      const saved: CoachPlan = { ...p, workout: wk };
      setPlan(saved);
      await saveCachedPlan(targetDate, saved);
      if (targetIsToday && wk) {
        pushWorkoutToWatch(wk).then(ok => ok && setWatchMsg('✓ Auto-sent to watch')).catch(() => {});
      }
    } catch (e: any) {
      setPlanError(e?.message ?? 'Could not reach the coach.');
    } finally {
      if (useLLM) setProseLoading(false); else setPlanLoading(false);
    }
  };

  // Auto-refresh today's plan if it went stale: materially different heat/strain, OR the volume cap
  // flipped since it was written (a walk/run pushed you over → no run today, or a rest day freed it).
  // Must pass tofNextRunInDays so planNeedsRefresh can see the cap, else a stale "run" plan lingers
  // (and was even auto-sent to the watch) while the accounting already says "next run tomorrow".
  useEffect(() => {
    // Wait for capCtx: regenerating before the cap is known would produce an UNCAPPED run (a ghost), and
    // staleRegenRef would then block the correct capped regen once capCtx loads — the "ghost run until I
    // press Generate" bug. Only auto-refresh once the cap context is in.
    if (!plan || !weather || !targetIsToday || planLoading || proseLoading || !capCtx || staleRegenRef.current) return;
    const snapLike = {
      weather: { apparentC: weather.apparentC, tempC: weather.tempC },
      strainReal: real,
      tofNextRunInDays: capCtx?.cap.nextRunInDays,
      recentTimeOnFeet: tof?.series14,   // so planNeedsRefresh can see today's run → drop a stale force-placed run
      readiness: readiness.readiness,    // so the force-place staleness check below can gate on green/red
      date: targetDate,
    } as any;
    (async () => {
      // planNeedsRefresh SKIPS the cap check for a shrinkForced plan (a session intentionally held over the
      // cap by shrink-to-fit OR race mode). But if that force-place is no longer active — race switched off,
      // shrink off, low readiness, not a quality day — a leftover shrinkForced RUN stays cached and contradicts
      // the cap ("run 25m" + "🏃 Next run Sat"). Regenerate it to the rest the cap wants. shrinkWantsQualityToday
      // is the SAME authority the home uses, so both screens agree. staleRegenRef caps this at one regen.
      const cappedNow = (capCtx?.cap.nextRunInDays ?? 0) > 0;
      const forceStale = cappedNow && plan.intensity !== 'rest' && plan.shrinkForced === true
        && !(await shrinkWantsQualityToday(snapLike));
      if (forceStale || planNeedsRefresh(plan, snapLike)) {
        staleRegenRef.current = true;
        requestPlan(false);   // deterministic — auto-refresh never hits the LLM
      }
    })();
  }, [plan, weather, targetIsToday, planLoading, real, capCtx]);

  // A PAST day with no stored row (outside the loaded window, or genuinely no data): say so explicitly rather
  // than render zeros/another day's numbers. Today keeps the main layout (its hero handles "no strain yet").
  if (!targetIsToday && Object.keys(target).length === 0) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 14, bottom: 14, left: 16, right: 16 }} style={{ paddingHorizontal: 4 }}>
            <Text style={s.backText}>‹ Back</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={s.title}>Strain Detail</Text>
            <Text style={s.headerDate}>{dayLabel}</Text>
          </View>
          <View style={{ width: 60 }} />
        </View>
        <KpiTabs current="strain" params={{ rec, str, date }} />
        <DayNav date={date} />
        <View style={s.center} {...swipe}>
          <Text style={s.emptyText}>{loadingH ? 'Loading…' : 'No strain data for this day.'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 14, bottom: 14, left: 16, right: 16 }} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>Strain Detail</Text>
          <Text style={s.headerDate}>{dayLabel}</Text>
        </View>
        <TouchableOpacity onPress={() => navTo('strain')} style={{ paddingHorizontal: 4 }}>
          <Text style={s.historyLink}>History ›</Text>
        </TouchableOpacity>
      </View>
      <KpiTabs current="strain" params={{ rec, str, date }} />
      <DayNav date={date} />

      <View style={{ flex: 1 }} {...swipe}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={status.color} />}
      >

        {/* Score hero */}
        <View style={[s.hero, { borderColor: status.color }]}>
          <View style={[s.scoreCircle, { borderColor: status.color + '55' }]}>
            <Text style={[s.scoreNumber, { color: status.color }]}>{real}</Text>
            <Text style={s.scoreUnit}>%</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.scoreLabel, { color: status.color }]}>{status.label.toUpperCase()}</Text>
            <Text style={s.scoreAdvice}>
              {strainToday
                ? `Today's strain ${real}% — Target ${strainToday.safeLow}–${strainToday.safeHigh}% given your recovery & form.`
                : targetIsToday ? 'No strain data yet today.' : 'Stored strain for this day.'}
            </Text>
          </View>
        </View>

        {/* Readiness — multi-factor (recovery + sleep + form + ACWR + illness guards). Today's snapshot only
            (a day-swipe drops the DayStrain that carries the live readiness band). */}
        {!loadingH && strainToday && (
          <View style={s.readyCard}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={s.readyNum}>{recoveryStale ? '≈' : ''}{readiness.readiness}</Text>
              <Text style={s.readyUnit}>/100 readiness{recoveryStale ? ' · est.' : ''}</Text>
              {readiness.acwr > 0 && <Text style={s.readyAcwr}>ACWR {readiness.acwr.toFixed(2)}</Text>}
            </View>
            <Text style={s.readyDrivers}>
              {recoveryStale ? '⚠️ Estimate — watch not worn overnight' : (readiness.drivers.length ? readiness.drivers.join(' · ') : 'all signals in normal range')}
            </Text>
            <Text style={s.readyRange}>Target {strainToday?.safeLow ?? readiness.safeLow}–{strainToday?.safeHigh ?? readiness.safeHigh}% strain</Text>
            {tof && (() => {
              // Show the SAME reference as the 7-Day card: what holds fitness (maintenance = CTL×7, in ToF-min
              // via the easy rate) alongside the ceiling — so the ceiling reads as HEADROOM, not a target. The
              // ceiling sits above maintenance because it's anchored to your recent PEAK week (anti-erosion +
              // heat-credit), not this lighter week.
              const maintMin = target.ctl ? Math.round((target.ctl * 7) / (estimateDayTrimp('easy', 100) / 100)) : 0;
              return (
                <Text style={s.readyTof}>
                  {capCtx?.ramp
                    ? `7-day load ${capCtx.ramp.load7} · ramp target ${capCtx.ramp.target7} (+${capCtx.ramp.ramp} CTL/wk) · today ≤ ${capCtx.ramp.budgetLoad} (~${capCtx.cap.budgetTodayMin} min easy) · time on feet ${tof.tof7d}m`
                    : `7-day time on feet ${tof.tof7d}m${maintMin ? ` · maintenance ~${maintMin}m` : ''} · ceiling ${tof.cap7dMin}m · today ≤ ${tof.budgetTodayMin}m`}
                </Text>
              );
            })()}
            {weather && targetIsToday && (
              <Text style={s.readyTof}>
                🌡 {weatherSummary(weather)}{weather.place ? ` · ${weather.place}` : ''}
              </Text>
            )}
          </View>
        )}

        {/* The coach plan now lives on its own screen (app/daily-coach.tsx) — reachable via the home
            recommendation card + the "Strain ›"/back links. This screen is a pure strain KPI page, so the
            coach block below is disabled (plan stays null → it never renders and never pushes to the watch). */}
        {plan && (
        <View style={s.coachCard}>
          {plan ? (
            <>
              <Text style={s.coachHeadline}>{plan.headline}</Text>
              <View style={s.coachRow}>
                <View style={[s.intensityPill, { backgroundColor: (INTENSITY_COLOR[plan.intensity] ?? '#888') + '22' }]}>
                  <Text style={[s.intensityText, { color: INTENSITY_COLOR[plan.intensity] ?? '#888' }]}>
                    {plan.intensity.toUpperCase()}
                  </Text>
                </View>
                <Text style={s.coachTarget}>
                  {effRunMin > 0 ? `run ${effDose}` : 'no run today'} · within target
                </Text>
              </View>
              <Text style={s.coachSession}>{plan.session}</Text>
              {plan.nextRunLabel && (plan.nextRunInDays ?? 0) > 0 && (
                <Text style={s.coachNextRun}>
                  🏃 Next run <Text style={{ fontWeight: '800' }}>{plan.nextRunLabel}</Text>
                  {plan.nextRunInDays === 1 ? ' (tomorrow)' : ` (in ${plan.nextRunInDays} days)`}
                </Text>
              )}
              {plan.strength ? (
                <View style={s.strengthRow}>
                  <Text style={s.strengthLabel}>🦵 LEG STRENGTH</Text>
                  <Text style={s.strengthText}>{plan.strength}</Text>
                </View>
              ) : null}
              <Text style={s.coachRationale}>{plan.rationale}</Text>
              {plan.cautions ? <Text style={s.coachCaution}>⚠️ {plan.cautions}</Text> : null}

              {watchWorkout && (
                <View style={s.workoutBox}>
                  <Text style={s.workoutTitle}>⌚ WATCH WORKOUT · {watchWorkout.name}</Text>
                  <Text style={s.workoutStep}>1. Warm-up {watchWorkout.warmupMeters > 0 ? `${watchWorkout.warmupMeters} m` : 'open'}</Text>
                  {watchWorkout.drillsMinutes > 0 && <Text style={s.workoutStep}>2. Drills {watchWorkout.drillsMinutes} min</Text>}
                  {watchWorkout.blocks.map((b, idx) => (
                    <Text key={idx} style={s.workoutStep}>
                      {watchWorkout.drillsMinutes > 0 ? idx + 3 : idx + 2}. {b.repeats}× ({b.workMinutes}m work
                      {b.hrZone ? ` @ ${b.hrZone}` : ''}
                      {b.powerLowWatts && b.powerHighWatts ? ` ${b.powerLowWatts}–${b.powerHighWatts} W` : ''}
                      {b.restMinutes > 0 ? ` + ${b.restMinutes}m easy` : ''}){b.label ? ` · ${b.label}` : ''}
                    </Text>
                  ))}
                  <Text style={s.workoutStep}>Cool-down {watchWorkout.cooldownMeters > 0 ? `${watchWorkout.cooldownMeters} m` : 'open'}</Text>

                  {/* Projected strain this session adds + today's resulting total vs the target band */}
                  {strainToday && (
                    <Text style={[s.projStrain, {
                      color: projectedStrain > strainToday.safeHigh ? '#f39c12'
                           : projectedStrain < strainToday.safeLow ? '#3498db' : '#27ae60',
                    }]}>
                      📊 Adds ~{runStrain}% strain → today ≈ {projectedStrain}%
                      {'  '}(target {strainToday.safeLow}–{strainToday.safeHigh}%
                      {projectedStrain > strainToday.safeHigh ? ' · above' : projectedStrain < strainToday.safeLow ? ' · below' : ' · in band'})
                    </Text>
                  )}

                  {/* Adjust the prescribed run time, then push the edited session to the watch */}
                  <View style={s.adjustRow}>
                    <Text style={s.adjustLabel}>Adjust run</Text>
                    <TouchableOpacity style={s.adjustBtn} onPress={() => setRunAdj(Math.max(5, effRunMin - 5))}>
                      <Text style={s.adjustBtnText}>−5</Text>
                    </TouchableOpacity>
                    <Text style={s.adjustVal}>{effDose}{runAdj != null ? ` · was ${baseRunMin}m` : ''}</Text>
                    <TouchableOpacity style={s.adjustBtn} onPress={() => setRunAdj(effRunMin + 5)}>
                      <Text style={s.adjustBtnText}>+5</Text>
                    </TouchableOpacity>
                    {runAdj != null && (
                      <TouchableOpacity onPress={() => setRunAdj(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={s.adjustReset}>reset</Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  <TouchableOpacity style={s.watchBtn} onPress={sendToWatch} disabled={watchSending}>
                    <Text style={s.watchBtnText}>{watchSending ? 'Sending…' : runAdj != null ? '⌚ Send edited to Watch' : '⌚ Send to Watch'}</Text>
                  </TouchableOpacity>
                  {watchMsg ? <Text style={s.watchMsg}>{watchMsg}</Text> : null}
                </View>
              )}
              {!watchWorkout && plan.intensity === 'rest' && (
                <Text style={s.workoutStep}>⌚ Rest day — no watch workout pushed.</Text>
              )}

              {/* Coach's notes are LLM prose — generated ONLY on request (the morning prep + regenerate are
                  deterministic). Tapping upgrades the headline/session/rationale to the model's narrative.
                  Hidden on rest days: there's no session to narrate (e.g. you've already run today). */}
              {plan.intensity !== 'rest' && (
                <TouchableOpacity
                  style={[s.proseBtn, { borderColor: status.color }, (!llm.ready || proseLoading) && { opacity: 0.5 }]}
                  onPress={() => requestPlan(true)}
                  disabled={proseLoading || planLoading || !llm.ready}
                >
                  {proseLoading
                    ? <ActivityIndicator size="small" color={status.color} />
                    : <Text style={[s.proseBtnText, { color: status.color }]}>{llm.ready ? "✨ Get coach's notes (AI)" : "✨ Coach's notes — add an API key"}</Text>}
                </TouchableOpacity>
              )}

              <TouchableOpacity onPress={() => requestPlan(false)} disabled={planLoading || proseLoading}>
                <Text style={s.coachRefresh}>{planLoading ? 'Recalculating…' : '↻ Regenerate'}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.coachIntro}>
                A coach-grade session that weighs recovery, HRV, sleep, form and your acute:chronic load — not
                recovery alone. Structure is instant; tap “Coach's notes” afterwards for the AI narrative.
              </Text>
              <TouchableOpacity style={[s.coachBtn, { backgroundColor: status.color }]} onPress={() => requestPlan(false)} disabled={planLoading || loadingH}>
                {planLoading
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={s.coachBtnText}>Get today's plan</Text>}
              </TouchableOpacity>
            </>
          )}
          {planError && <Text style={s.coachError}>{planError}</Text>}
        </View>
        )}
        <View style={{ height: 14 }} />

        {loadingH && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
            <ActivityIndicator size="small" color={status.color} />
            <Text style={s.rowSub}>Loading {Math.round(histMonths * 30)}-day history…</Text>
          </View>
        )}

        {/* Strain buildup — the day's activities that produced this strain, most-loading first. Concise. */}
        {dayActs.length > 0 && (
          <>
            <Text style={s.sectionTitle}>STRAIN BUILDUP</Text>
            <View style={s.card}>
              {dayActs.map((a, i) => (
                <View key={i} style={s.buildRow}>
                  <Text style={s.buildName} numberOfLines={1}>{a.emoji} {a.name}</Text>
                  <Text style={s.buildMeta}>{a.min}m{a.hr > 0 ? ` · ${a.hr}bpm` : ''}</Text>
                  <Text style={[s.buildLoad, { color: status.color }]}>{a.load}</Text>
                </View>
              ))}
              {/* The per-activity loads above come from computeWorkoutLoad (energy-based, the CTL/ATL model);
                  the headline strain comes from the HR-zone model. They are DIFFERENT models, so the old
                  "total → strain" arrow claimed a causation that never held (and read as a bug when a no-HR
                  walk showed a load but moved the strain by nothing). Show them side by side, not as a
                  derivation. */}
              <View style={s.buildTotalRow}>
                <Text style={s.buildTotalLabel}>Activity load · today’s strain</Text>
                <Text style={s.buildTotalVal}>{dayActs.reduce((sum, a) => sum + a.load, 0)} · {real}%</Text>
              </View>
            </View>
          </>
        )}

        {/* Sub-KPI metrics — hidden while the history refresh runs (the spinner above stands in), so
            the old period's numbers don't linger and swap live. */}
        {!loadingH && (<>
        <Text style={s.sectionTitle}>STRAIN METRICS</Text>
        <View style={s.card}>
          {/* `current` = the viewed day's value → the badge judges what's shown, not today's last point. */}
          <SubKPICard label="Strain Score"      value={last('strainScore') !== null ? `${last('strainScore')}` : `${real}`} unit="%" history={hist.strainScore ?? []} current={last('strainScore') ?? real} higherIsBetter color="#e67e22" onPress={() => navTo('strain')} />
          <SubKPICard label="Cardio Load"        value={last('cardioLoad') !== null ? `${last('cardioLoad')}` : '—'} unit="ATL" history={hist.cardioLoad ?? []} current={last('cardioLoad')} higherIsBetter color="#F97316" onPress={() => navTo('cardio-load')} />
          <SubKPICard label="Exercise Duration"  value={last('exerciseDuration') !== null ? `${last('exerciseDuration')}` : '—'} unit="min" history={hist.exerciseDuration ?? []} current={last('exerciseDuration')} higherIsBetter color="#2980b9" onPress={() => navTo('exercise-duration')} />
          <SubKPICard label="Daytime HR"         value={last('daytimeHR') !== null ? `${last('daytimeHR')}` : '—'} unit="bpm" history={hist.daytimeHR ?? []} current={last('daytimeHR')} higherIsBetter={false} color="#e74c3c" onPress={() => navTo('daytime-hr')} />
          <SubKPICard label="Total Energy"       value={last('totalEnergy') !== null ? `${last('totalEnergy')}` : '—'} unit="kcal" history={hist.totalEnergy ?? []} current={last('totalEnergy')} higherIsBetter color="#e67e22" onPress={() => navTo('total-energy')} />
          <SubKPICard label="Step Count"         value={last('stepCount') !== null ? `${last('stepCount')}` : '—'} unit="steps" history={hist.stepCount ?? []} current={last('stepCount')} higherIsBetter color="#16a085" onPress={() => navTo('step-count')} />
        </View>
        </>)}

      </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  historyLink: { fontSize: 15, color: c.accent, fontWeight: '600' },
  headerDate: { fontSize: 11, color: c.textFaint, marginTop: 1 },
  metricsDate: { fontSize: 13, fontWeight: '800', color: c.accent, textAlign: 'center', paddingVertical: 8 },
  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText:{ fontSize: 15, color: c.textFaint },
  scroll:   { padding: 12, paddingBottom: 40 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: c.surface, borderRadius: 16, padding: 16, marginBottom: 14,
    borderLeftWidth: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: c.shadowOpacity, shadowRadius: 5, elevation: 3,
  },
  scoreCircle: {
    width: 88, height: 88, borderRadius: 44, borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  scoreNumber: { fontSize: 34, fontWeight: '800', lineHeight: 38 },
  scoreUnit:   { fontSize: 12, color: c.textFaint },
  scoreLabel:  { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  scoreAdvice: { fontSize: 13, color: c.textSub, lineHeight: 19 },

  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 4,
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  rowSub: { fontSize: 11, color: c.textFaint },
  buildRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  buildName: { flex: 1, fontSize: 13.5, color: c.text, fontWeight: '600' },
  buildMeta: { fontSize: 12, color: c.textFaint, marginRight: 12 },
  buildLoad: { fontSize: 14, fontWeight: '800', minWidth: 34, textAlign: 'right' },
  buildTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9 },
  buildTotalLabel: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  buildTotalVal: { fontSize: 13, color: c.text, fontWeight: '800' },

  rangeCard: {
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  rangeHeadRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 },
  rangeBig:     { fontSize: 24, fontWeight: '800', color: c.text },
  rangePctUnit: { fontSize: 14, color: c.textFaint, fontWeight: '700' },
  rangeMidLabel:{ fontSize: 12, color: c.textSub, fontWeight: '600' },
  rangeTrack:   { position: 'relative', height: 16, borderRadius: 8, backgroundColor: c.bg },
  rangeBand:    { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#27ae6033', borderRadius: 8, borderWidth: 1, borderColor: '#27ae60' },
  rangeMidTick: { position: 'absolute', top: -3, bottom: -3, width: 2, marginLeft: -1, backgroundColor: c.textSub },
  rangeNow:     { position: 'absolute', top: -4, bottom: -4, width: 3, borderRadius: 2, marginLeft: -1.5 },
  rangeScaleRow:{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  rangeScaleTxt:{ fontSize: 10, color: c.textFaint },
  rangeSub:     { fontSize: 12, color: c.textSub, marginTop: 8, lineHeight: 18 },

  readyCard: {
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  readyNum:   { fontSize: 26, fontWeight: '800', color: c.text },
  readyUnit:  { fontSize: 12, color: c.textFaint },
  readyAcwr:  { fontSize: 11, color: c.textSub, marginLeft: 'auto', fontWeight: '600' },
  readyDrivers: { fontSize: 12, color: c.textSub, marginTop: 4 },
  readyRange: { fontSize: 12, color: '#16a085', fontWeight: '600', marginTop: 4 },
  readyTof:   { fontSize: 12, color: c.textSub, marginTop: 4 },

  coachCard: {
    backgroundColor: c.surface, borderRadius: 12, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  coachIntro: { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 12 },
  coachBtn:   { borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  coachBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  coachHeadline: { fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 8 },
  coachRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  intensityPill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  intensityText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  coachTarget: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  coachSession: { fontSize: 14, color: c.text, fontWeight: '600', marginBottom: 6, lineHeight: 20 },
  coachNextRun: { fontSize: 13, color: '#22C55E', fontWeight: '600', marginBottom: 8, lineHeight: 19 },
  strengthRow: { backgroundColor: c.bg, borderRadius: 8, padding: 10, marginBottom: 8 },
  strengthLabel: { fontSize: 10, fontWeight: '800', color: '#16a085', letterSpacing: 0.4, marginBottom: 3 },
  strengthText: { fontSize: 13, color: c.text, lineHeight: 19 },
  workoutBox: { backgroundColor: c.bg, borderRadius: 8, padding: 12, marginTop: 4, marginBottom: 8 },
  workoutTitle: { fontSize: 10, fontWeight: '800', color: c.accent, letterSpacing: 0.4, marginBottom: 6 },
  workoutStep: { fontSize: 13, color: c.text, lineHeight: 20 },
  watchBtn: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginTop: 10 },
  watchBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  adjustRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  adjustLabel: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  adjustBtn:   { backgroundColor: c.surface, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border },
  adjustBtnText: { fontSize: 18, fontWeight: '800', color: c.text },
  adjustVal:   { fontSize: 13, fontWeight: '700', color: c.text, minWidth: 44, textAlign: 'center' },
  adjustReset: { fontSize: 12, color: c.accent, fontWeight: '600' },
  projStrain:  { fontSize: 13, fontWeight: '700', marginTop: 8 },
  watchMsg: { fontSize: 12, color: c.textSub, marginTop: 6, textAlign: 'center' },
  coachRationale: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  coachCaution: { fontSize: 12, color: '#e67e22', marginTop: 8, lineHeight: 18 },
  coachRefresh: { fontSize: 12, color: c.accent, fontWeight: '600', marginTop: 12 },
  proseBtn:     { borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1.5, marginTop: 14 },
  proseBtnText: { fontWeight: '700', fontSize: 13 },
  coachError: { fontSize: 12, color: '#e74c3c', marginTop: 10 },
});
