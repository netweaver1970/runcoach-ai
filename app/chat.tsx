import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
  ActivityIndicator,
  SafeAreaView,
  Keyboard,
  KeyboardEvent,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { TABLE_CELL } from '../src/mdTable';
import MarkdownBody from '../src/MarkdownBody';
import { loadSnapshotCache } from '../src/services/healthkit';
import { loadRunMeta } from '../src/services/runMeta';
import { getCachedPlace } from '../src/services/weather';
import {
  getChatResponse,
  updateMemoryNote,
  buildNewRunUserMessage,
  ChatMessage,
  CHAT_MODEL,
} from '../src/services/claude';
import {
  loadChatPersistence,
  saveChatPersistence,
  clearChatPersistence,
  toApiMessages,
  trimForApi,
  makeMsg,
  PersistedMessage,
} from '../src/services/chatMemory';
import { formatUsage, lastCallUsage } from '../src/services/tokenUsage';
import { loadPrescriptionAt, assembleCoachSnapshot } from '../src/services/coach';
import { buildPrescriptionContext, buildBudgetContext } from '../src/services/runAnalysis';
import { loadSupplements, hrOffsetByDay } from '../src/services/supplements';
import { transcribeAudio, transcriptionReady } from '../src/services/transcription';
import { startRecording, stopRecording, cancelRecording, ensureMicPermission } from '../src/services/voiceRecorder';
import { HealthSnapshot } from '../src/types';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

// ─── Local context (location + time) ─────────────────────────────────────────
// Derive city name from IANA timezone — no location permissions needed.

function getLocalContext(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Real GPS-geocoded place (e.g. "Merelbeke"); the timezone city ("Brussels" for all of
  // Belgium) is only a last-resort fallback before the first weather fetch lands.
  const place = getCachedPlace() || tz.split('/').pop()?.replace(/_/g, ' ') || '';
  const time = new Date().toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: tz,
  });
  return place ? `Location: ${place} · ${time}` : time;
}

// ─── Quick-action chips ───────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  'Should I train hard today?',
  'What does my RMSSD trend say?',
  'How is my VO₂ Max progressing?',
  'Am I overtraining?',
  'What workout do you suggest today?',
  'How does my sleep affect my running?',
  'When should I do my next long run?',
  'Compare my avg HR in tempo vs Z2 runs',
  'How is my Z2 fitness trending?',
  'Show my interval progression over time',
  'Which workout type am I most efficient at?',
  'How does my pace compare across workout types?',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id:       string;
  role:     'user' | 'assistant' | 'system';
  content:  string;
  loading?: boolean;
  usage?:   string;   // token/cost line for THIS reply (see tokenUsage.formatUsage)
}

