/**
 * Debug screen — dense dump of raw computed figures for analysis.
 * Access via Settings → Debug screen.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  SafeAreaView, ActivityIndicator, StyleSheet, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { fetchOvernightHRHistory, OvernightHREntry, OvernightHRDebug } from '../src/services/healthkit';

// ─── helpers ─────────────────────────────────────────────────────────────────

const f1 = (n: number | null | undefined) =>
  n == null ? '—' : n.toFixed(1);
const f0 = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(n).toString();
const dipPct = (day: number, night: number) =>
  day > 0 ? ((day - night) / day * 100).toFixed(1) + '%' : '—';
const hhmm = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return '?'; }
};
const mmdd = (date: string) => date.slice(5); // "MM-DD"

// ─── components ──────────────────────────────────────────────────────────────

function Hdr({ children }: { children: string }) {
  return <Text style={s.hdr}>{children}</Text>;
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, dim && s.dim]}>{value}</Text>
    </View>
  );
}

function Sep() {
  return <View style={s.sep} />;
}

function NightDebug({ entry }: { entry: OvernightHREntry }) {
  const d  = entry.debug as OvernightHRDebug;
  const dy = entry.daytimeHR;

  return (
    <View style={s.card}>
      {/* ── Header ── */}
      <Text style={s.cardTitle}>{entry.date}  ({hhmm(d.bedtime)}→{hhmm(d.wakeTime)})</Text>

      {/* ── Sleep stages summary ── */}
      <Hdr>SLEEP (min)</Hdr>
      <Row label="Total"  value={f0(d.totalMin)} />
      <Row label="Deep"   value={f0(d.deepMin)} />
      <Row label="REM"    value={f0(d.remMin)} />
      <Row label="Core"   value={f0(d.coreMin)} />
      <Row label="Awake"  value={f0(d.awakeMin)} />

      <Sep />

      {/* ── Daytime HR ── */}
      <Hdr>DAYTIME HR</Hdr>
      <Row label="Window" value={`${hhmm(entry.dayWindowStart)}–${hhmm(entry.dayWindowEnd)}`} />
      <Row label="n"      value={String(entry.daytimeSamples)} />
      <Row label="Mean"   value={`${f1(dy)} bpm`} />
      <Row label="Range"  value={`${f0(d.daytimeMin)}–${f0(d.daytimeMax)}`} />

      <Sep />

      {/* ── Per-stage HR breakdown ── */}
      <Hdr>HR BY STAGE  (n | min | mean | max | p25 | med | p75)</Hdr>
      <Text style={[s.mono, s.dim]}>{'  '}{'Stage'.padEnd(14)} {'n'.padStart(3)}  {'min'.padStart(4)} {'mean'.padStart(4)} {'max'.padStart(4)}  {'p25'.padStart(4)} {'med'.padStart(4)} {'p75'.padStart(4)}</Text>
      {d.stageStats.length === 0
        ? <Text style={s.dim}>  no data</Text>
        : d.stageStats
            .sort((a, b) => a.mean - b.mean)
            .map(st => (
              <Text key={st.stage} style={s.mono}>
                {'  '}{st.stage.padEnd(14).slice(0, 14)}{' '}
                {String(st.n).padStart(3)}  {f1(st.min).padStart(4)} {f1(st.mean).padStart(4)} {f1(st.max).padStart(4)}  {f1(st.p25).padStart(4)} {f1(st.median).padStart(4)} {f1(st.p75).padStart(4)}
              </Text>
            ))
      }

      <Sep />

      {/* ── Overnight HR variants ── */}
      <Hdr>OVERNIGHT HR VARIANTS  (bpm → dip)</Hdr>
      <Text style={s.mono}>{'  '}{'Algorithm'.padEnd(16)} {'HR'.padStart(5)}  {'Dip'.padStart(6)}</Text>
      {[
        { label: 'Raw mean',        val: d.rawMean },
        { label: 'Raw median',      val: d.rawMedian },
        { label: 'Raw p75-trim',    val: d.rawP75 },
        { label: 'Deep+REM mean',   val: d.deepRemMean },
        { label: 'PerStage p75',    val: d.perStageTrim },
        { label: 'Apple RHR',       val: d.appleRHR },
      ].map(({ label, val }) => (
        <Text key={label} style={[s.mono, val == null && s.dim]}>
          {'  '}{label.padEnd(16)}{' '}
          {val != null ? f1(val).padStart(5) : '    —'}
          {'  '}
          {val != null ? dipPct(dy, val).padStart(6) : '     —'}
        </Text>
      ))}

      <Sep />

      {/* ── Bevel target ── */}
      <Hdr>BEVEL TARGET (enter manually)</Hdr>
      <Row label="Bevel dip" value="??? %   ← screenshot + annotate" dim />
      <Row label="Bevel day" value="??? bpm" dim />
      <Row label="Bevel ngt" value="??? bpm" dim />
    </View>
  );
}

