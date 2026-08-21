import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions, Alert } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText, Circle } from 'react-native-svg';
import { Stack } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { fetchTrainingLoadHistory } from '../src/services/healthkit';
import { callLLMWithImage } from '../src/services/llm';
import { DailyLoad } from '../src/types';
import {
  projectTravelItinerary, ItineraryProjection, TravelProjection, TravelScenario, ctlOn,
  TravelLeg, Climate, CLIMATES, CLIMATE_LABEL, CLIMATE_LOAD_FACTOR, climateForPlace,
  buildFlightExtractionPrompt, parseFlightExtraction,
} from '../src/services/travelProjection';
import { Itinerary, loadItinerary, saveItinerary } from '../src/services/travelStore';

const DAY = 86_400_000;
const dstr = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const fmtShort = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const SC_META: Record<TravelScenario, { label: string; color: string; sub: string }> = {
  continue: { label: 'Train through', color: '#2e9e5b', sub: 'full load, as if home' },
  maintain: { label: 'Maintain',      color: '#2f6fed', sub: '~3 short easy runs/wk' },
  rest:     { label: 'Mostly rest',   color: '#8a8f98', sub: 'sightseeing / NEAT' },
};

export default function TravelProjectionScreen() {
  const s = useThemedStyles(styles);
  const { c } = useTheme();
  const { width } = useWindowDimensions();

  const [hist, setHist]       = useState<DailyLoad[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);
  const [it, setIt]           = useState<Itinerary | null>(null);
  const [importing, setImporting] = useState(false);
  const saveTimer = useRef<any>(null);

  useEffect(() => {
    (async () => {
      try {
        const [h, i] = await Promise.all([fetchTrainingLoadHistory(4), loadItinerary()]);
        setHist(h); setIt(i);
      } catch (e: any) { setErr(e?.message ?? 'Could not load training history.'); }
      finally { setLoading(false); }
    })();
  }, []);

  // Update itinerary + debounce-persist.
  const update = useCallback((next: Itinerary) => {
    setIt(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveItinerary(next), 400);
  }, []);

  const setStart = (delta: number) => it && update({ ...it, startInDays: Math.max(1, Math.min(180, it.startInDays + delta)) });
  const patchLeg = (id: string, p: Partial<TravelLeg>) => it && update({ ...it, legs: it.legs.map(l => l.id === id ? { ...l, ...p } : l) });
  const cycleClimate = (id: string, cur: Climate) => patchLeg(id, { climate: CLIMATES[(CLIMATES.indexOf(cur) + 1) % CLIMATES.length] });
  const addLeg = () => it && update({ ...it, legs: [...it.legs, { id: `l${Date.now()}`, place: '', days: 5, climate: 'warm' }] });
  const removeLeg = (id: string) => it && it.legs.length > 1 && update({ ...it, legs: it.legs.filter(l => l.id !== id) });

  // Import an itinerary from a flight / booking screenshot via the LLM vision model.
  const importFromScreenshot = async () => {
    if (!it) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Photo access needed', 'Allow photo access in iOS Settings to import a flight screenshot.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 1 });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    if (!asset.base64) { Alert.alert('Could not read image', 'Try another screenshot.'); return; }
    setImporting(true);
    try {
      const todayISO = new Date().toISOString().slice(0, 10);
      const reply = await callLLMWithImage({ prompt: buildFlightExtractionPrompt(todayISO), imageBase64: asset.base64, mediaType: 'image/png', maxTokens: 1024 });
      const parsed = parseFlightExtraction(reply, todayISO);
      if (!parsed || !parsed.legs.length) { Alert.alert('No trip found', "Couldn't read flight dates from that screenshot. Add the legs manually, or try a clearer itinerary shot."); return; }
      update({ startInDays: parsed.startInDays, legs: parsed.legs });
      Alert.alert('Imported ✈️', `${parsed.legs.length} leg${parsed.legs.length > 1 ? 's' : ''} added. Tap a climate to fine-tune the heat penalty.`);
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'The vision model could not read the screenshot. Check your LLM key in Settings.');
    } finally { setImporting(false); }
  };

  const proj: ItineraryProjection | null = useMemo(() => {
    if (!hist?.length || !it) return null;
    const today = new Date(hist[hist.length - 1].date + 'T00:00:00');
    const tripStart = new Date(today.getTime() + it.startInDays * DAY);
    return projectTravelItinerary(hist, tripStart, it.legs, 21);
  }, [hist, it]);

  if (loading) return <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.dim}>Reading your training history…</Text></View>;
  if (err)     return <View style={s.center}><Text style={s.err}>{err}</Text></View>;
  if (!proj || !it) return <View style={s.center}><Text style={s.dim}>Not enough training history yet to project.</Text></View>;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Travel Projection', headerBackTitle: 'Back' }} />

      <Text style={s.lede}>
        Where your fitness (CTL) lands across a trip, under three training scenarios. Each leg's climate
        adds a heat penalty — in the tropics you simply can't train as hard, so the ceiling drops.
      </Text>

      {/* ── Itinerary editor ──────────────────────────────────────── */}
      <View style={s.card}>
        <View style={s.ctrlRow}>
          <Text style={s.ctrlLabel}>Leaves in</Text>
          <View style={s.stepper}>
            <TouchableOpacity style={s.stepBtn} onPress={() => setStart(-7)}><Text style={s.stepTxt}>−1w</Text></TouchableOpacity>
            <TouchableOpacity style={s.stepBtn} onPress={() => setStart(-1)}><Text style={s.stepTxt}>−1d</Text></TouchableOpacity>
            <Text style={s.ctrlVal}>{fmtShort(proj.tripStart)}</Text>
            <TouchableOpacity style={s.stepBtn} onPress={() => setStart(+1)}><Text style={s.stepTxt}>+1d</Text></TouchableOpacity>
            <TouchableOpacity style={s.stepBtn} onPress={() => setStart(+7)}><Text style={s.stepTxt}>+1w</Text></TouchableOpacity>
          </View>
        </View>

        {it.legs.map((lg) => (
            <View key={lg.id} style={s.legRow}>
              <TextInput
                style={s.placeInput}
                value={lg.place}
                placeholder="Place"
                placeholderTextColor={c.textFaint}
                onChangeText={t => patchLeg(lg.id, { place: t })}
                onBlur={() => { if (lg.place.trim()) patchLeg(lg.id, { climate: climateForPlace(lg.place) }); }}
                returnKeyType="done"
              />
              <TouchableOpacity style={[s.climateBadge, { borderColor: CLIMATE_TINT[lg.climate] }]} onPress={() => cycleClimate(lg.id, lg.climate)}>
                <Text style={[s.climateTxt, { color: CLIMATE_TINT[lg.climate] }]}>{CLIMATE_LABEL[lg.climate]}</Text>
              </TouchableOpacity>
              <View style={s.daysBox}>
                <TouchableOpacity onPress={() => patchLeg(lg.id, { days: Math.max(1, lg.days - 1) })}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
                <Text style={s.daysVal}>{lg.days}d</Text>
                <TouchableOpacity onPress={() => patchLeg(lg.id, { days: Math.min(120, lg.days + 1) })}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => removeLeg(lg.id)} hitSlop={8}><Text style={s.remove}>✕</Text></TouchableOpacity>
            </View>
        ))}
        <View style={s.actionRow}>
          <TouchableOpacity style={s.addLeg} onPress={addLeg}><Text style={s.addLegTxt}>+ Add leg</Text></TouchableOpacity>
          <TouchableOpacity style={[s.importBtn, importing && { opacity: 0.5 }]} onPress={importFromScreenshot} disabled={importing}>
            {importing
              ? <ActivityIndicator size="small" color={c.accent} />
              : <Text style={s.importTxt}>📷 Import from screenshot</Text>}
          </TouchableOpacity>
        </View>
        <Text style={s.ctrlNote}>
          Away {fmtShort(proj.tripStart)} → {fmtShort(proj.tripEnd)} · today CTL {proj.today.ctl.toFixed(0)} · sustaining ~{proj.normalDailyLoad} load/day · tap a climate to change it
        </Text>
      </View>

      {/* ── CTL chart ─────────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Fitness (CTL) projection</Text>
        <CtlChart proj={proj} width={width - 64} palette={c} />
        <View style={s.legend}>
          {(['continue', 'maintain', 'rest'] as TravelScenario[]).map(k => (
            <View key={k} style={s.legItem}>
              <View style={[s.legDot, { backgroundColor: SC_META[k].color }]} />
              <Text style={s.legTxt}>{SC_META[k].label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* ── Heat penalty per leg ──────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Heat penalty by leg</Text>
        {proj.legs.map((r, i) => {
          const factor = CLIMATE_LOAD_FACTOR[r.climate];
          const capPct = Math.round(factor * 100);
          return (
            <View key={i} style={s.heatRow}>
              <Text style={s.heatPlace} numberOfLines={1}>{r.place}</Text>
              <Text style={s.heatDates}>{fmtShort(r.from)}–{fmtShort(r.to)}</Text>
              <View style={[s.climateBadge, { borderColor: CLIMATE_TINT[r.climate] }]}>
                <Text style={[s.climateTxt, { color: CLIMATE_TINT[r.climate] }]}>{CLIMATE_LABEL[r.climate]}</Text>
              </View>
              <Text style={[s.heatCap, factor < 0.75 && { color: '#c0392b' }]}>effort ≤ {capPct}%</Text>
            </View>
          );
        })}
        <Text style={s.tblNote}>
          "effort ≤ X%" caps even the "train through" plan — in {CLIMATE_LABEL.tropical.toLowerCase()} heat you can't
          hold normal load, so tropical legs quietly bleed CTL no matter your intent. Early-morning easy runs + hard
          hydration are the play; treat those days as maintenance, not training.
        </Text>
      </View>

      {/* ── Summary table ─────────────────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Where you land</Text>
        <View style={s.tblHead}>
          <Text style={[s.th, { flex: 1.4 }]}>Scenario</Text>
          <Text style={s.th}>Back</Text>
          <Text style={s.th}>+3 wk</Text>
          <Text style={s.th}>vs now</Text>
        </View>
        {(['continue', 'maintain', 'rest'] as TravelScenario[]).map(k => {
          const endCtl  = ctlOn(proj.scenarios[k], proj.tripEnd) ?? proj.today.ctl;
          const horizCtl = ctlOn(proj.scenarios[k], proj.horizonEnd) ?? endCtl;
          const delta = horizCtl - proj.today.ctl;
          return (
            <View key={k} style={s.tblRow}>
              <View style={{ flex: 1.4 }}>
                <View style={s.legItem}>
                  <View style={[s.legDot, { backgroundColor: SC_META[k].color }]} />
                  <Text style={s.tdName}>{SC_META[k].label}</Text>
                </View>
                <Text style={s.tdSub}>{SC_META[k].sub}</Text>
              </View>
              <Text style={s.td}>{endCtl.toFixed(0)}</Text>
              <Text style={s.td}>{horizCtl.toFixed(0)}</Text>
              <Text style={[s.td, { color: delta >= 0 ? '#2e9e5b' : '#c0392b', fontWeight: '700' }]}>{delta >= 0 ? '+' : ''}{delta.toFixed(0)}</Text>
            </View>
          );
        })}
        <Text style={s.tblNote}>
          "Back" = the day you return; "+3 wk" = after fitness rebuilds. Detraining is slow — even mostly
          resting, the loss is small and comes back fast once you resume.
        </Text>
      </View>
    </ScrollView>
  );
}

const CLIMATE_TINT: Record<Climate, string> = {
  cool: '#2f6fed', mild: '#2e9e5b', warm: '#e0a12a', hot: '#e07b2a', tropical: '#c0392b',
};

// ── SVG multi-line CTL chart ───────────────────────────────────────────────
function CtlChart({ proj, width, palette }: { proj: TravelProjection; width: number; palette: any }) {
  const H = 210, padL = 30, padR = 8, padT = 12, padB = 22;
  const plotW = width - padL - padR, plotH = H - padT - padB;

  const series = proj.scenarios;
  const all = [...series.continue, ...series.maintain, ...series.rest];
  if (!all.length) return null;

  const t0 = new Date(proj.today.date + 'T00:00:00').getTime();
  const t1 = new Date(proj.horizonEnd + 'T00:00:00').getTime();
  const span = Math.max(1, t1 - t0);
  const ctls = all.map(d => d.ctl);
  let yMin = Math.min(...ctls), yMax = Math.max(...ctls);
  const padY = Math.max(2, (yMax - yMin) * 0.15); yMin -= padY; yMax += padY;
  if (yMax - yMin < 4) { yMax += 2; yMin -= 2; }

  const X = (iso: string) => padL + ((new Date(iso + 'T00:00:00').getTime() - t0) / span) * plotW;
  const Y = (v: number)   => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const pts = (arr: DailyLoad[]) => arr.map(d => `${X(d.date).toFixed(1)},${Y(d.ctl).toFixed(1)}`).join(' ');

  const tripX0 = X(proj.tripStart), tripX1 = X(proj.tripEnd);
  const yTicks = [yMin + (yMax - yMin) * 0.15, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.15].map(v => Math.round(v));

  return (
    <Svg width={width} height={H}>
      {/* trip window */}
      <Rect x={tripX0} y={padT} width={Math.max(1, tripX1 - tripX0)} height={plotH} fill={palette.accent} opacity={0.08} />
      <SvgText x={(tripX0 + tripX1) / 2} y={padT + 10} fill={palette.textSub} fontSize={9} textAnchor="middle">away</SvgText>
      {/* y grid + labels */}
      {yTicks.map((v, i) => (
        <React.Fragment key={i}>
          <Line x1={padL} y1={Y(v)} x2={width - padR} y2={Y(v)} stroke={palette.gridline} strokeWidth={0.5} />
          <SvgText x={padL - 4} y={Y(v) + 3} fill={palette.textSub} fontSize={9} textAnchor="end">{v}</SvgText>
        </React.Fragment>
      ))}
      {/* scenario lines */}
      <Polyline points={pts(series.rest)}     fill="none" stroke={SC_META.rest.color}     strokeWidth={2} />
      <Polyline points={pts(series.maintain)} fill="none" stroke={SC_META.maintain.color} strokeWidth={2} />
      <Polyline points={pts(series.continue)} fill="none" stroke={SC_META.continue.color} strokeWidth={2.5} />
      {/* today marker */}
      <Circle cx={X(proj.today.date)} cy={Y(proj.today.ctl)} r={3} fill={palette.text} />
      {/* x labels */}
      <SvgText x={padL} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="start">{fmtShort(proj.today.date)}</SvgText>
      <SvgText x={(tripX0 + tripX1) / 2} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="middle">{fmtShort(proj.tripEnd)}</SvgText>
      <SvgText x={width - padR} y={H - 6} fill={palette.textSub} fontSize={9} textAnchor="end">{fmtShort(proj.horizonEnd)}</SvgText>
    </Svg>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: 24, gap: 10 },
  dim:       { color: c.textSub, fontSize: 14, textAlign: 'center' },
  err:       { color: '#c0392b', fontSize: 14, textAlign: 'center' },
  lede:      { color: c.textSub, fontSize: 13, lineHeight: 19, paddingHorizontal: 20, paddingTop: 14 },
  card:      { backgroundColor: c.surface, borderRadius: 16, marginHorizontal: 16, marginTop: 14, padding: 16 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  ctrlRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  ctrlLabel: { color: c.text, fontSize: 14, fontWeight: '600' },
  stepper:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn:   { backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  stepTxt:   { color: c.accent, fontSize: 13, fontWeight: '700' },
  ctrlVal:   { color: c.text, fontSize: 13, fontWeight: '700', minWidth: 58, textAlign: 'center' },
  ctrlNote:  { color: c.textSub, fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  // itinerary editor
  legRow:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  placeInput:  { flex: 1, color: c.text, fontSize: 14, fontWeight: '600', paddingVertical: 4, paddingHorizontal: 8, backgroundColor: c.bg, borderRadius: 8 },
  climateBadge:{ borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  climateTxt:  { fontSize: 11, fontWeight: '700' },
  daysBox:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  daysVal:     { color: c.text, fontSize: 12, fontWeight: '700', minWidth: 26, textAlign: 'center' },
  remove:      { color: c.textFaint, fontSize: 15, fontWeight: '700', paddingHorizontal: 2 },
  actionRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  addLeg:      { paddingVertical: 4 },
  addLegTxt:   { color: c.accent, fontSize: 13, fontWeight: '700' },
  importBtn:   { backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, minHeight: 32, justifyContent: 'center' },
  importTxt:   { color: c.accent, fontSize: 12.5, fontWeight: '700' },
  // heat penalty rows
  heatRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  heatPlace:   { color: c.text, fontSize: 13.5, fontWeight: '600', flex: 1 },
  heatDates:   { color: c.textSub, fontSize: 11 },
  heatCap:     { color: c.textSub, fontSize: 12, fontWeight: '700', minWidth: 78, textAlign: 'right' },
  legend:    { flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 8 },
  legItem:   { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legDot:    { width: 9, height: 9, borderRadius: 5 },
  legTxt:    { color: c.textSub, fontSize: 12 },
  tblHead:   { flexDirection: 'row', paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  th:        { flex: 1, color: c.textSub, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  tblRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  tdName:    { color: c.text, fontSize: 13.5, fontWeight: '600' },
  tdSub:     { color: c.textSub, fontSize: 10.5, marginLeft: 14 },
  td:        { flex: 1, color: c.text, fontSize: 15, textAlign: 'right' },
  tblNote:   { color: c.textSub, fontSize: 11.5, lineHeight: 17, marginTop: 10 },
});
