/**
 * MEAL EDITOR (Food database → Meals → a meal / ＋ New meal): name, components (grams; swipe left to delete), add
 * components by search, by typing a list ("2 eggs, toast, 200 ml milk") or 🎤 by voice; save / delete the meal.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Keyboard } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { SwipeRow } from '../src/components/SwipeRow';
import { useDictation, cleanDictation } from '../src/components/useDictation';
import {
  loadLibrary, addMeal, renameMeal, updateMealItems, deleteMeal, scaleNutr, FoodLibrary, FoodItem, SavedMealItem, searchCustom,
} from '../src/services/foodLog';
import { searchFoodsEx, defaultServing, norm } from '../src/services/foodDb';
import { parseMeal, looksLikeMeal } from '../src/services/foodParse';

const r0 = (v?: number) => (v == null ? '–' : String(Math.round(v)));
const itemOf = (f: FoodItem, grams: number): SavedMealItem => ({ key: f.key, name: f.name, src: f.src, grams, per100: f.per100, ...(f.unit === 'ml' ? { unit: 'ml' as const } : {}) });

export default function FoodMealScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [lib, setLib] = useState<FoodLibrary | null>(null);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<{ it: SavedMealItem; gTxt: string }[]>([]);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));
  useEffect(() => {
    loadLibrary().then(l => {
      setLib(l);
      const m = l.meals.find(x => x.id === id);
      if (m) { setName(m.name); setRows(m.items.map(it => ({ it, gTxt: it.grams != null ? String(r0(it.grams)) : '' }))); }
    }).catch(() => {});
  }, [id]);

  const appendFoods = (list: { food: FoodItem; grams: number }[]) => {
    if (!list.length) return;
    setRows(prev => [...prev, ...list.map(x => ({ it: itemOf(x.food, x.grams), gTxt: String(r0(x.grams)) }))]);
    setDirty(true);
  };
  const addParsed = (text: string) => {
    const parsed = parseMeal(cleanDictation(text), undefined, t => (lib ? searchCustom(lib, t, norm)[0] : undefined));   // your own foods match too
    appendFoods(parsed.filter(p => p.food).map(p => ({ food: p.food!, grams: p.grams })));
    const miss = parsed.filter(p => !p.food).map(p => p.query);
    if (miss.length) Alert.alert('Not found', `No match for: ${miss.join(', ')} — search them one by one below.`);
  };
  const dict = useDictation(addParsed);

  const isList = dq.length >= 4 && looksLikeMeal(dq);
  const listCount = useMemo(() => (isList ? parseMeal(dq).length : 0), [isList, dq]);
  const results = useMemo(() => {
    if (dq.length < 2 || isList || !lib) return [] as FoodItem[];
    const mine = searchCustom(lib, dq, norm);
    const seen = new Set(mine.map(f => f.key));
    return [...mine, ...searchFoodsEx(dq, 15).items.filter(f => !seen.has(f.key))].slice(0, 15);
  }, [dq, isList, lib]);

  const gOf = (t: string) => parseFloat(t.replace(',', '.'));
  const items: SavedMealItem[] = rows.map(r => (r.it.per100 && gOf(r.gTxt) > 0 ? { ...r.it, grams: gOf(r.gTxt) } : r.it));
  const kcal = items.reduce((a, it) => a + ((it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams).kcal : it.n?.kcal) ?? 0), 0);

  const save = async () => {
    Keyboard.dismiss();
    if (!items.length) { Alert.alert('No components', 'Add at least one component.'); return; }
    try {
      if (isNew) { const m = await addMeal(name || 'My meal', items); router.replace({ pathname: '/food-meal' as any, params: { id: m.id } }); return; }
      await renameMeal(id, name);
      await updateMealItems(id, items);
      setDirty(false);
      Alert.alert('Saved', `${name} · ${items.length} components · ${r0(kcal)} kcal`);
    } catch (e: any) { Alert.alert('Not saved', String(e?.message ?? e)); }
  };
  const del = () => { Keyboard.dismiss(); Alert.alert(`Delete "${name}"?`, 'The saved meal is deleted. Logged days keep their entries.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { await deleteMeal(id).catch(() => {}); router.back(); } },
  ]); };

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: isNew ? 'New meal' : 'Edit meal' }} />
      <Text style={s.lbl}>Name</Text>
      <TextInput style={s.input} value={name} onChangeText={v => { setName(v); setDirty(true); }} placeholder="e.g. Sunday breakfast" placeholderTextColor={c.textFaint} />

      <Text style={s.lbl}>Components · {r0(kcal)} kcal</Text>
      {!rows.length && <Text style={s.hint}>None yet — search below, type a list, or 🎤 say them all.</Text>}
      {rows.map((r, i) => (
        <SwipeRow key={`${r.it.key}-${i}`} onDelete={() => { setRows(prev => prev.filter((_, j) => j !== i)); setDirty(true); }}>
          <View style={s.comp}>
            <Text style={s.compName} numberOfLines={2}>{r.it.name}</Text>
            {r.it.per100 ? (
              <>
                <TextInput style={s.grams} value={r.gTxt} keyboardType="decimal-pad" selectTextOnFocus
                  onChangeText={v => { setRows(prev => prev.map((x, j) => (j === i ? { ...x, gTxt: v } : x))); setDirty(true); }} />
                <Text style={s.unit}>{r.it.unit === 'ml' ? 'ml' : 'g'}</Text>
              </>
            ) : <Text style={s.unit}>{r0(r.it.n?.kcal)} kcal</Text>}
          </View>
        </SwipeRow>
      ))}
      {rows.length > 0 && <Text style={s.hint}>Swipe a component left to delete it.</Text>}

      <Text style={s.lbl}>Add components</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[s.input, { flex: 1 }]} value={q} onChangeText={setQ} placeholder="Search, or a list: 2 eggs, toast, 200 ml milk" placeholderTextColor={c.textFaint} autoCorrect={false} returnKeyType="done" />
        <TouchableOpacity style={[s.mic, dict.state === 'recording' && s.micRec]} onPress={() => { Keyboard.dismiss(); dict.toggle(); }}>
          <Text style={{ fontSize: 18 }}>{dict.state === 'recording' ? '⏹' : dict.state === 'transcribing' ? '…' : '🎤'}</Text>
        </TouchableOpacity>
      </View>
      {dict.state === 'recording' && <Text style={[s.hint, { color: c.accent }]}>● Listening — name every component, then tap ⏹</Text>}
      {isList && (
        <TouchableOpacity style={s.addList} onPress={() => { addParsed(dq); setQ(''); }}>
          <Text style={s.addListTxt}>＋ Add the {listCount} listed components</Text>
        </TouchableOpacity>
      )}
      {results.map(f => (
        <TouchableOpacity key={f.key} style={s.result} onPress={() => { appendFoods([{ food: f, grams: defaultServing(f).g }]); setQ(''); }}>
          <Text style={s.compName} numberOfLines={1}>＋ {f.name}</Text>
          <Text style={s.hint}>{r0(f.per100.kcal)} kcal/100 {f.unit === 'ml' ? 'ml' : 'g'} · adds {defaultServing(f).g} {f.unit === 'ml' ? 'ml' : 'g'}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity style={[s.save, !dirty && !isNew && { opacity: 0.5 }]} onPress={save}><Text style={s.saveTxt}>{isNew ? 'Create meal' : 'Save meal'}</Text></TouchableOpacity>
      {!isNew && <TouchableOpacity style={s.ghost} onPress={del}><Text style={[s.ghostTxt, { color: '#e5484d' }]}>🗑 Delete meal</Text></TouchableOpacity>}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  lbl:      { color: c.textSub, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 18, marginBottom: 6 },
  input:    { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: c.text, fontSize: 15 },
  comp:     { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 4, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  compName: { flex: 1, color: c.text, fontSize: 14.5, fontWeight: '600' },
  grams:    { width: 70, textAlign: 'right', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: c.text, fontSize: 15 },
  unit:     { color: c.textSub, fontSize: 13, minWidth: 22 },
  hint:     { color: c.textSub, fontSize: 12.5, marginTop: 4 },
  mic:      { width: 46, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  micRec:   { backgroundColor: '#ef4444', borderColor: '#ef4444' },
  addList:  { marginTop: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.surfaceAlt },
  addListTxt: { color: c.accent, fontWeight: '700' },
  result:   { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  save:     { marginTop: 24, backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  saveTxt:  { color: c.onAccent, fontWeight: '800', fontSize: 16 },
  ghost:    { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
  ghostTxt: { color: c.accent, fontWeight: '700', fontSize: 14 },
});
