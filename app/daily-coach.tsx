import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator, RefreshControl, Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DayStrain } from '../src/types';
import { useThemedStyles, Palette } from '../src/theme';
import { SubKPICard, buildHistories } from '../src/components/SubKPICard';
import { fetchOurDailyComponents, fetchDailyDurationHistory, loadSnapshotCache } from '../src/services/healthkit';
import { strainStatus, strainFromLoad, estimateWorkoutLoad, heatStrainFactor, prescribedTrimp } from '../src/services/trainingLoad';
import { getCoachPlan, deterministicCoachPlan, loadCachedPlan, saveCachedPlan, buildCapContext, CapContext, getLoadCapPct, getLoadCapBasis, synthesizeWorkout, mergeWorkoutPower, planNeedsRefresh, shrinkWantsQualityToday, getCoachingMode, getLongRunStyle, getLongSplitOptIn, setLongSplitOptIn, LongRunStyle, CoachPlan, cleanBlockLabel, formatWorkoutStructure, loadPendingPrescription, applyPendingPrescription, clearPendingPrescription, PendingPrescription } from '../src/services/coach';
import { useLLMReady } from '../src/hooks/useLLMReady';
import { ensureZonesFile } from '../src/services/zones';
import { weekdaySlot } from '../src/services/watchWorkout';
import { getLocalWeather, weatherSummary, WeatherNow } from '../src/services/weather';
import { toDateKey } from '../src/services/dayView';
import { useDetailSwipe } from '../src/components/useDetailSwipe';
import { pushWorkoutToWatch, watchModuleAvailable } from '../src/services/watchWorkout';
import { getPowerZones } from '../src/services/claude';

const INTENSITY_COLOR: Record<string, string> = {
  rest: '#3498db', easy: '#27ae60', moderate: '#f39c12', hard: '#e74c3c',
};