// Make rendered markdown selectable: `selectable` on the wrapping textgroup <Text>
// propagates to all nested Text (RN behaviour), so inline bold/italic styling is kept
// while the whole answer can be highlighted/copied for debugging.
const SELECTABLE_RULES = {
  textgroup: (node: any, children: React.ReactNode, _parent: any, mdStyles: any) => (
    <Text key={node.key} style={mdStyles.textgroup} selectable>{children}</Text>
  ),
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const styles = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const mdAssistant = useThemedStyles(makeMdAssistant);
  const { data, focusRunUUID, runDetailJson } = useLocalSearchParams<{ data?: string; focusRunUUID?: string; runDetailJson?: string }>();
  const [snapshot, setSnapshot]       = useState<HealthSnapshot | null>(data ? JSON.parse(data) : null);

  const [messages,       setMessages]       = useState<Message[]>([]);
  const [input,          setInput]          = useState('');
  const [sending,        setSending]        = useState(false);
  const [voiceState,     setVoiceState]     = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [showChips,      setShowChips]      = useState(true);
  const [memoryNote,     setMemoryNote]     = useState('');
  const [isLoaded,       setIsLoaded]       = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { height: screenHeight } = useWindowDimensions();
  const listRef      = useRef<FlatList>(null);
  const atBottomRef  = useRef(true);   // is the list scrolled to (near) the bottom? gates auto-stick-to-bottom
  const inputRef     = useRef<TextInput>(null);

  // Full persisted history (with timestamps). Only toApiMessages() result goes to the API.
  const historyRef        = useRef<PersistedMessage[]>([]);
  const lastSeenRunRef    = useRef<string | undefined>(undefined);
  const localContextRef   = useRef<string>(getLocalContext());

  // ── Dynamic keyboard height ─────────────────────────────────────────────────
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide'        : 'keyboardDidHide';

    const onShow = (e: KeyboardEvent) => {
      const kbH = screenHeight - e.endCoordinates.screenY;
      setKeyboardHeight(Math.max(0, kbH));
    };
    const onHide = () => setKeyboardHeight(0);

    const sub1 = Keyboard.addListener(showEvent, onShow);
    const sub2 = Keyboard.addListener(hideEvent, onHide);
    return () => { sub1.remove(); sub2.remove(); };
  }, [screenHeight]);

  // ── Load persisted history on mount ────────────────────────────────────────
  useEffect(() => {
    // Refresh localContext at load time (time may have changed since module init)
    localContextRef.current = getLocalContext();

    const init = async () => {
      // If no data passed but focusRunUUID present, load from cache
      let snap = snapshot;
      if (!snap && focusRunUUID) {
        snap = await loadSnapshotCache();
        if (snap) {
          // Cache may predate a note/temp just edited on the detail screen — merge
          // the latest per-run metadata so the focal run + comparisons are current.
          try {
            const runMeta = await loadRunMeta();
            snap = {
              ...snap,
              runs: snap.runs.map(r => {
                const m = runMeta[r.uuid];
                if (!m) return r;
                const tempC = m.tempSource === 'manual' && m.tempC != null ? m.tempC : r.tempC;
                return { ...r, note: m.note ?? r.note, tempC };
              }),
            };
          } catch {}
          setSnapshot(snap);
        }
      }

      if (!snap) {
        setMessages([{ id: 'err', role: 'system', content: 'No health data loaded. Go back and try again.' }]);
        setIsLoaded(true);
        return;
      }

      const saved = await loadChatPersistence();
      const latestRun = snap.runs[0] ?? null;
      // Per-day HR offset (yohimbine dose + coffee) → the run-analysis HR-corrects EF/SE for those runs.
      const yohOffsets = await loadSupplements().then(d => hrOffsetByDay(d)).catch(() => ({} as Record<string, number>));
      // The PURE rolling ToF budget, so the analysis doesn't mistake a readiness-reduced day for "no budget".
      const budgetCtx = buildBudgetContext(await assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs).catch(() => null));

      if (saved && saved.messages.length > 0) {
        // Restore previous conversation
        const savedAt  = new Date(saved.savedAt);
        const dateStr  = savedAt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const timeStr  = savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const divider: Message = {
          id:      'divider-' + saved.savedAt,
          role:    'system',
          content: `— continuing from ${dateStr} ${timeStr} —`,
        };
        // A prior analysis that returned EMPTY (e.g. a reasoning model that spent its whole token budget
        // thinking) persisted a BLANK assistant bubble AND advanced lastSeenRunUUID — so it displayed
        // forever and never retried. Drop blank messages; if the last turn was a blank reply, also drop its
        // orphaned trigger prompt and re-fire the analysis below (lastReplyBlank).
        const rawMsgs = saved.messages;
        const lastReplyBlank =
          rawMsgs[rawMsgs.length - 1]?.role === 'assistant' && !rawMsgs[rawMsgs.length - 1].content.trim();
        let restoreMsgs = rawMsgs.filter(m => m.content && m.content.trim());
        if (lastReplyBlank) {
          while (restoreMsgs.length && restoreMsgs[restoreMsgs.length - 1].role === 'user') restoreMsgs.pop();
        }

        const restored: Message[] = restoreMsgs.map((m, i) => ({
          id:      `hist-${i}`,
          role:    m.role,
          content: m.content,
        }));
        setMessages(restoreMsgs.length ? [divider, ...restored] : []);
        setMemoryNote(saved.memoryNote ?? '');
        historyRef.current     = restoreMsgs;
        lastSeenRunRef.current = saved.lastSeenRunUUID;
        setShowChips(false);

        // ── focusRunUUID: analyze a specific run ───────────────────────────
        if (focusRunUUID) {
          const focusRun = snap.runs.find(r => r.uuid === focusRunUUID);
          if (focusRun) {
            const sameType = snap.runs
              .filter(r => r.uuid !== focusRun.uuid && r.label === focusRun.label)
              .slice(0, 10);
            const parsedDetail = runDetailJson ? (() => { try { return JSON.parse(runDetailJson); } catch { return undefined; } })() : undefined;
            // Full data → system prompt (invisible); short question → visible user message.
            // Append the day's prescription so the coach judges the run against the plan.
            const plan = await loadPrescriptionAt(focusRun.date.slice(0, 10), new Date(focusRun.date).getTime()).catch(() => null);
            const systemContext = [
              buildNewRunUserMessage(focusRun, sameType, focusRun.kmSplits, true, parsedDetail, yohOffsets),
              buildPrescriptionContext(plan), budgetCtx,
            ].filter(Boolean).join('\n\n');
            const shortMsg = `Analyze my ${focusRun.label ?? 'run'} from ${new Date(focusRun.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} and compare with my last ${sameType.length} ${focusRun.label} runs.`;
            setIsLoaded(true);
            setTimeout(() => autoSend(shortMsg, snap, systemContext), 400);
            return;
          }
        }

        // ── Auto new-run analysis ──────────────────────────────────────────
        // Trigger only when: we have a tracked lastSeenRunUUID AND the newest
        // run is different (i.e., a new run completed since the last chat).
        if (
          latestRun &&
          ((saved.lastSeenRunUUID && latestRun.uuid !== saved.lastSeenRunUUID) || lastReplyBlank)
        ) {
          const sameType = snap.runs
            .filter(r => r.uuid !== latestRun.uuid && r.label === latestRun.label)
            .slice(0, 5);
          // Hide the raw run-data block in the system prompt (same as the "Analyse run" button) and show a
          // short human message — not a wall of metrics. Passing systemContext also starts the analysis
          // CLEAN (autoSend drops prior chat history when systemContext is present).
          const plan = await loadPrescriptionAt(latestRun.date.slice(0, 10), new Date(latestRun.date).getTime()).catch(() => null);
          const systemContext = [
            buildNewRunUserMessage(latestRun, sameType, undefined, undefined, undefined, yohOffsets),
            buildPrescriptionContext(plan), budgetCtx,
          ].filter(Boolean).join('\n\n');
          const shortMsg = `I just finished a ${latestRun.label ?? 'run'}. Analyze it and compare with my last ${sameType.length} ${latestRun.label ?? 'run'} runs.`;
          lastSeenRunRef.current = latestRun.uuid;
          setIsLoaded(true);
          // Auto-send after a short delay so the restored history renders first
          setTimeout(() => autoSend(shortMsg, snap, systemContext), 400);
          return;
        }
      } else {
        // ── focusRunUUID on fresh chat ─────────────────────────────────────
        if (focusRunUUID) {
          const focusRun = snap.runs.find(r => r.uuid === focusRunUUID);
          if (focusRun) {
            const sameType = snap.runs
              .filter(r => r.uuid !== focusRun.uuid && r.label === focusRun.label)
              .slice(0, 10);
            const parsedDetail = runDetailJson ? (() => { try { return JSON.parse(runDetailJson); } catch { return undefined; } })() : undefined;
            const plan = await loadPrescriptionAt(focusRun.date.slice(0, 10), new Date(focusRun.date).getTime()).catch(() => null);
            const systemContext = [
              buildNewRunUserMessage(focusRun, sameType, focusRun.kmSplits, true, parsedDetail, yohOffsets),
              buildPrescriptionContext(plan), budgetCtx,
            ].filter(Boolean).join('\n\n');
            const shortMsg = `Analyze my ${focusRun.label ?? 'run'} from ${new Date(focusRun.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} and compare with my last ${sameType.length} ${focusRun.label} runs.`;
            if (latestRun) lastSeenRunRef.current = latestRun.uuid;
            setIsLoaded(true);
            setTimeout(() => autoSend(shortMsg, snap, systemContext), 400);
            return;
          }
        }

        // Fresh start — show greeting
        const rec = snap.todayRecovery;
        let greeting = '👋 Morning! ';
        if (rec && rec.weightedRMSSD > 0) {
          const emoji = rec.recoveryScore >= 80 ? '🟢' : rec.recoveryScore >= 60 ? '🟡' : '🔴';
          greeting += `${emoji} Your recovery score is **${rec.recoveryScore}/100** (${rec.label}) — RMSSD ${rec.weightedRMSSD} ms vs your ${rec.baseline7Day} ms baseline.\n\nWhat would you like to know?`;
        } else {
          greeting += "Sleep data hasn't synced yet, so I don't have your recovery score. I can still answer questions about your recent runs and fitness trends.\n\nWhat would you like to know?";
        }
        setMessages([{ id: 'greeting', role: 'assistant', content: greeting }]);

        // Track lastSeenRunUUID from the start so future new runs trigger analysis
        if (latestRun) lastSeenRunRef.current = latestRun.uuid;
      }

      setIsLoaded(true);
    };

    init();
  }, []);

  // ── autoSend — silently injects a user message + gets Claude response ───────
  // Used for the new-run analysis trigger. Adds a visible "thinking" state.
  // snapOverride lets callers pass the freshly-loaded snapshot directly,
  // bypassing the React-closure stale-state problem (autoSend is created before
  // setSnapshot re-renders, so the closure captures the old null value).
  // systemContext is injected invisibly into the system prompt (doesn't appear in chat UI).
  const autoSend = useCallback(async (text: string, snapOverride?: HealthSnapshot | null, systemContext?: string) => {
    const activeSnap = snapOverride ?? snapshot;
    if (!activeSnap) return;
    localContextRef.current = getLocalContext(); // refresh time on every send

    const loadingId = 'auto-loading';
    const userMsg: Message    = { id: 'auto-user', role: 'user', content: text };
    const loadingMsg: Message = { id: loadingId, role: 'assistant', content: '', loading: true };
    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setSending(true);
    setTimeout(() => { atBottomRef.current = true; listRef.current?.scrollToEnd({ animated: true }); }, 100);

    const now       = new Date().toISOString();
    const persisted = makeMsg('user', text, now);
    // A run analysis is a SELF-CONTAINED report: the run data it needs is injected into the system
    // prompt via systemContext, and the coaching files + memory note ride along there too. Prior chat
    // turns add nothing it uses — they were just 24k tokens of ballast on every analysis. Start clean.
    const apiHistory: ChatMessage[] = systemContext
      ? toApiMessages([persisted])
      : toApiMessages(trimForApi([...historyRef.current, persisted]));

    try {
      const reply    = await getChatResponse(activeSnap, apiHistory, memoryNote, localContextRef.current, undefined, systemContext);
      const replyMsg = makeMsg('assistant', reply);
      const usageLine = formatUsage(lastCallUsage());
      const full: PersistedMessage[] = [...historyRef.current, persisted, replyMsg];
      historyRef.current = full;
      lastSeenRunRef.current = activeSnap.runs[0]?.uuid;

      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { id: 'auto-reply', role: 'assistant', content: reply, usage: usageLine },
      ]);

      updateMemoryNote(toApiMessages(full), memoryNote, activeSnap, localContextRef.current)
        .then(updatedMemory => {
          setMemoryNote(updatedMemory);
          saveChatPersistence(full, updatedMemory, lastSeenRunRef.current);
        })
        .catch(() => saveChatPersistence(full, memoryNote, lastSeenRunRef.current));
    } catch (err: any) {
      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { id: 'auto-err', role: 'system', content: `⚠️ ${err.message}` },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => { atBottomRef.current = true; listRef.current?.scrollToEnd({ animated: true }); }, 100);
    }
  }, [snapshot, memoryNote]);

  // ── New conversation ─────────────────────────────────────────────────────────
  const handleNewChat = useCallback(() => {
    Alert.alert(
      'New conversation',
      'Start a fresh chat? Your coaching memory (goals, patterns) will be kept — only the conversation messages are cleared.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start fresh',
          onPress: async () => {
            await clearChatPersistence();
            historyRef.current = [];
            const rec = snapshot?.todayRecovery;
            let greeting = '👋 Starting fresh! ';
            if (rec && rec.weightedRMSSD > 0) {
              const emoji = rec!.recoveryScore >= 80 ? '🟢' : rec!.recoveryScore >= 60 ? '🟡' : '🔴';
              greeting += `${emoji} Recovery score today: **${rec!.recoveryScore}/100** (${rec!.label}).\n\nWhat would you like to talk about?`;
            } else {
              greeting += 'What would you like to work on today?';
            }
            setMessages([{ id: 'greeting-new', role: 'assistant', content: greeting }]);
            setShowChips(true);
            setMemoryNote('');
          },
        },
      ],
    );
  }, [snapshot]);

  // ── Send message ─────────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending || !snapshot) return;
    localContextRef.current = getLocalContext(); // refresh time on every send

    setShowChips(false);
    setInput('');
    Keyboard.dismiss();

    const now        = new Date().toISOString();
    const persisted  = makeMsg('user', trimmed, now);
    const loadingId  = 'loading-' + now;

    const userMsg: Message    = { id: now,      role: 'user',      content: trimmed };
    const loadingMsg: Message = { id: loadingId, role: 'assistant', content: '', loading: true };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setSending(true);
    setTimeout(() => { atBottomRef.current = true; listRef.current?.scrollToEnd({ animated: true }); }, 100);

    // Build API history: persisted messages (with time-gap labels) + new user turn
    const apiHistory: ChatMessage[] = toApiMessages(trimForApi([...historyRef.current, persisted]));

    try {
      const reply    = await getChatResponse(snapshot, apiHistory, memoryNote, localContextRef.current);
      const replyMsg = makeMsg('assistant', reply);
      const usageLine = formatUsage(lastCallUsage());
      const full: PersistedMessage[] = [...historyRef.current, persisted, replyMsg];
      historyRef.current = full;

      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { ...{ id: now + 'a', role: 'assistant', content: reply }, usage: usageLine },
      ]);

      // Update memory + persist in background
      updateMemoryNote(toApiMessages(full), memoryNote, snapshot, localContextRef.current)
        .then(updatedMemory => {
          setMemoryNote(updatedMemory);
          saveChatPersistence(full, updatedMemory, lastSeenRunRef.current);
        })
        .catch(() => {
          saveChatPersistence(full, memoryNote, lastSeenRunRef.current);
        });

    } catch (err: any) {
      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { id: 'err' + now, role: 'system', content: `⚠️ ${err.message}` },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => { atBottomRef.current = true; listRef.current?.scrollToEnd({ animated: true }); }, 100);
    }
  }, [sending, snapshot, memoryNote]);

  // ── Voice input — record → cloud transcribe → auto-send (hands-free) ─────────
  const handleMicPress = useCallback(async () => {
    if (voiceState === 'transcribing') return;

    // Recording → stop, transcribe, and send.
    if (voiceState === 'recording') {
      setVoiceState('transcribing');
      try {
        const uri = await stopRecording();
        if (!uri) { setVoiceState('idle'); return; }
        const text = (await transcribeAudio(uri)).trim();
        setVoiceState('idle');
        if (text) send(text);   // auto-send the transcript
        else Alert.alert('Voice input', 'No speech detected — try again.');
      } catch (e: any) {
        setVoiceState('idle');
        Alert.alert('Voice input', e?.message ?? 'Could not transcribe.');
      }
      return;
    }

    // Idle → start recording (after checking it's configured + permitted).
    if (!(await transcriptionReady())) {
      Alert.alert('Voice input not set up', 'Add a transcription key in Settings → Voice input first — it\'s free with Groq.');
      return;
    }
    if (!(await ensureMicPermission())) {
      Alert.alert('Microphone needed', 'Enable microphone access for RunCoachAI in iOS Settings to use voice input.');
      return;
    }
    try {
      await startRecording();
      setVoiceState('recording');
    } catch (e: any) {
      setVoiceState('idle');
      Alert.alert('Voice input', e?.message ?? 'Could not start recording.');
    }
  }, [voiceState, send]);

  // Drop any in-flight recording if the screen unmounts mid-capture.
  useEffect(() => () => { cancelRecording().catch(() => {}); }, []);

  // ── Copy helper (long-press a bubble or tap ⧉ Copy → whole message to clipboard) ─
  const copyMessage = useCallback(async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      Alert.alert('Copied', 'The full message is on your clipboard.');
    } catch {
      Alert.alert('Copy failed', 'Could not access the clipboard.');
    }
  }, []);

  // ── Render message ──────────────────────────────────────────────────────────
  const renderMessage = ({ item }: { item: Message }) => {
    if (item.loading) {
      return (
        <View style={[styles.bubble, styles.bubbleAssistant]}>
          <ActivityIndicator size="small" color="#888" />
        </View>
      );
    }
    if (item.role === 'system') {
      return (
        <View style={styles.systemMsg}>
          <Text style={styles.systemMsgText} selectable>{item.content}</Text>
        </View>
      );
    }

    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
        <View style={{ maxWidth: isUser ? '82%' : '92%' }}>
          <TouchableOpacity
            activeOpacity={0.9}
            onLongPress={() => copyMessage(item.content)}
            delayLongPress={300}
            style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
          >
            <MarkdownBody content={item.content} style={isUser ? mdStylesUser : mdAssistant} rules={SELECTABLE_RULES} c={c} />
          </TouchableOpacity>
          {/* What this reply cost. Shown because there is no way to query the Anthropic credit balance
              from a normal API key — see tokenUsage.ts — so per-call visibility is the honest substitute. */}
          {!isUser && item.usage ? <Text style={styles.usageLine}>{item.usage}</Text> : null}
          {/* Copy affordance — assistant answers (the ones you debug) get an explicit button */}
          {!isUser && (
            <TouchableOpacity onPress={() => copyMessage(item.content)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Text style={styles.copyBtn}>⧉ Copy</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Coach',
          headerRight: () => (
            <TouchableOpacity onPress={handleNewChat} style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ color: c.accent, fontSize: 14, fontWeight: '600' }}>New chat</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <View style={{ flex: 1, paddingBottom: keyboardHeight }}>
        {/* Memory indicator */}
        {memoryNote.length > 0 && (
          <TouchableOpacity
            style={styles.memoryPill}
            onPress={() => Alert.alert('Coaching memory', memoryNote)}
          >
            <Text style={styles.memoryPillText}>🧠 Coach remembers your goals & patterns</Text>
          </TouchableOpacity>
        )}

        {/* Message list */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={m => m.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.list}
          scrollEventThrottle={16}
          onScroll={e => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottomRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 60;
          }}
          // Only stick to the bottom on content growth if the user is ALREADY near it — otherwise a
          // re-layout (rotation, table/markdown re-measure) yanks them back down while they scroll up.
          onContentSizeChange={() => { if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false }); }}
        />

        {/* Quick-action chips */}
        {showChips && messages.length <= 1 && (
          <View style={styles.chips}>
            <FlatList
              horizontal
              data={QUICK_ACTIONS}
              keyExtractor={q => q}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.chip} onPress={() => send(item)}>
                  <Text style={styles.chipText}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        )}

        {/* Voice status line */}
        {voiceState !== 'idle' && (
          <Text style={styles.voiceHint}>
            {voiceState === 'recording' ? '● Listening… tap ⏹ to send' : 'Transcribing…'}
          </Text>
        )}

        {/* Input bar */}
        <View style={styles.inputBar}>
          <TouchableOpacity
            style={[styles.micBtn, voiceState === 'recording' && styles.micBtnRecording]}
            onPress={handleMicPress}
            disabled={sending && voiceState === 'idle'}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            {voiceState === 'transcribing'
              ? <ActivityIndicator size="small" color={c.accent} />
              : <Text style={styles.micBtnText}>{voiceState === 'recording' ? '⏹' : '🎤'}</Text>}
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Ask your coach anything…"
            placeholderTextColor="#bbb"
            multiline
            maxLength={1000}
            returnKeyType="send"
            onSubmitEditing={() => send(input)}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
            onPress={() => send(input)}
            disabled={!input.trim() || sending}
          >
            {sending
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.sendBtnText}>↑</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Markdown style sheets ────────────────────────────────────────────────────

