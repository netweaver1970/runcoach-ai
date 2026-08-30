import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions, PanResponder, Modal } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { requestPermissions } from '../src/services/healthkit';
import { getBiologyReport, compositionChange, BiologyReport, BioMetric, BioPoint } from '../src/services/biology';
import { ReorderList } from '../src/ReorderList';
import { BioCard, BioCardId, BIO_CARD_TITLES, DEFAULT_BIO_LAYOUT, loadBioLayout, saveBioLayout } from '../src/services/bioLayout';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Range = '1M' | '3M' | '6M' | '1Y' | '5Y' | '10Y';
const RANGES: Range[] = ['1M', '3M', '6M', '1Y', '5Y', '10Y'];
const RANGE_MONTHS: Record<Range, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '5Y': 60, '10Y': 120 };
const CAT_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981', travel: '#3b82f6', holiday: '#f59e0b', other: '#9ca3af' };
const CAT_ICON: Record<string, string> = { medical: '🩺', life: '🎉', travel: '✈️', holiday: '🏖️', other: '📌' };
const SERIES: Record<string, string> = { weight: '#3b82f6', bodyfat: '#f59e0b', lean: '#10b981', bpSys: '#ef4444', bpDia: '#8b5cf6' };

const CH_H = 128, PAD_L = 34, PAD_R = 10, PAD_T = 8, PAD_B = 16;
const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const labelAt = (t: number, months: number) => months > 12
  ? new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// One chart. Cursor is CONTROLLED by the parent (cursorTime) so all charts move together; dragging any
