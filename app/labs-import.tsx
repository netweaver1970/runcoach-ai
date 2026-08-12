import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as XLSX from 'xlsx';
import { parseClinicalGrid, ParsedLabs, LabAnalyte, Cell } from '../src/services/labs';
import { mergeLabsImport, loadTemplates, saveTemplate, deleteTemplate, LabTemplate } from '../src/services/labsStore';
import { mirrorLabsToHealth } from '../src/services/healthkit';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Phase = 'idle' | 'parsing' | 'pickSheet' | 'review' | 'importing' | 'done';
const KIND_LABEL: Record<string, string> = { derived: 'derived', categorical: 'text' };

// Google Drive / Sheets share link → a direct-download URL (file must be shared "anyone with the link").
function driveDownloadUrl(link: string): string | null {
  let m = link.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`;   // native Google Sheet
  m = link.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)
    || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;              // uploaded xlsx/csv
  return null;
}

export default function LabsImport() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [driveUrl, setDriveUrl] = useState('');
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
  const [rep, setRep] = useState<ParsedLabs | null>(null);
  const [selDates, setSelDates] = useState<Set<string>>(new Set());
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [hkChosen, setHkChosen] = useState<LabAnalyte[]>([]);
  const [result, setResult] = useState<{ analytes: number; points: number; mirrorEligible: number } | null>(null);
  const [mirror, setMirror] = useState<{ busy: boolean; written?: number; skipped?: number }>({ busy: false });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<LabTemplate[]>([]);

  React.useEffect(() => { loadTemplates().then(setTemplates); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, LabAnalyte[]>();
    for (const a of rep?.analytes ?? []) { if (!m.has(a.category)) m.set(a.category, []); m.get(a.category)!.push(a); }
    return [...m.entries()];
  }, [rep]);

  const pointsIn = (a: LabAnalyte) =>
    a.series.filter(v => selDates.has(v.date)).length + (a.textSeries?.filter(v => selDates.has(v.date)).length ?? 0);

  function loadWorkbook(b64: string) {
    try {
      const book = XLSX.read(b64, { type: 'base64', cellDates: true });
      if (!book.SheetNames.length) { setPhase('idle'); Alert.alert('Empty file', 'No sheets found. If this came from Drive, make sure it is shared “anyone with the link”.'); return; }
      setWb(book);
      if (book.SheetNames.length > 1) { setPhase('pickSheet'); return; }   // let the user choose
      parseSheet(book, book.SheetNames[0]);
    } catch (e: any) {
      setPhase('idle');
      Alert.alert("Couldn't read that file", `${e?.message ?? e}. A Drive link must point to a spreadsheet shared “anyone with the link”.`);
    }
  }

  function parseSheet(book: XLSX.WorkBook, sheetName: string) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, raw: true, defval: null }) as Cell[][];
    const parsed = parseClinicalGrid(rows);
    if (!parsed.analytes.length) {
      Alert.alert('Nothing recognised', `No analytes found in “${sheetName}”. Expected analytes in rows and dates across the top.`);
      setPhase(book.SheetNames.length > 1 ? 'pickSheet' : 'idle');
      return;
    }
    setRep(parsed);
    setSelDates(new Set(parsed.dates));
    setSelKeys(new Set(parsed.analytes.map(a => a.key)));
    setPhase('review');
  }

  async function pickFile() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
               'text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text', 'org.openxmlformats.spreadsheetml.sheet'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      setFileName(res.assets[0].name ?? 'file'); setPhase('parsing');
      const b64 = await FileSystem.readAsStringAsync(res.assets[0].uri, { encoding: 'base64' });
      loadWorkbook(b64);
    } catch (e: any) { setPhase('idle'); Alert.alert("Couldn't open file", e?.message ?? String(e)); }
  }

  async function fetchFromDrive() {
    const url = driveDownloadUrl(driveUrl.trim());
    if (!url) { Alert.alert('Link not recognised', 'Paste a Google Drive share link — e.g. drive.google.com/file/d/…/view, or a Google Sheets link.'); return; }
    try {
      setFileName('Google Drive file'); setPhase('parsing');
      const dest = FileSystem.cacheDirectory + 'labs-import-download.xlsx';
      const dl = await FileSystem.downloadAsync(url, dest);
      if (dl.status !== 200) { setPhase('idle'); Alert.alert('Download failed', `Drive returned ${dl.status}. Make sure the file is shared “anyone with the link”.`); return; }
      const b64 = await FileSystem.readAsStringAsync(dl.uri, { encoding: 'base64' });
      loadWorkbook(b64);
    } catch (e: any) { setPhase('idle'); Alert.alert("Couldn't fetch from Drive", `${e?.message ?? e}. Check the link is shared “anyone with the link”.`); }
  }

  function toggleDate(d: string) { setSelDates(p => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; }); }
  function toggleKey(k: string) { setSelKeys(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; }); }
  function setCat(items: LabAnalyte[], on: boolean) { setSelKeys(p => { const n = new Set(p); for (const a of items) on ? n.add(a.key) : n.delete(a.key); return n; }); }
  function toggleCollapse(cat: string) { setCollapsed(p => { const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n; }); }

  function applyTemplate(t: LabTemplate) {
    if (!rep) return;
    const avail = new Set(rep.analytes.map(a => a.key));
    setSelKeys(new Set(t.keys.filter(k => avail.has(k))));
  }
  function saveCurrentTemplate() {
    const keys = [...selKeys];
    if (!keys.length) { Alert.alert('Nothing selected', 'Select some markers first, then save them as a template.'); return; }
    if (Alert.prompt) {
      Alert.prompt('Save template', `Save these ${keys.length} markers as a named template.`, async (name?: string) => {
        if (!name?.trim()) return;
        setTemplates(await saveTemplate(name, keys));
      });
    } else {
      Alert.alert('Not available', 'Naming templates needs iOS.');
    }
  }
  function removeTemplate(t: LabTemplate) {
    Alert.alert('Delete template', `Delete “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => setTemplates(await deleteTemplate(t.name)) },
    ]);
  }

  async function doImport() {
    if (!rep) return;
    setPhase('importing');
    try {
      const chosen: LabAnalyte[] = [];
      for (const a of rep.analytes) {
        if (!selKeys.has(a.key)) continue;
        const series = a.series.filter(v => selDates.has(v.date));
        const textSeries = (a.textSeries ?? []).filter(v => selDates.has(v.date));
        if (!series.length && !textSeries.length) continue;
        chosen.push({ ...a, series, textSeries: textSeries.length ? textSeries : undefined });
      }
      await mergeLabsImport(chosen);
      const hk = chosen.filter(a => a.hkType);
      setHkChosen(hk);
      setResult({ analytes: chosen.length, points: chosen.reduce((n, a) => n + a.series.length + (a.textSeries?.length ?? 0), 0),
        mirrorEligible: hk.reduce((n, a) => n + a.series.length, 0) });
      setPhase('done');
    } catch (e: any) { setPhase('review'); Alert.alert('Import failed', e?.message ?? String(e)); }
  }

  async function doMirror() {
    setMirror({ busy: true });
    try { const r = await mirrorLabsToHealth(hkChosen); setMirror({ busy: false, written: r.written, skipped: r.skipped }); }
    catch (e: any) { setMirror({ busy: false }); Alert.alert('Health write failed', e?.message ?? String(e)); }
  }

  const selAnalyteCount = rep ? rep.analytes.filter(a => selKeys.has(a.key) && pointsIn(a) > 0).length : 0;
  const selPointCount = rep ? rep.analytes.filter(a => selKeys.has(a.key)).reduce((n, a) => n + pointsIn(a), 0) : 0;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Import blood tests' }} />

      {(phase === 'idle' || phase === 'parsing') && (
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          <Text style={s.h1}>🩸 Import blood tests</Text>
          <Text style={s.p}>
            Import your clinical-tests spreadsheet (.xlsx or .csv). I map each row to a standard analyte,
            collapse duplicate units into one line, and let you de-select any dates or markers first. Everything
            stays in the app; only Weight, Blood Pressure and Glucose can also be written to Apple Health.
          </Text>
          {phase === 'parsing'
            ? <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.pFaint}>Reading {fileName}…</Text></View>
            : <>
                <TouchableOpacity style={s.btnPrimary} onPress={pickFile}><Text style={s.btnPrimaryTxt}>Choose a file…</Text></TouchableOpacity>
                <Text style={s.orLine}>or paste a Google Drive link</Text>
                <TextInput style={s.input} value={driveUrl} onChangeText={setDriveUrl} placeholder="https://drive.google.com/file/d/…/view"
                  placeholderTextColor={c.textFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
                <TouchableOpacity style={[s.btnSecondary, !driveUrl.trim() && s.btnDisabled]} disabled={!driveUrl.trim()} onPress={fetchFromDrive}>
                  <Text style={s.btnSecondaryTxt}>Fetch from Drive</Text></TouchableOpacity>
                <Text style={s.pFaint}>The Drive file must be shared “anyone with the link”. Works with an uploaded .xlsx or a native Google Sheet.</Text>
              </>}
        </ScrollView>
      )}

      {phase === 'pickSheet' && wb && (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.h1}>Choose a sheet</Text>
          <Text style={s.p}>This workbook has {wb.SheetNames.length} sheets. Pick the one with your lab results.</Text>
          {wb.SheetNames.map(n => (
            <TouchableOpacity key={n} style={s.sheetRow} onPress={() => { setPhase('parsing'); setTimeout(() => parseSheet(wb, n), 0); }}>
              <Text style={s.sheetName}>{n}</Text><Text style={s.sheetArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {phase === 'review' && rep && (
        <>
          <ScrollView contentContainerStyle={s.pad}>
            <View style={s.card}>
              <Text style={s.cardTitle}>{fileName}</Text>
              <Text style={s.pFaint}>{rep.dates[0]} → {rep.dates[rep.dates.length - 1]} · {rep.dates.length} test days · {rep.analytes.length} markers</Text>
              <Text style={s.sel}>{selAnalyteCount} markers · {selPointCount} values selected</Text>
            </View>

            {rep.warnings.length > 0 && (
              <View style={[s.card, { borderColor: c.accent }]}>
                <Text style={s.cardTitle}>Notes ({rep.warnings.length})</Text>
                {rep.warnings.map((w, i) => <Text key={i} style={s.warn}>• {w}</Text>)}
              </View>
            )}

            <View style={s.rowBetween}>
              <Text style={s.h2}>Test dates</Text>
              <View style={s.rowGap}>
                <TouchableOpacity onPress={() => setSelDates(new Set(rep.dates))}><Text style={s.link}>All</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setSelDates(new Set())}><Text style={s.link}>None</Text></TouchableOpacity>
              </View>
            </View>
            <View style={s.chips}>
              {rep.dates.map(d => { const on = selDates.has(d);
                return <TouchableOpacity key={d} onPress={() => toggleDate(d)} style={[s.chip, on && s.chipOn]}>
                  <Text style={[s.chipTxt, on && s.chipTxtOn]}>{d}</Text></TouchableOpacity>; })}
            </View>

            {/* Templates — recall a saved marker selection */}
            <View style={s.rowBetween}>
              <Text style={s.h2}>Templates</Text>
              <TouchableOpacity onPress={saveCurrentTemplate}><Text style={s.link}>＋ Save selection</Text></TouchableOpacity>
            </View>
            {templates.length === 0
              ? <Text style={s.pFaint}>Save the current marker selection as a named template, then recall it here on a future import.</Text>
              : <View style={s.chips}>{templates.map(t => (
                  <TouchableOpacity key={t.name} style={s.tpl} onPress={() => applyTemplate(t)} onLongPress={() => removeTemplate(t)}>
                    <Text style={s.tplTxt}>{t.name}</Text><Text style={s.tplN}>{t.keys.length}</Text>
                  </TouchableOpacity>))}</View>}

            <View style={s.rowBetween}>
              <Text style={s.h2}>Markers</Text>
              <View style={s.rowGap}>
                <TouchableOpacity onPress={() => setSelKeys(new Set(rep.analytes.map(a => a.key)))}><Text style={s.link}>All</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setSelKeys(new Set())}><Text style={s.link}>None</Text></TouchableOpacity>
              </View>
            </View>
            {groups.map(([cat, items]) => {
              const selN = items.filter(a => selKeys.has(a.key)).length;
              const tri = selN === 0 ? '' : selN === items.length ? '✓' : '–';
              const isCollapsed = collapsed.has(cat);
              return (
                <View key={cat} style={s.catBlock}>
                  <View style={s.catHead}>
                    <TouchableOpacity onPress={() => setCat(items, selN !== items.length)}><Text style={[s.cbBox, tri && s.cbBoxOn]}>{tri}</Text></TouchableOpacity>
                    <TouchableOpacity style={s.catHeadMain} onPress={() => toggleCollapse(cat)}>
                      <Text style={s.catTitle}>{cat}</Text>
                      <Text style={s.catCount}>{selN}/{items.length}</Text>
                      <Text style={s.chevron}>{isCollapsed ? '▸' : '▾'}</Text>
                    </TouchableOpacity>
                  </View>
                  {!isCollapsed && items.map(a => { const on = selKeys.has(a.key); const n = pointsIn(a);
                    return (
                      <TouchableOpacity key={a.key} style={s.aRow} onPress={() => toggleKey(a.key)}>
                        <Text style={[s.cbBox, on && s.cbBoxOn]}>{on ? '✓' : ''}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.aLabel, !on && s.aDim]} numberOfLines={1}>{a.label}</Text>
                          {!!a.note && <Text style={s.aNote} numberOfLines={1}>{a.note}</Text>}
                        </View>
                        <View style={s.badges}>
                          {a.hkType && <Text style={[s.badge, s.badgeHk]}>Health</Text>}
                          {KIND_LABEL[a.kind] && <Text style={[s.badge, s.badgeKind]}>{KIND_LABEL[a.kind]}</Text>}
                          <Text style={s.aUnit}>{a.unit || '—'}</Text><Text style={s.aN}>{n}</Text>
                        </View>
                      </TouchableOpacity>
                    ); })}
                </View>
              );
            })}
            <View style={{ height: 88 }} />
          </ScrollView>
          <View style={s.footer}>
            <TouchableOpacity style={[s.btnPrimary, selAnalyteCount === 0 && s.btnDisabled]} disabled={selAnalyteCount === 0} onPress={doImport}>
              <Text style={s.btnPrimaryTxt}>Import {selPointCount} values</Text></TouchableOpacity>
          </View>
        </>
      )}

      {phase === 'importing' && <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.pFaint}>Saving…</Text></View>}

      {phase === 'done' && result && (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.h1}>✅ Imported</Text>
          <Text style={s.p}>{result.points} values across {result.analytes} markers are now in your Labs store (Biology → Labs).</Text>

          {result.mirrorEligible > 0 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Apple Health mirror</Text>
              <Text style={s.pFaint}>{result.mirrorEligible} Weight / Blood-Pressure / Glucose readings can be written to Apple Health (BP converted cmHg→mmHg, glucose mmol/L→mg/dL). Re-writing is idempotent.</Text>
              {mirror.written == null
                ? <TouchableOpacity style={[s.btnSecondary, { marginTop: 10 }]} disabled={mirror.busy} onPress={doMirror}>
                    {mirror.busy ? <ActivityIndicator color={c.accent} /> : <Text style={s.btnSecondaryTxt}>Write to Apple Health</Text>}</TouchableOpacity>
                : <Text style={[s.sel, { marginTop: 8 }]}>✓ {mirror.written} written{mirror.skipped ? ` · ${mirror.skipped} skipped` : ''}</Text>}
            </View>
          )}

          <TouchableOpacity style={[s.btnPrimary, { marginTop: 16 }]} onPress={() => router.replace('/labs' as any)}><Text style={s.btnPrimaryTxt}>View Labs charts</Text></TouchableOpacity>
          <TouchableOpacity style={s.btnGhost} onPress={() => { setPhase('idle'); setRep(null); setWb(null); setResult(null); setMirror({ busy: false }); }}><Text style={s.btnGhostTxt}>Import another file</Text></TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  pad:      { padding: 16, paddingBottom: 32 },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  h1:       { color: c.text, fontSize: 22, fontWeight: '800', marginBottom: 10 },
  h2:       { color: c.text, fontSize: 16, fontWeight: '700', marginTop: 18, marginBottom: 6 },
  p:        { color: c.textSub, fontSize: 14, lineHeight: 21, marginBottom: 16 },
  pFaint:   { color: c.textFaint, fontSize: 13, lineHeight: 19 },
  orLine:   { color: c.textFaint, fontSize: 12.5, textAlign: 'center', marginVertical: 12 },
  input:    { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, color: c.text, fontSize: 14, marginBottom: 10 },
  card:     { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 14, marginBottom: 12 },
  cardTitle:{ color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sel:      { color: c.accent, fontSize: 13, fontWeight: '700', marginTop: 6 },
  warn:     { color: c.textSub, fontSize: 12.5, lineHeight: 19 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 15, marginBottom: 10 },
  sheetName:{ color: c.text, fontSize: 15, fontWeight: '600' },
  sheetArrow:{ color: c.textFaint, fontSize: 22 },
  rowBetween:{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  rowGap:   { flexDirection: 'row', gap: 14, paddingBottom: 6 },
  link:     { color: c.accent, fontSize: 13, fontWeight: '700' },
  chips:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip:     { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  chipOn:   { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:  { color: c.textFaint, fontSize: 11.5, fontWeight: '600' },
  chipTxtOn:{ color: c.onAccent },
  catBlock: { marginTop: 10, backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  catHead:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, backgroundColor: c.surfaceAlt },
  catHeadMain:{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  catTitle: { color: c.text, fontSize: 14, fontWeight: '700', flex: 1 },
  catCount: { color: c.textFaint, fontSize: 12, fontWeight: '600' },
  chevron:  { color: c.textFaint, fontSize: 12, fontWeight: '700', width: 14, textAlign: 'center' },
  tpl:      { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent },
  tplTxt:   { color: c.accent, fontSize: 13, fontWeight: '700' },
  tplN:     { color: c.textFaint, fontSize: 11, fontWeight: '600' },
  aRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: c.border },
  cbBox:    { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: c.textFaint, color: c.onAccent, textAlign: 'center', fontSize: 13, fontWeight: '800', overflow: 'hidden', lineHeight: 18 },
  cbBoxOn:  { backgroundColor: c.accent, borderColor: c.accent },
  aLabel:   { color: c.text, fontSize: 13.5, fontWeight: '600' },
  aDim:     { color: c.textFaint },
  aNote:    { color: c.textFaint, fontSize: 11, marginTop: 1 },
  badges:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge:    { fontSize: 9.5, fontWeight: '800', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' },
  badgeHk:  { color: '#065f46', backgroundColor: '#a7f3d0' },
  badgeKind:{ color: c.textSub, backgroundColor: c.surfaceAlt },
  aUnit:    { color: c.textFaint, fontSize: 11, minWidth: 42, textAlign: 'right' },
  aN:       { color: c.textSub, fontSize: 12, fontWeight: '700', minWidth: 22, textAlign: 'right' },
  footer:   { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, paddingBottom: 26, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.border },
  btnPrimary:{ backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  btnPrimaryTxt:{ color: c.onAccent, fontSize: 15, fontWeight: '800' },
  btnSecondary:{ backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  btnSecondaryTxt:{ color: c.text, fontSize: 14, fontWeight: '700' },
  btnDisabled:{ opacity: 0.4 },
  btnGhost: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  btnGhostTxt:{ color: c.accent, fontSize: 14, fontWeight: '700' },
});