const mdBase = {
  body:        { fontSize: 14, lineHeight: 20 },
  paragraph:   { marginTop: 0, marginBottom: 6 },
  strong:      { fontWeight: '700' as const },
  em:          { fontStyle: 'italic' as const },
  heading1:    { fontSize: 16, fontWeight: '700' as const, marginBottom: 6, marginTop: 4 },
  heading2:    { fontSize: 15, fontWeight: '700' as const, marginBottom: 4, marginTop: 4 },
  heading3:    { fontSize: 14, fontWeight: '700' as const, marginBottom: 2, marginTop: 2 },
  bullet_list: { marginBottom: 4 },
  ordered_list:{ marginBottom: 4 },
  list_item:   { marginBottom: 2 },
  code_inline: { fontFamily: 'Courier', fontSize: 12, backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 3, paddingHorizontal: 4 },
  fence:       { fontFamily: 'Courier', fontSize: 12, backgroundColor: 'rgba(0,0,0,0.06)', padding: 8, borderRadius: 6, marginBottom: 6 },
  table:       { borderWidth: 1, borderColor: '#ddd', borderRadius: 4, marginBottom: 8, overflow: 'hidden' as const },
  thead:       { backgroundColor: '#f0f0f0' },
  th:          { ...TABLE_CELL, fontWeight: '700' as const, padding: 4, fontSize: 10, borderRightWidth: 1, borderColor: '#ddd' },
  td:          { ...TABLE_CELL, padding: 4, fontSize: 10, borderRightWidth: 1, borderColor: '#ddd' },
  tr:          { borderBottomWidth: 1, borderColor: '#eee' },
  hr:          { borderBottomWidth: 1, borderColor: '#ddd', marginVertical: 8 },
  blockquote:  { borderLeftWidth: 3, borderColor: '#ccc', paddingLeft: 10, marginLeft: 0, opacity: 0.8 },
};

