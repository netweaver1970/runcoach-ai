import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Share,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import MarkdownBody from '../src/MarkdownBody';
import { generateCoachingReport } from '../src/services/claude';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  scheduleWeeklyCoachReminder,
  cancelWeeklyCoachReminder,
  isWeeklyReminderActive,
  requestNotificationPermissions,
} from '../src/services/notifications';
import { HealthSnapshot, CoachingReport } from '../src/types';
import { TABLE_CELL } from '../src/mdTable';
import { loadSnapshotCache } from '../src/services/healthkit';

export default function AnalysisScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const styles = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const markdownStyles = useThemedStyles(makeMarkdownStyles);
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weeklyActive, setWeeklyActive] = useState(false);

  const snapshot: HealthSnapshot | null = data ? JSON.parse(data) : null;

  const generate = async () => {
    // From the home button we get the snapshot as a param; from a notification tap we get none —
    // fall back to the cached snapshot so the report still works instead of erroring.
    let snap = snapshot ?? await loadSnapshotCache().catch(() => null);
    if (!snap) {
      setError('No health data available. Go back and refresh.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await generateCoachingReport(snap);
      setReport(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    generate();
    isWeeklyReminderActive().then(setWeeklyActive);
  }, []);

  const toggleWeekly = async () => {
    if (weeklyActive) {
      await cancelWeeklyCoachReminder();
      setWeeklyActive(false);
      Alert.alert('Weekly reminder cancelled.');
    } else {
      const granted = await requestNotificationPermissions();
      if (!granted) {
        Alert.alert('Notifications blocked', 'Enable notifications in iOS Settings to use this feature.');
        return;
      }
      await scheduleWeeklyCoachReminder();
      setWeeklyActive(true);
      Alert.alert('Weekly reminder set!', 'Every Monday at 8:00 AM you\'ll get a nudge to review your coaching report.');
    }
  };

  const shareReport = async () => {
    if (!report) return;
    await Share.share({ message: `My RunCoach AI Report\n\n${report.content}` });
  };

  const generatedDate = report
    ? new Date(report.generatedAt).toLocaleString('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <SafeAreaView style={styles.container}>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.accent} />
          <Text style={styles.loadingText}>Analysing your running data…</Text>
          <Text style={styles.loadingSubtext}>This takes 5–10 seconds</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={generate}>
            <Text style={styles.btnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="never">
          {/* Action bar */}
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionBtn} onPress={generate}>
              <Text style={styles.actionBtnText}>↻ Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={shareReport}>
              <Text style={styles.actionBtnText}>↑ Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, weeklyActive && styles.actionBtnActive]}
              onPress={toggleWeekly}
            >
              <Text style={[styles.actionBtnText, weeklyActive && styles.actionBtnActiveText]}>
                {weeklyActive ? '🔔 Weekly On' : '🔕 Weekly Off'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Meta info */}
          {generatedDate && (
            <Text style={styles.meta}>Generated {generatedDate} · {report?.model}</Text>
          )}

          {/* Report */}
          <View style={styles.reportCard}>
            <MarkdownBody content={report?.content ?? ''} style={markdownStyles} c={c} />
          </View>

          {/* Data summary */}
          {snapshot && (
            <View style={styles.dataSummary}>
              <Text style={styles.dataSummaryTitle}>Data used</Text>
              <Text style={styles.dataSummaryText}>
                {snapshot.runs.length} runs · {snapshot.vo2max.length} VO₂ Max readings · {snapshot.hrv.length} HRV readings · {snapshot.restingHR.length} resting HR readings
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 16, fontSize: 16, color: c.text, fontWeight: '600' },
  loadingSubtext: { marginTop: 6, fontSize: 13, color: c.textFaint },
  errorIcon: { fontSize: 40, marginBottom: 12 },
  errorText: { fontSize: 15, color: '#c0392b', textAlign: 'center', marginBottom: 20, lineHeight: 22 },
  btn: {
    backgroundColor: c.accent,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scroll: { padding: 14, paddingBottom: 40 },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: {
    flex: 1,
    backgroundColor: c.surface,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  actionBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
  actionBtnText: { fontSize: 13, color: c.textSub, fontWeight: '600' },
  actionBtnActiveText: { color: '#fff' },
  meta: { fontSize: 12, color: c.textFaint, marginBottom: 10, textAlign: 'center' },
  reportCard: {
    backgroundColor: c.surface,
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: c.shadowOpacity,
    shadowRadius: 6,
    elevation: 3,
  },
  dataSummary: {
    marginTop: 14,
    backgroundColor: c.surface,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
  },
  dataSummaryTitle: { fontSize: 11, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', marginBottom: 4 },
  dataSummaryText: { fontSize: 13, color: c.textSub },
});

const makeMarkdownStyles = (c: Palette) => StyleSheet.create({
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  heading2: { fontSize: 16, fontWeight: '700', color: c.accent, marginTop: 16, marginBottom: 4 },
  strong: { fontWeight: '700', color: c.text },
  em: { fontStyle: 'italic', color: c.text },
  paragraph: { marginBottom: 8 },
  bullet_list: { marginBottom: 8, color: c.text },
  ordered_list: { marginBottom: 8, color: c.text },
  list_item: { marginBottom: 4, color: c.text },
  code_inline: { fontFamily: 'Courier', fontSize: 13, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: 3, paddingHorizontal: 4 },
  fence: { fontFamily: 'Courier', fontSize: 13, color: c.text, backgroundColor: c.surfaceAlt, padding: 8, borderRadius: 6, marginBottom: 6 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: 4, marginBottom: 8, overflow: 'hidden' },
  thead: { backgroundColor: c.surfaceAlt },
  th: { ...TABLE_CELL, fontWeight: '700', padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  td: { ...TABLE_CELL, padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  tr: { borderBottomWidth: 1, borderColor: c.border },
  hr: { borderBottomWidth: 1, borderColor: c.border, marginVertical: 8 },
});
