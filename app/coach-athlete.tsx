import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useThemedStyles, Palette } from '../src/theme';
import { getAthleteSummary, prescribePlan, unprescribe, AthleteSummary, AthleteDayRow, PlanRow } from '../src/services/coachLink';
import { weekdayName, formatWorkoutStructure, CoachIntensity } from '../src/services/coach';

const n0 = (v?: number | null) => (v == null ? '—' : Math.round(v).toString());
const km = (m?: number) => (m ? (m / 1000).toFixed(1) : '0.0');
const pace = (secPerKm?: number) => {
  if (!secPerKm || secPerKm <= 0) return '—';
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
};
const pad = (n: number) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (key: string, n: number) => {
  const d = new Date(key + 'T00:00:00'); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shortDate = (iso: string) => {
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

const INTENSITIES: CoachIntensity[] = ['rest', 'easy', 'moderate', 'hard'];
const ZONE_FOR: Record<string, string> = { easy: 'Z2', moderate: 'Z3', hard: 'Z4' };
const cap = (sx: string) => sx.charAt(0).toUpperCase() + sx.slice(1);

function defaultsFor(intensity: CoachIntensity, minutes: number) {
  const budget = Math.max(8, minutes - 6);
  if (intensity === 'easy') return { reps: 1, workMin: Math.min(90, budget), restMin: 0 };
  if (intensity === 'hard') return { reps: Math.max(4, Math.min(8, Math.round(budget / 5))), workMin: 3, restMin: 2 };
  return { reps: Math.max(3, Math.min(6, Math.round(budget / 7))), workMin: 5, restMin: 2 }; // moderate
}

export default function CoachAthleteScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<AthleteSummary | null>(null);

  // ── Prescription editor state ──────────────────────────────────────────────
  const [date, setDate] = useState(todayKey());
  const [intensity, setIntensity] = useState<CoachIntensity>('easy');
  const [minutes, setMinutes] = useState('40');
  const [reps, setReps] = useState('5');
  const [workMin, setWorkMin] = useState('5');
  const [restMin, setRestMin] = useState('2');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    if (!id) { setErr('Missing athlete.'); setLoading(false); return; }
    setLoading(true); setErr(null);
    getAthleteSummary(String(id))
      .then(setData)
      .catch((e: any) => setErr(e?.message ?? 'Could not load athlete.'))
      .finally(() => setLoading(false));
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Prefill the editor from any existing prescription for the chosen date.
  useEffect(() => {
    const existing = data?.plans?.find((p) => p.date === date && p.source === 'coach')?.plan;
    if (existing) {
      const it: CoachIntensity = ['rest', 'easy', 'moderate', 'hard'].includes(existing.intensity) ? existing.intensity : 'easy';
      setIntensity(it);
      setMinutes(String(existing.runMinutes || 40));
      const b = existing.workout?.blocks?.[0];
      if (b) { setReps(String(b.repeats ?? 1)); setWorkMin(String(b.workMinutes ?? 5)); setRestMin(String(b.restMinutes ?? 0)); }
      setNote(typeof existing.session === 'string' && existing.session ? existing.session : '');
    }
  }, [date, data]);

  const onIntensity = (it: CoachIntensity) => {
    setIntensity(it);
    if (it !== 'rest') { const d = defaultsFor(it, parseInt(minutes, 10) || 40); setReps(String(d.reps)); setWorkMin(String(d.workMin)); setRestMin(String(d.restMin)); }
  };

  const existingForDate: PlanRow | undefined = data?.plans?.find((p) => p.date === date && p.source === 'coach');

  const buildPlan = () => {
    const mins = Math.max(0, parseInt(minutes, 10) || 0);
    const zone = ZONE_FOR[intensity] ?? 'Z2';
    const workout = intensity === 'rest' ? null : {
      name: weekdayName(date),
      warmupMeters: 600, drillsMinutes: 4,
      blocks: [{ repeats: Math.max(1, parseInt(reps, 10) || 1), workMinutes: Math.max(1, parseInt(workMin, 10) || 1), restMinutes: Math.max(0, parseInt(restMin, 10) || 0), hrZone: zone, label: intensity }],
      cooldownMeters: 600,
    };
    return {
      headline: `Coach: ${cap(intensity)}${intensity === 'rest' ? ' day' : ' session'}`,
      session: note.trim() || (workout ? formatWorkoutStructure(workout as any) : 'Rest day'),
      strength: '',
      intensity, runMinutes: intensity === 'rest' ? 0 : mins,
      strainLow: 30, strainHigh: 60,
      rationale: 'Prescribed by your coach.',
      workout,
      generatedAt: new Date().toISOString(),
    };
  };

  const send = async () => {
    setSending(true);
    try {
      await prescribePlan(String(id), date, buildPlan());
      Alert.alert('Prescribed', `Sent ${cap(intensity)} for ${shortDate(date)}. It appears on the athlete's app when they're in coach mode.`);
      load();
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? String(e));
    } finally { setSending(false); }
  };

  const remove = () => {
    Alert.alert('Remove prescription', `Clear the plan for ${shortDate(date)}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { try { await unprescribe(String(id), date); load(); } catch (e: any) { Alert.alert('Failed', e?.message ?? String(e)); } } },
    ]);
  };

  const today: AthleteDayRow | undefined = data?.days?.[0];

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{data?.athlete?.name || name || 'Athlete'}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        {loading ? (
          <ActivityIndicator size="large" color="#FF6B35" style={{ marginTop: 28 }} />
        ) : err ? (
          <View style={s.card}>
            <Text style={s.err}>{err}</Text>
            <TouchableOpacity style={s.btn} onPress={load}><Text style={s.btnText}>Retry</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            {/* ── Prescribe ──────────────────────────────────────────────────── */}
            <Text style={s.bigSection}>Prescribe</Text>
            <View style={s.card}>
              <View style={s.dateRow}>
                <TouchableOpacity onPress={() => setDate(addDays(date, -1))} disabled={date <= todayKey()} style={s.dateBtn}>
                  <Text style={[s.dateArrow, date <= todayKey() && { opacity: 0.3 }]}>‹</Text>
                </TouchableOpacity>
                <Text style={s.dateLabel}>{date === todayKey() ? 'Today' : shortDate(date)}</Text>
                <TouchableOpacity onPress={() => setDate(addDays(date, 1))} disabled={date >= addDays(todayKey(), 7)} style={s.dateBtn}>
                  <Text style={[s.dateArrow, date >= addDays(todayKey(), 7) && { opacity: 0.3 }]}>›</Text>
                </TouchableOpacity>
              </View>

              {existingForDate && (
                <Text style={s.existing}>Current: {existingForDate.plan?.intensity === 'rest' ? 'Rest' : formatWorkoutStructure(existingForDate.plan?.workout)}</Text>
              )}

              <View style={s.segment}>
                {INTENSITIES.map((it) => (
                  <TouchableOpacity key={it} style={[s.segBtn, intensity === it && s.segBtnActive]} onPress={() => onIntensity(it)}>
                    <Text style={[s.segText, intensity === it && s.segTextActive]}>{cap(it)}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {intensity !== 'rest' && (
                <>
                  <Field s={s} label="Total minutes" value={minutes} onChange={setMinutes} />
                  {intensity !== 'easy' && (
                    <View style={s.row3}>
                      <Field s={s} label="Reps" value={reps} onChange={setReps} flex />
                      <Field s={s} label="Work min" value={workMin} onChange={setWorkMin} flex />
                      <Field s={s} label="Rest min" value={restMin} onChange={setRestMin} flex />
                    </View>
                  )}
                  <Text style={s.zoneNote}>Target zone {ZONE_FOR[intensity]} · power is set on the athlete's device from their own zones.</Text>
                </>
              )}

              <Text style={s.fieldLabel}>Note to athlete (optional)</Text>
              <TextInput
                style={[s.input, { minHeight: 60, textAlignVertical: 'top' }]}
                value={note}
                onChangeText={setNote}
                placeholder="e.g. Keep it controlled, stop if the calf flares up."
                placeholderTextColor="#999"
                multiline
              />

              <TouchableOpacity style={[s.btn, sending && { opacity: 0.6 }]} disabled={sending} onPress={send}>
                <Text style={s.btnText}>{sending ? 'Sending…' : existingForDate ? 'Update prescription' : 'Send prescription'}</Text>
              </TouchableOpacity>
              {existingForDate && (
                <TouchableOpacity onPress={remove} style={{ marginTop: 10, alignItems: 'center' }}>
                  <Text style={s.removeLink}>Remove prescription</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* ── Read-only data ─────────────────────────────────────────────── */}
            <Text style={s.bigSection}>Their data</Text>
            <Text style={s.read}>Read-only · synced from the athlete's device</Text>

            {today ? (
              <View style={s.card}>
                <Text style={s.cardLabel}>Latest · {shortDate(today.date)}</Text>
                <View style={s.bigRow}>
                  <Stat s={s} label="Recovery" value={n0(today.recovery)} accent="#22C55E" />
                  <Stat s={s} label="Strain" value={n0(today.strain)} accent="#F97316" />
                </View>
                <View style={s.metaRow}>
                  <Meta s={s} label="CTL" value={n0(today.ctl)} />
                  <Meta s={s} label="ATL" value={n0(today.atl)} />
                  <Meta s={s} label="TSB" value={today.tsb == null ? '—' : `${today.tsb > 0 ? '+' : ''}${Math.round(today.tsb)}`} />
                  <Meta s={s} label="Sleep" value={today.sleepMin ? `${Math.floor(today.sleepMin / 60)}h${pad(today.sleepMin % 60)}` : '—'} />
                </View>
                <View style={s.metaRow}>
                  <Meta s={s} label="HRV" value={today.hrv ? `${Math.round(today.hrv)}ms` : '—'} />
                  <Meta s={s} label="RHR" value={today.rhr ? `${Math.round(today.rhr)}` : '—'} />
                </View>
              </View>
            ) : (
              <Text style={s.empty}>No daily metrics synced yet.</Text>
            )}

            {(data?.days?.length ?? 0) > 1 && (
              <>
                <Text style={s.section}>Recent days</Text>
                <View style={s.table}>
                  <View style={[s.trow, s.thead]}>
                    <Text style={[s.th, { flex: 1.4 }]}>Day</Text>
                    <Text style={s.th}>Rec</Text><Text style={s.th}>Str</Text>
                    <Text style={s.th}>CTL</Text><Text style={s.th}>ATL</Text><Text style={s.th}>TSB</Text>
                  </View>
                  {data!.days.slice(0, 14).map((d) => (
                    <View key={d.date} style={s.trow}>
                      <Text style={[s.td, { flex: 1.4, textAlign: 'left' }]}>{shortDate(d.date)}</Text>
                      <Text style={s.td}>{n0(d.recovery)}</Text><Text style={s.td}>{n0(d.strain)}</Text>
                      <Text style={s.td}>{n0(d.ctl)}</Text><Text style={s.td}>{n0(d.atl)}</Text>
                      <Text style={s.td}>{d.tsb == null ? '—' : `${d.tsb > 0 ? '+' : ''}${Math.round(d.tsb)}`}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            <Text style={s.section}>Recent runs</Text>
            {(data?.runs?.length ?? 0) === 0 ? (
              <Text style={s.empty}>No runs synced yet.</Text>
            ) : (
              data!.runs.map((r: any) => (
                <View key={r.id} style={s.runRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.runTitle}>{shortDate(r.date)} · {r.label || 'Run'}</Text>
                    <Text style={s.runSub}>{km(r.distance)} km · {pace(r.pace)}{r.avgHeartRate ? ` · ${Math.round(r.avgHeartRate)} bpm` : ''}</Text>
                  </View>
                  <Text style={s.runDur}>{r.duration ? `${Math.round(r.duration / 60)}′` : ''}</Text>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ s, label, value, onChange, flex }: { s: any; label: string; value: string; onChange: (t: string) => void; flex?: boolean }) {
  return (
    <View style={flex ? { flex: 1 } : undefined}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={(t) => onChange(t.replace(/[^0-9]/g, ''))} keyboardType="number-pad" />
    </View>
  );
}
function Stat({ s, label, value, accent }: { s: any; label: string; value: string; accent: string }) {
  return <View style={s.stat}><Text style={[s.statVal, { color: accent }]}>{value}</Text><Text style={s.statLabel}>{label}</Text></View>;
}
function Meta({ s, label, value }: { s: any; label: string; value: string }) {
  return <View style={s.meta}><Text style={s.metaVal}>{value}</Text><Text style={s.metaLabel}>{label}</Text></View>;
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700', color: c.text, flex: 1, textAlign: 'center' },
  scroll: { padding: 16, paddingBottom: 48 },
  bigSection: { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 10, marginLeft: 2 },
  read: { fontSize: 11.5, color: c.textFaint, marginBottom: 12, marginLeft: 2 },

  card: {
    backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  cardLabel: { fontSize: 11, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },

  dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  dateBtn: { paddingHorizontal: 16, paddingVertical: 4 },
  dateArrow: { fontSize: 28, color: '#FF6B35', fontWeight: '700' },
  dateLabel: { fontSize: 16, fontWeight: '700', color: c.text },
  existing: { fontSize: 12.5, color: c.textSub, marginBottom: 12, textAlign: 'center' },

  segment: { flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 12 },
  segBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segBtnActive: { backgroundColor: c.surface, shadowColor: '#000', shadowOpacity: c.shadowOpacity, shadowRadius: 2, elevation: 1 },
  segText: { fontSize: 13, fontWeight: '600', color: c.textSub },
  segTextActive: { color: c.text },

  fieldLabel: { fontSize: 12.5, fontWeight: '600', color: c.textSub, marginBottom: 5, marginTop: 4 },
  input: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: c.text, marginBottom: 8,
  },
  row3: { flexDirection: 'row', gap: 10 },
  zoneNote: { fontSize: 11.5, color: c.textFaint, marginBottom: 8, marginTop: 2 },
  removeLink: { fontSize: 13, color: '#E2553B', fontWeight: '700' },

  bigRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  stat: { flex: 1, alignItems: 'center' },
  statVal: { fontSize: 34, fontWeight: '800' },
  statLabel: { fontSize: 12, color: c.textSub, marginTop: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 4 },
  meta: { alignItems: 'center', flex: 1 },
  metaVal: { fontSize: 15, fontWeight: '700', color: c.text },
  metaLabel: { fontSize: 11, color: c.textFaint, marginTop: 1 },

  section: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8, marginLeft: 2 },
  empty: { fontSize: 13, color: c.textFaint, marginLeft: 2, marginBottom: 12 },

  table: { backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden', marginBottom: 16 },
  trow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  thead: { backgroundColor: c.surfaceAlt },
  th: { flex: 1, fontSize: 11, fontWeight: '700', color: c.textSub, textAlign: 'center' },
  td: { flex: 1, fontSize: 13, color: c.text, textAlign: 'center' },

  runRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: 12, padding: 13, marginBottom: 9,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  runTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  runSub: { fontSize: 12, color: c.textSub, marginTop: 2 },
  runDur: { fontSize: 14, fontWeight: '700', color: c.textSub },

  err: { fontSize: 14, color: '#E2553B', marginBottom: 12 },
  btn: { backgroundColor: '#FF6B35', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
