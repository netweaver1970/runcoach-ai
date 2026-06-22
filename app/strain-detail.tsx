import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DayStrain } from '../src/types';
import { useThemedStyles, Palette } from '../src/theme';
import { SubKPICard, buildHistories } from '../src/components/SubKPICard';
import { fetchOurDailyComponents, fetchDailyDurationHistory } from '../src/services/healthkit';
import { strainStatus } from '../src/services/trainingLoad';
import { getCoachPlan, loadCachedPlan, saveCachedPlan, computeTimeOnFeetPlan, synthesizeWorkout, CoachPlan } from '../src/services/coach';
import { weekdaySlot } from '../src/services/watchWorkout';
import { getLocalWeather, weatherSummary, WeatherNow } from '../src/services/weather';
import { toDateKey } from '../src/services/dayView';
import { useDetailSwipe } from '../src/components/useDetailSwipe';
import { pushWorkoutToWatch, watchModuleAvailable } from '../src/services/watchWorkout';
import { getPowerZones } from '../src/services/claude';

const INTENSITY_COLOR: Record<string, string> = {
  rest: '#3498db', easy: '#27ae60', moderate: '#f39c12', hard: '#e74c3c',
};

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
  const [plan, setPlan] = useState<CoachPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [watchSending, setWatchSending] = useState(false);
  const [watchMsg, setWatchMsg] = useState<string | null>(null);

  const [powerZones, setPowerZones] = useState<any>(undefined);
  useEffect(() => { getPowerZones().then(setPowerZones).catch(() => {}); }, []);

  const sendToWatch = async () => {
    if (!watchWorkout) return;
    setWatchSending(true); setWatchMsg(null);
    try {
      if (!watchModuleAvailable()) { setWatchMsg('Watch module not in this build.'); return; }
      const ok = await pushWorkoutToWatch(watchWorkout);
      setWatchMsg(ok ? '✓ Sent — open the Workout app on your watch.' : 'Could not send (needs iOS 17+ and permission).');
    } catch (e: any) {
      setWatchMsg(e?.message ?? 'Send failed.');
    } finally { setWatchSending(false); }
  };

  useEffect(() => {
    Promise.all([fetchOurDailyComponents(1), fetchDailyDurationHistory()])
      .then(([c, d]) => { setComps(c); setDur(d); })
      .catch(() => {})
      .finally(() => setLoadingH(false));
    getLocalWeather().then(setWeather).catch(() => {});
  }, []);

  const hist = useMemo(
    () => buildHistories(comps, ['strainScore', 'exerciseDuration', 'daytimeHR', 'totalEnergy', 'stepCount', 'cardioLoad']),
    [comps],
  );
  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  // Sub-KPI values for the VIEWED day (target is defined below; this closure runs in render).
  const last = (k: string) => { const v = target[k]; return v != null ? v : null; };

  const real   = strain?.real ?? 0;
  const status = strain ? strainStatus(strain) : { label: '—', color: '#888' };

  // The coach plan is built for the VIEWED day (the `date` param), not just today.
  const dates      = Object.keys(comps).sort();
  const targetDate = (date && comps[date]) ? date : (dates.length ? dates[dates.length - 1] : toDateKey(new Date()));
  const target     = comps[targetDate] ?? {};
  const targetIsToday = targetDate === toDateKey(new Date());

  // The workout to show/push: the coach's, or a synthesized one on any run-day plan
  // (covers stale cached plans + LLM omissions, so the watch box always appears on run days).
  const watchWorkout = plan && plan.intensity !== 'rest'
    ? (plan.workout ?? synthesizeWorkout(plan.intensity, plan.runMinutes, weekdaySlot(new Date(targetDate + 'T00:00:00')), powerZones))
    : null;

  // Rolling time-on-feet budget as of the viewed day.
  const tof = useMemo(
    () => (dur.length ? computeTimeOnFeetPlan(dur, new Date(targetDate + 'T00:00:00')) : null),
    [dur, targetDate],
  );
  // Strain history up to and including the viewed day (for recent/yesterday context).
  const strainHistUpTo = dates.filter(d => d <= targetDate)
    .map(d => comps[d].strainScore).filter((v): v is number => v !== undefined);

  // Single source of truth for the displayed band + drivers: the readiness carried on
  // the viewed day's DayStrain — the ring, hero, this card and the coach all agree.
  const readiness = {
    readiness: strain?.readiness ?? 0,
    acwr:      strain?.acwr ?? 0,
    drivers:   strain?.drivers ?? [],
    safeLow:   strain?.safeLow ?? 0,
    safeHigh:  strain?.safeHigh ?? 0,
  };

  // Load any plan already cached for the viewed day (one per calendar day).
  useEffect(() => { setPlan(null); loadCachedPlan(targetDate).then(p => { if (p) setPlan(p); }); }, [targetDate]);

  const requestPlan = async () => {
    setPlanLoading(true); setPlanError(null);
    try {
      const p = await getCoachPlan({
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
        advisableLow:  strain?.safeLow,
        advisableHigh: strain?.safeHigh,
        readiness:    readiness.readiness,
        drivers:      readiness.drivers,
        recentStrain: strainHistUpTo.slice(-10),
        recentTimeOnFeet:  tof?.series14,
        tof7d:             tof?.tof7d,
        tofPrev7d:         tof?.tofPrev7d,
        tofBudgetTodayMin: tof?.budgetTodayMin,
        yesterdayTofMin:   tof?.yesterdayMin,
        yesterdayStrain:   strainHistUpTo.length >= 2 ? strainHistUpTo[strainHistUpTo.length - 2] : undefined,
        powerZones,
        // Live weather only makes sense for today; past days had different conditions.
        weather: (targetIsToday && weather) ? {
          tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
          windKmh: weather.windKmh, description: weather.description, place: weather.place,
        } : undefined,
      });
      setPlan(p);
      await saveCachedPlan(targetDate, p);
    } catch (e: any) {
      setPlanError(e?.message ?? 'Could not reach the coach.');
    } finally {
      setPlanLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>Strain Detail</Text>
          {!!dateLbl && <Text style={s.headerDate}>{dateLbl}</Text>}
        </View>
        <TouchableOpacity onPress={() => navTo('strain')} style={{ paddingHorizontal: 4 }}>
          <Text style={s.historyLink}>History ›</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1 }} {...swipe}>
      <ScrollView contentContainerStyle={s.scroll}>

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
              <Text style={s.readyNum}>{readiness.readiness}</Text>
              <Text style={s.readyUnit}>/100 readiness</Text>
              {readiness.acwr > 0 && <Text style={s.readyAcwr}>ACWR {readiness.acwr.toFixed(2)}</Text>}
            </View>
            <Text style={s.readyDrivers}>
              {readiness.drivers.length ? readiness.drivers.join(' · ') : 'all signals in normal range'}
            </Text>
            <Text style={s.readyRange}>Target {strain?.safeLow ?? readiness.safeLow}–{strain?.safeHigh ?? readiness.safeHigh}% strain</Text>
            {tof && (
              <Text style={s.readyTof}>
                7-day time on feet {tof.tof7d}m · +10% cap {tof.cap7dMin}m · today ≤ {tof.budgetTodayMin}m
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
                  {plan.runMinutes > 0 ? `run ${plan.runMinutes}m` : 'no run today'} · within target
                </Text>
              </View>
              <Text style={s.coachSession}>{plan.session}</Text>
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
                  <Text style={s.workoutStep}>1. Warm-up {watchWorkout.warmupMeters} m</Text>
                  {watchWorkout.drillsMinutes > 0 && <Text style={s.workoutStep}>2. Drills {watchWorkout.drillsMinutes} min</Text>}
                  {watchWorkout.blocks.map((b, idx) => (
                    <Text key={idx} style={s.workoutStep}>
                      {watchWorkout.drillsMinutes > 0 ? idx + 3 : idx + 2}. {b.repeats}× ({b.workMinutes}m work
                      {b.hrZone ? ` @ ${b.hrZone}` : ''}
                      {b.powerLowWatts && b.powerHighWatts ? ` ${b.powerLowWatts}–${b.powerHighWatts} W` : ''}
                      {b.restMinutes > 0 ? ` + ${b.restMinutes}m easy` : ''}){b.label ? ` · ${b.label}` : ''}
                    </Text>
                  ))}
                  <Text style={s.workoutStep}>Cool-down {watchWorkout.cooldownMeters} m</Text>
                  <TouchableOpacity style={s.watchBtn} onPress={sendToWatch} disabled={watchSending}>
                    <Text style={s.watchBtnText}>{watchSending ? 'Sending…' : '⌚ Send to Watch'}</Text>
                  </TouchableOpacity>
                  {watchMsg ? <Text style={s.watchMsg}>{watchMsg}</Text> : null}
                </View>
              )}
              {!watchWorkout && plan.intensity === 'rest' && (
                <Text style={s.workoutStep}>⌚ Rest day — no watch workout pushed.</Text>
              )}

              <TouchableOpacity onPress={requestPlan} disabled={planLoading}>
                <Text style={s.coachRefresh}>{planLoading ? 'Thinking…' : '↻ Regenerate'}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={s.coachIntro}>
                Get a coach-grade session recommendation that weighs recovery, HRV, sleep, form and your
                acute:chronic load — not recovery alone.
              </Text>
              <TouchableOpacity style={[s.coachBtn, { backgroundColor: status.color }]} onPress={requestPlan} disabled={planLoading || loadingH}>
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

        {/* Sub-KPI metrics (sleep-detail pattern: sparkline + tap → history) */}
        <Text style={s.metricsDate}>📅 {dayLabel}</Text>
        <Text style={s.sectionTitle}>STRAIN METRICS</Text>
        <View style={s.card}>
          <SubKPICard label="Strain Score"      value={last('strainScore') !== null ? `${last('strainScore')}` : `${real}`} unit="%" history={hist.strainScore ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('strain')} />
          <SubKPICard label="Cardio Load"        value={last('cardioLoad') !== null ? `${last('cardioLoad')}` : '—'} unit="ATL" history={hist.cardioLoad ?? []} higherIsBetter color="#F97316" onPress={() => navTo('cardio-load')} />
          <SubKPICard label="Exercise Duration"  value={last('exerciseDuration') !== null ? `${last('exerciseDuration')}` : '—'} unit="min" history={hist.exerciseDuration ?? []} higherIsBetter color="#2980b9" onPress={() => navTo('exercise-duration')} />
          <SubKPICard label="Daytime HR"         value={last('daytimeHR') !== null ? `${last('daytimeHR')}` : '—'} unit="bpm" history={hist.daytimeHR ?? []} higherIsBetter={false} color="#e74c3c" onPress={() => navTo('daytime-hr')} />
          <SubKPICard label="Total Energy"       value={last('totalEnergy') !== null ? `${last('totalEnergy')}` : '—'} unit="kcal" history={hist.totalEnergy ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('total-energy')} />
          <SubKPICard label="Step Count"         value={last('stepCount') !== null ? `${last('stepCount')}` : '—'} unit="steps" history={hist.stepCount ?? []} higherIsBetter color="#16a085" onPress={() => navTo('step-count')} />
        </View>
        <Text style={s.metricsDate}>📅 {dayLabel}</Text>

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
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  historyLink: { fontSize: 15, color: '#FF6B35', fontWeight: '600' },
  headerDate: { fontSize: 11, color: c.textFaint, marginTop: 1 },
  metricsDate: { fontSize: 13, fontWeight: '800', color: '#FF6B35', textAlign: 'center', paddingVertical: 8 },
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
  strengthRow: { backgroundColor: c.bg, borderRadius: 8, padding: 10, marginBottom: 8 },
  strengthLabel: { fontSize: 10, fontWeight: '800', color: '#16a085', letterSpacing: 0.4, marginBottom: 3 },
  strengthText: { fontSize: 13, color: c.text, lineHeight: 19 },
  workoutBox: { backgroundColor: c.bg, borderRadius: 8, padding: 12, marginTop: 4, marginBottom: 8 },
  workoutTitle: { fontSize: 10, fontWeight: '800', color: '#FF6B35', letterSpacing: 0.4, marginBottom: 6 },
  workoutStep: { fontSize: 13, color: c.text, lineHeight: 20 },
  watchBtn: { backgroundColor: '#FF6B35', borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginTop: 10 },
  watchBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  watchMsg: { fontSize: 12, color: c.textSub, marginTop: 6, textAlign: 'center' },
  coachRationale: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  coachCaution: { fontSize: 12, color: '#e67e22', marginTop: 8, lineHeight: 18 },
  coachRefresh: { fontSize: 12, color: '#FF6B35', fontWeight: '600', marginTop: 12 },
  coachError: { fontSize: 12, color: '#e74c3c', marginTop: 10 },
});
