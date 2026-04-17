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
import { loadSnapshotCache } from '../src/services/healthkit';
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
  makeMsg,
  PersistedMessage,
} from '../src/services/chatMemory';
import { HealthSnapshot } from '../src/types';

// ─── Local context (location + time) ─────────────────────────────────────────
// Derive city name from IANA timezone — no location permissions needed.

function getLocalContext(): string {
  const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? '';
  const time = new Date().toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
    timeZone: tz,
  });
  return city ? `${city} · ${time}` : time;
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
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { data, focusRunUUID } = useLocalSearchParams<{ data?: string; focusRunUUID?: string }>();
  const [snapshot, setSnapshot]       = useState<HealthSnapshot | null>(data ? JSON.parse(data) : null);

  const [messages,       setMessages]       = useState<Message[]>([]);
  const [input,          setInput]          = useState('');
  const [sending,        setSending]        = useState(false);
  const [showChips,      setShowChips]      = useState(true);
  const [memoryNote,     setMemoryNote]     = useState('');
  const [isLoaded,       setIsLoaded]       = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { height: screenHeight } = useWindowDimensions();
  const listRef      = useRef<FlatList>(null);
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
        if (snap) setSnapshot(snap);
      }

      if (!snap) {
        setMessages([{ id: 'err', role: 'system', content: 'No health data loaded. Go back and try again.' }]);
        setIsLoaded(true);
        return;
      }

      const saved = await loadChatPersistence();
      const latestRun = snap.runs[0] ?? null;

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
        const restored: Message[] = saved.messages.map((m, i) => ({
          id:      `hist-${i}`,
          role:    m.role,
          content: m.content,
        }));
        setMessages([divider, ...restored]);
        setMemoryNote(saved.memoryNote ?? '');
        historyRef.current     = saved.messages;
        lastSeenRunRef.current = saved.lastSeenRunUUID;
        setShowChips(false);

        // ── focusRunUUID: analyze a specific run ───────────────────────────
        if (focusRunUUID) {
          const focusRun = snap.runs.find(r => r.uuid === focusRunUUID);
          if (focusRun) {
            const sameType = snap.runs
              .filter(r => r.uuid !== focusRun.uuid && r.label === focusRun.label)
              .slice(0, 5);
            const userText = buildNewRunUserMessage(focusRun, sameType, focusRun.kmSplits);
            setIsLoaded(true);
            setTimeout(() => autoSend(userText), 400);
            return;
          }
        }

        // ── Auto new-run analysis ──────────────────────────────────────────
        // Trigger only when: we have a tracked lastSeenRunUUID AND the newest
        // run is different (i.e., a new run completed since the last chat).
        if (
          latestRun &&
          saved.lastSeenRunUUID &&
          latestRun.uuid !== saved.lastSeenRunUUID
        ) {
          const sameType = snap.runs
            .filter(r => r.uuid !== latestRun.uuid && r.label === latestRun.label)
            .slice(0, 5);
          const userText = buildNewRunUserMessage(latestRun, sameType);
          lastSeenRunRef.current = latestRun.uuid;
          setIsLoaded(true);
          // Auto-send after a short delay so the restored history renders first
          setTimeout(() => autoSend(userText), 400);
          return;
        }
      } else {
        // ── focusRunUUID on fresh chat ─────────────────────────────────────
        if (focusRunUUID) {
          const focusRun = snap.runs.find(r => r.uuid === focusRunUUID);
          if (focusRun) {
            const sameType = snap.runs
              .filter(r => r.uuid !== focusRun.uuid && r.label === focusRun.label)
              .slice(0, 5);
            const userText = buildNewRunUserMessage(focusRun, sameType, focusRun.kmSplits);
            if (latestRun) lastSeenRunRef.current = latestRun.uuid;
            setIsLoaded(true);
            setTimeout(() => autoSend(userText), 400);
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
  const autoSend = useCallback(async (text: string) => {
    if (!snapshot) return;

    const loadingId = 'auto-loading';
    const userMsg: Message    = { id: 'auto-user', role: 'user', content: text };
    const loadingMsg: Message = { id: loadingId, role: 'assistant', content: '', loading: true };
    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setSending(true);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);

    const now       = new Date().toISOString();
    const persisted = makeMsg('user', text, now);
    const apiHistory: ChatMessage[] = toApiMessages([...historyRef.current, persisted]);

    try {
      const reply    = await getChatResponse(snapshot, apiHistory, memoryNote, localContextRef.current);
      const replyMsg = makeMsg('assistant', reply);
      const full: PersistedMessage[] = [...historyRef.current, persisted, replyMsg];
      historyRef.current = full;
      lastSeenRunRef.current = snapshot.runs[0]?.uuid;

      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { id: 'auto-reply', role: 'assistant', content: reply },
      ]);

      updateMemoryNote(toApiMessages(full), memoryNote, snapshot, localContextRef.current)
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
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
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
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);

    // Build API history: persisted messages (with time-gap labels) + new user turn
    const apiHistory: ChatMessage[] = toApiMessages([...historyRef.current, persisted]);

    try {
      const reply    = await getChatResponse(snapshot, apiHistory, memoryNote, localContextRef.current);
      const replyMsg = makeMsg('assistant', reply);
      const full: PersistedMessage[] = [...historyRef.current, persisted, replyMsg];
      historyRef.current = full;

      setMessages(prev => [
        ...prev.filter(m => m.id !== loadingId),
        { id: now + 'a', role: 'assistant', content: reply },
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
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [sending, snapshot, memoryNote]);

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
          <Text style={styles.systemMsgText}>{item.content}</Text>
        </View>
      );
    }

    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubbleRow, isUser && styles.bubbleRowUser]}>
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
          <FormattedText text={item.content} isUser={isUser} />
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
              <Text style={{ color: '#FF6B35', fontSize: 14, fontWeight: '600' }}>New chat</Text>
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
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
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

        {/* Input bar */}
        <View style={styles.inputBar}>
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

