import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../theme';
import { StrengthStore, StrengthSession, exerciseById, exerciseHistory, sessionPRs, sessionTonnage, isWorkSet, FEEL_LABEL } from '../services/strength';

const UP = '#2f9e44', DOWN = '#e5484d';
const fmtKg = (v: number) => `${Math.round(v * 10) / 10}`;
const fmtDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * A FINISHED session, as an analysis instead of its Start card (Geert 2026-10-08: "when done a routine it should
 * disappear or be replaced by an analysis of the exercises vs previous"): per exercise today's sets vs the last time you
 * did that exercise (any routine) — top weight, best reps, volume, est. 1RM — with records. Tap → the full session.
 */
export function SessionVsPrevious({ st, sess }: { st: StrengthStore; sess: StrengthSession }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const ids = [...new Set(sess.sets.filter(isWorkSet).map(l => l.exerciseId))];
  const prs = sessionPRs(st, sess.id);
  const prBy = new Map<string, string[]>();
  for (const p of prs) prBy.set(p.exerciseId, [...(prBy.get(p.exerciseId) ?? []), p.kind]);
  const rows = ids.map(id => {
    const ex = exerciseById(st, id);
    const hist = exerciseHistory(st, id);
    const k = hist.findIndex(h => h.sessionId === sess.id);
    const cur = k >= 0 ? hist[k] : undefined;
    const prev = k > 0 ? hist[k - 1] : undefined;
    const sets = sess.sets.filter(l => l.exerciseId === id && isWorkSet(l));
    const setsTxt = ex?.timed ? sets.map(l => `${l.reps}s`).join(', ')
      : `${fmtKg(cur?.topKg ?? 0)} kg × ${sets.filter(l => l.weightKg === Math.max(...sets.map(x => x.weightKg))).map(l => l.reps).join(', ')}`;
    const deltas: { txt: string; up: boolean | null }[] = [];
    if (cur && prev) {
      if (ex?.timed) {
        const d = (cur.bestReps ?? 0) - (prev.bestReps ?? 0);
        if (d) deltas.push({ txt: `${d > 0 ? '+' : ''}${d} s hold`, up: d > 0 });
      } else {
        const dKg = cur.topKg - prev.topKg;
        if (Math.abs(dKg) >= 0.25) deltas.push({ txt: `${dKg > 0 ? '+' : ''}${fmtKg(dKg)} kg top`, up: dKg > 0 });
        else { const dR = (cur.bestReps ?? 0) - (prev.bestReps ?? 0); if (dR) deltas.push({ txt: `${dR > 0 ? '+' : ''}${dR} reps`, up: dR > 0 }); }
        if (prev.volume > 0) { const p = Math.round((cur.volume / prev.volume - 1) * 100); if (Math.abs(p) >= 3) deltas.push({ txt: `vol ${p > 0 ? '+' : ''}${p}%`, up: p > 0 }); }
        if (cur.bestE1rm && prev.bestE1rm) { const d = cur.bestE1rm - prev.bestE1rm; if (Math.abs(d) >= 0.5) deltas.push({ txt: `e1RM ${d > 0 ? '+' : ''}${fmtKg(d)}`, up: d > 0 }); }
      }
      if (!deltas.length) deltas.push({ txt: 'same as last time', up: null });
    }
    return { id, name: ex?.name ?? id, setsTxt, prev, deltas, feel: sess.feel?.[id], pr: prBy.get(id) };
  });
  const ups = rows.filter(r => r.deltas.some(d => d.up === true)).length;
  const downs = rows.filter(r => r.deltas.some(d => d.up === false) && !r.deltas.some(d => d.up === true)).length;
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => router.push({ pathname: '/strength-session-detail' as any, params: { id: sess.id } })} style={s.box}>
      <Text style={s.head}>✅ {sess.routineName}<Text style={s.meta}>  {sessionTonnage(st, sess).toLocaleString()} kg{sess.rpe ? ` · RPE ${sess.rpe}` : ''}{prs.length ? ` · 🏆 ${prs.length} record${prs.length > 1 ? 's' : ''}` : ''} ›</Text></Text>
      <Text style={s.meta}>{ups ? `${ups} exercise${ups > 1 ? 's' : ''} up` : ''}{ups && downs ? ' · ' : ''}{downs ? `${downs} down` : ''}{!ups && !downs ? 'vs the last time you did each exercise' : ' vs last time'}</Text>
      {rows.map(r => (
        <View key={r.id} style={s.row}>
          <Text style={s.name} numberOfLines={1}>{r.name}{r.pr ? '  🏆' : ''}{r.feel ? <Text style={s.meta}>{`  · ${FEEL_LABEL[r.feel]}`}</Text> : null}</Text>
          <Text style={s.meta}>{r.setsTxt}{r.prev ? '' : '  · first time'}</Text>
          {r.prev ? (
            <Text style={s.meta}>
              {r.deltas.map((d, i) => <Text key={i} style={{ color: d.up == null ? c.textSub : d.up ? UP : DOWN, fontWeight: '600' }}>{i ? ' · ' : ''}{d.txt}</Text>)}
              <Text>{`  (vs ${fmtDay(r.prev.date)})`}</Text>
            </Text>
          ) : null}
        </View>
      ))}
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  box:  { paddingVertical: 4, marginBottom: 6 },
  head: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 2 },
  row:  { paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border, marginTop: 4 },
  name: { color: c.text, fontSize: 14, fontWeight: '600' },
  meta: { color: c.textSub, fontSize: 12.5, fontWeight: '400' },
});
