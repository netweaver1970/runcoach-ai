import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Modal, ActivityIndicator, Keyboard } from 'react-native';
import { Stack, useNavigation } from 'expo-router';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import {
  LibraryWorkout, WorkoutKind, WORKOUT_KINDS, KIND_COLOR, describeWorkout, workoutMinutes,
  loadLibrary, saveLibrary, newWorkout,
} from '../src/services/workoutLibrary';

const WORK_ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
const REC_ZONES  = ['Z0', 'Z1', 'Z2', 'Z3'];
const cycle = (arr: string[], v: string | undefined, dir = 1) => arr[((arr.indexOf(v ?? arr[0]) + dir) % arr.length + arr.length) % arr.length];

export default function WorkoutLibraryScreen() {
  const s = useThemedStyles(styles);
  const { c } = useTheme();
  const navigation = useNavigation();

  const [list, setList] = useState<LibraryWorkout[] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const saveTimer = useRef<any>(null);

  useEffect(() => { loadLibrary().then(setList); }, []);
  useEffect(() => navigation.addListener('beforeRemove', () => { Keyboard.dismiss(); }), [navigation]);

  const persist = useCallback((next: LibraryWorkout[]) => {
    setList(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveLibrary(next), 400);
  }, []);

  const patchW = (id: string, partial: Partial<LibraryWorkout>) =>
    list && persist(list.map(w => w.id === id ? { ...w, ...partial, updatedAt: Date.now() } : w));
  const patchBlock = (id: string, bi: number, partial: any) => {
    if (!list) return;
    patchW(id, { blocks: list.find(w => w.id === id)!.blocks.map((b, i) => i === bi ? { ...b, ...partial } : b) });
  };
  const addBlock = (id: string) => {
    if (!list) return;
    const w = list.find(x => x.id === id)!;
    patchW(id, { blocks: [...w.blocks, { repeats: 1, workMinutes: 5, restMinutes: 0, hrZone: 'Z3', recoveryZone: 'Z1', label: 'work' }] });
  };
  const removeBlock = (id: string, bi: number) => {
    if (!list) return;
    const w = list.find(x => x.id === id)!;
    if (w.blocks.length <= 1) return;
    patchW(id, { blocks: w.blocks.filter((_, i) => i !== bi) });
  };
  const addWorkout = () => { if (!list) return; const w = newWorkout(); persist([w, ...list]); setEditId(w.id); };
  const removeWorkout = (id: string) => { if (!list) return; persist(list.filter(w => w.id !== id)); setEditId(null); };

  const editing = list?.find(w => w.id === editId) ?? null;

  if (!list) return <View style={s.center}><ActivityIndicator color={c.accent} /></View>;

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: 'Workout Library', headerBackTitle: 'Back' }} />
      <Text style={s.lede}>
        Reusable structured workouts. Build them once, then push to your watch, drop into a day, or (as a
        coach) prescribe to an athlete. Power is set on-device from each runner's own zones.
      </Text>

      <TouchableOpacity style={s.addBtn} onPress={addWorkout}><Text style={s.addTxt}>＋ New workout</Text></TouchableOpacity>

      {list.map(w => (
        <TouchableOpacity key={w.id} style={s.card} activeOpacity={0.7} onPress={() => setEditId(w.id)}>
          <View style={s.cardHead}>
            <View style={[s.kindDot, { backgroundColor: KIND_COLOR[w.kind] }]} />
            <Text style={s.cardName} numberOfLines={1}>{w.name || 'Untitled'}</Text>
            <Text style={s.cardMin}>{workoutMinutes(w)}m</Text>
          </View>
          <Text style={s.cardDesc} numberOfLines={2}>{describeWorkout(w)}</Text>
        </TouchableOpacity>
      ))}

      {/* ── Editor ─────────────────────────────────────────────────── */}
      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={() => setEditId(null)}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            {editing && (
              <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
                <View style={s.sheetHead}>
                  <Text style={s.sheetTitle}>Edit workout</Text>
                  <TouchableOpacity onPress={() => setEditId(null)}><Text style={s.done}>Done</Text></TouchableOpacity>
                </View>

                <TextInput style={s.nameInput} value={editing.name} placeholder="Workout name" placeholderTextColor={c.textFaint}
                  onChangeText={t => patchW(editing.id, { name: t })} returnKeyType="done" />

                <Text style={s.fieldLabel}>Type</Text>
                <View style={s.kindRow}>
                  {WORKOUT_KINDS.map(k => (
                    <TouchableOpacity key={k} style={[s.kindChip, editing.kind === k && { backgroundColor: KIND_COLOR[k] + '22', borderColor: KIND_COLOR[k] }]} onPress={() => patchW(editing.id, { kind: k })}>
                      <Text style={[s.kindChipTxt, editing.kind === k && { color: KIND_COLOR[k], fontWeight: '800' }]}>{k}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={s.wcRow}>
                  <Stepper label="Warm-up (m)" value={editing.warmupMeters} step={100} min={0} max={3000} onChange={v => patchW(editing.id, { warmupMeters: v })} s={s} />
                  <Stepper label="Drills (min)" value={editing.drillsMinutes} step={1} min={0} max={20} onChange={v => patchW(editing.id, { drillsMinutes: v })} s={s} />
                  <Stepper label="Cool-down (m)" value={editing.cooldownMeters} step={100} min={0} max={3000} onChange={v => patchW(editing.id, { cooldownMeters: v })} s={s} />
                </View>

                <Text style={[s.fieldLabel, { marginTop: 12 }]}>Blocks</Text>
                {editing.blocks.map((b, bi) => (
                  <View key={bi} style={s.block}>
                    <View style={s.blockTop}>
                      <Stepper label="Reps" value={b.repeats} step={1} min={1} max={30} onChange={v => patchBlock(editing.id, bi, { repeats: v })} s={s} compact />
                      <Stepper label="Work (min)" value={b.workMinutes} step={1} min={1} max={180} onChange={v => patchBlock(editing.id, bi, { workMinutes: v })} s={s} compact />
                      <TouchableOpacity style={s.zoneBtn} onPress={() => patchBlock(editing.id, bi, { hrZone: cycle(WORK_ZONES, b.hrZone) })}>
                        <Text style={s.zoneLbl}>work</Text><Text style={s.zoneVal}>{b.hrZone ?? 'Z3'}</Text>
                      </TouchableOpacity>
                      {editing.blocks.length > 1 && <TouchableOpacity onPress={() => removeBlock(editing.id, bi)} hitSlop={8}><Text style={s.rm}>✕</Text></TouchableOpacity>}
                    </View>
                    <View style={s.blockBot}>
                      <Stepper label="Rest (min)" value={b.restMinutes} step={1} min={0} max={30} onChange={v => patchBlock(editing.id, bi, { restMinutes: v })} s={s} compact />
                      <TouchableOpacity style={[s.zoneBtn, b.restMinutes === 0 && { opacity: 0.4 }]} disabled={b.restMinutes === 0} onPress={() => patchBlock(editing.id, bi, { recoveryZone: cycle(REC_ZONES, b.recoveryZone) })}>
                        <Text style={s.zoneLbl}>recovery</Text><Text style={s.zoneVal}>{b.recoveryZone ?? 'Z1'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
                <TouchableOpacity style={s.addBlock} onPress={() => addBlock(editing.id)}><Text style={s.addBlockTxt}>＋ Add block</Text></TouchableOpacity>

                <Text style={[s.fieldLabel, { marginTop: 12 }]}>Notes (optional)</Text>
                <TextInput style={s.notes} value={editing.notes ?? ''} placeholder="Cues, goal pace, focus…" placeholderTextColor={c.textFaint}
                  onChangeText={t => patchW(editing.id, { notes: t })} multiline />

                <Text style={s.previewLabel}>Preview</Text>
                <Text style={s.preview}>{describeWorkout(editing)}  ·  ~{workoutMinutes(editing)}m</Text>

                <TouchableOpacity style={s.deleteBtn} onPress={() => removeWorkout(editing.id)}><Text style={s.deleteTxt}>Delete workout</Text></TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Stepper({ label, value, step, min, max, onChange, s, compact }: { label: string; value: number; step: number; min: number; max: number; onChange: (v: number) => void; s: any; compact?: boolean }) {
  return (
    <View style={[s.stepper, compact && { flex: 1 }]}>
      <Text style={s.stepLabel}>{label}</Text>
      <View style={s.stepRow}>
        <TouchableOpacity onPress={() => onChange(Math.max(min, value - step))} hitSlop={8}><Text style={s.stepBtn}>−</Text></TouchableOpacity>
        <Text style={s.stepVal}>{value}</Text>
        <TouchableOpacity onPress={() => onChange(Math.min(max, value + step))} hitSlop={8}><Text style={s.stepBtn}>＋</Text></TouchableOpacity>
      </View>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg },
  lede:    { color: c.textSub, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  addBtn:  { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginBottom: 14 },
  addTxt:  { color: '#fff', fontWeight: '700', fontSize: 14 },
  card:    { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 10 },
  cardHead:{ flexDirection: 'row', alignItems: 'center', gap: 8 },
  kindDot: { width: 10, height: 10, borderRadius: 5 },
  cardName:{ flex: 1, color: c.text, fontSize: 15.5, fontWeight: '800' },
  cardMin: { color: c.textSub, fontSize: 12.5, fontWeight: '700' },
  cardDesc:{ color: c.textSub, fontSize: 12.5, lineHeight: 17, marginTop: 6 },
  // editor sheet
  backdrop:{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 30, maxHeight: '92%' },
  sheetHead:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sheetTitle:{ fontSize: 17, fontWeight: '800', color: c.text },
  done:    { fontSize: 16, fontWeight: '700', color: c.accent },
  nameInput:{ color: c.text, fontSize: 17, fontWeight: '800', backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  fieldLabel:{ color: c.textSub, fontSize: 12, fontWeight: '700', marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kindChip:{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  kindChipTxt:{ color: c.textSub, fontSize: 12.5, fontWeight: '600' },
  wcRow:   { flexDirection: 'row', gap: 8, marginTop: 4 },
  stepper: { backgroundColor: c.bg, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 8, alignItems: 'center', flex: 1 },
  stepLabel:{ color: c.textSub, fontSize: 10.5, fontWeight: '600', marginBottom: 4, textAlign: 'center' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { color: c.accent, fontSize: 19, fontWeight: '800', width: 20, textAlign: 'center' },
  stepVal: { color: c.text, fontSize: 15, fontWeight: '800', minWidth: 30, textAlign: 'center' },
  block:   { backgroundColor: c.bg, borderRadius: 12, padding: 10, marginBottom: 8, gap: 8 },
  blockTop:{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  blockBot:{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  zoneBtn: { backgroundColor: c.surface, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingVertical: 6, paddingHorizontal: 10, alignItems: 'center', minWidth: 74 },
  zoneLbl: { color: c.textFaint, fontSize: 10, fontWeight: '600' },
  zoneVal: { color: c.text, fontSize: 15, fontWeight: '800' },
  rm:      { color: c.textFaint, fontSize: 16, fontWeight: '700', paddingHorizontal: 2, paddingBottom: 8 },
  addBlock:{ paddingVertical: 8, alignItems: 'center' },
  addBlockTxt:{ color: c.accent, fontSize: 13.5, fontWeight: '700' },
  notes:   { color: c.text, fontSize: 14, backgroundColor: c.bg, borderRadius: 10, padding: 10, minHeight: 60, textAlignVertical: 'top' },
  previewLabel:{ color: c.textFaint, fontSize: 10.5, fontWeight: '700', marginTop: 14, textTransform: 'uppercase', letterSpacing: 0.3 },
  preview: { color: c.textSub, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  deleteBtn:{ marginTop: 18, paddingVertical: 12, alignItems: 'center' },
  deleteTxt:{ color: '#e74c3c', fontSize: 14, fontWeight: '700' },
});
