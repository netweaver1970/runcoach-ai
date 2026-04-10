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
import Markdown from 'react-native-markdown-display';
import { generateCoachingReport } from '../src/services/claude';
import {
  scheduleWeeklyCoachReminder,
  cancelWeeklyCoachReminder,
  isWeeklyReminderActive,
  requestNotificationPermissions,
} from '../src/services/notifications';
import { HealthSnapshot, CoachingReport } from '../src/types';

export default function AnalysisScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weeklyActive, setWeeklyActive] = useState(false);

  const snapshot: HealthSnapshot | null = data ? JSON.parse(data) : null;

  const generate = async () => {
    if (!snapshot) {
      setError('No health data available. Go back and refresh.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await generateCoachingReport(snapshot);
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
          <ActivityIndicator size="large" color="#FF6B35" />
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
        <ScrollView contentContainerStyle={styles.scroll}>
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
            <Markdown style={markdownStyles}>{report?.content ?? ''}</Markdown>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 16, fontSize: 16, color: '#333', fontWeight: '600' },
  loadingSubtext: { marginTop: 6, fontSize: 13, color: '#999' },
  errorIcon: { fontSize: 40, marginBottom: 12 },
  errorText: { fontSize: 15, color: '#c0392b', textAlign: 'center', marginBottom: 20, lineHeight: 22 },
  btn: {
    backgroundColor: '#FF6B35',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scroll: { padding: 14, paddingBottom: 40 },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  actionBtnActive: { backgroundColor: '#FF6B35', borderColor: '#FF6B35' },
  actionBtnText: { fontSize: 13, color: '#555', fontWeight: '600' },
  actionBtnActiveText: { color: '#fff' },
  meta: { fontSize: 12, color: '#aaa', marginBottom: 10, textAlign: 'center' },
  reportCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  dataSummary: {
    marginTop: 14,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#eee',
  },
  dataSummaryTitle: { fontSize: 11, fontWeight: '700', color: '#aaa', textTransform: 'uppercase', marginBottom: 4 },
  dataSummaryText: { fontSize: 13, color: '#777' },
});

const markdownStyles = StyleSheet.create({
  body: { color: '#222', fontSize: 15, lineHeight: 22 },
  heading2: { fontSize: 16, fontWeight: '700', color: '#FF6B35', marginTop: 16, marginBottom: 4 },
  strong: { fontWeight: '700', color: '#222' },
  paragraph: { marginBottom: 8 },
  bullet_list: { marginBottom: 8 },
  list_item: { marginBottom: 4 },
});
