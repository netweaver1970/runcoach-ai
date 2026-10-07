import React from 'react';
import { View, Text, useWindowDimensions } from 'react-native';
import Svg, { Ellipse, Rect, Circle, Path, G } from 'react-native-svg';
import { useTheme } from '../theme';
import { Muscle, MuscleFresh, FRESH_COLOR, MUSCLE_LABEL } from '../services/strength';

// Stylised front + back body map (Bevel-style Muscle Map): every muscle region is tinted by its freshness band.
// Drawn from simple shapes in a 120×250 box per figure. Tap a region → onSelect(muscle).
type Shape =
  | { m: Muscle; t: 'e'; cx: number; cy: number; rx: number; ry: number; rot?: number }
  | { m: Muscle; t: 'r'; x: number; y: number; w: number; h: number; r?: number }
  | { m: Muscle; t: 'p'; d: string };

const mirror = (s: Shape): Shape => (s.t === 'e' ? { ...s, cx: 120 - s.cx, rot: s.rot ? -s.rot : undefined } : s);
const pair = (s: Shape): Shape[] => [s, mirror(s)];

const FRONT: Shape[] = [
  ...pair({ m: 'calves', t: 'e', cx: 49, cy: 214, rx: 6.5, ry: 19 }),
  ...pair({ m: 'quads', t: 'e', cx: 47, cy: 162, rx: 8.5, ry: 27, rot: 4 }),
  ...pair({ m: 'adductors', t: 'e', cx: 56.5, cy: 152, rx: 3, ry: 14 }),
  { m: 'abs', t: 'r', x: 49, y: 84, w: 22, h: 40, r: 7 },
  ...pair({ m: 'chest', t: 'e', cx: 49.5, cy: 70, rx: 11.5, ry: 8.5 }),
  ...pair({ m: 'side_delts', t: 'e', cx: 29, cy: 63, rx: 5, ry: 9, rot: 12 }),
  ...pair({ m: 'front_delts', t: 'e', cx: 35.5, cy: 59, rx: 7.5, ry: 7.5 }),
  ...pair({ m: 'biceps', t: 'e', cx: 28, cy: 86, rx: 5.5, ry: 12.5, rot: 8 }),
  ...pair({ m: 'forearms', t: 'e', cx: 23, cy: 114, rx: 5, ry: 13, rot: 10 }),
];
const BACK: Shape[] = [
  ...pair({ m: 'calves', t: 'e', cx: 49, cy: 210, rx: 7.5, ry: 20 }),
  ...pair({ m: 'hamstrings', t: 'e', cx: 49, cy: 165, rx: 8.5, ry: 23, rot: 3 }),
  ...pair({ m: 'glutes', t: 'e', cx: 51, cy: 133, rx: 10.5, ry: 10 }),
  { m: 'lower_back', t: 'r', x: 51, y: 104, w: 18, h: 18, r: 5 },
  ...pair({ m: 'lats', t: 'e', cx: 45, cy: 92, rx: 8, ry: 15, rot: -14 }),
  { m: 'upper_back', t: 'r', x: 46, y: 64, w: 28, h: 22, r: 8 },
  { m: 'traps', t: 'p', d: 'M60 40 L42 54 L50 60 L60 56 L70 60 L78 54 Z' },
  ...pair({ m: 'rear_delts', t: 'e', cx: 34.5, cy: 61, rx: 7.5, ry: 7.5 }),
  ...pair({ m: 'triceps', t: 'e', cx: 28, cy: 86, rx: 5.5, ry: 12.5, rot: 8 }),
  ...pair({ m: 'forearms', t: 'e', cx: 23, cy: 114, rx: 5, ry: 13, rot: 10 }),
];

