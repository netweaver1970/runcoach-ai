/**
 * Wayfinder — coach-driven route generation. Seeds an ORS round-trip loop from your location at the
 * prescribed distance, in a direction you pick, and previews it on an OpenTopoMap tile grid (trail/contour
 * detail, no native map module needed for v1). Export GPX to run it anywhere. See project_wayfinder.
 */
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, SafeAreaView, Image, Share, Switch,
  Modal, PanResponder,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { getOrsApiKey, orsHeadingOptions, orsDirectionalLoop, RouteOption, RouteLoop } from '../src/services/routing';
import { sendRouteToWatch, watchRouteAvailable } from '../src/services/watchRoute';
import { loadSnapshotCache } from '../src/services/healthkit';
import { deterministicCoachPlan, assembleCoachSnapshot } from '../src/services/coach';

const MERELBEKE: [number, number] = [3.7436, 50.9767];   // fallback start if location is unavailable
const TILE = 256;
const PACE: Record<string, number> = { easy: 6.0, moderate: 5.1, hard: 4.6, rest: 6.0 };  // min/km by intensity (rough)

// ── Web-Mercator tile projection ──────────────────────────────────────────────
const lon2px = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z) * TILE;
const lat2px = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * TILE;
};
// Inverse Web-Mercator (world px → lon/lat at zoom z) — for turning a finger-drag into a map-centre shift.
const px2lon = (px: number, z: number) => (px / (Math.pow(2, z) * TILE)) * 360 - 180;
const px2lat = (px: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * px) / (Math.pow(2, z) * TILE);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};
function bboxCenter(coords: [number, number][]): [number, number] {
  const lons = coords.map(p => p[0]), lats = coords.map(p => p[1]);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

// Largest zoom at which the route bbox still fits the view (with padding) — the "fit whole loop" level.
function fitZoom(coords: [number, number][], width: number, height: number): number {
  const lons = coords.map(p => p[0]), lats = coords.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  let z = 16;
  for (; z > 10; z--) {
    const w = lon2px(maxLon, z) - lon2px(minLon, z), h = lat2px(minLat, z) - lat2px(maxLat, z);
    if (w <= width * 0.86 && h <= height * 0.86) break;
  }
  return z;
}

// ── Static map: OpenTopoMap tile grid + the route drawn as rotated View segments ──
function StaticMap({ coords, start, here, center, zoom, width, height, line, c }: {
  coords: [number, number][]; start: [number, number]; here: [number, number] | null;
  center?: [number, number]; zoom?: number; width: number; height: number; line: string; c: Palette;
}) {
  if (width <= 0 || coords.length < 2) return <View style={{ width, height }} />;
  const lons = coords.map(p => p[0]), lats = coords.map(p => p[1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const z = zoom ?? fitZoom(coords, width, height);               // caller can force zoom (manual / follow)
  const cx = center ? lon2px(center[0], z) : (lon2px(minLon, z) + lon2px(maxLon, z)) / 2;
  const cy = center ? lat2px(center[1], z) : (lat2px(minLat, z) + lat2px(maxLat, z)) / 2;
  const ox = cx - width / 2, oy = cy - height / 2;                 // top-left origin in world px
  const px = (p: [number, number]) => [lon2px(p[0], z) - ox, lat2px(p[1], z) - oy] as [number, number];

  const tiles: React.ReactNode[] = [];
  const x0 = Math.floor(ox / TILE), x1 = Math.floor((ox + width) / TILE);
  const y0 = Math.floor(oy / TILE), y1 = Math.floor((oy + height) / TILE);
  const n = Math.pow(2, z);
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= n) continue;
    const wx = ((tx % n) + n) % n;
    tiles.push(<Image key={`${tx}_${ty}`} source={{ uri: `https://a.tile.opentopomap.org/${z}/${wx}/${ty}.png` }}
      style={{ position: 'absolute', left: tx * TILE - ox, top: ty * TILE - oy, width: TILE, height: TILE }} />);
  }
  const pts = coords.map(px);
  const segView = (a: [number, number], b: [number, number], key: string, h: number, color: string) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.sqrt(dx * dx + dy * dy);
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    return <View key={key} pointerEvents="none" style={{ position: 'absolute', left: (a[0] + b[0]) / 2 - len / 2, top: (a[1] + b[1]) / 2 - h / 2, width: len, height: h, backgroundColor: color, borderRadius: h / 2, transform: [{ rotate: `${ang}deg` }] }} />;
  };
  // White casing under the coloured line → the route reads clearly over streets/houses.
  const casing = pts.map((p, i) => i === 0 ? null : segView(pts[i - 1], p, `c${i}`, 8, '#ffffff'));
  // travel-direction arrows (screen-space): id 0 = green + larger "start this way"; the rest are accent-coloured
  // around the loop so clockwise vs counter-clockwise reads before you set off.
  const ahead = Math.max(1, Math.floor(pts.length / 30));
  const scrAng = (a: [number, number], b: [number, number]) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const arrows: { k: number; x: number; y: number; ang: number }[] = [];
  for (let k = 0; k < 5; k++) {
    const i = Math.floor((k / 5) * (pts.length - 1));
    const j = Math.min(i + ahead, pts.length - 1);
    if (i !== j) arrows.push({ k, x: pts[i][0], y: pts[i][1], ang: scrAng(pts[i], pts[j]) });
  }
  const segs = pts.map((p, i) => i === 0 ? null : segView(pts[i - 1], p, `l${i}`, 4.5, line));
  const [sx, sy] = px(start);
  return (
    <View style={{ width, height, borderRadius: 14, overflow: 'hidden', backgroundColor: c.surfaceAlt }}>
      {tiles}
      {/* Fade the busy topo tiles so the route + markers read clearly against the houses/streets. */}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height, backgroundColor: 'rgba(255,255,255,0.42)' }} />
      {casing}
      {segs}
      <View pointerEvents="none" style={{ position: 'absolute', left: sx - 8, top: sy - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: line, borderWidth: 3, borderColor: '#fff' }} />
      {arrows.map(a => {
        const big = a.k === 0, bl = big ? 15 : 9, bt = big ? 8 : 5;   // triangle points +x; rotate to heading
        return <View key={`arw${a.k}`} pointerEvents="none" style={{
          position: 'absolute', left: a.x - bl / 2, top: a.y - bt, width: 0, height: 0,
          borderTopWidth: bt, borderBottomWidth: bt, borderLeftWidth: bl,
          borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: big ? '#16a34a' : line,
          transform: [{ rotate: `${a.ang}deg` }],
        }} />;
      })}
      {here && (() => {
        const [hx, hy] = px(here);
        if (hx < -8 || hx > width + 8 || hy < -8 || hy > height + 8) return null;   // off the previewed loop
        return <View key="here" pointerEvents="none" style={{ position: 'absolute', left: hx - 7, top: hy - 7, width: 14, height: 14, borderRadius: 7, backgroundColor: '#2f7bff', borderWidth: 3, borderColor: '#fff', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }} />;
      })()}
      <Text style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 8.5, color: '#333', backgroundColor: '#ffffffaa', paddingHorizontal: 3, borderRadius: 2 }}>© OpenTopoMap (CC-BY-SA)</Text>
    </View>
  );
}

