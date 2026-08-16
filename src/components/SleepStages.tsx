/**
 * Bevel-style "Sleep Stages" card: a hypnogram (stage ribbon over the night) + Awake/REM/Core/Deep
 * ring gauges + "Sleep needed", with a Share button that renders the card to a PNG and opens the iOS
 * share sheet. Fed a single SleepSession (any day) so it works with the day-by-day navigation.
 */
import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import Svg, { Rect, Circle } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import { SleepSession } from '../types';
import { Palette } from '../theme';

// Stage → colour + a "wakefulness height" (awake tallest, deep shortest) so the ribbon steps like Bevel's.
const STAGE = {
  awake: { color: '#e8935e', h: 1.00, label: 'Awake' },
  rem:   { color: '#8b9cf0', h: 0.74, label: 'REM'   },
  core:  { color: '#5a6fd8', h: 0.50, label: 'Core'  },
  deep:  { color: '#3a4bb0', h: 0.26, label: 'Deep'  },
} as const;
type StageKey = keyof typeof STAGE;

function segStage(stage: string): StageKey | null {
  if (stage === 'awake') return 'awake';
  if (stage === 'asleepREM') return 'rem';
  if (stage === 'asleepDeep') return 'deep';
  if (stage === 'asleepCore' || stage === 'asleepUnspecified') return 'core';
  return null; // inBed → not drawn
}

function fmtHMS(min: number): string {
  const a = Math.max(0, Math.round(min));
  const h = Math.floor(a / 60), m = a % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function fmtHm(min: number): string {
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60), m = a % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Ring({ pct, color, track }: { pct: number; color: string; track: string }) {
  const size = 58, sw = 6, r = (size - sw) / 2, c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct / 100)) * c;
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={sw} fill="none" />
      <Circle
        cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={sw} fill="none"
        strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

export function SleepStagesCard({
  session, sleepNeededMin, palette: c,
}: { session: SleepSession; sleepNeededMin: number; palette: Palette }) {
  const shotRef = useRef<ViewShot>(null);
  const s = makeStyles(c);

  const asleep = session.totalMinutes;
  const inBed  = asleep + session.awakeMinutes;
  const pct = (m: number) => (inBed > 0 ? Math.round((m / inBed) * 100) : 0);
  const stageMin: Record<StageKey, number> = {
    awake: session.awakeMinutes, rem: session.remMinutes, core: session.coreMinutes, deep: session.deepMinutes,
  };

  // Hypnogram geometry
  const W = 320, H = 120;
  const segs = session.segments
    .map((seg) => ({ st: segStage(seg.stage), a: new Date(seg.startDate).getTime(), b: new Date(seg.endDate).getTime() }))
    .filter((v) => v.st && v.b > v.a) as { st: StageKey; a: number; b: number }[];
  const t0 = segs.length ? Math.min(...segs.map((v) => v.a)) : new Date(session.bedtime).getTime();
  const t1 = segs.length ? Math.max(...segs.map((v) => v.b)) : new Date(session.wakeTime).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * W;

  const share = async () => {
    try {
      const uri = await shotRef.current?.capture?.();
      // UTI matters on iOS: without it the share sheet treats the capture as an opaque file, which is why
      // several actions (Copy in particular) silently did nothing.
      if (uri && (await Sharing.isAvailableAsync())) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share sleep', UTI: 'public.png' });
      }
    } catch { /* user cancelled or capture failed */ }
  };

  // Explicit copy — the share sheet's own "Copy" acts on a file URL and often no-ops, so put the PNG on the
  // clipboard directly as base64 instead.
  const copy = async () => {
    try {
      const uri = await shotRef.current?.capture?.();
      if (!uri) { Alert.alert('Copy failed', 'Could not capture the card.'); return; }
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      await Clipboard.setImageAsync(b64);
      Alert.alert('Copied', 'Sleep card copied — paste it anywhere.');
    } catch (e: any) {
      Alert.alert('Copy failed', e?.message ?? 'Could not access the clipboard.');
    }
  };

  return (
    <View>
      <ViewShot ref={shotRef} options={{ format: 'png', quality: 1 }} style={s.shot}>
        <View style={s.headRow}>
          <Text style={s.title}>Sleep Stages</Text>
          <Text style={s.dur}>{fmtHMS(asleep)}</Text>
        </View>

        {/* Hypnogram */}
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {segs.map((v, i) => {
            const st = STAGE[v.st];
            const bh = st.h * (H - 8);
            const xa = x(v.a), w = Math.max(0.6, x(v.b) - xa);
            return <Rect key={i} x={xa} y={H - bh} width={w} height={bh} fill={st.color} rx={0.5} />;
          })}
        </Svg>
        <View style={s.timeRow}>
          <Text style={s.timeChip}>🌙 {clock(session.bedtime)}</Text>
          <Text style={s.timeChip}>{clock(session.wakeTime)} ☀️</Text>
        </View>

        {/* Stage rings 2×2 */}
        <View style={s.grid}>
          {(['awake', 'rem', 'core', 'deep'] as StageKey[]).map((k) => (
            <View key={k} style={s.cell}>
              <View style={{ flex: 1 }}>
                <Text style={s.cellLabel}>{STAGE[k].label}</Text>
                <Text style={s.cellVal}>{fmtHMS(stageMin[k])}</Text>
                <Text style={[s.cellPct, { color: STAGE[k].color }]}>{pct(stageMin[k])}%</Text>
              </View>
              <Ring pct={pct(stageMin[k])} color={STAGE[k].color} track={c.border} />
            </View>
          ))}
        </View>

        <View style={s.needRow}>
          <Text style={s.needLabel}>Sleep needed</Text>
          <Text style={s.needVal}>{fmtHm(sleepNeededMin)}</Text>
        </View>
      </ViewShot>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity style={[s.shareBtn, { flex: 1 }]} onPress={share} activeOpacity={0.8}>
          <Text style={s.shareTxt}>📤  Share</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.shareBtn, s.copyBtn]} onPress={copy} activeOpacity={0.8}>
          <Text style={s.shareTxt}>⧉  Copy</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  shot: { backgroundColor: c.surface, borderRadius: 16, padding: 16 },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
  title: { fontSize: 18, fontWeight: '700', color: c.text },
  dur: { fontSize: 18, fontWeight: '700', color: c.text },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, marginBottom: 12 },
  timeChip: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  cell: {
    width: '48%', flexDirection: 'row', alignItems: 'center', backgroundColor: c.bg,
    borderRadius: 12, padding: 12, marginBottom: 10,
  },
  cellLabel: { fontSize: 13, color: c.textSub, fontWeight: '600' },
  cellVal: { fontSize: 20, fontWeight: '700', color: c.text, marginTop: 2 },
  cellPct: { fontSize: 13, fontWeight: '700', marginTop: 1 },
  needRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.bg, borderRadius: 12, padding: 14, marginTop: 2,
  },
  needLabel: { fontSize: 15, fontWeight: '600', color: c.text },
  needVal: { fontSize: 15, fontWeight: '700', color: c.text },
  shareBtn: {
    marginTop: 12, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 22,
    backgroundColor: '#8e44ad', borderRadius: 22,
  },
  copyBtn: { backgroundColor: '#6b7280' },
  shareTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
