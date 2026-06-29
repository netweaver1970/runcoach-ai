/**
 * Bevel Calibration Screen
 *
 * - Shows last 30 nights of HealthKit sleep data (pre-populated)
 * - User enters Bevel's Recovery % for each night
 * - "Analyse" runs local constrained regression to find optimal RECOVERY weights
 *   (HRV, RHR, SpO₂, Sleep Score — respiratory rate excluded per Bevel design)
 * - "Apply weights" writes them to SecureStore for use in computeRecoveryScore
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, SafeAreaView, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  loadEntries, saveEntry,
  normaliseKPIs, applyWeights,
  DEFAULT_SLEEP_WEIGHTS,
  DEFAULT_RECOVERY_WEIGHTS,
  loadCustomRecoveryWeights, saveCustomRecoveryWeights, clearCustomRecoveryWeights,
  loadCustomSleepWeights, clearCustomSleepWeights,
  runRecoveryRegression,
  loadPersonalSleepGoal, savePersonalSleepGoal, computePersonalSleepGoal,
  BevelEntry, RecoveryRegressionResult, RecoveryWeights,
} from '../src/services/bevelCalibration';
import { fetchSleepHistory, fetchSleepBiometrics, SleepBiometrics } from '../src/services/healthkit';
import { useThemedStyles, Palette } from '../src/theme';
import { SleepSession } from '../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtH(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}
function pct(n: number) { return `${Math.round(n)}%`; }

const ACCENT = '#8e44ad';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NightRow {
  session:  SleepSession;
  bio:      SleepBiometrics | null;
  entry:    BevelEntry | null;
}

// ─── Nightly row card ─────────────────────────────────────────────────────────

function NightCard({ row, sleepGoalMin, onSave }: {
  row: NightRow; sleepGoalMin: number; onSave: (e: BevelEntry) => void;
}) {
  const c = useThemedStyles(makeStyles);
  const bio   = row.bio;
  const s     = row.session;
  const inBed = s.totalMinutes + s.awakeMinutes;
  const eff   = inBed > 0 ? (s.totalMinutes / inBed) * 100 : 0;

  const sleepKpis = {
    totalMinutes: s.totalMinutes, deepMinutes: s.deepMinutes,
    remMinutes: s.remMinutes, awakeMinutes: s.awakeMinutes,
    efficiency: eff, hrDipPct: bio?.hrDipPct ?? 0,
  };
  const sleepScores   = normaliseKPIs(sleepKpis, sleepGoalMin);
  const ourSleepScore = applyWeights(sleepScores, DEFAULT_SLEEP_WEIGHTS);

  const [bevelRecovery, setBevelRecovery] = useState(row.entry ? String(row.entry.bevelRecovery || '') : '');
  const [expanded,      setExpanded]      = useState(false);
  const [saved,         setSaved]         = useState(!!row.entry?.bevelRecovery);

  const handleSave = () => {
    const bRec = parseFloat(bevelRecovery);
    if (isNaN(bRec) || bRec <= 0) {
      Alert.alert('Enter Bevel Recovery %', 'Type the Recovery % shown in Bevel for this night.');
      return;
    }
    const entry: BevelEntry = {
      date: s.date, sleep: sleepKpis, sleepGoalMin,
      bevelSleep:    row.entry?.bevelSleep ?? 0,
      bevelRecovery: bRec,
      ourSleep:      ourSleepScore,
    };
    onSave(entry);
    setSaved(true);
  };

  return (
    <View style={c.nightCard}>
      {/* ── collapsed header ── */}
      <TouchableOpacity style={c.nightHeader} onPress={() => setExpanded(e => !e)} activeOpacity={0.75}>
        <View style={{ flex: 1 }}>
          <Text style={c.nightDate}>{s.date}</Text>
          <Text style={c.nightSummary}>
            {fmtH(s.totalMinutes)} · {s.deepMinutes}m deep · {s.remMinutes}m REM
            {bio?.hrv ? `  HRV ${bio.hrv}ms` : ''}
            {bio?.spO2 ? `  SpO₂ ${bio.spO2}%` : ''}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {saved && bevelRecovery ? (
            <Text style={[c.bevelScore, { color: '#27ae60' }]}>
              Rec: {bevelRecovery}%
            </Text>
          ) : (
            <Text style={c.bevelMissing}>tap to enter Recovery %</Text>
          )}
        </View>
        <Text style={c.chevron}>{expanded ? '▾' : '›'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={c.nightExpanded}>

          {/* ── Recovery biometrics — inputs fed into regression ── */}
          <Text style={c.sectionLabel}>Recovery inputs (sleep window)</Text>
          <View style={c.bioRow}>
            {([
              ['HRV',   bio?.hrv              ? `${bio.hrv} ms`                    : '—'],
              ['RHR',   bio?.overnightHR      ? `${bio.overnightHR} bpm`           : '—'],
              ['SpO₂', bio?.spO2             ? `${bio.spO2}%`                     : '—'],
              ['RR',    bio?.respiratoryRate  ? `${bio.respiratoryRate} rpm`       : '—'],
              ['Sleep', `${ourSleepScore}/100`],
            ] as [string, string][]).map(([lbl, val]) => (
              <View key={lbl} style={c.bioCell}>
                <Text style={c.bioCellLabel}>{lbl}</Text>
                <Text style={c.bioCellVal}>{val}</Text>
              </View>
            ))}
          </View>

          {/* ── Sleep detail ── */}
          <Text style={[c.sectionLabel, { marginTop: 10 }]}>Sleep detail</Text>
          <View style={c.bioRow}>
            {([
              ['Total',  fmtH(s.totalMinutes)],
              ['Deep',   `${s.deepMinutes}m`],
              ['REM',    `${s.remMinutes}m`],
              ['Core',   `${s.totalMinutes - s.deepMinutes - s.remMinutes}m`],
              ['Effic',  pct(eff)],
              ['HR dip', bio?.hrDipPct ? `${bio.hrDipPct.toFixed(1)}%` : '—'],
            ] as [string, string][]).map(([lbl, val]) => (
              <View key={lbl} style={c.bioCell}>
                <Text style={c.bioCellLabel}>{lbl}</Text>
                <Text style={[c.bioCellVal, { color: '#888' }]}>{val}</Text>
              </View>
            ))}
          </View>

          {/* ── Bevel Recovery input ── */}
          <View style={c.inputRow}>
            <View style={c.inputGroup}>
              <Text style={c.inputLabel}>Bevel Recovery %</Text>
              <TextInput
                style={c.input}
                value={bevelRecovery}
                onChangeText={v => { setBevelRecovery(v); setSaved(false); }}
                keyboardType="numeric"
                placeholder="0–100"
                placeholderTextColor="#555"
                returnKeyType="done"
                maxLength={5}
              />
            </View>
            <TouchableOpacity
              style={[c.saveBtn, !bevelRecovery && c.saveBtnDisabled]}
              onPress={handleSave}
              disabled={!bevelRecovery}
            >
              <Text style={c.saveBtnText}>{saved ? '✓' : 'Save'}</Text>
            </TouchableOpacity>
          </View>

        </View>
      )}
    </View>
  );
}