// Map + overlays (zoom −/AUTO/+, fullscreen toggle, follow pill) + finger-pan. Used inline and in the modal.
function MapPane({ coords, start, here, center, zoom, width, height, c, moving, isFull, autoOn, onPan, onZoomIn, onZoomOut, onAuto, onToggleFull }: {
  coords: [number, number][]; start: [number, number]; here: [number, number] | null;
  center?: [number, number]; zoom: number; width: number; height: number; c: Palette; moving: boolean;
  isFull: boolean; autoOn: boolean;
  onPan: (c: [number, number]) => void; onZoomIn: () => void; onZoomOut: () => void; onAuto: () => void; onToggleFull: () => void;
}) {
  const s = useThemedStyles(makeStyles);
  const zRef = useRef(zoom); zRef.current = zoom;
  const cRef = useRef<[number, number]>(center ?? bboxCenter(coords)); cRef.current = center ?? bboxCenter(coords);
  const onPanRef = useRef(onPan); onPanRef.current = onPan;
  const startC = useRef<[number, number] | null>(null);
  // Own the gesture on touch-start so the parent ScrollView doesn't steal vertical drags. Buttons are children
  // and still win on their own area. Handlers read live zoom/centre from refs, so the responder never needs to
  // be rebuilt mid-drag (rebuilding it was what killed panning).
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,   // don't let the ScrollView reclaim mid-pan
    onPanResponderGrant: () => { startC.current = cRef.current; },
    onPanResponderMove: (_, g) => {
      const z = zRef.current, sc = startC.current; if (!sc) return;
      const bx = lon2px(sc[0], z) - g.dx, by = lat2px(sc[1], z) - g.dy;   // drag content with the finger
      onPanRef.current([px2lon(bx, z), px2lat(by, z)]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  return (
    <View style={{ position: 'relative', width, height }} {...pan.panHandlers}>
      <StaticMap coords={coords} start={start} here={here} center={center} zoom={zoom} width={width} height={height} line={c.accent} c={c} />
      <View style={s.zoomCtl}>
        <TouchableOpacity style={s.zoomBtn} onPress={onZoomIn}><Text style={s.zoomT}>＋</Text></TouchableOpacity>
        <TouchableOpacity style={[s.zoomBtn, autoOn && s.zoomBtnOn]} onPress={onAuto}><Text style={[s.zoomTsm, autoOn && { color: '#fff' }]}>AUTO</Text></TouchableOpacity>
        <TouchableOpacity style={s.zoomBtn} onPress={onZoomOut}><Text style={s.zoomT}>－</Text></TouchableOpacity>
      </View>
      <TouchableOpacity style={s.fullBtn} onPress={onToggleFull}>
        <Text style={s.fullT}>{isFull ? '✕ Close' : '⤢ Full'}</Text>
      </TouchableOpacity>
      {moving && <View style={s.followPill}><Text style={s.followT}>● following</Text></View>}
    </View>
  );
}

export default function WayfinderScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();

  const [start, setStart] = useState<[number, number]>(MERELBEKE);
  const [placed, setPlaced] = useState('Merelbeke (default)');
  const [targetKm, setTargetKm] = useState(8);
  const [trails, setTrails] = useState(true);          // foot-hiking (trails) vs foot-walking (roads)
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [opts, setOpts] = useState<RouteOption[]>([]);
  const [sel, setSel] = useState(0);
  const [reach, setReach] = useState(0);                       // 0 = the round-trip loop; 1–3 = steered further out
  const [steered, setSteered] = useState<(RouteLoop & { reachKm: number }) | null>(null);
  const [steerBusy, setSteerBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mapW, setMapW] = useState(0);
  const [here, setHere] = useState<[number, number] | null>(null);   // live phone position, shown on the map
  const [moving, setMoving] = useState(false);                       // running → auto-follow tighter
  const [zoomMode, setZoomMode] = useState<'auto' | number>('auto'); // 'auto' = fit loop / follow when running
  const [panCenter, setPanCenter] = useState<[number, number] | null>(null);  // finger-panned map centre
  const [fullscreen, setFullscreen] = useState(false);
  const [fullDims, setFullDims] = useState({ w: 0, h: 0 });

  // On mount: key present? where am I? what did the coach prescribe today?
  useEffect(() => {
    (async () => {
      setHasKey(await getOrsApiKey().then(k => !!k).catch(() => false));
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 })
            ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          if (pos) {
            setStart([pos.coords.longitude, pos.coords.latitude]);
            const geo = await Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }).catch(() => []);
            setPlaced(geo?.[0]?.city ?? geo?.[0]?.subregion ?? 'your location');
          }
        }
      } catch { /* keep default */ }
      try {
        const snap = await loadSnapshotCache();
        if (snap) {
          const cs = await assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs).catch(() => null);
          const plan = cs ? await deterministicCoachPlan(cs).catch(() => null) : null;
          if (plan && plan.intensity !== 'rest' && (plan.runMinutes ?? 0) > 0) {
            const km = Math.round(((plan.runMinutes ?? 0) / (PACE[plan.intensity] ?? 6)) * 2) / 2;
            if (km >= 2 && km <= 30) setTargetKm(km);
          }
        }
      } catch { /* keep default 8 */ }
    })();
  }, []);

  const generate = useCallback(async () => {
    setBusy(true); setErr(null); setOpts([]);
    try {
      // one steered loop per compass point → every routable direction (incl. W/SW/NW) is offered
      const list = await orsHeadingOptions({
        lon: start[0], lat: start[1], km: targetKm, profile: trails ? 'foot-hiking' : 'foot-walking',
      });
      if (!list.length) setErr('No routes came back — check the key in Settings, or try a different distance.');
      else { setOpts(list); setSel(0); setReach(0); setSteered(null); }
    } catch (e: any) { setErr(e?.message ?? 'Could not generate routes.'); }
    finally { setBusy(false); }
  }, [start, targetKm, trails]);

  // Amplify the chosen direction: level 0 = the round-trip loop; 1–3 push the far point further out (narrower
  // wedge + bigger reach) via a steered directional loop toward the selected heading.
  const REACH_CFG = [null, { r: 0.30, s: 74 }, { r: 0.38, s: 56 }, { r: 0.46, s: 40 }];
  const applyReach = useCallback(async (level: number) => {
    setReach(level);
    const o = opts[sel];
    if (level === 0 || !o) { setSteered(null); return; }
    setSteerBusy(true);
    const cfg = REACH_CFG[level]!;
    const loop = await orsDirectionalLoop({
      lon: start[0], lat: start[1], headingDeg: o.headingDeg,
      reachKm: Math.max(1, targetKm * cfg.r), spreadDeg: cfg.s, profile: trails ? 'foot-hiking' : 'foot-walking',
    }).catch(() => null);
    if (!loop) setErr('Could not push that way — no path far enough that direction. Try another heading.');
    setSteered(loop);
    setSteerBusy(false);
  }, [opts, sel, start, targetKm, trails]);

  const pickHeading = (i: number) => { setSel(i); setReach(0); setSteered(null); setErr(null); };

  const exportGpx = useCallback(async () => {
    const o = opts[sel]; if (!o) return;
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RunCoachAI Wayfinder" xmlns="http://www.topografix.com/GPX/1/1">\n <trk><name>${o.distanceKm.toFixed(1)}km ${o.heading} loop</name><trkseg>\n`;
    for (const cc of o.coords) gpx += `  <trkpt lat="${cc[1]}" lon="${cc[0]}"></trkpt>\n`;
    gpx += ' </trkseg></trk>\n</gpx>\n';
    try {
      const uri = `${FileSystem.cacheDirectory}wayfinder-${o.distanceKm.toFixed(1)}km-${o.heading}.gpx`;
      await FileSystem.writeAsStringAsync(uri, gpx);
      await Share.share({ url: uri, message: `${o.distanceKm.toFixed(1)} km ${o.heading} loop` });
    } catch { await Share.share({ message: gpx }); }
  }, [opts, sel]);

  const base = opts[sel];
  const cur: (RouteOption & { reachKm?: number }) | undefined =
    base ? (steered ? { ...base, ...steered } : base) : undefined;
  const hasRoute = !!cur;

  // While a loop is on screen, follow the phone's live GPS on the map — a glanceable backup if the watch map
  // isn't detailed enough. Foreground-only, high accuracy; the subscription stops when you leave the screen.
  useEffect(() => {
    if (!hasRoute) { setHere(null); return; }
    let alive = true; let sub: any = null;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted' || !alive) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 4, timeInterval: 2000 },
          pos => { setHere([pos.coords.longitude, pos.coords.latitude]); setMoving((pos.coords.speed ?? 0) > 1); },
        );
      } catch { /* ignore — map still shows the loop without a live dot */ }
    })();
    return () => { alive = false; sub?.remove(); };
  }, [hasRoute]);
  const [watchMsg, setWatchMsg] = useState('');
  const sendToWatch = useCallback(async () => {
    if (!cur) return;
    const ok = await sendRouteToWatch(cur, `${cur.heading} · ${cur.distanceKm.toFixed(1)}km`);
    setWatchMsg(ok ? '✓ Sent to watch' : 'Watch not reachable — open the RunCoach watch app');
    setTimeout(() => setWatchMsg(''), 2500);
  }, [cur]);

  // Map zoom/centre. Auto = fit the whole loop, but tighten-and-follow once you're actually running; manual
  // (±) forces a zoom, still following you when you move. A finger-pan sets panCenter and freezes the zoom.
  const mapH = mapW > 0 ? Math.round(mapW * 0.92) : 0;
  const autoZ = cur && mapW > 0 ? fitZoom(cur.coords, mapW, mapH) : 15;
  const effZoom = zoomMode === 'auto' ? ((moving && here) ? 16 : autoZ) : zoomMode;
  const effCenter: [number, number] | undefined = panCenter ?? ((moving && here) ? here : undefined);
  const autoOn = zoomMode === 'auto' && !panCenter;
  const effZoomRef = useRef(effZoom); effZoomRef.current = effZoom;

  // Panning freezes the zoom (so auto-fit/follow stop fighting the drag); AUTO returns to automatic + recentres.
  // onPan is kept STABLE (reads zoom from a ref) so the pan responder is never rebuilt mid-drag.
  const onPan = useCallback((cc: [number, number]) => { setPanCenter(cc); setZoomMode(z => (z === 'auto' ? Math.round(effZoomRef.current) : z)); }, []);
  const onZoomIn = useCallback(() => setZoomMode(Math.min(18, Math.round(effZoom) + 1)), [effZoom]);
  const onZoomOut = useCallback(() => setZoomMode(Math.max(11, Math.round(effZoom) - 1)), [effZoom]);
  const onAuto = useCallback(() => { setPanCenter(null); setZoomMode('auto'); }, []);
  const paneProps = cur ? {
    coords: cur.coords, start, here, center: effCenter, zoom: effZoom, c, moving, autoOn,
    onPan, onZoomIn, onZoomOut, onAuto,
  } : null;

  return (
    <SafeAreaView style={s.container}>
      <Stack.Screen options={{ title: 'Route' }} />
      <ScrollView contentContainerStyle={s.scroll} onLayout={e => setMapW(e.nativeEvent.layout.width - 28)}>

        {hasKey === false ? (
          <View style={s.card}>
            <Text style={s.h}>Add your routing key</Text>
            <Text style={s.sub}>Wayfinder uses OpenRouteService (free) to draw the loop. Add a key in Settings, then come back.</Text>
            <TouchableOpacity style={s.btn} onPress={() => router.push('/settings' as any)}><Text style={s.btnT}>Open Settings</Text></TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Controls */}
            <View style={s.card}>
              <Text style={s.h}>Loop from {placed}</Text>
              <View style={s.rowBetween}>
                <Text style={s.label}>Distance</Text>
                <View style={s.stepper}>
                  <TouchableOpacity style={s.step} onPress={() => setTargetKm(k => Math.max(2, Math.round((k - 0.5) * 2) / 2))}><Text style={s.stepT}>−</Text></TouchableOpacity>
                  <Text style={s.stepVal}>{targetKm.toFixed(1)} km</Text>
                  <TouchableOpacity style={s.step} onPress={() => setTargetKm(k => Math.min(30, Math.round((k + 0.5) * 2) / 2))}><Text style={s.stepT}>+</Text></TouchableOpacity>
                </View>
              </View>
              <View style={s.rowBetween}>
                <Text style={s.label}>Prefer trails</Text>
                <Switch value={trails} onValueChange={setTrails} />
              </View>
              <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} onPress={generate} disabled={busy}>
                <Text style={s.btnT}>{busy ? 'Finding loops…' : opts.length ? '↻ New loops' : 'Generate loops'}</Text>
              </TouchableOpacity>
              <Text style={s.hint}>Default distance comes from today's session. Pick a heading below to steer it toward the green you know.</Text>
            </View>

            {err && <Text style={s.err}>{err}</Text>}
            {busy && !opts.length && <ActivityIndicator style={{ marginTop: 20 }} color={c.accent} />}

            {/* Heading chooser */}
            {opts.length > 0 && (
              <>
                <Text style={s.groupLabel}>Heading — pick a way to explore</Text>
                <View style={s.chips}>
                  {opts.map((o, i) => (
                    <TouchableOpacity key={o.seed} style={[s.chip, i === sel && s.chipOn]} onPress={() => pickHeading(i)}>
                      <Text style={[s.chipT, i === sel && s.chipTOn]}>{o.heading} · {o.distanceKm.toFixed(1)}k</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Reach — amplify the chosen direction (push the loop further out that way) */}
                <Text style={s.groupLabel}>Reach {steerBusy ? '· steering…' : ''}</Text>
                <View style={s.chips}>
                  {['Balanced', 'Further', 'Deeper', 'Farthest'].map((lbl, lv) => (
                    <TouchableOpacity key={lv} style={[s.chip, reach === lv && s.chipOn, steerBusy && { opacity: 0.5 }]} onPress={() => applyReach(lv)} disabled={steerBusy}>
                      <Text style={[s.chipT, reach === lv && s.chipTOn]}>{lbl}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Map preview — pan with a finger, −/AUTO/+ zoom, ⤢ for fullscreen */}
                {paneProps && mapW > 0 && (
                  <MapPane {...paneProps} width={mapW} height={mapH} isFull={false} onToggleFull={() => setFullscreen(true)} />
                )}

                {/* Selected stats + export */}
                {cur && (
                  <View style={s.statCard}>
                    <View style={s.statRow}>
                      <View style={s.stat}><Text style={s.statV}>{cur.distanceKm.toFixed(1)}</Text><Text style={s.statL}>km</Text></View>
                      <View style={s.stat}><Text style={s.statV}>{cur.heading}</Text><Text style={s.statL}>{cur.headingDeg}°</Text></View>
                      <View style={s.stat}><Text style={[s.statV, { color: cur.trailPct >= 30 ? '#2e9e5b' : c.text }]}>{cur.trailPct}%</Text><Text style={s.statL}>trail</Text></View>
                      {cur.reachKm != null && <View style={s.stat}><Text style={s.statV}>{cur.reachKm}</Text><Text style={s.statL}>km out</Text></View>}
                      {cur.reachKm == null && cur.ascentM > 0 && <View style={s.stat}><Text style={s.statV}>{cur.ascentM}</Text><Text style={s.statL}>m up</Text></View>}
                    </View>
                    <TouchableOpacity style={s.btn} onPress={exportGpx}><Text style={s.btnT}>↑ Export GPX</Text></TouchableOpacity>
                    {watchRouteAvailable() && (
                      <TouchableOpacity style={[s.btn, { backgroundColor: c.surfaceAlt, marginTop: 8 }]} onPress={sendToWatch}>
                        <Text style={[s.btnT, { color: c.text }]}>⌚ Send to Watch</Text>
                      </TouchableOpacity>
                    )}
                    {watchMsg ? <Text style={[s.hint, { textAlign: 'center' }]}>{watchMsg}</Text> : null}
                  </View>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Fullscreen map — same pan/zoom, filling the safe area. */}
      <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}
          onLayout={e => setFullDims({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {paneProps && fullDims.w > 0 && (
            <MapPane {...paneProps} width={fullDims.w} height={fullDims.h} isFull onToggleFull={() => setFullscreen(false)} />
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 14, paddingBottom: 44 },
  card: { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12 },
  h: { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 4 },
  sub: { fontSize: 13.5, color: c.textSub, lineHeight: 19, marginBottom: 12 },
  hint: { fontSize: 12, color: c.textFaint, marginTop: 10, lineHeight: 16 },
  label: { fontSize: 15, color: c.text, fontWeight: '500' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { width: 34, height: 34, borderRadius: 8, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  stepT: { fontSize: 20, color: c.text, fontWeight: '600' },
  stepVal: { fontSize: 15, fontWeight: '700', color: c.text, minWidth: 62, textAlign: 'center' },
  btn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  btnT: { color: '#fff', fontWeight: '700', fontSize: 15 },
  err: { color: '#c0392b', fontSize: 14, textAlign: 'center', marginVertical: 10, lineHeight: 20 },
  groupLabel: { fontSize: 11.5, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 7, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 100, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  chipOn: { backgroundColor: c.accent, borderColor: c.accent },
  chipT: { fontSize: 13, fontWeight: '600', color: c.textSub },
  chipTOn: { color: '#fff' },
  zoomCtl: { position: 'absolute', right: 8, top: 8, gap: 6 },
  zoomBtn: { width: 36, height: 36, borderRadius: 9, backgroundColor: '#ffffffE6', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
  zoomBtnOn: { backgroundColor: c.accent },
  zoomT: { fontSize: 20, fontWeight: '700', color: '#222' },
  zoomTsm: { fontSize: 10, fontWeight: '800', color: '#222' },
  followPill: { position: 'absolute', left: 8, bottom: 8, backgroundColor: '#2f7bffE6', borderRadius: 100, paddingHorizontal: 9, paddingVertical: 4 },
  followT: { color: '#fff', fontSize: 11, fontWeight: '700' },
  fullBtn: { position: 'absolute', left: 8, top: 8, backgroundColor: '#ffffffF2', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  fullT: { fontSize: 13, fontWeight: '800', color: '#222' },
  statCard: { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginTop: 12 },
  statRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  statV: { fontSize: 20, fontWeight: '800', color: c.text },
  statL: { fontSize: 11, color: c.textFaint, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4 },
});