const makeMdAssistant = (c: Palette) => StyleSheet.create({
  ...mdBase,
  body:        { ...mdBase.body, color: c.text },
  strong:      { ...mdBase.strong, color: c.text },
  em:          { ...mdBase.em, color: c.text },
  heading1:    { ...mdBase.heading1, color: c.text },
  heading2:    { ...mdBase.heading2, color: c.text },
  heading3:    { ...mdBase.heading3, color: c.text },
  bullet_list: { ...mdBase.bullet_list, color: c.text },
  ordered_list:{ ...mdBase.ordered_list, color: c.text },
  list_item:   { ...mdBase.list_item, color: c.text },
  code_inline: { ...mdBase.code_inline, color: c.text, backgroundColor: c.surfaceAlt },
  fence:       { ...mdBase.fence, color: c.text, backgroundColor: c.surfaceAlt },
  table:       { ...mdBase.table, borderColor: c.border },
  thead:       { backgroundColor: c.surfaceAlt },
  th:          { ...mdBase.th, color: c.text, borderColor: c.border },
  td:          { ...mdBase.td, color: c.text, borderColor: c.border },
  tr:          { ...mdBase.tr, borderColor: c.border },
  hr:          { ...mdBase.hr, borderColor: c.border },
  blockquote:  { ...mdBase.blockquote, borderColor: c.border },
});