// chart reports the time back via onCursor. Metric lines are bold; CTL is the dashed overlay; events show
// as icons (point) or shaded zones (range).
function BioChart({ lines, t0, t1, ctl, events, innerW, c, months, styles, cursorTime, onCursor }: {
  lines: { key: string; label: string; points: BioPoint[] }[];
  t0: number; t1: number; ctl: BioPoint[];
  events: { date: string; endDate?: string; label: string; category: string }[];
  innerW: number; c: Palette; months: number; styles: any;
  cursorTime: number | null; onCursor: (t: number | null) => void;
}) {
  const plotW = Math.max(1, innerW - PAD_L - PAD_R);
  const plotH = CH_H - PAD_T - PAD_B;
  const span = Math.max(1, t1 - t0);
  // Map a plot-relative touch x → time. Held in a ref RE-ASSIGNED every render so the once-created
  // PanResponder always uses the CURRENT window (fixes the cursor drifting / not reaching the left after nav).
  const mapRef = useRef<(x: number) => number>(() => t0);
  mapRef.current = (x: number) => t0 + ((Math.max(PAD_L, Math.min(PAD_L + plotW, x)) - PAD_L) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
    // Use the touch x RELATIVE to the plot view (locationX) — no window-measure offset, so the whole width
    // (incl. the first half) is reachable.
    onPanResponderGrant: (evt) => onCursor(mapRef.current(evt.nativeEvent.locationX)),
    onPanResponderMove: (evt) => onCursor(mapRef.current(evt.nativeEvent.locationX)),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const tOf = (iso: string) => new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime();
  const inRange = (iso: string) => tOf(iso) >= t0 && tOf(iso) <= t1;
  const xOf = (iso: string) => PAD_L + Math.max(0, Math.min(1, (tOf(iso) - t0) / span)) * plotW;

  const vals = lines.flatMap(l => l.points.filter(p => inRange(p.date)).map(p => p.value)).filter(Number.isFinite);
  if (vals.length < 2) return <View style={{ height: CH_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint }}>Not enough data in this range.</Text></View>;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * plotH;

  const cInR = ctl.filter(p => inRange(p.date));
  const cv = cInR.map(p => p.value).filter(Number.isFinite);
  const cLo = cv.length ? Math.min(...cv) : 0, cHi = cv.length ? Math.max(...cv) : 1;
  const yCtl = (v: number) => PAD_T + (1 - (v - cLo) / Math.max(1, cHi - cLo)) * plotH;
  const ctlPts = cInR.map(p => `${xOf(p.date).toFixed(1)},${yCtl(p.value).toFixed(1)}`).join(' ');

  const yearly = months > 12;
  const bands: { x: number; w: number }[] = [];
  { const d = new Date(t0); if (yearly) d.setMonth(0, 1); else d.setDate(1); d.setHours(0, 0, 0, 0); let i = 0;
    while (d.getTime() <= t1) { const s = Math.max(t0, d.getTime()); const n = new Date(d); if (yearly) n.setFullYear(n.getFullYear() + 1); else n.setMonth(n.getMonth() + 1); const e = Math.min(t1, n.getTime());
      if (i % 2 === 0) bands.push({ x: PAD_L + ((s - t0) / span) * plotW, w: ((e - s) / span) * plotW });
      if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); i++; } }
  const bandFill = c.mode === 'dark' ? '#fff' : '#000';
  const yTicks = [yLo + (yHi - yLo) * 0.12, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.12];
  const nLab = 4;

  // Cursor (controlled): default to latest (right edge) so the readout is never empty.
  const scrubbing = cursorTime != null;
  const cT = scrubbing ? Math.max(t0, Math.min(t1, cursorTime!)) : t1;
  const cx = PAD_L + ((cT - t0) / span) * plotW;
  const nearestOf = (pts: BioPoint[]) => { let best: BioPoint | null = null, bd = Infinity; for (const p of pts) { if (!inRange(p.date)) continue; const d = Math.abs(tOf(p.date) - cT); if (d < bd) { bd = d; best = p; } } return best; };
  const evInR = events.filter(e => tOf(e.date) <= t1 && tOf(e.endDate ?? e.date) >= t0);
  const nearEv = evInR.map(e => { const xs = xOf(e.date), xe = e.endDate ? xOf(e.endDate) : xs; const loX = Math.min(xs, xe), hiX = Math.max(xs, xe); const dx = cx >= loX - 2 && cx <= hiX + 2 ? 0 : Math.min(Math.abs(cx - xs), Math.abs(cx - xe)); return { e, dx }; }).sort((a, b) => a.dx - b.dx)[0];
  const showEvent = nearEv && nearEv.dx < 16 ? nearEv.e : null;
  const sameEv = (a: { date: string; label: string }, b: { date: string; label: string }) => a.date === b.date && a.label === b.label;
  const readVals = lines.map(l => ({ key: l.key, label: l.label, p: nearestOf(l.points) }));

  return (
    <View>
      {/* Per-graph cursor VALUES (kept — each graph shows its own metric; not duplicated). Event is NOT here
          (it's shown once under the nav bar) so this row never changes height → no jump. */}
      <View style={styles.readout}>
        <Text style={styles.readDate}>{labelAt(cT, months)}</Text>
        {readVals.map(r => <Text key={r.key} style={[styles.readVal, { color: SERIES[r.key] }]}>{r.label} {r.p ? r.p.value : '—'}</Text>)}
      </View>
      <View {...pan.panHandlers}>
        <Svg width={innerW} height={CH_H}>
          {bands.map((b, i) => <Rect key={`b${i}`} x={b.x} y={PAD_T} width={b.w} height={plotH} fill={bandFill} opacity={0.04} />)}
          {yTicks.map((v, i) => <React.Fragment key={`y${i}`}>
            <Line x1={PAD_L} y1={yOf(v)} x2={PAD_L + plotW} y2={yOf(v)} stroke={c.gridline} strokeWidth={0.5} />
            <SvgText x={PAD_L - 4} y={yOf(v) + 3} fontSize={9} fill={c.textSub} fontWeight="600" textAnchor="end">{Math.round(v * 10) / 10}</SvgText>
          </React.Fragment>)}
          {evInR.map((e, i) => {
            const on = !!showEvent && sameEv(e, showEvent);
            const col = CAT_COLOR[e.category] ?? CAT_COLOR.other;
            const icon = CAT_ICON[e.category] ?? CAT_ICON.other;
            const xs = xOf(e.date);
            if (e.endDate && e.endDate !== e.date) {
              const xe = xOf(e.endDate); const x = Math.min(xs, xe); const w = Math.max(1, Math.abs(xe - xs));
              return <React.Fragment key={`e${i}`}>
                <Rect x={x} y={PAD_T} width={w} height={plotH} fill={col} opacity={on ? 0.16 : 0.09} />
                <Line x1={x} y1={PAD_T} x2={x} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 1.5 : 1} opacity={on ? 0.9 : 0.5} />
                <Line x1={x + w} y1={PAD_T} x2={x + w} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 1.5 : 1} opacity={on ? 0.9 : 0.5} />
                <SvgText x={Math.max(PAD_L + 6, Math.min(PAD_L + plotW - 6, x + w / 2))} y={PAD_T + 8} fontSize={10} textAnchor="middle">{icon}</SvgText>
              </React.Fragment>;
            }
            return <React.Fragment key={`e${i}`}>
              <Line x1={xs} y1={PAD_T + 5} x2={xs} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 2 : 1} strokeDasharray={on ? undefined : '2,3'} opacity={on ? 0.95 : 0.55} />
              <SvgText x={Math.max(PAD_L + 5, Math.min(PAD_L + plotW - 5, xs))} y={PAD_T + 2} fontSize={10} textAnchor="middle">{icon}</SvgText>
            </React.Fragment>;
          })}
          {ctlPts && <Polyline points={ctlPts} fill="none" stroke={c.textSub} strokeWidth={1.8} opacity={0.8} strokeDasharray="6,3" />}
          {lines.map(l => {
            const pts = l.points.filter(p => inRange(p.date));
            const poly = pts.map(p => `${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ');
            return <React.Fragment key={l.key}>
              {pts.length > 1 && <Polyline points={poly} fill="none" stroke={SERIES[l.key]} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />}
              {pts.map((p, i) => <Circle key={i} cx={xOf(p.date)} cy={yOf(p.value)} r={pts.length > 60 ? 1.6 : 2.4} fill={SERIES[l.key]} />)}
            </React.Fragment>;
          })}
          <Line x1={cx} y1={PAD_T} x2={cx} y2={PAD_T + plotH} stroke={c.textSub} strokeWidth={1} opacity={scrubbing ? 0.85 : 0.3} />
          {readVals.map(r => r.p && inRange(r.p.date) ? <Circle key={`c${r.key}`} cx={xOf(r.p.date)} cy={yOf(r.p.value)} r={4.5} fill={SERIES[r.key]} stroke={c.surface} strokeWidth={1.5} /> : null)}
          {Array.from({ length: nLab }, (_, k) => t0 + (span * k) / (nLab - 1)).map((t, i) =>
            <SvgText key={`x${i}`} x={PAD_L + (i / (nLab - 1)) * plotW} y={CH_H - 5} fontSize={9} fill={c.textSub} fontWeight="600" textAnchor="middle">{labelAt(t, months)}</SvgText>)}
        </Svg>
      </View>
    </View>
  );
}

export default function BiologyMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const innerW = width - 32 - 24;
  const [range, setRange] = useState<Range>('6M');
  const [offset, setOffset] = useState(0);            // periods shifted back (0 = current)
  const [cursorTime, setCursorTime] = useState<number | null>(null);   // coupled cursor across all charts
  const [showEvents, setShowEvents] = useState(false);                 // default OFF; toggle 👁 to overlay events
  const [rep, setRep] = useState<BiologyReport | null>(null);
  const [loading, setLoading] = useState(true);
  // Customise sheet: which cards show, in what order (persisted). Reorder is drag-based (shared ReorderList).
  const [layout, setLayout] = useState<BioCard[]>(DEFAULT_BIO_LAYOUT);
  const [customising, setCustomising] = useState(false);
  useEffect(() => { loadBioLayout().then(setLayout); }, []);
  const commitLayout = useCallback((next: BioCard[]) => { setLayout(next); saveBioLayout(next); }, []);

  const months = RANGE_MONTHS[range];
  const spanMs = months * 30 * 86_400_000;
  const t1 = Date.now() - offset * spanMs;
  const t0 = t1 - spanMs;

  useEffect(() => { requestPermissions().catch(() => {}); }, []);
  useEffect(() => { setCursorTime(null); }, [range, offset]);
  // Load the FULL history once (metrics ~40y, fitness/CTL ~10y). range + offset are then a pure VIEWPORT
  // into the loaded data — so scrolling to any period (incl. >10 years back) shows its data instantly, no
  // per-step re-fetch. The report is queried live from HealthKit; there's no on-disk cache, so a Refresh
  // simply re-runs this (picks up readings you've since deleted/edited in Health).
  const load = useCallback((force = false) => {
    let alive = true; setLoading(true);
    getBiologyReport({ force })   // shared source (same report feeds the backup export); force = bypass memo
      .then(r => { if (alive) { setRep(r); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => load(), [load]);

  const byKey = (k: string): BioMetric | undefined => rep?.metrics.find(m => m.key === k);
  // One metric-chart card (returns null when no data in the loaded history, so the card just hides).
  const renderChartCard = (id: BioCardId, keys: string[]): React.ReactNode => {
    if (!keys.some(k => (byKey(k)?.points.length ?? 0) > 0)) return null;
    const metrics = keys.map(byKey).filter(Boolean) as BioMetric[];
    const lines = metrics.filter(m => m.points.length > 0).map(m => ({ key: m.key, label: m.label, points: m.points }));
    return (
      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>{BIO_CARD_TITLES[id]}</Text>
          {metrics.map(m => m.latest != null && (
            <Text key={m.key} style={[s.latest, { color: SERIES[m.key] }]}>{m.latest}{m.unit === '%' ? '%' : ` ${m.unit}`}</Text>
          ))}
        </View>
        <BioChart lines={lines} t0={t0} t1={t1} ctl={rep!.ctl} events={showEvents ? rep!.events : []} innerW={innerW} c={c} months={months} styles={s} cursorTime={cursorTime} onCursor={setCursorTime} />
      </View>
    );
  };
  const comp = rep && rep.hasAnyData ? compositionChange(byKey('weight')?.points ?? [], byKey('bodyfat')?.points ?? [], t0, t1) : null;
  const compShow = comp && (Math.abs(comp.dFat) + Math.abs(comp.dLean)) >= 0.3;   // only when there's a real move
  const compFatW = comp ? Math.abs(comp.dFat) : 1;    // true magnitudes → bar matches the numbers (no floor)
  const compLeanW = comp ? Math.abs(comp.dLean) : 1;
  const leanShare = comp && (Math.abs(comp.dFat) + Math.abs(comp.dLean)) > 0 ? Math.abs(comp.dLean) / (Math.abs(comp.dFat) + Math.abs(comp.dLean)) : 0;
  const sgn = (n: number) => (n > 0 ? '+' : '') + n;

  // Each card keyed by id → rendered in the user's chosen order/enabled set (Customise sheet). Null = no data.
  const cardNodes: Record<BioCardId, React.ReactNode> = {
    weight:  renderChartCard('weight', ['weight']),
    bodyfat: renderChartCard('bodyfat', ['bodyfat']),
    lean:    renderChartCard('lean', ['lean']),
    bp:      renderChartCard('bp', ['bpSys', 'bpDia']),
    composition: (compShow && comp) ? (
      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>Fat vs lean change</Text>
          <Text style={[s.latest, { color: comp.dW <= 0 ? SERIES.lean : c.textSub }]}>{sgn(comp.dW)} kg</Text>
        </View>
        <Text style={s.compSub}>{monthYear(comp.fromT)} → {monthYear(comp.toT)} · of your {sgn(comp.dW)} kg: <Text style={{ color: SERIES.bodyfat, fontWeight: '700' }}>fat {sgn(comp.dFat)} kg</Text>, <Text style={{ color: SERIES.lean, fontWeight: '700' }}>lean {sgn(comp.dLean)} kg</Text></Text>
        <View style={s.compRow}>
          <View style={s.compBar}>
            <View style={{ flex: compFatW, backgroundColor: SERIES.bodyfat }} />
            <View style={{ flex: compLeanW, backgroundColor: SERIES.lean }} />
          </View>
        </View>
        {comp.dW < -0.3 && comp.dLean < -0.2 && leanShare > 0.25 && (
          <Text style={s.compWarn}>⚠ {Math.round(leanShare * 100)}% of the loss is lean mass — protect it with protein (~1.6 g/kg) + resistance work.</Text>
        )}
        {comp.dW < -0.3 && !(comp.dLean < -0.2 && leanShare > 0.25) && (
          <Text style={[s.compSub, { color: SERIES.lean }]}>Good — the loss is mostly fat, lean largely preserved.</Text>
        )}
        {comp.dW >= -0.3 && comp.dFat < -0.2 && comp.dLean > 0.2 && (
          <Text style={[s.compSub, { color: SERIES.lean }]}>Recomposition — fat down, lean up. Ideal.</Text>
        )}
      </View>
    ) : null,
  };

  // ONE shared EVENT row (rendered once under the nav bar). Event titles were repeating on every graph
  // (1↔2 lines each) → the whole screen jumped; here the event shows a single time. The per-graph cursor
  // VALUES stay on their own charts (each is a different metric — valuable, not duplicated).
  const rtOf = (iso: string) => new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime();
  const cT = cursorTime != null ? Math.max(t0, Math.min(t1, cursorTime)) : t1;
  const rPlotW = Math.max(1, innerW - 34 - 10);
  const evList = showEvents && rep ? rep.events.filter(e => rtOf(e.date) <= t1 && rtOf(e.endDate ?? e.date) >= t0) : [];
  let nearE: (typeof evList)[number] | null = null, nd = Infinity;
  for (const e of evList) { const es = rtOf(e.date), en = rtOf(e.endDate ?? e.date); const within = cT >= Math.min(es, en) && cT <= Math.max(es, en); const d = within ? 0 : Math.min(Math.abs(cT - es), Math.abs(cT - en)); if (d < nd) { nd = d; nearE = e; } }
  const readEvent = nearE && nd <= (t1 - t0) * (18 / rPlotW) ? nearE : null;
  const evDate = readEvent ? (readEvent.endDate && readEvent.endDate !== readEvent.date
    ? `${monthYear(rtOf(readEvent.date))} – ${monthYear(rtOf(readEvent.endDate))}`
    : labelAt(rtOf(readEvent.date), months)) : '';

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Sticky header — the ONLY header (native one hidden to avoid duplicate title/back) */}
      <View style={[s.header, { paddingTop: insets.top + 4 }]}>
        <View style={s.headerTop}>
          <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠</Text></TouchableOpacity>
          <Text style={s.hTitle}>Biology</Text>
          <View style={{ flex: 1 }} />
          {loading && <ActivityIndicator size="small" color={c.accent} style={{ marginRight: 8 }} />}
          <TouchableOpacity style={s.eyeBtn} onPress={() => setCustomising(true)}>
            <Text style={s.eyeTxt}>⚙︎</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.eyeBtn} onPress={() => router.push('/data-chat?mode=biology' as any)}>
            <Text style={s.eyeTxt}>💬</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.eyeBtn} onPress={() => router.push('/labs' as any)}>
            <Text style={s.eyeTxt}>Labs</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.eyeBtn} disabled={loading} onPress={() => load(true)}>
            <Text style={[s.eyeTxt, loading && s.eyeTxtOff]}>↻</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.eyeBtn, !showEvents && s.eyeBtnOff]} onPress={() => setShowEvents(v => !v)}>
            <Text style={[s.eyeTxt, !showEvents && s.eyeTxtOff]}>{showEvents ? '👁' : '🚫'}</Text>
          </TouchableOpacity>
        </View>
        <View style={s.tabs}>{RANGES.map(r => (
          <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>
        ))}</View>
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => setOffset(o => o + 1)}><Text style={s.navTxt}>◀ Prev</Text></TouchableOpacity>
          <Text style={s.navLabel}>{monthYear(t0)} – {monthYear(t1)}</Text>
          <TouchableOpacity style={[s.navBtn, offset === 0 && s.navBtnOff]} disabled={offset === 0} onPress={() => setOffset(o => Math.max(0, o - 1))}><Text style={[s.navTxt, offset === 0 && s.navTxtOff]}>Next ▶</Text></TouchableOpacity>
        </View>
        {rep && rep.hasAnyData && showEvents && (
          <View style={s.eventBar}>
            {readEvent
              ? <Text numberOfLines={1} style={[s.eventTxt, { color: CAT_COLOR[readEvent.category] ?? CAT_COLOR.other }]}>
                  {CAT_ICON[readEvent.category] ?? '📌'} {readEvent.label}<Text style={s.eventDate}>  ·  {evDate}</Text>
                </Text>
              : <Text numberOfLines={1} style={s.eventHint}>Scrub any chart — events appear here</Text>}
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 48 }}>
        {loading && <View style={s.loadCard}><ActivityIndicator color={c.accent} /><Text style={s.loadCardTxt}>Loading your full history from Apple Health…</Text></View>}

        {!loading && rep && !rep.hasAnyData && (
          <View style={s.card}><Text style={s.cardTitle}>No body data yet</Text>
            <Text style={s.li}>Nothing in Apple Health for weight, body fat, lean mass or blood pressure in this range. Connect a smart scale / BP cuff (or log manually), grant access when prompted, then come back.</Text>
          </View>
        )}

        {!loading && rep && rep.hasAnyData &&
          layout.filter(l => l.on).map(l => <React.Fragment key={l.id}>{cardNodes[l.id]}</React.Fragment>)}
      </ScrollView>

      {/* Customise sheet — toggle + reorder cards (persisted) */}
      <Modal visible={customising} animationType="slide" transparent onRequestClose={() => setCustomising(false)}>
        <View style={s.sheetBackdrop}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Customise cards</Text>
              <TouchableOpacity onPress={() => setCustomising(false)}><Text style={s.sheetDone}>Done</Text></TouchableOpacity>
            </View>
            <Text style={s.sheetHint}>Drag ≡ to reorder · switch to show or hide</Text>
            <ReorderList items={layout} titleOf={(id) => BIO_CARD_TITLES[id as BioCardId]} onCommit={commitLayout} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  header:    { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, minHeight: 52, backgroundColor: c.bg, borderBottomWidth: 1, borderColor: c.border },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  homeBtn:   { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 20 },
  hTitle:    { color: c.text, fontSize: 18, fontWeight: '800' },
  tabs:      { flexDirection: 'row', gap: 6, marginBottom: 8 },
  tab:       { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:     { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:    { color: c.textSub, fontWeight: '600', fontSize: 13 },
  tabTxtOn:  { color: c.onAccent },
  navRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBtn:    { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  navBtnOff: { opacity: 0.4 },
  navTxt:    { color: c.text, fontWeight: '700', fontSize: 15 },
  navTxtOff: { color: c.textFaint },
  navLabel:  { color: c.textSub, fontSize: 12, fontWeight: '600' },
  card:      { backgroundColor: c.surface, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  cardHead:  { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  latest:    { fontSize: 15, fontWeight: '800', marginLeft: 8 },
  li:        { color: c.textSub, fontSize: 13, lineHeight: 20 },
  readout:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 4, minHeight: 18 },  // per-graph values (fixed content → no jump)
  readDate:  { color: c.text, fontSize: 12, fontWeight: '700' },
  readVal:   { fontSize: 12, fontWeight: '700' },
  eventBar:  { height: 22, marginTop: 8, justifyContent: 'center' },   // ONE event row, fixed height → no jump
  eventTxt:  { fontSize: 12, fontWeight: '700' },
  eventDate: { color: c.textFaint, fontSize: 12, fontWeight: '600' },
  eventHint: { color: c.textFaint, fontSize: 11, fontStyle: 'italic' },
  loadPill:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  loadTxt:   { color: c.textSub, fontSize: 12, fontWeight: '600' },
  loadCard:  { backgroundColor: c.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: c.border, alignItems: 'center', gap: 10, marginTop: 8 },
  loadCardTxt: { color: c.textSub, fontSize: 13, textAlign: 'center' },
  eyeBtn:    { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  eyeBtnOff: { borderColor: c.accent },
  eyeTxt:    { color: c.text, fontSize: 18, fontWeight: '600' },
  eyeTxtOff: { color: c.accent },
  compRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  compBar:   { flex: 1, height: 16, borderRadius: 5, overflow: 'hidden', flexDirection: 'row', backgroundColor: c.surfaceAlt },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 34, maxHeight: '92%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: c.text },
  sheetDone: { fontSize: 16, fontWeight: '700', color: c.accent },
  sheetHint: { fontSize: 12, color: c.textSub, marginBottom: 10 },
  compSub:   { color: c.textSub, fontSize: 12, lineHeight: 18, marginTop: 8 },
  compWarn:  { color: '#f59e0b', fontSize: 12, lineHeight: 18, marginTop: 6, fontWeight: '600' },
});
