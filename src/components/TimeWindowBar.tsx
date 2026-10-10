/**
 * The shared time-window bar of the history screens (same periods + ◀ ▶ paging as Statistics): 1M · 3M · 6M · 1Y ·
 * 5Y · All, and for a fixed span a "Oct 2025 – Oct 2026" line with ◀ (older) / ▶ (newer). Render it OUTSIDE the
 * ScrollView so the period stays on screen while scrolling.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useThemedStyles, Palette } from '../theme';

export type WinRange = '1M' | '3M' | '6M' | '1Y' | '5Y' | 'All';
export const WIN_RANGES: WinRange[] = ['1M', '3M', '6M', '1Y', '5Y', 'All'];
export const WIN_DAYS: Record<WinRange, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825, All: 0 };

/** Window state: range + paging offset → [t0, t1]. `dataStart` = the oldest data point (for "All"). */
export function useTimeWindow(initial: WinRange, dataStart: number | null, end = Date.now()) {
  const [range, setRangeS] = useState<WinRange>(initial);
  const [offset, setOffset] = useState(0);
  const setRange = (r: WinRange) => { setRangeS(r); setOffset(0); };
  const days = WIN_DAYS[range];
  const span = days ? days * 86_400_000 : Math.max(86_400_000, end - (dataStart ?? end - 30 * 86_400_000));
  const t1 = days ? end - offset * span : end;
  const t0 = t1 - span;
  return { range, setRange, offset, setOffset, t0, t1, days };
}

const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const dayMonth = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function TimeWindowBar({ w, right }: { w: ReturnType<typeof useTimeWindow>; right?: React.ReactNode }) {
  const s = useThemedStyles(makeS);
  const fmt = w.days && w.days <= 90 ? dayMonth : monthYear;
  return (
    <View style={s.wrap}>
      <View style={s.ctrlRow}>
        {WIN_RANGES.map(r => (
          <TouchableOpacity key={r} onPress={() => w.setRange(r)} style={[s.tab, w.range === r && s.tabOn]}>
            <Text style={[s.tabTxt, w.range === r && s.tabTxtOn]}>{r}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {w.days > 0 && (
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => w.setOffset(o => o + 1)}><Text style={s.navTxt}>◀</Text></TouchableOpacity>
          <Text style={s.navLabel}>{fmt(w.t0)} – {fmt(w.t1)}</Text>
          <TouchableOpacity style={[s.navBtn, w.offset === 0 && { opacity: 0.4 }]} disabled={w.offset === 0} onPress={() => w.setOffset(o => Math.max(0, o - 1))}><Text style={s.navTxt}>▶</Text></TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  wrap:     { backgroundColor: c.bg, paddingTop: 8 },
  ctrlRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  tab:      { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:   { color: c.textSub, fontSize: 14, fontWeight: '700' },
  tabTxtOn: { color: c.onAccent },
  navRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 8 },
  navBtn:   { paddingVertical: 4, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  navTxt:   { color: c.text, fontSize: 17, fontWeight: '800' },
  navLabel: { color: c.textSub, fontSize: 12.5, fontWeight: '600' },
});
