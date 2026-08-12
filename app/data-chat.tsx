import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { runDataChat, loadChatHistory, saveChatHistory, clearChatHistory, ChatMode, ChatMsg } from '../src/services/dataChat';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import MarkdownBody from '../src/MarkdownBody';
import { TABLE_CELL } from '../src/mdTable';

const SUGGEST: Record<ChatMode, string[]> = {
  labs: ['Summarise what stands out across all my labs', 'How is my iron panel trending?', 'Read my lipids / cardiovascular risk', 'Anything I should raise with my GP?'],
  biology: ['How is my weight trend vs my training?', 'Is my recent loss fat or lean mass?', 'How does my blood pressure look over time?', 'Any event that clearly moved a metric?'],
};

export default function DataChat() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const md = useThemedStyles(makeMarkdownStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: ChatMode = params.mode === 'biology' ? 'biology' : 'labs';
  const title = mode === 'biology' ? '🧬 Biology chat' : '🧪 Labs chat';

  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => { loadChatHistory(mode).then(setMsgs); }, [mode]);
  useEffect(() => { const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80); return () => clearTimeout(t); }, [msgs, sending]);

  async function send(text: string) {
    const q = text.trim(); if (!q || sending) return;
    setInput('');
    const next = [...msgs, { role: 'user' as const, content: q }];
    setMsgs(next); setSending(true);
    try {
      const reply = await runDataChat(mode, next);
      const after = [...next, { role: 'assistant' as const, content: reply }];
      setMsgs(after); await saveChatHistory(mode, after);
    } catch (e: any) {
      const after = [...next, { role: 'assistant' as const, content: `⚠️ ${e?.message ?? String(e)}` }];
      setMsgs(after); await saveChatHistory(mode, after);
    } finally { setSending(false); }
  }

  function clearChat() {
    Alert.alert('Clear this chat', `Delete the ${mode} conversation history?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await clearChatHistory(mode); setMsgs([]); } },
    ]);
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: mode === 'biology' ? 'Biology chat' : 'Labs chat' }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹ Back</Text></TouchableOpacity>
        <Text style={s.title}>{title}</Text>
        <View style={{ flex: 1 }} />
        {msgs.length > 0 && <TouchableOpacity onPress={clearChat}><Text style={s.clear}>Clear</Text></TouchableOpacity>}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <ScrollView ref={scrollRef} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          {msgs.length === 0 && (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>Ask about your {mode === 'biology' ? 'body metrics & blood pressure' : 'blood-lab history'}.</Text>
              <Text style={s.emptyHint}>It reads your own data (agentic — it pulls what it needs) and answers with context. Not medical advice.</Text>
              {SUGGEST[mode].map(q => (
                <TouchableOpacity key={q} style={s.suggest} onPress={() => send(q)}><Text style={s.suggestTxt}>{q}</Text></TouchableOpacity>
              ))}
            </View>
          )}
          {msgs.map((m, i) => m.role === 'user'
            ? <View key={i} style={[s.bubble, s.userBubble]}><Text style={s.userTxt}>{m.content}</Text></View>
            : <View key={i} style={[s.bubble, s.aiBubble]}><MarkdownBody content={m.content} style={md} c={c} /></View>)}
          {sending && <View style={[s.bubble, s.aiBubble, s.thinking]}><ActivityIndicator color={c.accent} size="small" /><Text style={s.thinkTxt}>Thinking…</Text></View>}
        </ScrollView>

        <View style={s.inputBar}>
          <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="Ask a question…" placeholderTextColor={c.textFaint}
            multiline onSubmitEditing={() => send(input)} blurOnSubmit returnKeyType="send" />
          <TouchableOpacity style={[s.sendBtn, (!input.trim() || sending) && s.sendOff]} disabled={!input.trim() || sending} onPress={() => send(input)}>
            <Text style={s.sendTxt}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  header:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border },
  back:     { color: c.accent, fontSize: 15, fontWeight: '700' },
  title:    { color: c.text, fontSize: 16, fontWeight: '800' },
  clear:    { color: c.textFaint, fontSize: 13, fontWeight: '700' },
  pad:      { padding: 14, paddingBottom: 20 },
  empty:    { paddingTop: 20, gap: 10 },
  emptyTitle:{ color: c.text, fontSize: 16, fontWeight: '700' },
  emptyHint:{ color: c.textFaint, fontSize: 13, lineHeight: 19, marginBottom: 6 },
  suggest:  { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 13 },
  suggestTxt:{ color: c.accent, fontSize: 14, fontWeight: '600' },
  bubble:   { borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10, marginBottom: 8, maxWidth: '92%' },
  userBubble:{ alignSelf: 'flex-end', backgroundColor: c.accent },
  userTxt:  { color: c.onAccent, fontSize: 14.5, lineHeight: 20 },
  aiBubble: { alignSelf: 'flex-start', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinkTxt: { color: c.textFaint, fontSize: 13 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg },
  input:    { flex: 1, maxHeight: 120, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 18, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, color: c.text, fontSize: 15 },
  sendBtn:  { width: 40, height: 40, borderRadius: 20, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  sendOff:  { opacity: 0.4 },
  sendTxt:  { color: c.onAccent, fontSize: 20, fontWeight: '800' },
});

const makeMarkdownStyles = (c: Palette) => StyleSheet.create({
  body: { color: c.text, fontSize: 14, lineHeight: 20 },
  heading1: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 6, marginBottom: 4 },
  heading2: { fontSize: 15, fontWeight: '700', color: c.accent, marginTop: 8, marginBottom: 3 },
  heading3: { fontSize: 14, fontWeight: '700', color: c.text, marginTop: 6, marginBottom: 2 },
  strong: { fontWeight: '800', color: c.text },
  em: { fontStyle: 'italic', color: c.text },
  paragraph: { marginBottom: 7 },
  bullet_list: { marginBottom: 7, color: c.text },
  ordered_list: { marginBottom: 7, color: c.text },
  list_item: { marginBottom: 3, color: c.text },
  code_inline: { fontFamily: 'Courier', fontSize: 13, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: 3, paddingHorizontal: 4 },
  hr: { borderBottomWidth: 1, borderColor: c.border, marginVertical: 8 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: 4, marginBottom: 8, overflow: 'hidden' },
  thead: { backgroundColor: c.surfaceAlt },
  th: { ...TABLE_CELL, fontWeight: '700', padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  td: { ...TABLE_CELL, padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  tr: { borderBottomWidth: 1, borderColor: c.border },
});