// ─── screen ──────────────────────────────────────────────────────────────────

export default function DebugScreen() {
  const router = useRouter();
  const [data,     setData]     = useState<OvernightHREntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(0); // index into data (most recent first)

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const history = await fetchOvernightHRHistory(1); // last month
      setData(history.slice().reverse());               // newest first
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={s.safe}>
      {/* nav bar */}
      <View style={s.nav}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 14, bottom: 14, left: 16, right: 16 }} style={s.backBtn}>
          <Text style={s.backTxt}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.navTitle}>HR Debug</Text>
        <View style={{ width: 60 }} />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#00d4ff" />
      ) : data.length === 0 ? (
        <Text style={[s.dim, { padding: 20 }]}>No data</Text>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor="#00d4ff" />}
        >
          {/* Night picker */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.picker}>
            {data.map((e, i) => (
              <TouchableOpacity
                key={e.date}
                style={[s.chip, i === selected && s.chipSel]}
                onPress={() => setSelected(i)}
              >
                <Text style={[s.chipTxt, i === selected && s.chipTxtSel]}>
                  {mmdd(e.date)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Debug dump for selected night */}
          <NightDebug entry={data[selected]} />

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const BG   = '#0a0a0f';
const CARD = '#13131a';
const ACC  = '#00d4ff';
const TXT  = '#e0e0e0';
const DIM  = '#666';
const HDR  = '#8888aa';

const s = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: BG },
  nav:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1e1e2e' },
  backBtn:   { width: 60 },
  backTxt:   { color: ACC, fontSize: 16 },
  navTitle:  { color: TXT, fontSize: 16, fontWeight: '600' },

  picker:    { paddingHorizontal: 12, paddingVertical: 8 },
  chip:      { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: CARD, marginRight: 6, borderWidth: 1, borderColor: '#2a2a3a' },
  chipSel:   { backgroundColor: ACC, borderColor: ACC },
  chipTxt:   { color: DIM, fontSize: 12, fontFamily: 'monospace' },
  chipTxtSel:{ color: '#000' },

  card:      { margin: 12, padding: 12, backgroundColor: CARD, borderRadius: 10, borderWidth: 1, borderColor: '#1e1e2e' },
  cardTitle: { color: ACC, fontSize: 12, fontFamily: 'monospace', marginBottom: 8, fontWeight: '700' },

  hdr:       { color: HDR, fontSize: 9, fontFamily: 'monospace', fontWeight: '700', marginTop: 10, marginBottom: 2, letterSpacing: 1 },
  row:       { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1 },
  label:     { color: DIM, fontSize: 11, fontFamily: 'monospace' },
  value:     { color: TXT, fontSize: 11, fontFamily: 'monospace' },
  dim:       { color: DIM },
  mono:      { color: TXT, fontSize: 11, fontFamily: 'monospace', paddingVertical: 1 },
  sep:       { height: 1, backgroundColor: '#1e1e2e', marginVertical: 6 },
});
