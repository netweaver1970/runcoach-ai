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
import { strainStatus, advisableStrainRange } from '../src/services/trainingLoad';
import { getCoachPlan, loadCachedPlan, saveCachedPlan, computeTimeOnFeetPlan, CoachPlan, TofPlan } from '../src/services/coach';

const INTENSITY_COLOR: Record<string, string> = {
  rest: '#3498db', easy: '#27ae60', moderate: '#f39c12', hard: '#e74c3c',
};

export default function StrainDetailScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeStyles);
  const strain = data ? JSON.parse(data) as DayStrain : null;

  const [comps, setComps] = useState<Record<string, Record<string, number>>>({});
  const [tof, setTof] = useState<TofPlan | null>(null);
  const [loadingH, setLoadingH] = useState(true);
  const [plan, setPlan] = useState<CoachPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchOurDailyComponents(1), fetchDailyDurationHistory()])
      .then(([c, dur]) => { setComps(c); setTof(computeTimeOnFeetPlan(dur)); })
      .catch(() => {})
      .finally(() => setLoadingH(false));
  }, []);

  const hist = useMemo(
    () => buildHistories(comps, ['strainScore', 'exerciseDuration', 'daytimeHR', 'totalEnergy', 'stepCount', 'cardioLoad']),
    [comps],
  );
  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  const last = (k: string) => { const a = hist[k]; return a && a.length ? a[a.length - 1] : null; };

  const real   = strain?.real ?? 0;
  const status = strain ? strainStatus(strain) : { label: '—', color: '#888' };

  // Latest day's full component record drives readiness + the coach snapshot.
  const dates    = Object.keys(comps).sort();
  const latest   = dates.length ? comps[dates[dates.length - 1]] : {};
  const latestDate = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  const readiness = useMemo(() => advisableStrainRange({
    recovery:     latest.recoveryScore,
    sleepScore:   latest.sleepScore,
    sleepDebtMin: latest.sleepBank,
    tsb:          latest.tsb,
    ctl:          latest.ctl,
    atl:          latest.cardioLoad,
    respRate:     latest.respiratoryRate,
    spO2:         latest.oxygenSaturation,
    yesterdayStrain: dates.length >= 2 ? comps[dates[dates.length - 2]]?.strainScore : undefined,
  }), [comps]);

  // Load any plan already generated today (one per calendar day).
  useEffect(() => { loadCachedPlan(latestDate).then(p => { if (p) setPlan(p); }); }, [latestDate]);

  const requestPlan = async () => {
    setPlanLoading(true); setPlanError(null);
    try {
      const strainHist = hist.strainScore ?? [];
      const p = await getCoachPlan({
        date:         latestDate,
        recovery:     latest.recoveryScore,
        hrv:          latest.restingHrv,
        rhr:          latest.restingHr,
        respRate:     latest.respiratoryRate,
        spO2:         latest.oxygenSaturation,
        sleepScore:   latest.sleepScore,
        sleepMin:     latest.timeAsleep,
        sleepDebtMin: latest.sleepBank,
        ctl:          latest.ctl,
        atl:          latest.cardioLoad,
        tsb:          latest.tsb,
        acwr:         readiness.acwr || undefined,
        strainReal:   real,
        advisableLow:  strain?.safeLow,
        advisableHigh: strain?.safeHigh,
        readiness:    readiness.readiness,
        drivers:      readiness.drivers,
        recentStrain: strainHist.slice(-10),
        recentTimeOnFeet:  tof?.series14,
        tof7d:             tof?.tof7d,
        tofPrev7d:         tof?.tofPrev7d,
        tofBudgetTodayMin: tof?.budgetTodayMin,
        yesterdayTofMin:   tof?.yesterdayMin,
        yesterdayStrain:   strainHist.length >= 2 ? strainHist[strainHist.length - 2] : undefined,
      });
      setPlan(p);
      await saveCachedPlan(latestDate, p);
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
        <Text style={s.title}>Strain Detail</Text>
        <TouchableOpacity onPress={() => navTo('strain')} style={{ paddingHorizontal: 4 }}>
          <Text style={s.historyLink}>History ›</Text>
        </TouchableOpacity>
      </View>

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
                ? `Today's strain ${real}% — advisable range ${strain.safeLow}–${strain.safeHigh}% given your recovery & form.`
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
            <Text style={s.readyRange}>advisable strain {readiness.safeLow}–{readiness.safeHigh}%</Text>
            {tof && (
              <Text style={s.readyTof}>
                7-day time on feet {tof.tof7d}m · +10% cap {tof.cap7dMin}m · today ≤ {tof.budgetTodayMin}m
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
                  target {plan.strainLow}–{plan.strainHigh}%{plan.runMinutes > 0 ? ` · run ${plan.runMinutes}m` : ' · no run'}
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
        <Text style={s.sectionTitle}>STRAIN METRICS</Text>
        <View style={s.card}>
          <SubKPICard label="Strain Score"      value={last('strainScore') !== null ? `${last('strainScore')}` : `${real}`} unit="%" history={hist.strainScore ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('strain')} />
          <SubKPICard label="Cardio Load"        value={last('cardioLoad') !== null ? `${last('cardioLoad')}` : '—'} unit="ATL" history={hist.cardioLoad ?? []} higherIsBetter color="#F97316" onPress={() => navTo('cardio-load')} />
          <SubKPICard label="Exercise Duration"  value={last('exerciseDuration') !== null ? `${last('exerciseDuration')}` : '—'} unit="min" history={hist.exerciseDuration ?? []} higherIsBetter color="#2980b9" onPress={() => navTo('exercise-duration')} />
          <SubKPICard label="Daytime HR"         value={last('daytimeHR') !== null ? `${last('daytimeHR')}` : '—'} unit="bpm" history={hist.daytimeHR ?? []} higherIsBetter={false} color="#e74c3c" onPress={() => navTo('daytime-hr')} />
          <SubKPICard label="Total Energy"       value={last('totalEnergy') !== null ? `${last('totalEnergy')}` : '—'} unit="kcal" history={hist.totalEnergy ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('total-energy')} />
          <SubKPICard label="Step Count"         value={last('stepCount') !== null ? `${last('stepCount')}` : '—'} unit="steps" history={hist.stepCount ?? []} higherIsBetter color="#16a085" onPress={() => navTo('step-count')} />
        </View>

      </ScrollView>
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
  coachRationale: { fontSize: 13, color: c.textSub, lineHeight: 19 },
  coachCaution: { fontSize: 12, color: '#e67e22', marginTop: 8, lineHeight: 18 },
  coachRefresh: { fontSize: 12, color: '#FF6B35', fontWeight: '600', marginTop: 12 },
  coachError: { fontSize: 12, color: '#e74c3c', marginTop: 10 },
});