// ─── Results panel ────────────────────────────────────────────────────────────

function ResultsPanel({ result, onApply, applied }: {
  result: RecoveryRegressionResult;
  onApply: (w: RecoveryWeights) => void;
  applied: boolean;
}) {
  const c = useThemedStyles(makeStyles);
  const { weights: w, mae, r2, dataPoints, perDayErrors } = result;
  return (
    <View style={c.resultsCard}>
      <Text style={c.resultsTitle}>Recovery Regression Results</Text>
      <Text style={c.resultsSub}>{dataPoints} nights · MAE {mae} pts · R² {r2.toFixed(3)}</Text>
      <Text style={[c.resultsSub, { marginTop: 2 }]}>
        Personal baseline: {Math.round(w.intercept * 100)}% offset
        {dataPoints < 10 ? `  ⚠ weights regularised toward defaults (${dataPoints}/10+ nights)` : ''}
      </Text>

      <View style={c.weightsTable}>
        <View style={c.weightsHeader}>
          <Text style={[c.wCol, { flex: 2, textAlign: 'left' }]}>KPI</Text>
          <Text style={c.wCol}>Default</Text>
          <Text style={c.wCol}>Optimal</Text>
          <Text style={c.wCol}>Δ</Text>
        </View>
        {([
          ['HRV',         DEFAULT_RECOVERY_WEIGHTS.hrv,             w.hrv],
          ['RHR',         DEFAULT_RECOVERY_WEIGHTS.rhr,             w.rhr],
          ['SpO₂',       DEFAULT_RECOVERY_WEIGHTS.spO2,            w.spO2],
          ['Resp Rate',   DEFAULT_RECOVERY_WEIGHTS.respiratoryRate, w.respiratoryRate],
          ['Sleep Score', DEFAULT_RECOVERY_WEIGHTS.sleepScore,      w.sleepScore],
        ] as [string, number, number][]).map(([lbl, def, opt]) => {
          const delta = Math.round((opt - def) * 100);
          return (
            <View key={lbl} style={c.weightsRow}>
              <Text style={[c.wCol, { flex: 2, textAlign: 'left', color: '#ccc' }]}>{lbl}</Text>
              <Text style={c.wCol}>{Math.round(def * 100)}%</Text>
              <Text style={[c.wCol, { color: ACCENT, fontWeight: '700' }]}>{Math.round(opt * 100)}%</Text>
              <Text style={[c.wCol, { color: delta > 0 ? '#27ae60' : delta < 0 ? '#e74c3c' : '#888' }]}>
                {delta >= 0 ? '+' : ''}{delta}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={[c.resultsSub, { marginTop: 12, marginBottom: 4 }]}>Per-night (our → Bevel Recovery)</Text>
      {[...perDayErrors].reverse().slice(0, 10).map(d => (
        <View key={d.date} style={c.errRow}>
          <Text style={c.errDate}>{d.date}</Text>
          <Text style={c.errVal}>{d.ours}% → {d.bevel}%</Text>
          <Text style={[c.errDelta, {
            color: Math.abs(d.error) <= 3 ? '#27ae60' : Math.abs(d.error) <= 8 ? '#f39c12' : '#e74c3c',
          }]}>{d.error >= 0 ? '+' : ''}{d.error}</Text>
        </View>
      ))}

      <TouchableOpacity
        style={[c.applyBtn, applied && { backgroundColor: '#27ae60' }]}
        onPress={() => onApply(result.weights)}
      >
        <Text style={c.applyBtnText}>
          {applied ? '✓ Recovery weights applied' : 'Apply optimal weights to Recovery Score'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function BevelCalibrationScreen() {
  const router = useRouter();
  const c = useThemedStyles(makeStyles);
  const [rows,         setRows]         = useState<NightRow[]>([]);
  const [entries,      setEntries]      = useState<BevelEntry[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [result,       setResult]       = useState<RecoveryRegressionResult | null>(null);
  const [applied,      setApplied]      = useState(false);
  const [hasCustom,    setHasCustom]    = useState(false);
  const [sleepGoalMin, setSleepGoalMin] = useState(375); // 6h15m fallback

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sessions, bioData, saved, customW, savedGoal, legacySleepW] = await Promise.all([
        fetchSleepHistory(3),
        fetchSleepBiometrics(3),
        loadEntries(),
        loadCustomRecoveryWeights(),
        loadPersonalSleepGoal(),
        loadCustomSleepWeights(),   // check for corrupt weights from old regression
      ]);
      // The old regression was miscalibrated (it used sleep sub-KPIs as features
      // for a Bevel Recovery % target, then saved the result as sleep weights).
      // Clear any stored sleep weights automatically — they're invalid.
      if (legacySleepW) await clearCustomSleepWeights();
      setHasCustom(!!customW);
      const goal = savedGoal ?? computePersonalSleepGoal(sessions);
      if (goal > 0) setSleepGoalMin(goal);
      const bioByDate: Record<string, SleepBiometrics> = {};
      bioData.forEach(d => { bioByDate[d.date] = d; });
      const recent = sessions.slice(-30).reverse();
      setRows(recent.map(session => ({
        session,
        bio:   bioByDate[session.date] ?? null,
        entry: saved.find(e => e.date === session.date) ?? null,
      })));
      setEntries(saved);
    } catch (e: any) {
      Alert.alert('Error loading data', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaveEntry = useCallback(async (entry: BevelEntry) => {
    const updated = await saveEntry(entry);
    setEntries(updated);
    setRows(prev => prev.map(r => r.session.date === entry.date ? { ...r, entry } : r));
  }, []);

  const handleAnalyse = () => {
    // Build lookup maps from loaded rows
    const bioByDate: Record<string, { hrv: number; rhr: number; spO2: number; respiratoryRate: number }> = {};
    const sleepScoreByDate: Record<string, number> = {};

    for (const row of rows) {
      if (!row.bio) continue;
      const date = row.session.date;
      bioByDate[date] = {
        hrv:             row.bio.hrv,
        rhr:             row.bio.overnightHR,
        spO2:            row.bio.spO2,
        respiratoryRate: row.bio.respiratoryRate ?? 0,
      };
      // Recompute sleep score for this night
      const inBed = row.session.totalMinutes + row.session.awakeMinutes;
      const eff   = inBed > 0 ? (row.session.totalMinutes / inBed) * 100 : 0;
      const kpis  = {
        totalMinutes: row.session.totalMinutes, deepMinutes: row.session.deepMinutes,
        remMinutes:   row.session.remMinutes,   awakeMinutes: row.session.awakeMinutes,
        efficiency:   eff, hrDipPct: row.bio.hrDipPct ?? 0,
      };
      sleepScoreByDate[date] = applyWeights(normaliseKPIs(kpis, sleepGoalMin), DEFAULT_SLEEP_WEIGHTS);
    }

    const res = runRecoveryRegression(entries, bioByDate, sleepScoreByDate);
    if (!res) {
      Alert.alert('Not enough data', 'Enter Bevel Recovery % for at least 3 nights to run the analysis.');
      return;
    }
    setResult(res);
    setApplied(false);
  };

  const handleApply = async (w: RecoveryWeights) => {
    await saveCustomRecoveryWeights(w);
    setApplied(true);
    setHasCustom(true);
    Alert.alert('Weights saved', `Applied! MAE vs Bevel: ${result?.mae} pts.\nOpen the app to see your updated Recovery Score.`);
  };

  const handleReset = () => {
    Alert.alert('Reset recovery weights?', 'This restores the default coefficients.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => {
        await Promise.all([clearCustomRecoveryWeights(), clearCustomSleepWeights()]);
        setHasCustom(false); setApplied(false);
      }},
    ]);
  };

  const enteredCount = entries.filter(e => e.bevelRecovery > 0).length;

  return (
    <SafeAreaView style={c.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={c.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
            <Text style={c.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={c.title}>Calibration</Text>
          {hasCustom
            ? <TouchableOpacity onPress={handleReset}><Text style={c.resetText}>Reset</Text></TouchableOpacity>
            : <View style={{ width: 50 }} />}
        </View>

        <ScrollView contentContainerStyle={c.scroll} keyboardShouldPersistTaps="handled">

          <View style={c.explainer}>
            <Text style={c.explainerTitle}>How this works</Text>
            <Text style={c.explainerBody}>
              Each night shows sleep-window biometrics used to compute your Recovery Score:
              HRV, overnight HR (RHR), SpO₂, Respiratory Rate, and Sleep Score.{'\n\n'}
              Enter Bevel's Recovery % for each night, then tap "Analyse" to find the optimal
              weights. More nights = better calibration.
            </Text>
            <View style={[c.customBadge, { backgroundColor: '#1f2a1f', marginTop: 8 }]}>
              <Text style={[c.customBadgeText, { color: '#4caf80' }]}>
                🎯 Sleep goal: {Math.floor(sleepGoalMin / 60)}h{sleepGoalMin % 60 > 0 ? ` ${sleepGoalMin % 60}m` : ''} (90-day median)
              </Text>
            </View>
            {hasCustom && (
              <View style={c.customBadge}>
                <Text style={c.customBadgeText}>✓ Custom recovery weights active</Text>
              </View>
            )}
          </View>

          <View style={c.analyseRow}>
            <Text style={c.analyseCount}>{enteredCount} nights entered</Text>
            <TouchableOpacity
              style={[c.analyseBtn, enteredCount < 3 && c.analyseBtnDisabled]}
              onPress={handleAnalyse}
              disabled={enteredCount < 3}
            >
              <Text style={c.analyseBtnText}>Analyse weights ›</Text>
            </TouchableOpacity>
          </View>

          {result && (
            <ResultsPanel result={result} onApply={handleApply} applied={applied} />
          )}

          <Text style={c.sectionHeader}>Recent nights — tap to expand &amp; enter Bevel Recovery %</Text>

          {loading ? (
            <View style={c.center}>
              <ActivityIndicator size="large" color={ACCENT} />
              <Text style={c.loadingText}>Loading sleep history…</Text>
            </View>
          ) : rows.length === 0 ? (
            <Text style={{ color: '#888', textAlign: 'center', marginTop: 20 }}>
              No sleep data found in the last 3 months.
            </Text>
          ) : (
            rows.map(row => (
              <NightCard key={row.session.date} row={row} sleepGoalMin={sleepGoalMin} onSave={handleSaveEntry} />
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (t: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
  },
  backText:  { fontSize: 17, color: t.accent, fontWeight: '600' },
  title:     { fontSize: 17, fontWeight: '700', color: t.text },
  resetText: { fontSize: 13, color: '#e74c3c', fontWeight: '600' },
  scroll:    { padding: 12, paddingBottom: 60 },
  center:    { alignItems: 'center', paddingVertical: 24 },
  loadingText: { color: t.textSub, marginTop: 8, fontSize: 13 },

  explainer: {
    backgroundColor: t.surface, borderRadius: 12, padding: 14, marginBottom: 14,
    borderLeftWidth: 3, borderLeftColor: ACCENT,
  },
  explainerTitle: { fontSize: 14, fontWeight: '700', color: t.text, marginBottom: 6 },
  explainerBody:  { fontSize: 12, color: t.textSub, lineHeight: 18 },
  customBadge: {
    marginTop: 8, backgroundColor: ACCENT + '33', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start',
  },
  customBadgeText: { fontSize: 11, fontWeight: '700', color: ACCENT },

  analyseRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14,
  },
  analyseCount:       { fontSize: 13, color: t.textSub },
  analyseBtn:         { backgroundColor: ACCENT, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  analyseBtnDisabled: { backgroundColor: t.border },
  analyseBtnText:     { color: '#fff', fontWeight: '700', fontSize: 13 },

  sectionHeader: {
    fontSize: 11, fontWeight: '700', color: t.textFaint, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 8, marginTop: 4,
  },

  nightCard:    { backgroundColor: t.surface, borderRadius: 12, marginBottom: 8, overflow: 'hidden' },
  nightHeader:  { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 },
  nightDate:    { fontSize: 13, fontWeight: '700', color: t.text },
  nightSummary: { fontSize: 11, color: t.textSub, marginTop: 2 },
  bevelScore:   { fontSize: 12, fontWeight: '600', marginTop: 2 },
  bevelMissing: { fontSize: 11, color: t.textFaint, fontStyle: 'italic', marginTop: 2 },
  chevron:      { fontSize: 16, color: t.textFaint, marginLeft: 4 },

  nightExpanded: { borderTopWidth: 1, borderTopColor: t.border, padding: 12, gap: 8 },
  sectionLabel:  { fontSize: 9, fontWeight: '700', color: t.textFaint, textTransform: 'uppercase', letterSpacing: 0.5 },

  inputRow:   { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  inputGroup: { flex: 1 },
  inputLabel: { fontSize: 10, color: t.textSub, marginBottom: 4, fontWeight: '600', textTransform: 'uppercase' },
  input: {
    backgroundColor: t.surfaceAlt, borderRadius: 8, borderWidth: 1, borderColor: t.border,
    color: t.text, fontSize: 16, fontWeight: '700',
    paddingHorizontal: 10, paddingVertical: 9, textAlign: 'center',
  },
  saveBtn:         { backgroundColor: ACCENT, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  saveBtnDisabled: { backgroundColor: t.border },
  saveBtnText:     { color: '#fff', fontWeight: '700', fontSize: 14 },

  resultsCard: {
    backgroundColor: t.surface, borderRadius: 12, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: ACCENT + '55',
  },
  resultsTitle: { fontSize: 15, fontWeight: '800', color: t.text, marginBottom: 2 },
  resultsSub:   { fontSize: 12, color: t.textSub },

  weightsTable:  { marginTop: 10, borderRadius: 8, overflow: 'hidden' },
  weightsHeader: {
    flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, backgroundColor: t.surfaceAlt,
  },
  weightsRow: {
    flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 7,
    borderBottomWidth: 1, borderBottomColor: t.border,
  },
  wCol: { flex: 1, fontSize: 12, color: t.textSub, fontWeight: '600', textAlign: 'center' },

  errRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 5,
    borderBottomWidth: 1, borderBottomColor: t.border,
  },
  errDate:  { flex: 2, fontSize: 12, color: t.textSub },
  errVal:   { flex: 2, fontSize: 12, color: t.text, textAlign: 'center' },
  errDelta: { flex: 1, fontSize: 13, fontWeight: '700', textAlign: 'right' },

  applyBtn:     { marginTop: 16, backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  applyBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  bioRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bioCell:      { backgroundColor: t.surfaceAlt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, alignItems: 'center', minWidth: 60 },
  bioCellLabel: { fontSize: 9, color: t.textFaint, fontWeight: '700', textTransform: 'uppercase' },
  bioCellVal:   { fontSize: 13, fontWeight: '700', color: t.text, marginTop: 2 },
});
