import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme, useThemedStyles, Palette } from '../theme';
import type { Nutr } from '../services/foodLog';

/**
 * Nutrition visuals (Geert 2026-10-09): compact macro RINGS like the Home sleep / recovery / strain rings, an energy
 * SPLIT bar, and a full BREAKDOWN (per-ingredient contributors). Energy per gram: protein 4, available carbs 4,
 * fat 9, alcohol 7, fibre and resistant starch 2 (EU labelling) — the split is the share of the day's energy.
 */
export const MACRO_COLOR = { prot: '#3B82F6', carb: '#F59E0B', fat: '#EF4444', fib: '#10B981', alc: '#8B5CF6' };

export interface Split { kcal: number; prot: number; carb: number; fat: number; fib: number; alc: number; pctP: number; pctC: number; pctF: number; pctA: number; pctOther: number }
/** Standard drinks (Belgium / EU: 10 g pure alcohol each). */
export const STD_DRINK_G = 10;
/** n = totals with carbs already AVAILABLE (resistant starch out — netNutr / sumNutr). */
export function macroSplit(n: Nutr): Split {
  const prot = n.prot ?? 0, carb = n.carb ?? 0, fat = n.fat ?? 0, fib = (n.fib ?? 0) + (n.rs ?? 0), alc = n.alc ?? 0;
  const eP = prot * 4, eC = carb * 4, eF = fat * 9, eA = alc * 7, eO = fib * 2;
  const tot = eP + eC + eF + eA + eO || 1;
  return { kcal: n.kcal ?? Math.round(tot), prot, carb, fat, fib, alc, pctP: (eP / tot) * 100, pctC: (eC / tot) * 100, pctF: (eF / tot) * 100, pctA: (eA / tot) * 100, pctOther: (eO / tot) * 100 };
}

function Arc({ size, sw, p, color, track }: { size: number; sw: number; p: number; color: string; track: string }) {
  const half = size / 2, r = half - sw / 2, circ = 2 * Math.PI * r, q = Math.min(1, Math.max(0, p));
  return (
    <Svg width={size} height={size}>
      <Circle cx={half} cy={half} r={r} stroke={track} strokeWidth={sw} fill="none" />
      {q > 0 && <Circle cx={half} cy={half} r={r} stroke={color} strokeWidth={sw} fill="none" strokeDasharray={circ} strokeDashoffset={circ * (1 - q)} strokeLinecap="round" transform={`rotate(-90 ${half} ${half})`} />}
    </Svg>
  );
}

/** Four compact rings: calories (vs the energy you burned, when known) and protein / carbs / fat as % of energy. */
export function MacroRings({ n, burnKcal, size = 64 }: { n: Nutr; burnKcal?: number | null; size?: number }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const sp = macroSplit(n);
  const rings = [
    { lbl: 'kcal', val: Math.round(sp.kcal), sub: burnKcal ? `of ${Math.round(burnKcal)}` : 'energy', p: burnKcal ? sp.kcal / burnKcal : 0, col: c.accent },
    { lbl: 'protein', val: `${Math.round(sp.prot)}g`, sub: `${Math.round(sp.pctP)}%`, p: sp.pctP / 100, col: MACRO_COLOR.prot },
    { lbl: 'carbs', val: `${Math.round(sp.carb)}g`, sub: `${Math.round(sp.pctC)}%`, p: sp.pctC / 100, col: MACRO_COLOR.carb },
    { lbl: 'fat', val: `${Math.round(sp.fat)}g`, sub: `${Math.round(sp.pctF)}%`, p: sp.pctF / 100, col: MACRO_COLOR.fat },
  ];
  return (
    <View style={s.rings}>
      {rings.map(r => (
        <View key={r.lbl} style={{ alignItems: 'center' }}>
          <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            <Arc size={size} sw={6} p={r.p} color={r.col} track={c.surfaceAlt} />
            <View style={StyleSheet.absoluteFill}><View style={s.center}><Text style={s.val}>{r.val}</Text><Text style={s.sub}>{r.sub}</Text></View></View>
          </View>
          <Text style={[s.lbl, { color: r.col }]}>{r.lbl}</Text>
        </View>
      ))}
    </View>
  );
}

