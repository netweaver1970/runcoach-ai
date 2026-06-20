import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, SafeAreaView, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { callLLMWithImage } from '../src/services/llm';
import {
  buildBevelExtractionPrompt, parseBevelExtraction, saveBevelKpi,
  allBevelDays, deleteBevelDay, formatCanonical, BevelDay, BevelKpiKey, BevelKpiRecord,
} from '../src/services/bevelData';
import { kpiScale } from '../src/services/bevelScales';
import { useThemedStyles, useTheme, Palette } from '../src/theme';

const KPI_COLOR: Record<BevelKpiKey, string> = {
  strain:   '#e67e22',
  recovery: '#27ae60',
  sleep:    '#7c6cf0',
};

interface ReviewItem {
  id:     string;
  kpi:    BevelKpiKey;
  date:   string;                 // editable YYYY-MM-DD
  record: BevelKpiRecord;
  saved:  boolean;
}
interface FailItem { id: string; error: string; }

export default function BevelImportScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();

  const [phase, setPhase]   = useState<'idle' | 'working' | 'review'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [items, setItems]   = useState<ReviewItem[]>([]);
  const [fails, setFails]   = useState<FailItem[]>([]);
  const [stored, setStored] = useState<BevelDay[]>([]);

  const refreshStored = () => allBevelDays().then(setStored);
  useEffect(() => { refreshStored(); }, []);

  const pickAndExtract = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photo access needed', 'Allow photo access in iOS Settings to import Bevel screenshots.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      base64: true,
      quality: 1,
    });
    if (res.canceled || res.assets.length === 0) return;

    setPhase('working');
    setItems([]); setFails([]);
    setProgress({ done: 0, total: res.assets.length });

    const prompt = buildBevelExtractionPrompt();
    const today = new Date().toISOString().slice(0, 10);
    const good: ReviewItem[] = [];
    const bad: FailItem[] = [];

    for (let i = 0; i < res.assets.length; i++) {
      const asset = res.assets[i];
      const id = `${Date.now()}-${i}`;
      try {
        if (!asset.base64) throw new Error('Could not read image data.');
        const reply = await callLLMWithImage({ prompt, imageBase64: asset.base64, mediaType: 'image/png', maxTokens: 1024 });
        const ext = parseBevelExtraction(reply);
        good.push({ id, kpi: ext.kpi as BevelKpiKey, date: ext.date ?? today, record: ext.record, saved: false });
      } catch (e: any) {
        bad.push({ id, error: e?.message ?? String(e) });
      }
      setProgress({ done: i + 1, total: res.assets.length });
    }

    setItems(good); setFails(bad);
    setPhase('review');
  };

  const setDate = (id: string, date: string) =>
    setItems(prev => prev.map(it => (it.id === id ? { ...it, date, saved: false } : it)));

  const saveItem = async (it: ReviewItem) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) {
      Alert.alert('Invalid date', 'Use the format YYYY-MM-DD (e.g. 2026-06-20).');
      return;
    }
    await saveBevelKpi(it.date, it.kpi, it.record);
    setItems(prev => prev.map(p => (p.id === it.id ? { ...p, saved: true } : p)));
    refreshStored();
  };

  const saveAll = async () => {
    for (const it of items) if (!it.saved) await saveItem(it);
  };

  const removeDay = (date: string) => {
    Alert.alert('Delete Bevel day?', date, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteBevelDay(date); refreshStored(); } },
    ]);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Bevel Import</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.intro}>
          Import Bevel screenshots (overview or a single metric). Each is read by the AI, then you confirm
          the date and save. Values are stored alongside ours for calibration.
        </Text>

        <TouchableOpacity style={s.pickBtn} onPress={pickAndExtract} disabled={phase === 'working'}>
          <Text style={s.pickBtnText}>＋ Pick screenshots</Text>
        </TouchableOpacity>

        {phase === 'working' && (
          <View style={s.workRow}>
            <ActivityIndicator color={c.accent} />
            <Text style={s.workText}>Reading {progress.done}/{progress.total}…</Text>
          </View>
        )}

        {/* Review */}
        {items.map(it => {
          const scale = kpiScale(it.kpi);
          const rows = scale.components.filter(comp => it.record.components[comp.key] !== undefined);
          return (
            <View key={it.id} style={s.card}>
              <View style={s.cardHead}>
                <View style={[s.kpiBadge, { backgroundColor: KPI_COLOR[it.kpi] + (c.mode === 'dark' ? '2e' : '22') }]}>
                  <Text style={[s.kpiBadgeText, { color: KPI_COLOR[it.kpi] }]}>{scale.label}</Text>
                </View>
                {it.saved
                  ? <Text style={s.savedTag}>✓ Saved</Text>
                  : <TouchableOpacity style={s.saveBtn} onPress={() => saveItem(it)}><Text style={s.saveBtnText}>Save</Text></TouchableOpacity>}
              </View>

              <View style={s.dateRow}>
                <Text style={s.dateLabel}>Date</Text>
                <TextInput
                  style={s.dateInput}
                  value={it.date}
                  onChangeText={t => setDate(it.id, t)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={c.textFaint}
                  autoCapitalize="none"
                  keyboardType="numbers-and-punctuation"
                />
              </View>

              {rows.map(comp => (
                <View key={comp.key} style={s.valRow}>
                  <Text style={s.valLabel}>{comp.label}{comp.isScore ? ' ★' : ''}</Text>
                  <Text style={s.valNum}>{formatCanonical(comp.unit, it.record.components[comp.key])}</Text>
                </View>
              ))}
            </View>
          );
        })}

        {items.length > 1 && (
          <TouchableOpacity style={s.saveAllBtn} onPress={saveAll}>
            <Text style={s.saveAllText}>Save all ({items.filter(i => !i.saved).length} unsaved)</Text>
          </TouchableOpacity>
        )}

        {fails.map(f => (
          <View key={f.id} style={s.failCard}>
            <Text style={s.failText}>⚠️ {f.error}</Text>
          </View>
        ))}

        {/* Stored */}
        <Text style={s.sectionTitle}>Stored Bevel days · {stored.length}</Text>
        {stored.length === 0 && <Text style={s.empty}>Nothing imported yet.</Text>}
        {[...stored].reverse().map(d => {
          const tags = (['strain', 'recovery', 'sleep'] as BevelKpiKey[]).filter(k => d[k]);
          return (
            <View key={d.date} style={s.storedRow}>
              <Text style={s.storedDate}>{d.date}</Text>
              <View style={s.storedTags}>
                {tags.map(k => (
                  <View key={k} style={[s.dot, { backgroundColor: KPI_COLOR[k] }]} />
                ))}
                <Text style={s.storedTagText}>{tags.join(' · ') || '—'}</Text>
              </View>
              <TouchableOpacity onPress={() => removeDay(d.date)} style={{ paddingHorizontal: 6 }}>
                <Text style={s.del}>✕</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  backText: { color: c.accent, fontSize: 16, fontWeight: '600' },
  title: { color: c.text, fontSize: 17, fontWeight: '700' },
  scroll: { padding: 14, paddingBottom: 48 },
  intro: { color: c.textSub, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  pickBtn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  pickBtnText: { color: c.onAccent, fontSize: 15, fontWeight: '700' },
  workRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, justifyContent: 'center' },
  workText: { color: c.textSub, fontSize: 14 },

  card: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginTop: 14, borderWidth: 1, borderColor: c.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  kpiBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  kpiBadgeText: { fontSize: 13, fontWeight: '700' },
  saveBtn: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 },
  saveBtnText: { color: c.onAccent, fontSize: 13, fontWeight: '700' },
  savedTag: { color: '#27ae60', fontSize: 13, fontWeight: '700' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  dateLabel: { color: c.textSub, fontSize: 13, width: 44 },
  dateInput: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, color: c.text, fontSize: 14, borderWidth: 1, borderColor: c.border },
  valRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderTopWidth: 1, borderTopColor: c.border },
  valLabel: { color: c.textSub, fontSize: 14 },
  valNum: { color: c.text, fontSize: 14, fontWeight: '600' },

  saveAllBtn: { marginTop: 14, borderWidth: 1, borderColor: c.accent, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  saveAllText: { color: c.accent, fontSize: 14, fontWeight: '700' },

  failCard: { backgroundColor: c.surface, borderRadius: 10, padding: 12, marginTop: 12, borderWidth: 1, borderColor: '#c0392b55' },
  failText: { color: '#e74c3c', fontSize: 13 },

  sectionTitle: { color: c.textFaint, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 26, marginBottom: 8 },
  empty: { color: c.textFaint, fontSize: 13 },
  storedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border },
  storedDate: { color: c.text, fontSize: 14, fontWeight: '600', width: 96 },
  storedTags: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  storedTagText: { color: c.textSub, fontSize: 12, marginLeft: 4 },
  del: { color: c.textFaint, fontSize: 16 },
});
