import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Modal, ActivityIndicator, Keyboard, Alert, Linking, Switch } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { ExerciseThumb, ExercisePeek, ExerciseMini } from '../src/components/ExercisePeek';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, Routine, RoutineItem, Exercise, Muscle, MUSCLES, MUSCLE_LABEL, WEEKDAYS, flatRoutine,
  loadStrength, updateStrength, allExercises, exerciseById, estimateMinutes, newId,
} from '../src/services/strength';

/**
 * Numeric field: commits on every change that parses (Back straight from the field can't lose it — onBlur arrives
 * after unmount), keeps its own text so "22." survives typing; empty = undefined. Clamping happens in onCommit.
 */
function NumField({ value, onCommit, style, placeholder, decimal }: { value?: number; onCommit: (n: number | undefined) => void; style: any; placeholder?: string; decimal?: boolean }) {
  const [txt, setTxt] = useState(value != null ? String(value) : '');
  const mine = useRef<number | undefined>(value);
  useEffect(() => { if (value !== mine.current) { mine.current = value; setTxt(value != null ? String(value) : ''); } }, [value]);
  const parse = (x: string) => { const t = x.trim().replace(',', '.'); return t === '' ? undefined : (decimal ? parseFloat(t) : parseInt(t, 10)); };
  return (
    <TextInput style={style} value={txt} returnKeyType="done" placeholder={placeholder} placeholderTextColor="#999"
      keyboardType={decimal ? 'numbers-and-punctuation' : 'number-pad'}
      onChangeText={x => { setTxt(x); const n = parse(x); if (n === undefined || Number.isFinite(n)) { mine.current = n; onCommit(n); } }}
      onBlur={() => setTxt(value != null ? String(value) : '')} />
  );
}