/** Energy split as one stacked bar (protein / carbs / fat / fibre+alcohol). */
export function SplitBar({ n }: { n: Nutr }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const sp = macroSplit(n);
  const parts = [{ w: sp.pctP, col: MACRO_COLOR.prot }, { w: sp.pctC, col: MACRO_COLOR.carb }, { w: sp.pctF, col: MACRO_COLOR.fat }, { w: sp.pctA, col: MACRO_COLOR.alc }, { w: sp.pctOther, col: MACRO_COLOR.fib }];
  return (
    <View>
      <View style={[s.bar, { backgroundColor: c.surfaceAlt }]}>{parts.map((p, i) => p.w > 0 ? <View key={i} style={{ width: `${p.w}%`, backgroundColor: p.col }} /> : null)}</View>
      <Text style={s.legend}>
        <Text style={{ color: MACRO_COLOR.prot }}>■ protein {Math.round(sp.pctP)}%</Text>  <Text style={{ color: MACRO_COLOR.carb }}>■ carbs {Math.round(sp.pctC)}%</Text>  <Text style={{ color: MACRO_COLOR.fat }}>■ fat {Math.round(sp.pctF)}%</Text>{sp.pctA >= 1 ? <Text style={{ color: MACRO_COLOR.alc }}>  ■ alcohol {Math.round(sp.pctA)}%</Text> : null}{sp.pctOther >= 1 ? <Text style={{ color: MACRO_COLOR.fib }}>  ■ fibre {Math.round(sp.pctOther)}%</Text> : null}
      </Text>
    </View>
  );
}

/** Full breakdown of a set of items (a meal): totals, rings, split, details, and who contributes what. */
export function NutritionBreakdown({ items, total }: { items: { name: string; n: Nutr }[]; total: Nutr }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const sp = macroSplit(total);
  const r1 = (v?: number) => (v == null ? '–' : (Math.round(v * 10) / 10).toString());
  const top = (k: 'prot' | 'carb' | 'fat' | 'kcal' | 'fib') => [...items].filter(i => (i.n[k] ?? 0) > 0).sort((a, b) => (b.n[k] ?? 0) - (a.n[k] ?? 0)).slice(0, 3)
    .map(i => `${i.name.split(',')[0]} ${Math.round(((i.n[k] ?? 0) / ((total[k] ?? 0) || 1)) * 100)}%`).join(' · ');
  const rows: [string, string][] = [
    ['Energy', `${Math.round(sp.kcal)} kcal`], ['Protein', `${r1(total.prot)} g`], ['Carbs (available)', `${r1(total.carb)} g`], ['  of which sugars', `${r1(total.sug)} g`],
    ...((total.rs ?? 0) > 0 ? [['Resistant starch (not in carbs)', `${r1(total.rs)} g`] as [string, string]] : []),
    ['Fat', `${r1(total.fat)} g`], ['  of which saturated', `${r1(total.sat)} g`], ['Fibre', `${r1(total.fib)} g`], ['Salt', `${r1(total.salt)} g`],
    ...((total.alc ?? 0) > 0 ? [['Alcohol', `${r1(total.alc)} g · ${(total.alc! / STD_DRINK_G).toFixed(1)} drinks · ${Math.round(total.alc! * 7)} kcal`] as [string, string]] : []),
    ...((total.caf ?? 0) > 0 ? [['Caffeine', `${Math.round(total.caf!)} mg`] as [string, string]] : []),
  ];
  return (
    <View>
      <MacroRings n={total} size={72} />
      <View style={{ marginTop: 12 }}><SplitBar n={total} /></View>
      <View style={{ marginTop: 12 }}>
        {rows.map(([k, v]) => <View key={k} style={s.row}><Text style={s.rowK}>{k}</Text><Text style={s.rowV}>{v}</Text></View>)}
      </View>
      <Text style={[s.lbl, { color: c.textSub, marginTop: 12, textAlign: 'left' }]}>WHERE IT COMES FROM</Text>
      {(['kcal', 'prot', 'carb', 'fat', 'fib'] as const).map(k => {
        const t = top(k);
        return t ? <Text key={k} style={s.contrib}><Text style={{ fontWeight: '700', color: k === 'kcal' ? c.text : (MACRO_COLOR as any)[k] }}>{k === 'kcal' ? 'Energy' : k === 'prot' ? 'Protein' : k === 'carb' ? 'Carbs' : k === 'fat' ? 'Fat' : 'Fibre'}: </Text>{t}</Text> : null;
      })}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  rings:   { flexDirection: 'row', justifyContent: 'space-between' },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  val:     { color: c.text, fontSize: 13.5, fontWeight: '800' },
  sub:     { color: c.textSub, fontSize: 10 },
  lbl:     { fontSize: 11, fontWeight: '700', marginTop: 3, textAlign: 'center', letterSpacing: 0.3 },
  bar:     { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden' },
  legend:  { fontSize: 11.5, marginTop: 5, color: c.textSub },
  row:     { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  rowK:    { flex: 1, color: c.text, fontSize: 13.5 },
  rowV:    { color: c.text, fontSize: 13.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  contrib: { color: c.textSub, fontSize: 12.5, marginTop: 4, lineHeight: 18 },
});
