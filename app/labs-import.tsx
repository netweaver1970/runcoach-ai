import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as XLSX from 'xlsx';
import { parseClinicalGrid, ParsedLabs, LabAnalyte, Cell } from '../src/services/labs';
import { mergeLabsImport } from '../src/services/labsStore';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Phase = 'idle' | 'parsing' | 'review' | 'importing' | 'done';

const KIND_LABEL: Record<string, string> = { derived: 'derived', categorical: 'text' };

export default function LabsImport() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [rep, setRep] = useState<ParsedLabs | null>(null);
  const [selDates, setSelDates] = useState<Set<string>>(new Set());
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ analytes: number; points: number; mirrored: number } | null>(null);

  // group analytes by category for the review list
  const groups = useMemo(() => {
    const m = new Map<string, LabAnalyte[]>();
    for (const a of rep?.analytes ?? []) { if (!m.has(a.category)) m.set(a.category, []); m.get(a.category)!.push(a); }
    return [...m.entries()];
  }, [rep]);

  const pointsIn = (a: LabAnalyte) =>
    (a.series.filter(v => selDates.has(v.date)).length) + (a.textSeries?.filter(v => selDates.has(v.date)).length ?? 0);

  async function pickAndParse() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               'application/vnd.ms-excel', 'text/csv', 'text/comma-separated-values',
               'public.comma-separated-values-text', 'org.openxmlformats.spreadsheetml.sheet'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      const asset = res.assets[0];
      setFileName(asset.name ?? 'file'); setPhase('parsing');
      const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
      const wb = XLSX.read(b64, { type: 'base64', cellDates: true });
      const sheetName = wb.SheetNames.find(n => /clinical|blood|lab|test/i.test(n)) ?? wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null }) as Cell[][];
      const parsed = parseClinicalGrid(rows);
      if (!parsed.analytes.length) {
        setPhase('idle');
        Alert.alert('Nothing recognised', 'No analytes were found in that file. Is it the clinical-tests sheet (analytes in rows, dates across the top)?');
        return;
      }
      setRep(parsed);
      setSelDates(new Set(parsed.dates));
      setSelKeys(new Set(parsed.analytes.map(a => a.key)));
      setPhase('review');
    } catch (e: any) {
      setPhase('idle');
      Alert.alert("Couldn't read file", e?.message ?? String(e));
    }
  }

  function toggleDate(d: string) { setSelDates(p => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; }); }
  function toggleKey(k: string) { setSelKeys(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; }); }
  function setCat(items: LabAnalyte[], on: boolean) {
    setSelKeys(p => { const n = new Set(p); for (const a of items) on ? n.add(a.key) : n.delete(a.key); return n; });
  }

  async function doImport() {
    if (!rep) return;
    setPhase('importing');
    try {
      // keep only selected analytes, and within each only readings on selected dates
      const chosen: LabAnalyte[] = [];
      for (const a of rep.analytes) {
        if (!selKeys.has(a.key)) continue;
        const series = a.series.filter(v => selDates.has(v.date));
        const textSeries = (a.textSeries ?? []).filter(v => selDates.has(v.date));
        if (!series.length && !textSeries.length) continue;
        chosen.push({ ...a, series, textSeries: textSeries.length ? textSeries : undefined });
      }
      await mergeLabsImport(chosen);
      const points = chosen.reduce((n, a) => n + a.series.length + (a.textSeries?.length ?? 0), 0);
      const mirrored = chosen.filter(a => a.hkType).length;   // HK mirror wired in the next step
      setResult({ analytes: chosen.length, points, mirrored });
      setPhase('done');
    } catch (e: any) {
      setPhase('review');
      Alert.alert('Import failed', e?.message ?? String(e));
    }
  }

  const selAnalyteCount = rep ? rep.analytes.filter(a => selKeys.has(a.key) && pointsIn(a) > 0).length : 0;
  const selPointCount = rep ? rep.analytes.filter(a => selKeys.has(a.key)).reduce((n, a) => n + pointsIn(a), 0) : 0;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Import blood tests' }} />

      {(phase === 'idle' || phase === 'parsing') && (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.h1}>🩸 Import blood tests</Text>
          <Text style={s.p}>
            Pick your clinical-tests spreadsheet (.xlsx or .csv). I read it, map each row to a standard
            analyte, collapse duplicate units into one consistent line, and let you de-select any dates or
            markers before saving. Everything stays in the app; only Weight, Blood Pressure and Glucose are
            also written to Apple Health.
          </Text>
          {phase === 'parsing'
            ? <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.pFaint}>Reading {fileName}…</Text></View>
            : <TouchableOpacity style={s.btnPrimary} onPress={pickAndParse}><Text style={s.btnPrimaryTxt}>Choose file…</Text></TouchableOpacity>}
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

            {/* Dates */}
            <View style={s.rowBetween}>
              <Text style={s.h2}>Test dates</Text>
              <View style={s.rowGap}>
                <TouchableOpacity onPress={() => setSelDates(new Set(rep.dates))}><Text style={s.link}>All</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setSelDates(new Set())}><Text style={s.link}>None</Text></TouchableOpacity>
              </View>
            </View>
            <View style={s.chips}>
              {rep.dates.map(d => {
                const on = selDates.has(d);
                return <TouchableOpacity key={d} onPress={() => toggleDate(d)} style={[s.chip, on && s.chipOn]}>
                  <Text style={[s.chipTxt, on && s.chipTxtOn]}>{d}</Text></TouchableOpacity>;
              })}
            </View>

            {/* Analytes by category */}
            <View style={s.rowBetween}>
              <Text style={s.h2}>Markers</Text>
              <View style={s.rowGap}>
                <TouchableOpacity onPress={() => setSelKeys(new Set(rep.analytes.map(a => a.key)))}><Text style={s.link}>All</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setSelKeys(new Set())}><Text style={s.link}>None</Text></TouchableOpacity>
              </View>
            </View>
            {groups.map(([cat, items]) => {
              const allOn = items.every(a => selKeys.has(a.key));
              return (
                <View key={cat} style={s.catBlock}>
                  <TouchableOpacity style={s.catHead} onPress={() => setCat(items, !allOn)}>
                    <Text style={[s.cbBox, allOn && s.cbBoxOn]}>{allOn ? '✓' : ''}</Text>
                    <Text style={s.catTitle}>{cat}</Text>
                    <Text style={s.catCount}>{items.length}</Text>
                  </TouchableOpacity>
                  {items.map(a => {
                    const on = selKeys.has(a.key);
                    const n = pointsIn(a);
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
                          <Text style={s.aUnit}>{a.unit || '—'}</Text>
                          <Text style={s.aN}>{n}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
            <View style={{ height: 88 }} />
          </ScrollView>

          <View style={s.footer}>
            <TouchableOpacity style={[s.btnPrimary, (selAnalyteCount === 0) && s.btnDisabled]} disabled={selAnalyteCount === 0} onPress={doImport}>
              <Text style={s.btnPrimaryTxt}>Import {selPointCount} values</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {phase === 'importing' && <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.pFaint}>Saving…</Text></View>}

      {phase === 'done' && result && (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.h1}>✅ Imported</Text>
          <Text style={s.p}>{result.points} values across {result.analytes} markers are now in your in-app Labs store.</Text>
          <Text style={s.pFaint}>{result.mirrored} markers are eligible to mirror to Apple Health (Weight / BP / Glucose) — that step lands next.</Text>
          <TouchableOpacity style={[s.btnPrimary, { marginTop: 20 }]} onPress={() => router.back()}><Text style={s.btnPrimaryTxt}>Done</Text></TouchableOpacity>
          <TouchableOpacity style={s.btnGhost} onPress={() => { setPhase('idle'); setRep(null); setResult(null); }}><Text style={s.btnGhostTxt}>Import another file</Text></TouchableOpacity>
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
  card:     { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 14, marginBottom: 12 },
  cardTitle:{ color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  sel:      { color: c.accent, fontSize: 13, fontWeight: '700', marginTop: 6 },
  warn:     { color: c.textSub, fontSize: 12.5, lineHeight: 19 },
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
  catTitle: { color: c.text, fontSize: 14, fontWeight: '700', flex: 1 },
  catCount: { color: c.textFaint, fontSize: 12, fontWeight: '600' },
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
  btnDisabled:{ opacity: 0.4 },
  btnGhost: { paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  btnGhostTxt:{ color: c.accent, fontSize: 14, fontWeight: '700' },
});