// ─── Simple markdown renderer ─────────────────────────────────────────────────

function FormattedText({ text, isUser }: { text: string; isUser: boolean }) {
  const baseColor = isUser ? '#fff' : '#222';
  const boldColor = isUser ? '#fff' : '#111';

  const lines = text.split('\n');
  return (
    <Text>
      {lines.map((line, li) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/g);
        return (
          <Text key={li}>
            {parts.map((part, pi) => {
              if (part.startsWith('**') && part.endsWith('**')) {
                return (
                  <Text key={pi} style={{ fontWeight: '700', color: boldColor }}>
                    {part.slice(2, -2)}
                  </Text>
                );
              }
              return <Text key={pi} style={{ color: baseColor }}>{part}</Text>;
            })}
            {li < lines.length - 1 ? '\n' : ''}
          </Text>
        );
      })}
    </Text>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  list:      { padding: 12, paddingBottom: 4 },

  memoryPill: {
    alignSelf: 'center',
    marginTop: 6,
    marginBottom: 2,
    backgroundColor: '#f0eaff',
    borderWidth: 1,
    borderColor: '#c9b8f5',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  memoryPillText: { fontSize: 12, color: '#7c4dcc', fontWeight: '500' },

  bubbleRow:     { marginBottom: 10, flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: '#FF6B35',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
    minWidth: 48,
    minHeight: 36,
    justifyContent: 'center',
  },

  systemMsg:     { alignItems: 'center', marginVertical: 8 },
  systemMsgText: { fontSize: 12, color: '#aaa', textAlign: 'center', fontStyle: 'italic' },

  chips: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#eee', backgroundColor: '#fff' },
  chip: {
    backgroundColor: '#FFF3EE',
    borderWidth: 1,
    borderColor: '#FF6B35',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: { color: '#FF6B35', fontSize: 13, fontWeight: '500' },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    paddingBottom: 6,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    backgroundColor: '#F5F5F5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#222',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#ccc' },
  sendBtnText: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 24 },
});
