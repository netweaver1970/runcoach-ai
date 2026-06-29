import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, Switch, ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  listKnowledge, setKnowledgeEnabled, createKnowledge, KnowledgeMeta,
} from '../src/services/coachFiles';

export default function CoachKnowledgeScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [files, setFiles] = useState<KnowledgeMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listKnowledge().then(setFiles).finally(() => setLoading(false));
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = async (id: string, enabled: boolean) => {
    setFiles(f => f.map(m => (m.id === id ? { ...m, enabled } : m)));
    await setKnowledgeEnabled(id, enabled);
  };

  const addFile = async () => {
    const m = await createKnowledge('New File', 'My coaching note');
    router.push({ pathname: '/coach-knowledge-edit' as any, params: { id: m.id } });
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Coaching Knowledge</Text>
        <TouchableOpacity onPress={addFile} style={{ paddingHorizontal: 4 }}>
          <Text style={s.addText}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.intro}>
          These files are the coach's brain. Every enabled file is included in the coach's prompt — edit the rules,
          list your preferred strength exercises and pre-run drills, set a weekly schedule, or add your own. Tap a
          file to edit, import, export or let the AI enhance it.
        </Text>

        {loading ? (
          <ActivityIndicator size="small" color={c.accent} style={{ marginTop: 24 }} />
        ) : (
          files.map(m => (
            <TouchableOpacity
              key={m.id}
              style={s.card}
              activeOpacity={0.7}
              onPress={() => router.push({ pathname: '/coach-knowledge-edit' as any, params: { id: m.id } })}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={s.cardTitle}>{m.title}</Text>
                  {m.builtin && <Text style={s.badge}>default</Text>}
                </View>
                {!!m.description && <Text style={s.cardDesc}>{m.description}</Text>}
              </View>
              <Switch
                value={m.enabled}
                onValueChange={v => toggle(m.id, v)}
                trackColor={{ true: c.accent }}
              />
              <Text style={s.chev}>›</Text>
            </TouchableOpacity>
          ))
        )}
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
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  addText:  { fontSize: 15, color: c.accent, fontWeight: '700' },
  scroll:   { padding: 12, paddingBottom: 40 },
  intro:    { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 14 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  badge: {
    fontSize: 9, fontWeight: '800', color: '#16a085', backgroundColor: '#16a85022',
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, textTransform: 'uppercase',
  },
  cardDesc: { fontSize: 12, color: c.textFaint, marginTop: 3 },
  chev: { fontSize: 20, color: c.textFaint },
});
