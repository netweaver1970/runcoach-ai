import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { loadSnapshotCache } from '../src/services/healthkit';
import { assembleCoachSnapshot, getWeekPlan, synthesizeWorkout, WeekPlanDay } from '../src/services/coach';
import { estimateWorkoutLoad, strainFromLoad, estimateDayTrimp, rollLoadForward } from '../src/services/trainingLoad';

type Row = WeekPlanDay & { strain: number; ctl: number; atl: number; tsb: number };

const INTENSITY: Record<string, { label: string; color: string }> = {
  rest:     { label: 'Rest',     color: '#7f8c8d' },
  easy:     { label: 'Easy',     color: '#27ae60' },
  moderate: { label: 'Moderate', color: '#e67e22' },
  hard:     { label: 'Hard',     color: '#e74c3c' },
};

export default function WeekPlan() {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [rows, setRows]   = useState<Row[] | null>(null);
  const [start, setStart] = useState<{ ctl: number; atl: number } | null>(null);
  const [err, setErr]     = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);

  const build = useCallback(async () => {
    setBusy(true); setErr(null); setRows(null);
    try {
      const snap = await loadSnapshotCache();
      if (!snap) { setErr('No data yet — open the home screen first to sync.'); return; }
      const coach = await assembleCoachSnapshot(snap.strain ?? null, snap.activities);
      const ctl0 = coach.ctl ?? 0, atl0 = coach.atl ?? 0;
      setStart({ ctl: ctl0, atl: atl0 });

      const days   = await getWeekPlan(coach);
      const trimps = days.map(d => estimateDayTrimp(d.intensity, d.runMinutes));
      const load   = rollLoadForward(ctl0, atl0, trimps);

      setRows(days.map((d, i) => {
        const runStrain = d.intensity === 'rest'
          ? 0
          : strainFromLoad(estimateWorkoutLoad(synthesizeWorkout(d.intensity, d.runMinutes, d.weekday, coach.powerZones)));
        return { ...d, strain: Math.max(20, Math.round(runStrain)), ...load[i] };
      }));
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to build the week plan.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { build(); }, [build]);

  const totalRunMin = rows?.reduce((a, r) => a + r.runMinutes, 0) ?? 0;
  const runDays     = rows?.filter(r => r.intensity !== 'rest').length ?? 0;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
      <Text style={s.intro}>
        Next 7 days from your weekly schedule, adjusted for the rolling cap, recovery and alternation.
        Strain + CTL/ATL/TSB are forward estimates (rest days counted as strain 20).
      </Text>

      {start && (
        <Text style={s.startLine}>
          Starting today: CTL {start.ctl.toFixed(0)} · ATL {start.atl.toFixed(0)} · TSB {(start.ctl - start.atl).toFixed(0)}
        </Text>
      )}

      {busy && !rows && (
        <View style={s.center}>
          <ActivityIndicator size="large" color="#FF6B35" />
          <Text style={s.dim}>Planning your week…</Text>
        </View>
      )}

      {err && (
        <View style={s.center}>
          <Text style={s.err}>{err}</Text>
          <TouchableOpacity style={s.btn} onPress={build}><Text style={s.btnText}>Retry</Text></TouchableOpacity>
        </View>
      )}

      {rows && (
        <>
          <View style={s.headRow}>
            <Text style={[s.h, { flex: 1 }]}>Day</Text>
            <Text style={[s.h, s.num]}>Strain</Text>
            <Text style={[s.h, s.num]}>CTL</Text>
            <Text style={[s.h, s.num]}>ATL</Text>
            <Text style={[s.h, s.num]}>TSB</Text>
          </View>

          {rows.map((r) => {
            const day = Number(r.date.slice(8, 10));
            const it  = INTENSITY[r.intensity] ?? INTENSITY.rest;
            return (
              <View key={r.date} style={s.row}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={s.dayLine}>
                    <Text style={s.weekday}>{r.weekday} {day}</Text>
                    {'  '}<Text style={[s.tag, { color: it.color }]}>{it.label}</Text>
                  </Text>
                  <Text style={s.struct} numberOfLines={1}>{r.structure}</Text>
                  {!!r.note && <Text style={s.note} numberOfLines={1}>{r.note}</Text>}
                </View>
                <Text style={[s.num, s.strain, { color: it.color }]}>{r.strain}</Text>
                <Text style={[s.num, s.val]}>{r.ctl.toFixed(0)}</Text>
                <Text style={[s.num, s.val]}>{r.atl.toFixed(0)}</Text>
                <Text style={[s.num, s.val, { color: r.tsb < -10 ? '#e74c3c' : r.tsb > 5 ? '#3498db' : c.textSub }]}>
                  {r.tsb > 0 ? '+' : ''}{r.tsb.toFixed(0)}
                </Text>
              </View>
            );
          })}

          <Text style={s.footer}>
            {runDays} run day{runDays === 1 ? '' : 's'} · {totalRunMin} run-min this week
          </Text>

          <TouchableOpacity style={[s.btn, busy && { opacity: 0.5 }]} onPress={build} disabled={busy}>
            <Text style={s.btnText}>{busy ? 'Re-planning…' : '↻ Regenerate'}</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  intro:    { fontSize: 12.5, color: c.textSub, lineHeight: 18, marginBottom: 8 },
  startLine:{ fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 12 },
  center:   { alignItems: 'center', paddingVertical: 40, gap: 10 },
  dim:      { color: c.textSub, fontSize: 13 },
  err:      { color: '#e74c3c', fontSize: 13, textAlign: 'center', paddingHorizontal: 10 },
  headRow:  { flexDirection: 'row', alignItems: 'flex-end', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border },
  h:        { fontSize: 10, fontWeight: '700', color: c.textFaint, letterSpacing: 0.4, textTransform: 'uppercase' },
  row:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  dayLine:  { fontSize: 14 },
  weekday:  { fontSize: 14, fontWeight: '800', color: c.text },
  tag:      { fontSize: 12, fontWeight: '700' },
  struct:   { fontSize: 13, color: c.text, marginTop: 2 },
  note:     { fontSize: 11, color: c.textSub, marginTop: 1 },
  num:      { width: 46, textAlign: 'right' },
  strain:   { fontSize: 16, fontWeight: '800' },
  val:      { fontSize: 14, fontWeight: '600', color: c.textSub },
  footer:   { fontSize: 12.5, color: c.textSub, marginTop: 14, fontWeight: '600' },
  btn:      { backgroundColor: '#FF6B35', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  btnText:  { color: '#fff', fontWeight: '700', fontSize: 14 },
});
