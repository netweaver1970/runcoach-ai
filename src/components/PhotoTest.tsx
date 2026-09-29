/**
 * Photo-meal pre-build spike S1 (docs/nutrition/REPORT.md §4.4) — run ONCE on the real phone before the photo
 * feature is built. Takes the same plate at camera quality 1 / 0.5 / 0.25 and records, per photo:
 *   • base64 size (vs the provider's per-image cap — Anthropic documents 5 MB per image on the API; the error text
 *     tells a size rejection apart) and the real format (first bytes) vs what the picker says
 *   • whether EXIF / GPS survive inside the bytes that would be uploaded
 *   • per media-type label (sniffed vs forced "image/png"): accepted or rejected by the configured LLM, and latency
 * Results are shown and can be copied / shared so they can be pasted back into the build session.
 * Costs ≈ 6 small vision calls on the user's own key.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet, Share, ActivityIndicator, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { useTheme, useThemedStyles, Palette } from '../theme';
import { callLLMWithImage, loadLLMConfig } from '../services/llm';

type Tri = boolean | 'n/a';
interface Shot { quality: number; b64Len: number; mb: number; w: number; h: number; pickerMime?: string; sniffed: string; exifInBytes: Tri; gpsInBytes: Tri; exifKeys: number; gpsInPickerExif: boolean }
interface Call { quality: number; sentAs: string; ok: boolean; ms: number; note: string }

const bytesOf = (b64: string, n: number): string => (globalThis as any).atob(b64.slice(0, Math.ceil(n / 3) * 4));

export function sniffMediaType(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  try { const h = bytesOf(b64, 12); if (h.slice(4, 8) === 'ftyp' && /hei|mif1|heix/.test(h.slice(8, 12))) return 'image/heic'; } catch { /* ignore */ }
  return 'unknown';
}

/**
 * Parse the JPEG's APP1/Exif segment properly: TIFF header (II/MM), walk IFD0's entries and look for the GPS IFD
 * pointer tag 0x8825 — no scanning of compressed image bytes (that gave random false positives).
 */
function exifScan(b64: string): { exif: Tri; gps: Tri } {
  try {
    const b = bytesOf(b64, 65536);
    const u8 = (i: number) => b.charCodeAt(i) & 0xff;
    if (u8(0) !== 0xff || u8(1) !== 0xd8) return { exif: false, gps: false };
    let i = 2;
    while (i + 4 < b.length && u8(i) === 0xff) {
      const marker = u8(i + 1), len = (u8(i + 2) << 8) | u8(i + 3);
      if (marker === 0xe1 && b.slice(i + 4, i + 8) === 'Exif' && u8(i + 8) === 0 && u8(i + 9) === 0) {
        const t = i + 10;                                        // TIFF header start
        const le = b.slice(t, t + 2) === 'II';
        const r16 = (o: number) => (le ? u8(t + o) | (u8(t + o + 1) << 8) : (u8(t + o) << 8) | u8(t + o + 1));
        const r32 = (o: number) => (le ? (u8(t + o) | (u8(t + o + 1) << 8) | (u8(t + o + 2) << 16) | (u8(t + o + 3) << 24)) >>> 0
          : ((u8(t + o) << 24) | (u8(t + o + 1) << 16) | (u8(t + o + 2) << 8) | u8(t + o + 3)) >>> 0);
        const ifd0 = r32(4);
        const n = r16(ifd0);
        for (let k = 0; k < n && k < 200; k++) if (r16(ifd0 + 2 + k * 12) === 0x8825) return { exif: true, gps: true };
        return { exif: true, gps: false };
      }
      if (marker === 0xda) break;                                // start of scan: no more metadata segments
      i += 2 + len;
    }
    return { exif: false, gps: false };
  } catch { return { exif: 'n/a', gps: 'n/a' }; }
}

const PROMPT = 'List the foods visible in this photo as JSON only: {"items":[{"name":"...","grams":0}]}. No other text.';