const mdStylesUser = StyleSheet.create({
  ...mdBase,
  body:        { ...mdBase.body, color: '#fff' },
  strong:      { ...mdBase.strong, color: '#fff' },
  heading1:    { ...mdBase.heading1, color: '#fff' },
  heading2:    { ...mdBase.heading2, color: '#fff' },
  heading3:    { ...mdBase.heading3, color: '#fff' },
  code_inline: { ...mdBase.code_inline, backgroundColor: 'rgba(255,255,255,0.2)' },
  fence:       { ...mdBase.fence, backgroundColor: 'rgba(255,255,255,0.15)' },
  table:       { ...mdBase.table, borderColor: 'rgba(255,255,255,0.4)' },
  thead:       { backgroundColor: 'rgba(255,255,255,0.2)' },
  th:          { ...mdBase.th, borderColor: 'rgba(255,255,255,0.3)', color: '#fff' },
  td:          { ...mdBase.td, borderColor: 'rgba(255,255,255,0.2)', color: '#fff' },
  tr:          { borderColor: 'rgba(255,255,255,0.2)' },
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  list:      { padding: 12, paddingBottom: 4 },

  memoryPill: {
    alignSelf: 'center',
    marginTop: 6,
    marginBottom: 2,
    backgroundColor: c.mode === 'dark' ? '#2a2440' : '#f0eaff',
    borderWidth: 1,
    borderColor: '#8e44ad55',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  memoryPillText: { fontSize: 12, color: '#9b6dd6', fontWeight: '500' },

  bubbleRow:     { marginBottom: 10, flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: c.accent,
    borderBottomRightRadius: 4,
    maxWidth: '82%',
  },
  bubbleAssistant: {
    backgroundColor: c.surface,
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: c.shadowOpacity,
    shadowRadius: 3,
    elevation: 2,
    minWidth: 48,
    minHeight: 36,
    justifyContent: 'center',
  },

  systemMsg:     { alignItems: 'center', marginVertical: 8 },
  systemMsgText: { fontSize: 12, color: c.textFaint, textAlign: 'center', fontStyle: 'italic' },
  usageLine: { fontSize: 10, color: c.textFaint, marginTop: 3, marginLeft: 4 },
  copyBtn:       { fontSize: 11, color: c.textFaint, fontWeight: '600', marginTop: 3, marginLeft: 6 },

  chips: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface },
  chip: {
    backgroundColor: c.mode === 'dark' ? '#3a2218' : '#FFF3EE',
    borderWidth: 1,
    borderColor: c.accent,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: { color: c.accent, fontSize: 13, fontWeight: '500' },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    paddingBottom: 6,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: c.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: c.textFaint },
  sendBtnText: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 24 },
  micBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border,
    alignItems: 'center', justifyContent: 'center',
  },
  micBtnRecording: { backgroundColor: '#e5484d', borderColor: '#e5484d' },
  micBtnText: { fontSize: 18 },
  voiceHint: { fontSize: 12, color: c.textFaint, textAlign: 'center', paddingBottom: 4 },
});
