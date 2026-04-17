import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, SafeAreaView, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useRouter } from 'expo-router';

const STORE_KEY = 'bevel_calibration_entries';

interface CalibrationEntry {
  date: string;           // YYYY-MM-DD
  // Bevel scores
  bevelRecovery: number;  // 0-100
  bevelSleep: number;     // 0-100
  // Biometrics
  rmssd: number;          // ms
  restingHR: number;      // bpm
  sleepHours: number;     // total sleep hours
  deepMinutes: number;    // deep sleep minutes
  remMinutes: number;     // REM sleep minutes
  inBedHours: number;     // total time in bed hours
  awakeMinutes: number;   // awake during night minutes
  daytimeHR: number;      // avg daytime HR bpm
  // Computed by our algorithm (filled in after save)
  ourRecovery?: number;
  ourSleep?: number;
}

function emptyEntry(): Partial<CalibrationEntry> {
  return {
    date: new Date().toISOString().slice(0, 10),
    bevelRecovery: undefined as any,
    bevelSleep: undefined as any,
    rmssd: undefined as any,
    restingHR: undefined as any,
    sleepHours: undefined as any,
    deepMinutes: undefined as any,
    remMinutes: undefined as any,
    inBedHours: undefined as any,
    awakeMinutes: undefined as any,
    daytimeHR: undefined as any,
  };
}

// Mirror of computeSleepScore from healthkit.ts for local computation
function computeOurSleep(entry: CalibrationEntry): number {
  const totalMin   = entry.sleepHours * 60;
  const deepMin    = entry.deepMinutes;
  const remMin     = entry.remMinutes;
  const awakeMin   = entry.awakeMinutes;
  const goalMin    = 480;
  const inBedMin   = entry.inBedHours * 60;
  const overnightHR = entry.restingHR;
  const daytimeHR  = entry.daytimeHR;

  const goalRatio = Math.min(1.2, totalMin / goalMin);
  const timeScore =
    goalRatio >= 1.0 ? 100
    : goalRatio >= 0.85 ? 70 + (goalRatio - 0.85) / 0.15 * 30
    : goalRatio >= 0.60 ? 30 + (goalRatio - 0.60) / 0.25 * 40
    : goalRatio * 50;

  const deepRemFrac = totalMin > 0 ? (deepMin + remMin) / totalMin : 0;
  const stagesScore =
    deepRemFrac >= 0.40 ? 100
    : deepRemFrac >= 0.25 ? 60 + (deepRemFrac - 0.25) / 0.15 * 40
    : deepRemFrac >= 0.10 ? 20 + (deepRemFrac - 0.10) / 0.15 * 40
    : deepRemFrac * 200;

  const totalInBed = inBedMin > 0 ? inBedMin : totalMin + awakeMin;
  const efficiency = totalInBed > 0 ? totalMin / totalInBed : 1;
  const effScore = Math.min(100, efficiency * 110);

  let hrDipScore = 50;
  if (overnightHR > 0 && daytimeHR > 0) {
    const dip = (daytimeHR - overnightHR) / daytimeHR;
    hrDipScore =
      dip >= 0.25 ? 100
      : dip >= 0.15 ? 70 + (dip - 0.15) / 0.10 * 30
      : dip >= 0.05 ? 20 + (dip - 0.05) / 0.10 * 50
      : Math.max(0, dip * 400);
  }

  const awakeFrac = totalInBed > 0 ? awakeMin / totalInBed : 0;
  const continuityScore =
    awakeFrac <= 0.05 ? 100
    : awakeFrac <= 0.15 ? 100 - (awakeFrac - 0.05) / 0.10 * 50
    : Math.max(0, 50 - (awakeFrac - 0.15) * 300);

  const raw = timeScore * 0.40 + stagesScore * 0.25 + effScore * 0.15 + hrDipScore * 0.10 + continuityScore * 0.10;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

function computeOurRecovery(entry: CalibrationEntry): number {
  const absHRV = Math.min(98, Math.max(5, 38 + entry.rmssd * 0.95));
  const absRHR = Math.min(95, Math.max(5, 190 - entry.restingHR * 2.1));
  const useRHR = entry.restingHR > 0;
  return Math.round(useRHR ? 0.65 * absHRV + 0.35 * absRHR : absHRV);
}

function scoreColor(ours: number, bevel: number): string {
  const diff = Math.abs(ours - bevel);
  if (diff <= 5)  return '#27ae60';
  if (diff <= 15) return '#f39c12';
  return '#e74c3c';
}

// ─── Field input helper ───────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, unit,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; unit?: string;
}) {
  return (
    <View style={fs.row}>
      <Text style={fs.label}>{label}</Text>
      <TextInput
        style={fs.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ?? '—'}
        placeholderTextColor="#bbb"
        keyboardType="decimal-pad"
        returnKeyType="done"
      />
      {unit ? <Text style={fs.unit}>{unit}</Text> : <View style={{ width: 30 }} />}
    </View>
  );
}