function Figure({ shapes, w, label, color, onSelect, selected, base, selStroke }: {
  shapes: Shape[]; w: number; label: string; color: (m: Muscle) => string; onSelect?: (m: Muscle) => void; selected?: Muscle | null; base: string; selStroke: string;
}) {
  const h = w * (250 / 120);
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={w} height={h} viewBox="0 0 120 250">
        {/* neutral silhouette under the muscles: head, neck, hands, feet, torso/limb fill */}
        <G fill={base}>
          <Circle cx={60} cy={22} r={13} />
          <Rect x={54} y={33} width={12} height={10} rx={3} />
          <Rect x={40} y={50} width={40} height={78} rx={14} />
          <Rect x={39} y={124} width={42} height={18} rx={8} />
          <Ellipse cx={20} cy={134} rx={4.5} ry={6} /><Ellipse cx={100} cy={134} rx={4.5} ry={6} />
          {/* limbs: upper arms, forearms, thighs, shins */}
          <Ellipse cx={28} cy={86} rx={7.5} ry={16} transform="rotate(8 28 86)" /><Ellipse cx={92} cy={86} rx={7.5} ry={16} transform="rotate(-8 92 86)" />
          <Ellipse cx={23} cy={114} rx={6.5} ry={15} transform="rotate(10 23 114)" /><Ellipse cx={97} cy={114} rx={6.5} ry={15} transform="rotate(-10 97 114)" />
          <Ellipse cx={48.5} cy={163} rx={11.5} ry={30} transform="rotate(4 48.5 163)" /><Ellipse cx={71.5} cy={163} rx={11.5} ry={30} transform="rotate(-4 71.5 163)" />
          <Ellipse cx={49} cy={213} rx={8.5} ry={22} /><Ellipse cx={71} cy={213} rx={8.5} ry={22} />
          <Ellipse cx={48} cy={238} rx={6} ry={4} /><Ellipse cx={72} cy={238} rx={6} ry={4} />
        </G>
        {shapes.map((s, i) => {
          const fill = color(s.m);
          const stroke = selected === s.m ? selStroke : 'rgba(0,0,0,0.25)';
          const sw = selected === s.m ? 1.6 : 0.6;
          const press = onSelect ? () => onSelect(s.m) : undefined;
          if (s.t === 'e') return <Ellipse key={i} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} fill={fill} stroke={stroke} strokeWidth={sw} onPress={press}
            transform={s.rot ? `rotate(${s.rot} ${s.cx} ${s.cy})` : undefined} />;
          if (s.t === 'r') return <Rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} fill={fill} stroke={stroke} strokeWidth={sw} onPress={press} />;
          return <Path key={i} d={s.d} fill={fill} stroke={stroke} strokeWidth={sw} onPress={press} />;
        })}
      </Svg>
      <Text style={{ fontSize: 11, fontWeight: '700', color: '#8a8f98', marginTop: 2 }}>{label}</Text>
    </View>
  );
}

export function BodyMap({ fresh, onSelect, selected }: { fresh: Map<Muscle, MuscleFresh>; onSelect?: (m: Muscle) => void; selected?: Muscle | null }) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const w = Math.min(150, (width - 80) / 2);
  const color = (m: Muscle) => {
    const f = fresh.get(m);
    const st = f?.state ?? 'Calibrating';
    // calibrating = neutral grey; otherwise the band colour, deeper the more depleted
    if (st === 'Calibrating') return c.mode === 'dark' ? '#3a3d46' : '#c9ccd3';
    const a = 0.45 + 0.55 * (1 - (f?.pct ?? 100) / 100);
    return FRESH_COLOR[st] + Math.round(a * 255).toString(16).padStart(2, '0');
  };
  const base = c.mode === 'dark' ? '#2a2c33' : '#e2e4ea';
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
      <Figure shapes={FRONT} w={w} label="FRONT" color={color} onSelect={onSelect} selected={selected} base={base} selStroke={c.text} />
      <Figure shapes={BACK} w={w} label="BACK" color={color} onSelect={onSelect} selected={selected} base={base} selStroke={c.text} />
    </View>
  );
}
export { MUSCLE_LABEL };
