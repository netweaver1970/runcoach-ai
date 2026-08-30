import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions, Alert, Keyboard } from 'react-native';
import Svg, { Polyline, Rect, Line, Text as SvgText, Circle } from 'react-native-svg';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Stack, useNavigation } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { fetchTrainingLoadHistory } from '../src/services/healthkit';
import { callLLM, callLLMWithImage } from '../src/services/llm';
import { DailyLoad } from '../src/types';
import {
  projectTravelItinerary, ItineraryProjection, TravelProjection, TravelScenario, ctlOn,
  TravelLeg, Climate, CLIMATES, CLIMATE_LABEL, CLIMATE_LOAD_FACTOR, climateForPlace,
  buildFlightExtractionPrompt, parseFlightExtraction, buildFlightLookupPrompt, parseFlightLookup,
  TransportMode, TRANSPORT_MODES, MODE_META,
} from '../src/services/travelProjection';
import { TravelData, SavedTrip, loadTravelData, saveTravelData, newTrip } from '../src/services/travelStore';
import { lookupFlightReal } from '../src/services/flightLookup';

const dstr = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const fmtShort = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dateOf = (iso: string) => { const d = new Date((iso || '') + 'T00:00:00'); return isNaN(d.getTime()) ? new Date() : d; };
const addDays = (iso: string, n: number) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return dstr(d); };

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
  const [data, setData]       = useState<TravelData | null>(null);
  const [importing, setImporting] = useState(false);
  const [lookingUp, setLookingUp] = useState<string | null>(null);
  const saveTimer = useRef<any>(null);
  const navigation = useNavigation();

  useEffect(() => {
    (async () => {
      try {
        const [h, d] = await Promise.all([fetchTrainingLoadHistory(4), loadTravelData()]);
        setHist(h); setData(d);
      } catch (e: any) { setErr(e?.message ?? 'Could not load training history.'); }
      finally { setLoading(false); }
    })();
  }, []);

  // Dismiss the keyboard before navigating away, so a focused field's keyboard can't linger over the
  // previous screen and freeze the app (same class of bug as the chat + run-notes screens).
  useEffect(() => navigation.addListener('beforeRemove', () => { Keyboard.dismiss(); }), [navigation]);

  const update = useCallback((next: TravelData) => {
    setData(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveTravelData(next), 400);
  }, []);

  const activeOf = (d: TravelData) => d.trips.find(t => t.id === d.activeId) ?? d.trips[0];
  const patchActive = (patch: Partial<SavedTrip>) => { if (!data) return; update({ ...data, trips: data.trips.map(t => t.id === activeOf(data).id ? { ...t, ...patch, updatedAt: dstr(new Date()) } : t) }); };
  const patchLeg = (legId: string, p: Partial<TravelLeg>) => { if (!data) return; const a = activeOf(data); patchActive({ legs: a.legs.map(l => l.id === legId ? { ...l, ...p } : l) }); };
  const cycleClimate = (legId: string, cur: Climate) => patchLeg(legId, { climate: CLIMATES[(CLIMATES.indexOf(cur) + 1) % CLIMATES.length] });
  const addLeg = () => { if (!data) return; const a = activeOf(data); const last = a.legs[a.legs.length - 1]; const arrive = addDays(last?.arrive ?? dstr(new Date()), 3); patchActive({ legs: [...a.legs, { id: `l${Date.now()}`, mode: 'flight', arrive, place: '', climate: 'warm' }] }); };
  const removeLeg = (legId: string) => { if (!data) return; const a = activeOf(data); if (a.legs.length <= 1) return; patchActive({ legs: a.legs.filter(l => l.id !== legId) }); };

  const selectTrip = (id: string) => { if (data) update({ ...data, activeId: id }); };
  const addTrip = () => { if (!data) return; const t = newTrip('New trip'); update({ trips: [...data.trips, t], activeId: t.id }); };
  const deleteTrip = (id: string) => {
    if (!data) return;
    const rest = data.trips.filter(t => t.id !== id);
    const trips = rest.length ? rest : [newTrip('New trip')];
    update({ trips, activeId: trips[0].id });
  };

  // LLM best-guess fallback (used only when the real flight API has no key / no data). Returns true if filled.
  const llmGuessFlight = async (lg: TravelLeg): Promise<boolean> => {
    try {
      const reply = await callLLM({ messages: [{ role: 'user', content: buildFlightLookupPrompt(lg.flightNo!, lg.arrive) }], maxTokens: 200, temperature: 0 });
      const r = parseFlightLookup(reply, lg.arrive);
      if (r) { patchLeg(lg.id, { place: r.place, arrive: r.arrive, climate: r.climate }); return true; }
    } catch { /* fall through */ }
    return false;
  };

  // Resolve a flight number + date via the REAL flight API (AeroDataBox); fall back to the LLM guess when
  // there's no API key configured or the flight isn't in the database.
  const lookupFlight = async (lg: TravelLeg) => {
    if (!lg.flightNo) return;
    setLookingUp(lg.id);
    try {
      const real = await lookupFlightReal(lg.flightNo, lg.arrive);
      if (real.ok) { patchLeg(lg.id, real.result); return; }
      if (real.reason === 'error') { Alert.alert('Flight lookup failed', real.message ?? 'Try again, or type the destination by hand.'); return; }
      // no-key or not-found → try the AI, then guide the user.
      const guessed = await llmGuessFlight(lg);
      if (guessed) {
        if (real.reason === 'no-key') Alert.alert('Filled from AI estimate', 'For exact routing, add a free AeroDataBox (RapidAPI) key in Settings → Flight Lookup. I used the AI\'s best guess for now — check the destination.');
        return;
      }
      Alert.alert(
        real.reason === 'no-key' ? 'Add a flight-lookup key' : 'Flight not found',
        real.reason === 'no-key'
          ? 'Add a free AeroDataBox (RapidAPI) key in Settings → Flight Lookup for automatic routing — or just type the destination and arrival date.'
          : `Couldn't find ${lg.flightNo} on ${fmtShort(lg.arrive)}. Type the destination and arrival date by hand.`,
      );
    } finally { setLookingUp(null); }
  };

  // Import a whole itinerary from a flight / booking screenshot via the LLM vision model.
  const importFromScreenshot = async () => {
    if (!data) return;
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
      if (!parsed || !parsed.legs.length) { Alert.alert('No trip found', "Couldn't read flight dates from that screenshot. Add the stops by hand, or try a clearer itinerary shot."); return; }
      patchActive({ legs: parsed.legs, returnDate: parsed.returnDate });
      Alert.alert('Imported ✈️', `${parsed.legs.length} stop${parsed.legs.length > 1 ? 's' : ''} added. Tap a climate to fine-tune the heat penalty.`);
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'The vision model could not read the screenshot. Check your LLM key in Settings.');
    } finally { setImporting(false); }
  };

  const proj: ItineraryProjection | null = useMemo(() => {
    if (!hist?.length || !data) return null;
    const a = activeOf(data);
    if (!a) return null;
    return projectTravelItinerary(hist, a.legs, a.returnDate, 21);
  }, [hist, data]);

  if (loading) return <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.dim}>Reading your training history…</Text></View>;
  if (err)     return <View style={s.center}><Text style={s.err}>{err}</Text></View>;
  if (!data || !hist) return <View style={s.center}><Text style={s.dim}>Not enough training history yet to project.</Text></View>;

  const active = activeOf(data);

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: 'Travel Projection', headerBackTitle: 'Back' }} />

      <Text style={s.lede}>
        Where your fitness (CTL) lands across a trip, under three training scenarios. Enter each stop — a
        flight (number + date) or a car / train / boat leg (destination + arrival date). Each stop's climate
        adds a heat penalty: in the tropics you can't train as hard, so the ceiling drops.
      </Text>

      {/* ── Saved trips ───────────────────────────────────────────── */}
      <View style={s.card}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tripChips} keyboardShouldPersistTaps="handled">
          {data.trips.map(t => (
            <TouchableOpacity key={t.id} style={[s.tripChip, t.id === active.id && s.tripChipOn]} onPress={() => selectTrip(t.id)}>
              <Text style={[s.tripChipTxt, t.id === active.id && s.tripChipTxtOn]} numberOfLines={1}>{t.name || 'Untitled'}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.tripChipNew} onPress={addTrip}><Text style={s.tripChipNewTxt}>＋ New</Text></TouchableOpacity>
        </ScrollView>
        <View style={s.nameRow}>
          <TextInput style={s.nameInput} value={active.name} placeholder="Trip name" placeholderTextColor={c.textFaint} onChangeText={t => patchActive({ name: t })} returnKeyType="done" />
          {data.trips.length > 1 && <TouchableOpacity onPress={() => deleteTrip(active.id)} hitSlop={8}><Text style={s.deleteTrip}>🗑</Text></TouchableOpacity>}
        </View>
        <Text style={s.savedHint}>Saved trips are shared with your AI coach — it plans around your travel automatically.</Text>
      </View>

      {/* ── Itinerary editor ──────────────────────────────────────── */}
      <View style={s.card}>
        {active.legs.map((lg, i) => (
          <View key={lg.id} style={s.legCard}>
            <View style={s.modeRow}>
              {TRANSPORT_MODES.map(m => (
                <TouchableOpacity key={m} style={[s.modeBtn, lg.mode === m && s.modeBtnOn]} onPress={() => patchLeg(lg.id, { mode: m })}>
                  <Text style={[s.modeIcon, lg.mode === m && s.modeIconOn]}>{MODE_META[m].icon}</Text>
                </TouchableOpacity>
              ))}
              <View style={{ flex: 1 }} />
              <Text style={s.legIdx}>Stop {i + 1}</Text>
              <TouchableOpacity onPress={() => removeLeg(lg.id)} hitSlop={8}><Text style={s.remove}>✕</Text></TouchableOpacity>
            </View>

            {lg.mode === 'flight' && (
              <View style={s.rowGap}>
                <TextInput
                  style={s.flightInput} value={lg.flightNo ?? ''} placeholder="Flight no. (e.g. SQ337)"
                  placeholderTextColor={c.textFaint} autoCapitalize="characters" autoCorrect={false}
                  onChangeText={t => patchLeg(lg.id, { flightNo: t.replace(/\s/g, '').toUpperCase() })} returnKeyType="done"
                />
                <TouchableOpacity style={[s.lookupBtn, (lookingUp === lg.id || !lg.flightNo) && { opacity: 0.5 }]} disabled={lookingUp === lg.id || !lg.flightNo} onPress={() => lookupFlight(lg)}>
                  {lookingUp === lg.id ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={s.lookupTxt}>🔎 Look up</Text>}
                </TouchableOpacity>
              </View>
            )}

            <View style={s.rowGap}>
              <TextInput
                style={s.placeInput} value={lg.place} placeholder="Destination" placeholderTextColor={c.textFaint}
                onChangeText={t => patchLeg(lg.id, { place: t })}
                onBlur={() => { if (lg.place.trim()) patchLeg(lg.id, { climate: climateForPlace(lg.place) }); }}
                returnKeyType="done"
              />
              <TouchableOpacity style={[s.climateBadge, { borderColor: CLIMATE_TINT[lg.climate] }]} onPress={() => cycleClimate(lg.id, lg.climate)}>
                <Text style={[s.climateTxt, { color: CLIMATE_TINT[lg.climate] }]}>{CLIMATE_LABEL[lg.climate]}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.dateRow}>
              <Text style={s.dateLabel}>{lg.mode === 'flight' ? 'Arrives' : 'Arrival'}</Text>
              <DateTimePicker value={dateOf(lg.arrive)} mode="date" display="compact" themeVariant={c.mode as 'light' | 'dark'} accentColor={c.accent}
                onChange={(_e, d) => { if (d) patchLeg(lg.id, { arrive: dstr(d) }); }} />
            </View>
          </View>
        ))}

        <View style={s.dateRow}>
          <Text style={[s.dateLabel, { fontWeight: '700', color: c.text }]}>✈️ Return home</Text>
          <DateTimePicker value={dateOf(active.returnDate)} mode="date" display="compact" themeVariant={c.mode as 'light' | 'dark'} accentColor={c.accent}
            onChange={(_e, d) => { if (d) patchActive({ returnDate: dstr(d) }); }} />
        </View>

        <View style={s.actionRow}>
          <TouchableOpacity style={s.addLeg} onPress={addLeg}><Text style={s.addLegTxt}>+ Add stop</Text></TouchableOpacity>
          <TouchableOpacity style={[s.importBtn, importing && { opacity: 0.5 }]} onPress={importFromScreenshot} disabled={importing}>
            {importing ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={s.importTxt}>📷 Import screenshot</Text>}
          </TouchableOpacity>
        </View>
        {proj && (
          <Text style={s.ctrlNote}>
            Away {fmtShort(proj.tripStart)} → {fmtShort(proj.tripEnd)} · today CTL {proj.today.ctl.toFixed(0)} · sustaining ~{proj.normalDailyLoad} load/day · tap a climate to change it
          </Text>
        )}
      </View>

      {!proj ? (
        <View style={s.card}><Text style={s.dim}>Set an arrival date for at least one stop and a return-home date to see the projection.</Text></View>
      ) : (
        <>
          {/* ── CTL chart ─────────────────────────────────────────── */}
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

          {/* ── Heat penalty per leg ──────────────────────────────── */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Heat penalty by stop</Text>
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
              hold normal load, so tropical stops quietly bleed CTL no matter your intent. Early-morning easy runs + hard
              hydration are the play; treat those days as maintenance, not training.
            </Text>
          </View>

          {/* ── Summary table ─────────────────────────────────────── */}
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
        </>
      )}
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
  dim:       { color: c.textSub, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  err:       { color: '#c0392b', fontSize: 14, textAlign: 'center' },
  lede:      { color: c.textSub, fontSize: 13, lineHeight: 19, paddingHorizontal: 20, paddingTop: 14 },
  card:      { backgroundColor: c.surface, borderRadius: 16, marginHorizontal: 16, marginTop: 14, padding: 16 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  ctrlNote:  { color: c.textSub, fontSize: 11.5, marginTop: 10, lineHeight: 16 },
  // saved-trip chips + name
  tripChips:   { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 4 },
  tripChip:    { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, maxWidth: 160 },
  tripChipOn:  { backgroundColor: c.accent + '22', borderColor: c.accent },
  tripChipTxt: { color: c.textSub, fontSize: 13, fontWeight: '600' },
  tripChipTxtOn:{ color: c.accent, fontWeight: '800' },
  tripChipNew: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: c.border, borderStyle: 'dashed' },
  tripChipNewTxt:{ color: c.accent, fontSize: 14, fontWeight: '700' },
  nameRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  nameInput:   { flex: 1, color: c.text, fontSize: 17, fontWeight: '800', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.bg, borderRadius: 10 },
  deleteTrip:  { fontSize: 18, paddingHorizontal: 2 },
  savedHint:   { color: c.textFaint, fontSize: 11.5, marginTop: 8, lineHeight: 16 },
  // itinerary editor — one card per stop
  legCard:     { backgroundColor: c.bg, borderRadius: 12, padding: 10, marginBottom: 10, gap: 8 },
  modeRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  modeBtn:     { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  modeBtnOn:   { backgroundColor: c.accent + '22', borderColor: c.accent },
  modeIcon:    { fontSize: 15, opacity: 0.55 },
  modeIconOn:  { opacity: 1 },
  legIdx:      { color: c.textFaint, fontSize: 11.5, fontWeight: '700', marginRight: 8 },
  remove:      { color: c.textFaint, fontSize: 15, fontWeight: '700', paddingHorizontal: 2 },
  rowGap:      { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flightInput: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600', paddingVertical: 7, paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 8 },
  lookupBtn:   { backgroundColor: c.surface, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, minWidth: 92, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  lookupTxt:   { color: c.accent, fontSize: 14, fontWeight: '700' },
  placeInput:  { flex: 1, color: c.text, fontSize: 14, fontWeight: '600', paddingVertical: 7, paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 8 },
  climateBadge:{ borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  climateTxt:  { fontSize: 11, fontWeight: '700' },
  dateRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  dateLabel:   { color: c.textSub, fontSize: 13, fontWeight: '600' },
  actionRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  addLeg:      { paddingVertical: 4 },
  addLegTxt:   { color: c.accent, fontSize: 14, fontWeight: '700' },
  importBtn:   { backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, minHeight: 32, justifyContent: 'center' },
  importTxt:   { color: c.accent, fontSize: 14, fontWeight: '700' },
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