export default function StrengthRoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const navigation = useNavigation();
  const [store, setStore] = useState<StrengthStore | null>(null);
  const [picker, setPicker] = useState(false);
  const [incPicker, setIncPicker] = useState(false);
  const [peek, setPeek] = useState<number | null>(null);   // item whose picture is open   // "＋ Include a routine" (supersets / blocks inside this one)
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState<{ name: string; muscle: Muscle } | null>(null);

  // reload on focus: coming Back from an included superset's screen shows its new exercises
  useFocusEffect(useCallback(() => { loadStrength().then(st => setStore({ ...st })).catch(() => {}); }, []));
  useEffect(() => navigation.addListener('beforeRemove', () => { Keyboard.dismiss(); }), [navigation]);

  // Every edit is applied to the LATEST store in the write queue (no debounce → nothing pending on Back).
  const apply = (fn: (st: StrengthStore) => StrengthStore) => {
    setStore(cur => (cur ? fn(cur) : cur));
    updateStrength(fn).catch(() => {});
  };

  if (!store) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const r = store.routines.find(x => x.id === id);
  if (!r) return <View style={s.screen}><Stack.Screen options={{ title: 'Routine' }} /><Text style={[s.meta, { padding: 16 }]}>Routine not found.</Text></View>;

  const rid = r.id;
  const patchR = (fn: (x: Routine) => Partial<Routine>) =>
    apply(st => ({ ...st, routines: st.routines.map(x => x.id === rid ? { ...x, ...fn(x), updatedAt: Date.now() } : x) }));
  const patch = (p: Partial<Routine>) => patchR(() => p);
  const patchItem = (i: number, p: Partial<RoutineItem> | ((it: RoutineItem) => Partial<RoutineItem>)) =>
    patchR(x => ({ items: x.items.map((it, k) => k === i ? { ...it, ...(typeof p === 'function' ? p(it) : p) } : it) }));
  const move = (i: number, d: -1 | 1) => patchR(x => {
    const j = i + d; if (j < 0 || j >= x.items.length) return {};
    const items = [...x.items]; [items[i], items[j]] = [items[j], items[i]]; return { items };
  });
  const closePicker = () => { Keyboard.dismiss(); setPicker(false); setCustom(null); setQ(''); };   // keyboard down BEFORE the modal goes
  const addExercise = (ex: Exercise) => {
    patchR(x => ({ items: [...x.items, { exerciseId: ex.id, sets: 3, repsLo: 8, repsHi: 12, restSec: 90 }] }));
    closePicker();
  };
  const saveCustom = () => {
    if (!custom || !custom.name.trim()) return;
    const ex: Exercise = { id: newId('ex'), name: custom.name.trim(), muscles: { [custom.muscle]: 1 }, custom: true };
    apply(st => ({ ...st, customExercises: [...st.customExercises, ex],
      routines: st.routines.map(x => x.id === rid ? { ...x, items: [...x.items, { exerciseId: ex.id, sets: 3, repsLo: 8, repsHi: 12, restSec: 90 }], updatedAt: Date.now() } : x) }));
    closePicker();
  };
  const removeRoutine = () => Alert.alert('Delete routine?', `"${r.name}" — logged sessions stay in your history.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { Keyboard.dismiss(); await updateStrength(st => ({ ...st, routines: st.routines.filter(x => x.id !== rid) })); router.back(); } },
  ]);

  const list = allExercises(store).filter(e => !q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: r.name || 'Routine', headerBackTitle: 'Back' }} />
      <Text style={s.label}>Name</Text>
      <TextInput style={s.input} value={r.name} onChangeText={t => patch({ name: t })} returnKeyType="done" />
      <Text style={s.label}>Source (who / where it's from)</Text>
      <TextInput style={s.input} value={r.source ?? ''} onChangeText={t => patch({ source: t })} placeholder="e.g. coach, book, video" placeholderTextColor="#999" returnKeyType="done" />
      <Text style={s.label}>Planned days</Text>
      <View style={s.days}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => {
          const on = r.days.includes(d);
          return (
            <TouchableOpacity key={d} style={[s.day, on && s.dayOn]} onPress={() => patchR(x => ({ days: x.days.includes(d) ? x.days.filter(y => y !== d) : [...x.days, d] }))}>
              <Text style={[s.dayTxt, on && s.dayTxtOn]}>{WEEKDAYS[d]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 6 }}>
        <View style={{ flex: 1 }}>
          <Text style={[s.itemName, { fontSize: 14 }]}>Auto-update weights</Text>
          <Text style={s.meta}>After each session, set the next target weights from how it went.</Text>
        </View>
        <Switch value={r.autoUpdate !== false} onValueChange={v => patch({ autoUpdate: v })} />
      </View>
      {/* SUPERSET = the exercises alternate one set at a time (A1 B1 A2 B2 …), rest after each round */}
      <Text style={s.label}>How the exercises are done</Text>
      <View style={s.days}>
        {(['straight', 'superset'] as const).map(m => {
          const on = (r.mode ?? 'straight') === m;
          return (
            <TouchableOpacity key={m} style={[s.day, { flex: 1 }, on && s.dayOn]} onPress={() => patch({ mode: m })}>
              <Text style={[s.dayTxt, on && s.dayTxtOn]}>{m === 'straight' ? 'Straight sets' : '🔁 Superset'}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={s.meta}>{r.mode === 'superset'
        ? 'Alternate: one set of each exercise, then the next round (rounds = sets). Only the last exercise\'s rest is used, after each round. Include this superset in other routines as a block.'
        : 'Each exercise: all its sets, then the next. Included routines (＋ Include) run as blocks; an included SUPERSET alternates.'}</Text>
      <Text style={s.meta}>{flatRoutine(store, r).items.length} exercises{r.items.some(i => i.ref) ? ' (incl. included routines)' : ''} · ~{estimateMinutes(flatRoutine(store, r))} min</Text>

      {r.items.map((it, i) => {
        if (it.ref) {
          // an INCLUDED routine (a superset or a block) — expanded when the session starts
          const sub = store.routines.find(x => x.id === it.ref);
          const subFlat = sub ? flatRoutine(store, sub, [r.id]) : null;
          return (
            <View key={`ref-${it.ref}-${i}`} style={[s.item, { borderColor: c.accent }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => sub && router.push({ pathname: '/strength-routine' as any, params: { id: sub.id } })}>
                  <Text style={s.itemName}>{String.fromCharCode(97 + i)}. {sub?.mode === 'superset' ? '🔁 ' : '📦 '}{sub?.name ?? 'Missing routine'} ›</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => move(i, -1)} hitSlop={8}><Text style={s.icon}>↑</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => move(i, 1)} hitSlop={8}><Text style={s.icon}>↓</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => patchR(x => ({ items: x.items.filter((_, k) => k !== i) }))} hitSlop={8}><Text style={[s.icon, { color: '#e5484d' }]}>✕</Text></TouchableOpacity>
              </View>
              <Text style={s.meta}>{sub?.mode === 'superset' ? 'Superset — alternates: ' : 'Block: '}{subFlat?.items.map(x => exerciseById(store, x.exerciseId)?.name ?? x.exerciseId).join(' · ') || '(empty or loops back)'}</Text>
            </View>
          );
        }
        const ex = exerciseById(store, it.exerciseId);
        return (
          <View key={`${it.exerciseId}-${i}`} style={s.item}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ExerciseThumb ex={ex} open={peek === i} onToggle={() => setPeek(p => (p === i ? null : i))} />
              <Text style={[s.itemName, { flex: 1 }]}>{String.fromCharCode(97 + i)}. {ex?.name ?? it.exerciseId}</Text>
              {ex?.video && <TouchableOpacity onPress={() => Linking.openURL(ex.video!.url)} hitSlop={8}><Text style={s.link}>▶ video</Text></TouchableOpacity>}
            </View>
            {peek === i && <ExercisePeek ex={ex} onClose={() => setPeek(null)} />}
            {it.altIds?.length ? <Text style={s.meta}>or {it.altIds.map(a => exerciseById(store, a)?.name ?? a).join(' / ')}</Text> : null}
            <View style={s.grid}>
              <View style={s.cell}><Text style={s.cellLbl}>Sets</Text><NumField style={s.num} value={it.sets} onCommit={n => n != null && n >= 1 && patchItem(i, { sets: Math.min(10, n) })} /></View>
              <View style={s.cell}><Text style={s.cellLbl}>{ex?.timed ? 'Hold s' : 'Reps'}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <NumField style={[s.num, { flex: 1 }]} value={it.repsLo} onCommit={n => n != null && n >= 1 && patchItem(i, { repsLo: n })} />
                  <Text style={s.meta}> – </Text>
                  <NumField style={[s.num, { flex: 1 }]} value={it.repsHi} onCommit={n => n != null && n >= 1 && patchItem(i, { repsHi: n })} />
                </View>
              </View>
              <View style={s.cell}><Text style={s.cellLbl}>{ex?.bodyweightFrac ? 'Added kg' : 'Weight kg'}</Text><NumField decimal style={s.num} value={it.weightKg} placeholder="auto" onCommit={n => patchItem(i, { weightKg: n })} /></View>
              <View style={s.cell}><Text style={s.cellLbl}>Rest s</Text><NumField style={s.num} value={it.restSec} onCommit={n => n != null && patchItem(i, { restSec: Math.max(0, Math.min(600, n)) })} /></View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
              <Text style={s.cellLbl}>Tempo </Text>
              <TextInput style={[s.num, { width: 80 }]} value={it.tempo ?? ''} onChangeText={t => patchItem(i, { tempo: t || undefined })} placeholder="3:1:2:1" placeholderTextColor="#999" returnKeyType="done" />
              <View style={{ flex: 1 }} />
              <TouchableOpacity onPress={() => move(i, -1)} hitSlop={8}><Text style={s.icon}>↑</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => move(i, 1)} hitSlop={8}><Text style={s.icon}>↓</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => patchR(x => ({ items: x.items.filter((_, k) => k !== i) }))} hitSlop={8}><Text style={[s.icon, { color: '#e5484d' }]}>✕</Text></TouchableOpacity>
            </View>
            {ex?.cue ? <Text style={s.cue}>{ex.cue}</Text> : null}
          </View>
        );
      })}

      <TouchableOpacity style={s.addBtn} onPress={() => setPicker(true)}><Text style={s.addTxt}>＋ Add exercise</Text></TouchableOpacity>
      <TouchableOpacity style={s.addBtn} onPress={() => setIncPicker(true)}><Text style={s.addTxt}>＋ Include a routine (superset / block)</Text></TouchableOpacity>
      <TouchableOpacity style={s.addBtn} onPress={async () => {
        // a new SUPERSET routine, included here right away → add its exercises on its own screen
        const sid = newId('rt');
        await updateStrength(st => ({ ...st, routines: [...st.routines.map(x => x.id === rid ? { ...x, items: [...x.items, { exerciseId: '', ref: sid, sets: 0, repsLo: 0, repsHi: 0, restSec: 0 }], updatedAt: Date.now() } : x),
          { id: sid, name: `${r.name} superset`, days: [], mode: 'superset', items: [], updatedAt: Date.now() }] }));
        setStore({ ...(await loadStrength()) });
        router.push({ pathname: '/strength-routine' as any, params: { id: sid } });
      }}><Text style={s.addTxt}>＋ New superset inside this routine</Text></TouchableOpacity>
      <Modal visible={incPicker} animationType="slide" transparent onRequestClose={() => setIncPicker(false)}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Text style={[s.itemName, { flex: 1 }]}>Include a routine</Text>
              <TouchableOpacity onPress={() => setIncPicker(false)}><Text style={s.link}>Close</Text></TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {store.routines.filter(x => x.id !== rid && !flatIncludes(store, x.id, rid)).map(x => (
                <TouchableOpacity key={x.id} style={s.pickRow} onPress={() => { patchR(y => ({ items: [...y.items, { exerciseId: '', ref: x.id, sets: 0, repsLo: 0, repsHi: 0, restSec: 0 }] })); setIncPicker(false); }}>
                  <Text style={s.itemName}>{x.mode === 'superset' ? '🔁 ' : '📦 '}{x.name}</Text>
                  <Text style={s.meta}>{flatRoutine(store, x).items.length} exercises{x.mode === 'superset' ? ' · superset' : ''}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <TouchableOpacity style={s.delBtn} onPress={removeRoutine}><Text style={s.delTxt}>Delete routine</Text></TouchableOpacity>

      <Modal visible={picker} animationType="slide" transparent onRequestClose={closePicker}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Text style={[s.itemName, { flex: 1 }]}>{custom ? 'Custom exercise' : 'Add exercise'}</Text>
              <TouchableOpacity onPress={closePicker}><Text style={s.link}>Close</Text></TouchableOpacity>
            </View>
            {custom ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <TextInput style={s.input} value={custom.name} onChangeText={t => setCustom({ ...custom, name: t })} placeholder="Exercise name" placeholderTextColor="#999" autoFocus returnKeyType="done" />
                <Text style={s.label}>Main muscle</Text>
                <View style={s.days}>
                  {MUSCLES.map(m => (
                    <TouchableOpacity key={m} style={[s.day, custom.muscle === m && s.dayOn]} onPress={() => setCustom({ ...custom, muscle: m })}>
                      <Text style={[s.dayTxt, custom.muscle === m && s.dayTxtOn]}>{MUSCLE_LABEL[m]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity style={[s.addBtn, { borderStyle: 'solid', borderColor: c.accent }]} onPress={saveCustom}><Text style={[s.addTxt, { color: c.accent }]}>Add</Text></TouchableOpacity>
              </ScrollView>
            ) : (
              <>
                <TextInput style={s.input} value={q} onChangeText={setQ} placeholder="Search exercises" placeholderTextColor="#999" returnKeyType="search" />
                <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 420 }}>
                  {list.map(e => (
                    <TouchableOpacity key={e.id} style={[s.pickRow, { flexDirection: 'row', alignItems: 'center' }]} onPress={() => addExercise(e)}>
                      <ExerciseMini ex={e} size={36} />
                      <View style={{ flex: 1 }}>
                      <Text style={s.pickName}>{e.name}</Text>
                      <Text style={s.meta}>{Object.entries(e.muscles).filter(([, v]) => (v ?? 0) >= 0.5).map(([m]) => MUSCLE_LABEL[m as Muscle]).join(', ')}</Text>
                    </View>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={s.pickRow} onPress={() => setCustom({ name: q, muscle: 'chest' })}>
                    <Text style={[s.pickName, { color: c.accent }]}>＋ Custom exercise{q ? ` "${q}"` : ''}</Text>
                  </TouchableOpacity>
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  label:    { color: c.textSub, fontSize: 12, fontWeight: '700', marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  input:    { backgroundColor: c.surfaceAlt, color: c.text, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, marginBottom: 6 },
  meta:     { color: c.textSub, fontSize: 13, lineHeight: 18 },
  days:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  day:      { paddingVertical: 7, paddingHorizontal: 11, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  dayOn:    { backgroundColor: c.accent, borderColor: c.accent },
  dayTxt:   { color: c.textSub, fontWeight: '700', fontSize: 13 },
  dayTxtOn: { color: c.onAccent },
  item:     { backgroundColor: c.surface, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: c.border, marginTop: 10 },
  itemName: { color: c.text, fontSize: 15, fontWeight: '700', flex: 1 },
  link:     { color: c.accent, fontWeight: '700', fontSize: 14 },
  grid:     { flexDirection: 'row', gap: 8, marginTop: 8 },
  cell:     { flex: 1 },
  cellLbl:  { color: c.textFaint, fontSize: 11, fontWeight: '700', marginBottom: 3 },
  num:      { backgroundColor: c.surfaceAlt, color: c.text, borderRadius: 8, borderWidth: 1, borderColor: c.border, paddingHorizontal: 8, paddingVertical: 7, fontSize: 15, textAlign: 'center', fontVariant: ['tabular-nums'] },
  icon:     { color: c.textSub, fontSize: 18, fontWeight: '700', paddingHorizontal: 8 },
  cue:      { color: c.textFaint, fontSize: 12, lineHeight: 17, marginTop: 6 },
  addBtn:   { marginTop: 14, paddingVertical: 12, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border },
  addTxt:   { color: c.textSub, fontWeight: '700' },
  delBtn:   { marginTop: 24, alignItems: 'center', paddingVertical: 10 },
  delTxt:   { color: '#e5484d', fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet:    { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 34, maxHeight: '85%' },
  pickRow:  { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  pickName: { color: c.text, fontSize: 15, fontWeight: '600' },
});

/** Does routine `id` (expanded) include `target` anywhere? (an include that would loop back is not offered) */
function flatIncludes(st: StrengthStore, id: string, target: string, depth = 0): boolean {
  const r = st.routines.find(x => x.id === id);
  if (!r || depth > 5) return false;
  return r.items.some(it => it.ref === target || (!!it.ref && flatIncludes(st, it.ref, target, depth + 1)));
}