export default function DailyCoachScreen() {
  const { str, rec, date } = useLocalSearchParams<{ str?: string; rec?: string; date?: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeStyles);
  const strain = str ? JSON.parse(str) as DayStrain : null;
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
  // In COACH mode the plan is authored in the cloud (the home caches it locally) — this screen must only
  // DISPLAY it, never self-regenerate a deterministic plan over the coach's prescription. Default true so
  // self mode (the common case) is unaffected while the mode loads.
  const [selfMode, setSelfMode] = useState(true);
  useEffect(() => { getCoachingMode().then(m => setSelfMode(m !== 'coach')).catch(() => {}); }, []);
  // Long-run style + per-day opt-in (drives the "Split this long run" toggle shown on long days).
  const [longStyle, setLongStyle] = useState<LongRunStyle>('long');
  const [splitOptIn, setSplitOptIn] = useState(false);
  const [part2Sending, setPart2Sending] = useState(false);
  const llm = useLLMReady();
  const [watchSending, setWatchSending] = useState(false);
  const [watchMsg, setWatchMsg] = useState<string | null>(null);
  // Chat-coach PROPOSAL awaiting approval — never auto-applied (propose+review).
  const [pending, setPending] = useState<PendingPrescription | null>(null);
  const [pendBusy, setPendBusy] = useState(false);

  const [powerZones, setPowerZones] = useState<any>(undefined);
  const [runAdj, setRunAdj] = useState<number | null>(null); // user override of prescribed run minutes
  const [repAdj, setRepAdj] = useState<number | null>(null); // user override of interval rep count (interval days)
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

  // Fast by default: load only ~the last week of daily components. Pull down for the
  // full month (longer history sparklines).
  const loadHistory = useCallback((months: number, isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoadingH(true);
    Promise.all([fetchOurDailyComponents(months), fetchDailyDurationHistory()])
      .then(([c, d]) => { setComps(c); setDur(d); })
      .catch(() => {})
      .finally(() => { setLoadingH(false); setRefreshing(false); });
  }, []);
  useEffect(() => {
    loadHistory(0.3);                                  // ~last 9 days — quick
    getLocalWeather().then(setWeather).catch(() => {});
  }, [loadHistory]);
  const onRefresh = useCallback(() => loadHistory(1, true), [loadHistory]); // full month

  const hist = useMemo(
    () => buildHistories(comps, ['strainScore', 'exerciseDuration', 'daytimeHR', 'totalEnergy', 'stepCount', 'cardioLoad']),
    [comps],
  );
  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  // Sub-KPI values for the VIEWED day (target is defined below; this closure runs in render).
  const last = (k: string) => { const v = target[k]; return v != null ? v : null; };

  // Notification-tap entry passes NO str param → strain would be null and readiness defaulted to 0, and any
  // auto/manual regen then re-planned the day as if readiness were 0 — easing/resting a green-day session and
  // SAVING it over the correct morning plan. Fall back to the snapshot cache's DayStrain (the same object the
  // home passes), so this screen always plans with the real readiness.
  const [snapStrain, setSnapStrain] = useState<DayStrain | null>(null);
  useEffect(() => {
    if (str) return; // param already carries today's DayStrain
    loadSnapshotCache().then((sn: any) => setSnapStrain(sn?.strain ?? null)).catch(() => {});
  }, [str]);
  const strainObj = strain ?? snapStrain;

  // The coach plan is built for the VIEWED day (the `date` param), not just today.
  const dates        = Object.keys(comps).sort();
  const realTodayKey = toDateKey(new Date());
  // Viewing TODAY must resolve to today's plan even before today's components are computed — otherwise it
  // silently falls back to the last day WITH data (yesterday), showing a stale "yesterday" plan while the
  // strain hero + title (from the snapshot/params) show today. Only a specific PAST day with data targets it.
  const targetDate = (date && comps[date]) ? date
                   : (!date || date === realTodayKey) ? realTodayKey
                   : (dates.length ? dates[dates.length - 1] : realTodayKey);
  const target     = comps[targetDate] ?? {};
  const targetIsToday = targetDate === realTodayKey;

  const real   = strainObj?.real ?? Math.round((target.strainScore as number) ?? 0);
  const status = strainObj ? strainStatus(strainObj) : { label: '—', color: '#888' };
  // "est." readiness: viewing today but there's no overnight recovery for last night (watch not worn)
  // → the recovery/readiness shown is the last-known estimate, not today's. (History days have data.)
  const wantToday = !date || date === realTodayKey;
  const todayRec = comps[realTodayKey];
  const recoveryStale = wantToday && dates.length > 0 && (!todayRec || (!todayRec.timeAsleep && todayRec.restingHrv == null));

  // The workout to show/push: the coach's, or a synthesized one on any run-day plan
  // (covers stale cached plans + LLM omissions, so the watch box always appears on run days).
  // runAdj lets the user nudge the prescribed run minutes ± before pushing to the watch.
  const baseRunMin   = plan?.runMinutes ?? 0;
  // Interval sessions are adjusted by REP COUNT, not minutes ("adjust duration" makes no sense for
  // intervals) — the ± edits the work block's rep count and the run duration is DERIVED from it
  // (base ± Δreps × per-rep minutes). Every other session keeps the minute-based ± (runAdj).
  const wkBlocks     = plan?.workout?.blocks ?? [];
  const isIntervalRun = plan?.sessionKind === 'intervals' && plan.intensity !== 'rest' && wkBlocks.length > 0;
  const ivIdx        = isIntervalRun
    ? Math.max(0, wkBlocks.findIndex(b => (b.repeats ?? 0) >= 2 || /interval/i.test(b.label ?? '')))
    : -1;
  const ivBlock      = ivIdx >= 0 ? wkBlocks[ivIdx] : null;
  const baseReps     = ivBlock?.repeats ?? 0;
  const effReps      = isIntervalRun ? Math.max(1, Math.min(20, repAdj ?? baseReps)) : baseReps;
  const perRepMin    = ivBlock ? (ivBlock.workMinutes + ivBlock.restMinutes) : 5;

  const effRunMin    = Math.max(0,
    isIntervalRun ? baseRunMin + (effReps - baseReps) * perRepMin
                  : (runAdj ?? baseRunMin));
  // Distance-basis display: derive km from the plan's km↔min ratio (the ± adjust stays minute-based).
  const kmPerMin     = plan?.runKm != null && plan.runMinutes ? plan.runKm / plan.runMinutes : null;
  const effKm        = kmPerMin != null ? Math.round(effRunMin * kmPerMin * 10) / 10 : null;
  const effDose      = effKm != null ? `${effKm} km` : `${effRunMin}m`;
  const edited       = runAdj != null || repAdj != null;
  const watchWorkout = plan && plan.intensity !== 'rest'
    ? (isIntervalRun
        // reps edit: keep the coach's per-zone watts, only change the rep count on the work block
        ? (repAdj != null
            ? { ...plan.workout!, blocks: wkBlocks.map((b, i) => i === ivIdx ? { ...b, repeats: effReps } : b) }
            : plan.workout!)
        : ((runAdj != null || !plan.workout)
            ? mergeWorkoutPower(
                synthesizeWorkout(plan.intensity, effRunMin, weekdaySlot(new Date(targetDate + 'T00:00:00')), powerZones),
                plan.workout)   // re-synth on ± adjust: inherit the original plan's per-zone watts (duration-only change)
            : plan.workout))
    : null;

  // Projected strain the prescribed (or adjusted) run will add → today's resulting total vs the band.
  const planHeatFactor = heatStrainFactor(targetIsToday && weather
    ? { tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity } : null);
  const runLoad         = watchWorkout ? estimateWorkoutLoad(watchWorkout) : 0;
  const projectedStrain = watchWorkout ? strainFromLoad((strainObj?.trimp ?? 0) + runLoad * planHeatFactor) : real;
  const runStrain       = Math.max(0, projectedStrain - real);
  // Derived IMPACT readout: the session's prescribed Banister TRIMP (recomputed from the EDITED workout so it
  // tracks the reps ± control live). This is the load currency — the tunable number that equalises varied
  // interval shapes; minutes/strain above are the volume + daily-band views.
  const sessionLoad     = watchWorkout ? prescribedTrimp(watchWorkout) : 0;

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
    readiness: strainObj?.readiness ?? 0,
    acwr:      strainObj?.acwr ?? 0,
    drivers:   strainObj?.drivers ?? [],
    safeLow:   strainObj?.safeLow ?? 0,
    safeHigh:  strainObj?.safeHigh ?? 0,
  };

  // Load any plan already cached for the viewed day (one per calendar day).
  const staleRegenRef = useRef(false);
  const [cacheChecked, setCacheChecked] = useState(false);
  useEffect(() => {
    staleRegenRef.current = false;
    setPlan(null);
    setRunAdj(null);
    setRepAdj(null);
    setCacheChecked(false);
    loadCachedPlan(targetDate).then(p => { if (p) setPlan(p); setCacheChecked(true); });
    // A chat-coach PROPOSAL waiting for approval (propose_prescription). Never auto-applied.
    loadPendingPrescription(targetDate).then(setPending).catch(() => setPending(null));
  }, [targetDate]);

  // Long-run style + this day's split opt-in (for the toggle shown on long-run days).
  useEffect(() => {
    getLongRunStyle().then(setLongStyle).catch(() => {});
    getLongSplitOptIn(targetDate).then(setSplitOptIn).catch(() => {});
  }, [targetDate]);
  const isLongDay = plan?.sessionKind === 'long';

  // useLLM=false → fast DETERMINISTIC plan (the default: morning prep, auto-refresh, ↻ Regenerate).
  // useLLM=true  → on-request LLM prose (the "Coach's notes" button), the ONLY path that hits the model.
  const requestPlan = async (useLLM = false) => {
    // Regenerating TODAY before the rolling volume-cap context loads would produce an UNCAPPED "ghost run"
    // that gets saved + auto-pushed to the watch. Make the button wait for it instead.
    if (!useLLM && targetIsToday && !capCtx) { setPlanError('Volume budget still loading — try again in a second.'); return; }
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
        advisableLow:  strainObj?.safeLow,
        advisableHigh: strainObj?.safeHigh,
        readiness:    strainObj ? readiness.readiness : undefined,
        drivers:      strainObj ? readiness.drivers : undefined,
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
        loadUnit:          capCtx?.loadUnit,
        // Yesterday's strain by DATE (not strainHistUpTo[length-2], which reads the day-before-yesterday
        // whenever today's components aren't in `comps` yet — the "yesterday's intervals" ghost).
        yesterdayStrain:   comps[toDateKey(new Date(new Date(targetDate + 'T00:00:00').getTime() - 86_400_000))]?.strainScore,
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
      // Auto-send today's session to the watch — but NOT an OPTIONAL post-completion 2nd run (it's opt-in;
      // the athlete taps "Send to Watch" below if they want it).
      if (targetIsToday && wk && !saved.optional2nd) {
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
    if (!weather || !targetIsToday || planLoading || proseLoading || !capCtx || !strainObj || staleRegenRef.current) return;
    if (!selfMode) return;   // coach mode: the coach owns the plan — display only, never self-regenerate
    if (!plan) {
      // No plan cached for today (e.g. the morning flow didn't run) — generate one once the cache lookup
      // has resolved (so we don't race it and double-generate before a cached plan loads).
      if (cacheChecked) { staleRegenRef.current = true; requestPlan(false); }
      return;
    }
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
  }, [plan, weather, targetIsToday, planLoading, proseLoading, real, strainObj, capCtx, cacheChecked, selfMode]);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>Daily Coach</Text>
          <Text style={s.headerDate}>{dayLabel}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push({ pathname: '/strain-detail' as any, params: { str, rec, date } })}
          style={{ paddingHorizontal: 4 }}
        >
          <Text style={s.historyLink}>Strain ›</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1 }}>
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
              {strain
                ? `Today's strain ${real}% — Target ${strain.safeLow}–${strain.safeHigh}% given your recovery & form.`
                : 'No strain data yet today.'}
            </Text>
          </View>
        </View>

        {/* Readiness — multi-factor (recovery + sleep + form + ACWR + illness guards) */}
        {!loadingH && dates.length > 0 && (
          <View style={s.readyCard}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={s.readyNum}>{recoveryStale ? '≈' : ''}{readiness.readiness}</Text>
              <Text style={s.readyUnit}>/100 readiness{recoveryStale ? ' · est.' : ''}</Text>
              {readiness.acwr > 0 && <Text style={s.readyAcwr}>ACWR {readiness.acwr.toFixed(2)}</Text>}
            </View>
            <Text style={s.readyDrivers}>
              {recoveryStale ? '⚠️ Estimate — watch not worn overnight' : (readiness.drivers.length ? readiness.drivers.join(' · ') : 'all signals in normal range')}
            </Text>
            <Text style={s.readyRange}>Target {strainObj?.safeLow ?? readiness.safeLow}–{strainObj?.safeHigh ?? readiness.safeHigh}% strain</Text>
            {tof && (
              <Text style={s.readyTof}>
                7-day time on feet {tof.tof7d}m · +{capCtx?.capPct ?? 10}% cap {tof.cap7dMin}m · today ≤ {tof.budgetTodayMin}m
              </Text>
            )}
            {weather && targetIsToday && (
              <Text style={s.readyTof}>
                🌡 {weatherSummary(weather)}{weather.place ? ` · ${weather.place}` : ''}
              </Text>
            )}
          </View>
        )}

        {/* Coach's plan — LLM, fed the full picture per current training guidelines */}
        <Text style={s.sectionTitle}>COACH'S PLAN</Text>
        <View style={s.coachCard}>
          {planLoading ? (
            // While (re)generating, show a spinner instead of the stale plan — so the swap isn't a surprise.
            <View style={{ paddingVertical: 28, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={status.color} />
              <Text style={[s.coachRefresh, { marginTop: 10 }]}>Preparing today's plan…</Text>
            </View>
          ) : plan ? (
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

              {/* PROPOSED by the chat coach — awaits an explicit tap. Nothing reaches the watch unreviewed. */}
              {pending && targetIsToday && (
                <View style={s.proposalCard}>
                  <Text style={s.proposalTitle}>💬 Coach proposed a change</Text>
                  <Text style={s.proposalSession}>{pending.session}</Text>
                  {pending.rationale ? <Text style={s.proposalWhy}>{pending.rationale}</Text> : null}
                  <Text style={s.proposalMeta}>
                    {pending.intensity}{pending.runMinutes > 0 ? ` · ${pending.runMinutes} min` : ''}
                    {pending.workout ? ` · ${formatWorkoutStructure(pending.workout)}` : ''}
                  </Text>
                  <View style={s.proposalBtns}>
                    <TouchableOpacity
                      style={[s.proposalApply, pendBusy && { opacity: 0.6 }]}
                      disabled={pendBusy}
                      onPress={async () => {
                        setPendBusy(true);
                        try {
                          if (!plan) return;                       // need a base plan to merge onto
                          const applied = await applyPendingPrescription(targetDate, plan);
                          if (applied) { setPlan(applied); setPending(null); setWatchMsg('Applied — tap Send to Watch to push it.'); }
                        } catch (e: any) { setPlanError(e?.message ?? 'Could not apply.'); }
                        finally { setPendBusy(false); }
                      }}
                    >
                      {pendBusy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.proposalApplyText}>✓ Apply</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.proposalDiscard}
                      disabled={pendBusy}
                      onPress={async () => { await clearPendingPrescription(targetDate); setPending(null); }}
                    >
                      <Text style={s.proposalDiscardText}>Discard</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Opt-in split toggle — only on a long-run day when the Long-run style is "Opt-in". */}
              {isLongDay && longStyle === 'optin' && targetIsToday && (
                <View style={s.splitRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.splitLabel}>Split this long run</Text>
                    <Text style={s.splitSub}>Deliver it as two shorter Z2 runs today (Part 1 now + Part 2 later).</Text>
                  </View>
                  <Switch
                    value={splitOptIn}
                    onValueChange={async v => { setSplitOptIn(v); await setLongSplitOptIn(targetDate, v); requestPlan(false); }}
                  />
                </View>
              )}

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
                      {b.restMinutes > 0 ? ` + ${b.restMinutes}m ${b.recoveryLowWatts ? 'float' : 'jog'}` : ''}
                      {b.restMinutes > 0 && b.recoveryLowWatts && b.recoveryHighWatts
                        ? ` ${b.recoveryLowWatts}–${b.recoveryHighWatts} W` : ''}){cleanBlockLabel(b.label, b.hrZone) ? ` · ${cleanBlockLabel(b.label, b.hrZone)}` : ''}
                    </Text>
                  ))}
                  <Text style={s.workoutStep}>Cool-down {watchWorkout.cooldownMeters > 0 ? `${watchWorkout.cooldownMeters} m` : 'open'}</Text>

                  {/* Projected strain this session adds + today's resulting total vs the target band */}
                  {strain && (
                    <Text style={[s.projStrain, {
                      color: projectedStrain > strain.safeHigh ? '#f39c12'
                           : projectedStrain < strain.safeLow ? '#3498db' : '#27ae60',
                    }]}>
                      📊 Adds ~{runStrain}% strain → today ≈ {projectedStrain}%
                      {'  '}(target {strain.safeLow}–{strain.safeHigh}%
                      {projectedStrain > strain.safeHigh ? ' · above' : projectedStrain < strain.safeLow ? ' · below' : ' · in band'})
                    </Text>
                  )}

                  {/* Derived IMPACT readout — the prescribed Banister TRIMP; tracks the reps ± live. This is the
                      currency that equalises the week's varied interval shapes (a short Z5/float set and a longer
                      Z4/jog set at the same number are the same session, just different minutes). */}
                  {sessionLoad > 0 && (
                    <Text style={s.sessionLoad}>
                      ⚡ Session load ~{sessionLoad}
                      <Text style={s.sessionLoadHint}>  · TRIMP impact (shape-independent)</Text>
                    </Text>
                  )}

                  {/* Interval days adjust REP COUNT (a duration ± makes no sense for intervals); every other
                      day adjusts run minutes. Then push the edited session to the watch. */}
                  {isIntervalRun ? (
                    <View style={s.adjustRow}>
                      <Text style={s.adjustLabel}>Adjust reps</Text>
                      <TouchableOpacity style={s.adjustBtn} onPress={() => setRepAdj(Math.max(1, effReps - 1))}>
                        <Text style={s.adjustBtnText}>−1</Text>
                      </TouchableOpacity>
                      <Text style={s.adjustVal} numberOfLines={1}>
                        {effReps}×{ivBlock?.workMinutes}min{repAdj != null ? ` · was ${baseReps}` : ''}
                      </Text>
                      <TouchableOpacity style={s.adjustBtn} onPress={() => setRepAdj(Math.min(20, effReps + 1))}>
                        <Text style={s.adjustBtnText}>+1</Text>
                      </TouchableOpacity>
                      {repAdj != null && (
                        <TouchableOpacity onPress={() => setRepAdj(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Text style={s.adjustReset}>reset</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ) : (
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
                  )}

                  <TouchableOpacity style={s.watchBtn} onPress={sendToWatch} disabled={watchSending}>
                    <Text style={s.watchBtnText}>{watchSending ? 'Sending…' : edited ? '⌚ Send edited to Watch' : '⌚ Send to Watch'}</Text>
                  </TouchableOpacity>
                  {watchMsg ? <Text style={s.watchMsg}>{watchMsg}</Text> : null}
                </View>
              )}
              {/* SPLIT LONG RUN — Part 2 (the later easy run). Shown below Part 1; the watch takes one workout
                  at a time, so Part 1 auto-sends and Part 2 is sent on demand once you're ready for it. */}
              {plan.secondSession && plan.secondSession.workout && (
                <View style={[s.workoutBox, { borderColor: '#3498db55' }]}>
                  <Text style={s.workoutTitle}>🔁 {plan.secondSession.label} · later today</Text>
                  <Text style={s.coachSession}>
                    {plan.secondSession.runMinutes} min easy Z2 · leave ~{plan.secondSession.earliestAfterHrs ?? 4}h after Part 1.
                  </Text>
                  <Text style={s.workoutStep}>1. Warm-up {plan.secondSession.workout.warmupMeters > 0 ? `${plan.secondSession.workout.warmupMeters} m` : 'open'}</Text>
                  {plan.secondSession.workout.drillsMinutes > 0 && <Text style={s.workoutStep}>2. Drills {plan.secondSession.workout.drillsMinutes} min</Text>}
                  {plan.secondSession.workout.blocks.map((b, idx) => (
                    <Text key={idx} style={s.workoutStep}>
                      {plan.secondSession!.workout!.drillsMinutes > 0 ? idx + 3 : idx + 2}. {b.workMinutes}m
                      {b.hrZone ? ` @ ${b.hrZone}` : ''}
                      {b.powerLowWatts && b.powerHighWatts ? ` ${b.powerLowWatts}–${b.powerHighWatts} W` : ''}
                    </Text>
                  ))}
                  <Text style={s.workoutStep}>Cool-down {plan.secondSession.workout.cooldownMeters > 0 ? `${plan.secondSession.workout.cooldownMeters} m` : 'open'}</Text>
                  <TouchableOpacity
                    style={s.watchBtn}
                    disabled={part2Sending}
                    onPress={async () => {
                      setPart2Sending(true); setWatchMsg(null);
                      try {
                        if (!watchModuleAvailable()) { setWatchMsg('Watch module not in this build.'); return; }
                        const ok = await pushWorkoutToWatch(plan.secondSession!.workout!);
                        setWatchMsg(ok ? '✓ Part 2 sent — replaces Part 1 on the watch.' : 'Could not send Part 2.');
                      } catch (e: any) { setWatchMsg(e?.message ?? 'Send failed.'); }
                      finally { setPart2Sending(false); }
                    }}
                  >
                    <Text style={s.watchBtnText}>{part2Sending ? 'Sending…' : '⌚ Send Part 2 to Watch'}</Text>
                  </TouchableOpacity>
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
        <View style={{ height: 14 }} />

        {loadingH && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
            <ActivityIndicator size="small" color={status.color} />
            <Text style={s.rowSub}>Loading 30-day history…</Text>
          </View>
        )}

        {/* Strain KPI detail (day's runs + metrics) lives on its own screen now — reachable via the
            "Strain ›" link in the header. This screen is purely the daily coach plan. */}

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
  adjustRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  adjustLabel: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  adjustBtn:   { backgroundColor: c.surface, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border },
  adjustBtnText: { fontSize: 14, fontWeight: '800', color: c.text },
  adjustVal:   { fontSize: 13, fontWeight: '700', color: c.text, minWidth: 44, textAlign: 'center', flexShrink: 1 },
  adjustReset: { fontSize: 12, color: c.accent, fontWeight: '600' },
  proposalCard:    { backgroundColor: c.bg, borderRadius: 12, borderWidth: 1, borderColor: c.accent, padding: 12, marginTop: 10, marginBottom: 4 },
  proposalTitle:   { fontSize: 13, fontWeight: '800', color: c.accent, marginBottom: 4 },
  proposalSession: { fontSize: 14, fontWeight: '600', color: c.text, lineHeight: 20 },
  proposalWhy:     { fontSize: 12, color: c.textSub, marginTop: 4, lineHeight: 17 },
  proposalMeta:    { fontSize: 12, color: c.textSub, marginTop: 6 },
  proposalBtns:    { flexDirection: 'row', gap: 10, marginTop: 10, alignItems: 'center' },
  proposalApply:   { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 18 },
  proposalApplyText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  proposalDiscard: { paddingVertical: 8, paddingHorizontal: 12 },
  proposalDiscardText: { color: c.textSub, fontWeight: '600', fontSize: 13 },
  sessionLoad:     { fontSize: 13, fontWeight: '700', color: c.text, marginTop: 4 },
  sessionLoadHint: { fontSize: 11, fontWeight: '500', color: c.textSub },
  projStrain:  { fontSize: 13, fontWeight: '700', marginTop: 8 },
  watchMsg: { fontSize: 12, color: c.textSub, marginTop: 6, textAlign: 'center' },
  coachRationale: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  coachCaution: { fontSize: 12, color: '#e67e22', marginTop: 8, lineHeight: 18 },
  splitRow:    { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, paddingVertical: 6 },
  splitLabel:  { fontSize: 14, color: c.text, fontWeight: '700' },
  splitSub:    { fontSize: 12, color: c.textSub, marginTop: 2, lineHeight: 16 },
  coachRefresh: { fontSize: 12, color: c.accent, fontWeight: '600', marginTop: 12 },
  proseBtn:     { borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1.5, marginTop: 14 },
  proseBtnText: { fontWeight: '700', fontSize: 13 },
  coachError: { fontSize: 12, color: '#e74c3c', marginTop: 10 },
});
