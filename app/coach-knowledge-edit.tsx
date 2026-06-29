import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, SafeAreaView,
  ActivityIndicator, Alert, Keyboard, Platform, useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  listKnowledge, readKnowledgeContent, writeKnowledgeContent, renameKnowledge,
  deleteKnowledge, resetKnowledge, enhanceKnowledge, isBuiltinId, KnowledgeMeta,
} from '../src/services/coachFiles';

export default function CoachKnowledgeEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [proposed, setProposed] = useState(false);
  const builtin = isBuiltinId(id ?? '');

  // ── Keyboard-aware editing ──────────────────────────────────────────────────
  // The content field can be longer than the screen, so we cap its height to the space ABOVE the
  // keyboard while typing. That makes the native text view scroll internally (it always keeps the
  // caret visible), instead of growing under the keyboard where the cursor would be hidden.
  const { height: winH } = useWindowDimensions();
  const [kbH, setKbH] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const contentY = useRef(0);

  useEffect(() => {
    // keyboardWillChangeFrame tracks show / hide / resize, so the editor adapts to whatever
    // keyboard is loaded (taller emoji/3rd-party keyboards included).
    const onFrame = (e: any) => {
      const screenY = e?.endCoordinates?.screenY;
      setKbH(typeof screenY === 'number' ? Math.max(0, winH - screenY) : (e?.endCoordinates?.height ?? 0));
    };
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const sub1 = Keyboard.addListener(showEvt, onFrame);
    const sub2 = Keyboard.addListener(hideEvt, () => setKbH(0));
    return () => { sub1.remove(); sub2.remove(); };
  }, [winH]);

  // Cap height to the room above the keyboard (≈150px reserves the header + safe-area + a margin).
  const editorH = kbH > 0 ? Math.max(150, winH - kbH - 150) : undefined;

  const onContentFocus = () => {
    // Slide the editor up to just below the header so the whole capped box sits above the keyboard.
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, contentY.current - 6), animated: true }), 60);
  };

  useEffect(() => {
    (async () => {
      const m = (await listKnowledge()).find(x => x.id === id) ?? null;
      setMeta(m);
      setTitle(m?.title ?? '');
      setDesc(m?.description ?? '');
      setContent(await readKnowledgeContent(id ?? ''));
      setLoading(false);
    })();
  }, [id]);

  const save = async () => {
    await writeKnowledgeContent(id!, content);
    if (!builtin) await renameKnowledge(id!, title.trim() || 'Untitled', desc.trim());
    setSaved(true); setProposed(false); setTimeout(() => setSaved(false), 1500);
  };

  const doEnhance = async (instruction?: string) => {
    setEnhancing(true);
    try {
      const out = await enhanceKnowledge(id!, instruction);
      setContent(out);
      setProposed(true);
      Alert.alert('AI proposal ready', 'Review the suggested content, then tap Save to keep it. Nothing is saved automatically.');
    }
    catch (e: any) { Alert.alert('Enhance failed', e?.message ?? 'Could not reach the model.'); }
    finally { setEnhancing(false); }
  };

  const enhance = () => {
    const prompt = (Alert as any).prompt;
    if (Platform.OS === 'ios' && typeof prompt === 'function') {
      prompt(
        'Enhance with AI',
        'Optional instruction (e.g. "add hill-sprint drills", "make stricter"). Leave blank to just refine.',
        (instruction?: string) => doEnhance(instruction?.trim() || undefined),
      );
    } else {
      doEnhance(undefined);
    }
  };

  const exportFile = async () => {
    try {
      const uri = `${FileSystem.cacheDirectory}${(title || 'knowledge').replace(/[^a-z0-9]+/gi, '-')}.md`;
      await FileSystem.writeAsStringAsync(uri, content);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'text/markdown', dialogTitle: title });
      else { await Clipboard.setStringAsync(content); Alert.alert('Copied', 'Sharing unavailable — content copied to clipboard.'); }
    } catch (e: any) { Alert.alert('Export failed', e?.message ?? String(e)); }
  };

  const importClip = async () => {
    const t = await Clipboard.getStringAsync();
    if (!t) { Alert.alert('Clipboard empty', 'Copy file text first, then import.'); return; }
    Alert.alert('Import from clipboard', 'Replace the current content with the clipboard text?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: () => setContent(t) },
    ]);
  };

  const onReset = () => Alert.alert('Reset to default', 'Restore this file to its shipped content?', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: async () => setContent(await resetKnowledge(id!)) },
  ]);

  const onDelete = () => Alert.alert('Delete file', `Delete "${title}"? This cannot be undone.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { await deleteKnowledge(id!); router.back(); } },
  ]);

  if (loading || !meta) {
    return <SafeAreaView style={s.container}><ActivityIndicator size="small" color={c.accent} style={{ marginTop: 40 }} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{builtin ? title : 'Edit File'}</Text>
        <TouchableOpacity onPress={save} style={{ paddingHorizontal: 4 }}>
          <Text style={[s.saveText, saved && { color: '#27ae60' }]}>{saved ? 'Saved ✓' : 'Save'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
          {!builtin && (
            <>
              <Text style={s.label}>TITLE</Text>
              <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="File title" placeholderTextColor="#999" />
              <Text style={s.label}>DESCRIPTION</Text>
              <TextInput style={s.input} value={desc} onChangeText={setDesc} placeholder="Short description" placeholderTextColor="#999" />
            </>
          )}

          <Text style={s.label}>CONTENT (markdown)</Text>
          {proposed && <Text style={s.proposeNote}>✨ AI proposal — unsaved. Tap Save to keep, or edit/Back to discard.</Text>}
          <TextInput
            style={[s.input, s.contentInput, editorH != null && { height: editorH, minHeight: 0 }]}
            value={content}
            onChangeText={setContent}
            multiline
            scrollEnabled
            textAlignVertical="top"
            autoCapitalize="sentences"
            onLayout={e => { contentY.current = e.nativeEvent.layout.y; }}
            onFocus={onContentFocus}
            placeholder="Write coaching rules, exercises, drills, schedule…"
            placeholderTextColor="#999"
          />

          <TouchableOpacity style={[s.btn, { backgroundColor: '#7c5cf0' }]} onPress={enhance} disabled={enhancing}>
            {enhancing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.btnText}>✨ Enhance with AI</Text>}
          </TouchableOpacity>

          <View style={s.btnRow}>
            <TouchableOpacity style={[s.btn, s.btnHalf, { backgroundColor: '#2980b9' }]} onPress={exportFile}>
              <Text style={s.btnText}>⇪ Export</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.btnHalf, { backgroundColor: '#16a085' }]} onPress={importClip}>
              <Text style={s.btnText}>⇩ Import</Text>
            </TouchableOpacity>
          </View>

          {builtin ? (
            <TouchableOpacity style={[s.btn, { backgroundColor: 'transparent' }]} onPress={onReset}>
              <Text style={[s.btnText, { color: '#e67e22' }]}>↺ Reset to default</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[s.btn, { backgroundColor: 'transparent' }]} onPress={onDelete}>
              <Text style={[s.btnText, { color: '#e74c3c' }]}>🗑 Delete file</Text>
            </TouchableOpacity>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text, flex: 1, textAlign: 'center', marginHorizontal: 8 },
  saveText: { fontSize: 15, color: c.accent, fontWeight: '700' },
  scroll:   { padding: 12, paddingBottom: 40 },
  label:    { fontSize: 11, fontWeight: '700', color: c.textSub, letterSpacing: 0.4, marginBottom: 5, marginTop: 12 },
  input: {
    backgroundColor: c.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: c.text, borderWidth: 1, borderColor: c.border,
  },
  contentInput: { minHeight: 320, lineHeight: 20, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12.5 },
  proposeNote: { fontSize: 12, color: '#7c5cf0', marginBottom: 6, fontWeight: '600' },
  btn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  btnHalf: { flex: 1 },
  btnRow: { flexDirection: 'row', gap: 10 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