export function PhotoTest({ onClose }: { onClose: () => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [meta, setMeta] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);   // closing the test stops it (no more calls on the key)

  const running = useRef(false);
  const run = async () => {
    if (running.current) return;                          // a ref, so two taps in the same frame can't start two runs
    running.current = true;
    try { await runInner(); } finally { running.current = false; }
  };
  const runInner = async () => {
    setBusy('Starting…');
    const cfg = await loadLLMConfig().catch(() => null);
    if (!cfg?.apiKey) { setBusy(null); Alert.alert('No AI key', 'The photo test needs the LLM key you use for chat (Settings).'); return; }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setBusy(null); Alert.alert('Camera not allowed', 'Allow camera access for RunCoach in iOS Settings.'); return; }
    setShots([]); setCalls([]);
    setMeta(`${cfg.provider} · ${cfg.model} · ${new Date().toISOString()}`);
    const got: { q: number; b64: string; sniffed: string }[] = [];
    for (const q of [1, 0.5, 0.25]) {
      setBusy(`Photo ${got.length + 1} of 3 — same plate, quality ${q}`);
      const r = await ImagePicker.launchCameraAsync({ quality: q, base64: true, exif: true, allowsEditing: false });
      if (!alive.current) return;
      if (r.canceled || !r.assets?.[0]?.base64) { setBusy(null); return; }
      const a = r.assets[0];
      const b64 = a.base64!;
      const sn = sniffMediaType(b64);
      const scan = exifScan(b64);
      const ex = (a.exif ?? {}) as Record<string, unknown>;
      const shot: Shot = {
        quality: q, b64Len: b64.length, mb: Math.round(b64.length / 1048576 * 100) / 100, w: a.width, h: a.height,
        pickerMime: a.mimeType ?? undefined, sniffed: sn, exifInBytes: scan.exif, gpsInBytes: scan.gps,
        exifKeys: Object.keys(ex).length, gpsInPickerExif: Object.keys(ex).some(k => /gps/i.test(k)) || !!(ex as any)['{GPS}'],
      };
      setShots(prev => [...prev, shot]);
      got.push({ q, b64, sniffed: sn });
    }
    for (const g of got) {
      for (const mt of [...new Set([g.sniffed === 'unknown' ? 'image/jpeg' : g.sniffed, 'image/png'])]) {
        if (!alive.current) return;
        setBusy(`Sending quality ${g.q} as ${mt}…`);
        const t0 = Date.now();
        try {
          const out = await callLLMWithImage({ prompt: PROMPT, imageBase64: g.b64, mediaType: mt, maxTokens: 300 });
          setCalls(prev => [...prev, { quality: g.q, sentAs: mt, ok: true, ms: Date.now() - t0, note: out.replace(/\s+/g, ' ').slice(0, 160) }]);
        } catch (e: any) {
          setCalls(prev => [...prev, { quality: g.q, sentAs: mt, ok: false, ms: Date.now() - t0, note: String(e?.message ?? e).slice(0, 200) }]);
        }
      }
    }
    setBusy(null);
  };

  const report = () => JSON.stringify({ spike: 'S1 photo upload', meta, shots, calls }, null, 1);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <View style={s.head}>
          <Text style={s.title}>🧪 Photo test</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}><Text style={s.link}>Close</Text></TouchableOpacity>
        </View>
        <Text style={s.p}>
          One-time check before the photo-meal feature is built. You take the SAME plate 3 times (the camera opens 3×);
          the app measures each photo and sends it to your AI provider twice (6 small calls on your key, a few cents).
          Nothing is logged. Then tap Copy and paste the result into the chat.
        </Text>
        <TouchableOpacity style={[s.btn, !!busy && { opacity: 0.5 }]} disabled={!!busy} onPress={() => { run().catch(e => { setBusy(null); Alert.alert('Test failed', String(e?.message ?? e)); }); }}>
          <Text style={s.btnTxt}>{shots.length ? 'Run again' : 'Start — take 3 photos'}</Text>
        </TouchableOpacity>
        {busy && <View style={s.busy}><ActivityIndicator /><Text style={s.p}>{busy}</Text></View>}

        {shots.length > 0 && <Text style={s.h2}>Photos</Text>}
        {shots.map(x => (
          <Text key={x.quality} style={s.mono}>
            q{x.quality}: {x.mb} MB base64 · {x.w}×{x.h} · bytes={x.sniffed} (picker says {x.pickerMime ?? '—'}) · EXIF in bytes {x.exifInBytes === 'n/a' ? 'n/a' : x.exifInBytes ? 'YES' : 'no'} · GPS in bytes {x.gpsInBytes === 'n/a' ? 'n/a' : x.gpsInBytes ? 'YES' : 'no'} · picker exif keys {x.exifKeys}{x.gpsInPickerExif ? ' (has GPS)' : ''}
          </Text>
        ))}
        {calls.length > 0 && <Text style={s.h2}>AI calls</Text>}
        {calls.map((x, i) => (
          <Text key={i} style={[s.mono, { color: x.ok ? c.text : '#dc2626' }]}>
            q{x.quality} as {x.sentAs}: {x.ok ? 'ACCEPTED' : 'REJECTED'} in {(x.ms / 1000).toFixed(1)} s — {x.note}
          </Text>
        ))}
        {!busy && (shots.length > 0 || calls.length > 0) && (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <TouchableOpacity style={[s.btn, { flex: 1 }]} onPress={async () => { await Clipboard.setStringAsync(report()); Alert.alert('Copied', 'Paste it into the chat.'); }}>
              <Text style={s.btnTxt}>Copy result</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.btnGhost, { flex: 1 }]} onPress={() => { Share.share({ message: report() }).catch(() => {}); }}>
              <Text style={s.btnGhostTxt}>Share…</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  head:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },
  link:  { color: c.accent, fontSize: 16, fontWeight: '700' },
  p:     { color: c.textSub, fontSize: 13.5, lineHeight: 19, marginBottom: 12 },
  h2:    { color: c.text, fontSize: 15, fontWeight: '800', marginTop: 16, marginBottom: 6 },
  mono:  { color: c.text, fontSize: 12.5, lineHeight: 18, marginBottom: 6, fontVariant: ['tabular-nums'] },
  busy:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  btn:   { paddingVertical: 13, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center' },
  btnTxt:{ color: c.onAccent, fontSize: 16, fontWeight: '800' },
  btnGhost: { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  btnGhostTxt: { color: c.text, fontSize: 16, fontWeight: '700' },
});
