import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, SafeAreaView, Share,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import MarkdownBody from '../src/MarkdownBody';
import { loadLatestRunAnalysis, maybeAnalyzeLatestRun, RunAnalysis } from '../src/services/runAnalysis';
import { TABLE_CELL } from '../src/mdTable';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { useLLMReady } from '../src/hooks/useLLMReady';

export default function RunAnalysisScreen() {
  const router = useRouter();
  const { runUUID } = useLocalSearchParams<{ runUUID?: string }>();
  const styles = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const llm = useLLMReady();
  const md = useThemedStyles(makeMarkdownStyles);

  const [analysis, setAnalysis] = useState<RunAnalysis | null>(null);
  const [loading, setLoading]   = useState(true);
  const [regenning, setRegenning] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Load the cached analysis (and refresh it whenever we return to this screen).
  const loadCached = useCallback(async () => {
    const a = await loadLatestRunAnalysis();
    setAnalysis(a);
    setLoading(false);
  }, []);

  useEffect(() => { loadCached(); }, [loadCached]);
  useFocusEffect(useCallback(() => { loadCached(); }, [loadCached]));

  const regenerate = async () => {
    setRegenning(true);
    setError(null);
    try {
      const a = await maybeAnalyzeLatestRun({ force: true, notify: false });
      if (a) setAnalysis(a);
      else setError('No recent run to analyse. Go for a run, then come back.');
    } catch (e: any) {
      setError(e?.message ?? 'Could not generate analysis.');
    } finally {
      setRegenning(false);
    }
  };

  const shareReport = async () => {
    if (!analysis) return;
    await Share.share({ message: `Run analysis — ${analysis.verdict}\n\n${analysis.full}` });
  };

  const dateLabel = analysis
    ? new Date(analysis.runDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      + ' · ' + new Date(analysis.runDate).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '';
  const genLabel = analysis
    ? new Date(analysis.generatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen options={{ title: 'Run Analysis' }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.accent} />
        </View>
      ) : !analysis ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🏁</Text>
          <Text style={styles.emptyText}>No run analysis yet.</Text>
          <Text style={styles.emptySub}>Your most recent run is analysed automatically when it finishes. You can also generate it now.</Text>
          <TouchableOpacity style={styles.btn} onPress={regenerate} disabled={regenning}>
            {regenning ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Analyse latest run</Text>}
          </TouchableOpacity>
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="never">
          {/* Verdict header */}
          <View style={styles.headerCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.verdict}>{analysis.verdict}</Text>
              <Text style={styles.runMeta}>{analysis.label} · {dateLabel}</Text>
            </View>
            {!analysis.hadPlan && <Text style={styles.noPlanPill}>no plan that day</Text>}
          </View>

          {/* Action bar */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionBtn} onPress={regenerate} disabled={regenning}>
              <Text style={styles.actionBtnText}>{regenning ? '…' : '↻ Refresh'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={shareReport}>
              <Text style={styles.actionBtnText}>↑ Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, !llm.ready && { opacity: 0.4 }]}
              disabled={!llm.ready}
              onPress={() => router.push({ pathname: '/chat', params: { focusRunUUID: analysis.runUUID } } as any)}
            >
              <Text style={styles.actionBtnText}>💬 Discuss</Text>
            </TouchableOpacity>
          </View>

          {error && <Text style={styles.errorText}>{error}</Text>}

          {/* Body */}
          <View style={styles.reportCard}>
            <MarkdownBody content={analysis.full} style={md} c={c} />
          </View>

          <Text style={styles.meta}>Generated {genLabel}</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 17, fontWeight: '700', color: c.text, marginBottom: 6 },
  emptySub: { fontSize: 13, color: c.textSub, textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  btn: { backgroundColor: c.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, minWidth: 180, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scroll: { padding: 14, paddingBottom: 40 },

  headerCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 10,
    borderLeftWidth: 4, borderLeftColor: c.accent,
  },
  verdict: { fontSize: 22, fontWeight: '800', color: c.text },
  runMeta: { fontSize: 13, color: c.textSub, marginTop: 3 },
  noPlanPill: {
    fontSize: 10, fontWeight: '700', color: c.textFaint, backgroundColor: c.surfaceAlt,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, overflow: 'hidden',
  },

  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: {
    flex: 1, backgroundColor: c.surface, borderRadius: 8, paddingVertical: 9,
    alignItems: 'center', borderWidth: 1, borderColor: c.border,
  },
  actionBtnText: { fontSize: 13, color: c.textSub, fontWeight: '600' },

  reportCard: {
    backgroundColor: c.surface, borderRadius: 14, padding: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: c.shadowOpacity, shadowRadius: 6, elevation: 3,
  },
  meta: { fontSize: 12, color: c.textFaint, marginTop: 12, textAlign: 'center' },
  errorText: { fontSize: 14, color: '#c0392b', textAlign: 'center', marginVertical: 10, lineHeight: 20 },
});

const makeMarkdownStyles = (c: Palette) => StyleSheet.create({
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  heading2: { fontSize: 16, fontWeight: '700', color: c.accent, marginTop: 14, marginBottom: 4 },
  strong: { fontWeight: '700', color: c.text },
  em: { fontStyle: 'italic', color: c.text },
  paragraph: { marginBottom: 8 },
  bullet_list: { marginBottom: 8, color: c.text },
  ordered_list: { marginBottom: 8, color: c.text },
  list_item: { marginBottom: 4, color: c.text },
  code_inline: { fontFamily: 'Courier', fontSize: 13, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: 3, paddingHorizontal: 4 },
  fence: { fontFamily: 'Courier', fontSize: 13, color: c.text, backgroundColor: c.surfaceAlt, padding: 8, borderRadius: 6, marginBottom: 6 },
  hr: { borderBottomWidth: 1, borderColor: c.border, marginVertical: 8 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: 4, marginBottom: 8, overflow: 'hidden' },
  thead: { backgroundColor: c.surfaceAlt },
  th: { ...TABLE_CELL, fontWeight: '700', padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  td: { ...TABLE_CELL, padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  tr: { borderBottomWidth: 1, borderColor: c.border },
});