const fs = StyleSheet.create({
  row:   { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  label: { flex: 1, fontSize: 13, color: '#555', fontWeight: '500' },
  input: {
    width: 80, borderWidth: 1, borderColor: '#ddd', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7,
    fontSize: 14, color: '#222', backgroundColor: '#fafafa',
    textAlign: 'right',
  },
  unit: { width: 36, fontSize: 12, color: '#888', marginLeft: 6 },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function BevelCalibrationScreen() {
  const router = useRouter();
  const [entries, setEntries] = useState<CalibrationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [form, setForm]       = useState<Record<string, string>>({
    date: new Date().toISOString().slice(0, 10),
  });

  useEffect(() => {
    SecureStore.getItemAsync(STORE_KEY).then((raw) => {
      if (raw) {
        try { setEntries(JSON.parse(raw)); } catch {}
      }
      setLoading(false);
    });
  }, []);

  const setField = (key: string, val: string) => setForm(f => ({ ...f, [key]: val }));

  const handleAdd = useCallback(async () => {
    const get = (k: string) => parseFloat(form[k] ?? '');
    const entry: CalibrationEntry = {
      date:          form.date ?? new Date().toISOString().slice(0, 10),
      bevelRecovery: get('bevelRecovery'),
      bevelSleep:    get('bevelSleep'),
      rmssd:         get('rmssd'),
      restingHR:     get('restingHR'),
      sleepHours:    get('sleepHours'),
      deepMinutes:   get('deepMinutes'),
      remMinutes:    get('remMinutes'),
      inBedHours:    get('inBedHours'),
      awakeMinutes:  get('awakeMinutes'),
      daytimeHR:     get('daytimeHR'),
    };
    if (isNaN(entry.rmssd) || isNaN(entry.bevelRecovery)) {
      Alert.alert('Missing data', 'At minimum, RMSSD and Bevel Recovery score are required.');
      return;
    }
    entry.ourRecovery = computeOurRecovery(entry);
    entry.ourSleep    = !isNaN(entry.sleepHours) ? computeOurSleep(entry) : undefined;

    setSaving(true);
    const updated = [entry, ...entries.filter(e => e.date !== entry.date)].sort(
      (a, b) => b.date.localeCompare(a.date)
    );
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(updated));
    setEntries(updated);
    setForm({ date: new Date().toISOString().slice(0, 10) });
    setSaving(false);
  }, [form, entries]);

  const handleDelete = (date: string) => {
    Alert.alert('Delete entry', `Remove data for ${date}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          const updated = entries.filter(e => e.date !== date);
          await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(updated));
          setEntries(updated);
        },
      },
    ]);
  };

  // Simple correlation summary
  const recCorr = entries
    .filter(e => e.ourRecovery !== undefined)
    .map(e => `Δ${((e.ourRecovery ?? 0) - e.bevelRecovery) > 0 ? '+' : ''}${Math.round((e.ourRecovery ?? 0) - e.bevelRecovery)}`);
  const sleepCorr = entries
    .filter(e => e.ourSleep !== undefined && !isNaN(e.bevelSleep))
    .map(e => `Δ${((e.ourSleep ?? 0) - e.bevelSleep) > 0 ? '+' : ''}${Math.round((e.ourSleep ?? 0) - e.bevelSleep)}`);

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
            <Text style={s.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={s.title}>Bevel Calibration</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <Text style={s.subtitle}>
            Enter daily Bevel scores and biometrics to compare with RunCoach AI's algorithm and fine-tune the weights.
          </Text>

          {/* ── Entry form ─────────────────────────────────────────── */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Add / Update Entry</Text>

            <Field label="Date (YYYY-MM-DD)" value={form.date ?? ''} onChange={v => setField('date', v)} placeholder="2025-04-13" />

            <Text style={s.sectionDivider}>BEVEL SCORES</Text>
            <Field label="Bevel Recovery" value={form.bevelRecovery ?? ''} onChange={v => setField('bevelRecovery', v)} placeholder="75" unit="%" />
            <Field label="Bevel Sleep"    value={form.bevelSleep ?? ''}    onChange={v => setField('bevelSleep', v)}    placeholder="80" unit="%" />

            <Text style={s.sectionDivider}>BIOMETRICS</Text>
            <Field label="RMSSD"           value={form.rmssd ?? ''}        onChange={v => setField('rmssd', v)}        placeholder="43"  unit="ms"  />
            <Field label="Resting HR"      value={form.restingHR ?? ''}    onChange={v => setField('restingHR', v)}    placeholder="58"  unit="bpm" />
            <Field label="Daytime HR avg"  value={form.daytimeHR ?? ''}    onChange={v => setField('daytimeHR', v)}    placeholder="72"  unit="bpm" />

            <Text style={s.sectionDivider}>SLEEP DATA</Text>
            <Field label="Total sleep"  value={form.sleepHours ?? ''}   onChange={v => setField('sleepHours', v)}   placeholder="7.5" unit="h"   />
            <Field label="Time in bed"  value={form.inBedHours ?? ''}   onChange={v => setField('inBedHours', v)}   placeholder="8.0" unit="h"   />
            <Field label="Deep sleep"   value={form.deepMinutes ?? ''}  onChange={v => setField('deepMinutes', v)}  placeholder="60"  unit="min" />
            <Field label="REM sleep"    value={form.remMinutes ?? ''}   onChange={v => setField('remMinutes', v)}   placeholder="90"  unit="min" />
            <Field label="Awake time"   value={form.awakeMinutes ?? ''} onChange={v => setField('awakeMinutes', v)} placeholder="20"  unit="min" />

            <TouchableOpacity
              style={[s.btn, saving && { opacity: 0.6 }]}
              onPress={handleAdd}
              disabled={saving}
            >
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={s.btnText}>Save Entry</Text>}
            </TouchableOpacity>
          </View>

          {/* ── Analysis summary ────────────────────────────────────── */}
          {entries.length >= 2 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Parameter Analysis ({entries.length} days)</Text>
              <Text style={s.hint}>
                Recovery deltas (our − Bevel): {recCorr.slice(0, 10).join('  ')}
              </Text>
              {sleepCorr.length > 0 && (
                <Text style={s.hint}>
                  Sleep deltas (our − Bevel): {sleepCorr.slice(0, 10).join('  ')}
                </Text>
              )}
              <Text style={s.hint}>
                {'\n'}Green = within 5 pts  ·  Amber = within 15 pts  ·  Red = off by 15+
              </Text>
            </View>
          )}

          {/* ── Entries table ────────────────────────────────────────── */}
          {loading ? (
            <ActivityIndicator color="#FF6B35" style={{ marginTop: 20 }} />
          ) : entries.length === 0 ? (
            <Text style={s.emptyText}>No entries yet — add one above.</Text>
          ) : (
            <View style={s.card}>
              <Text style={s.cardTitle}>Logged Days</Text>
              {/* Table header */}
              <View style={[s.tableRow, s.tableHeader]}>
                <Text style={[s.col0, s.th]}>Date</Text>
                <Text style={[s.col1, s.th]}>Rec{'\n'}Bevel</Text>
                <Text style={[s.col1, s.th]}>Rec{'\n'}Ours</Text>
                <Text style={[s.col1, s.th]}>Slp{'\n'}Bevel</Text>
                <Text style={[s.col1, s.th]}>Slp{'\n'}Ours</Text>
                <Text style={[s.col2, s.th]}>RMSSD</Text>
              </View>
              {entries.map((e) => {
                const recDiff  = (e.ourRecovery ?? 0) - e.bevelRecovery;
                const slpDiff  = (e.ourSleep ?? 0) - e.bevelSleep;
                return (
                  <TouchableOpacity
                    key={e.date}
                    style={s.tableRow}
                    onLongPress={() => handleDelete(e.date)}
                  >
                    <Text style={s.col0}>{e.date.slice(5)}</Text>
                    <Text style={s.col1}>{e.bevelRecovery}</Text>
                    <Text style={[s.col1, { color: scoreColor(e.ourRecovery ?? 0, e.bevelRecovery), fontWeight: '600' }]}>
                      {e.ourRecovery ?? '--'}
                    </Text>
                    <Text style={s.col1}>{isNaN(e.bevelSleep) ? '--' : e.bevelSleep}</Text>
                    <Text style={[s.col1, { color: e.ourSleep ? scoreColor(e.ourSleep, e.bevelSleep) : '#aaa', fontWeight: '600' }]}>
                      {e.ourSleep ?? '--'}
                    </Text>
                    <Text style={s.col2}>{e.rmssd} ms</Text>
                  </TouchableOpacity>
                );
              })}
              <Text style={s.hint}>Long-press a row to delete it.</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700', color: '#222' },
  scroll: { padding: 12, paddingBottom: 60 },
  subtitle: { fontSize: 13, color: '#888', lineHeight: 20, marginBottom: 12 },
  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  cardTitle: {
    fontSize: 13, fontWeight: '700', color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12,
  },
  sectionDivider: {
    fontSize: 10, fontWeight: '700', color: '#bbb',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 10, marginBottom: 8,
  },
  btn: {
    backgroundColor: '#FF6B35', borderRadius: 8, paddingVertical: 12,
    alignItems: 'center', marginTop: 10,
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  hint: { fontSize: 12, color: '#999', lineHeight: 18, marginTop: 4 },
  emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center', marginTop: 24 },

  tableRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', alignItems: 'center' },
  tableHeader: { borderBottomWidth: 2, borderBottomColor: '#eee' },
  th:   { fontSize: 10, color: '#aaa', fontWeight: '700', textAlign: 'center' },
  col0: { width: 54, fontSize: 12, color: '#555' },
  col1: { flex: 1, fontSize: 12, color: '#333', textAlign: 'center' },
  col2: { width: 60, fontSize: 11, color: '#888', textAlign: 'right' },
});
