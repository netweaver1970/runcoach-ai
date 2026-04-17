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
import { getChatResponse, updateMemoryNote, ChatMessage, CHAT_MODEL } from '../src/services/claude';
import { loadChatPersistence, saveChatPersistence, clearChatPersistence } from '../src/services/chatMemory';
import { HealthSnapshot } from '../src/types';

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
  const { data } = useLocalSearchParams<{ data: string }>();
  const snapshot: HealthSnapshot | null = data ? JSON.parse(data) : null;

  const [messages,       setMessages]       = useState<Message[]>([]);
  const [input,          setInput]          = useState('');
  const [sending,        setSending]        = useState(false);
  const [showChips,      setShowChips]      = useState(true);
  const [memoryNote,     setMemoryNote]     = useState('');
  const [isLoaded,       setIsLoaded]       = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { height: screenHeight } = useWindowDimensions();
  const listRef   = useRef<FlatList>(null);
  const inputRef  = useRef<TextInput>(null);
  // Keep a ref to the current ChatMessage history so the memory updater
  // always sees the latest version without needing it as a dependency.
  const historyRef = useRef<ChatMessage[]>([]);

  // ── Dynamic keyboard height ──────────────────────────────────────────────────
  // Read the actual keyboard frame from the OS rather than using a hardcoded
  // keyboardVerticalOffset. This handles any keyboard (SwiftKey, Gboard, etc.)
  // regardless of extra toolbars or number rows.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide'        : 'keyboardDidHide';

    const onShow = (e: KeyboardEvent) => {
      // screenY is the top edge of the keyboard in screen coordinates.
      // screenHeight - screenY = full keyboard height including any toolbars.
      const kbH = screenHeight - e.endCoordinates.screenY;
      setKeyboardHeight(Math.max(0, kbH));
    };
    const onHide = () => setKeyboardHeight(0);

    const sub1 = Keyboard.addListener(showEvent, onShow);
    const sub2 = Keyboard.addListener(hideEvent, onHide);
    return () => { sub1.remove(); sub2.remove(); };
  }, [screenHeight]);

  // ── Load persisted history on mount ─────────────────────────────────────────
  useEffect(() => {
    if (!snapshot) {
      setMessages([{ id: 'err', role: 'system', content: 'No health data loaded. Go back and try again.' }]);
      setIsLoaded(true);
      return;
    }

    loadChatPersistence().then(saved => {
      if (saved && saved.messages.length > 0) {
        // Restore previous conversation — no greeting, just a thin divider
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
        historyRef.current = saved.messages;
        setShowChips(false);
      } else {
        // Fresh start — show greeting
        const rec = snapshot.todayRecovery;
        let greeting = '👋 Morning! ';
        if (rec && rec.weightedRMSSD > 0) {
          const emoji = rec.recoveryScore >= 80 ? '🟢' : rec.recoveryScore >= 60 ? '🟡' : '🔴';
          greeting += `${emoji} Your recovery score is **${rec.recoveryScore}/100** (${rec.label}) — RMSSD ${rec.weightedRMSSD} ms vs your ${rec.baseline7Day} ms baseline.\n\nWhat would you like to know?`;
        } else {
          greeting += "Sleep data hasn't synced yet, so I don't have your recovery score. I can still answer questions about your recent runs and fitness trends.\n\nWhat would you like to know?";
        }
        setMessages([{ id: 'greeting', role: 'assistant', content: greeting }]);
      }
      setIsLoaded(true);
    });
  }, []);

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
            // Re-show greeting
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

    const userMsg: Message    = { id: Date.now().toString(),       role: 'user',      content: trimmed };
    const loadingMsg: Message = { id: 'loading',                   role: 'assistant', content: '', loading: true };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setSending(true);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);

    // Build API history: previous turns + new user message
    const apiHistory: ChatMessage[] = [
      ...historyRef.current,
      { role: 'user', content: trimmed },
    ];

    try {
      const reply = await getChatResponse(snapshot, apiHistory, memoryNote);

      // Full history now includes the assistant reply
      const fullHistory: ChatMessage[] = [
        ...apiHistory,
        { role: 'assistant', content: reply },
      ];
      historyRef.current = fullHistory;

      setMessages(prev => [
        ...prev.filter(m => m.id !== 'loading'),
        { id: Date.now().toString() + 'a', role: 'assistant', content: reply },
      ]);

      // Update memory note in the background after every reply, then persist
      updateMemoryNote(fullHistory, memoryNote, snapshot)
        .then(updatedMemory => {
          setMemoryNote(updatedMemory);
          saveChatPersistence(fullHistory, updatedMemory);
        })
        .catch(() => {
          // If memory update fails, still save with current memory
          saveChatPersistence(fullHistory, memoryNote);
        });

    } catch (err: any) {
      setMessages(prev => [
        ...prev.filter(m => m.id !== 'loading'),
        { id: 'err' + Date.now(), role: 'system', content: `⚠️ ${err.message}` },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages, sending, snapshot, memoryNote]);

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
        {/* Memory indicator — subtle pill when a memory note exists */}
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
