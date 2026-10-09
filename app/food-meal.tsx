/**
 * MEAL EDITOR (Food database → Meals → a meal / ＋ New meal): name, components (grams; swipe left to delete), add
 * components by search, by typing a list ("2 eggs, toast, 200 ml milk") or 🎤 by voice; save / delete the meal.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Keyboard, Modal } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { SwipeRow } from '../src/components/SwipeRow';
import { NutritionBreakdown } from '../src/components/NutritionViz';
import { useDictation, cleanDictation } from '../src/components/useDictation';
import {
  loadLibrary, addMeal, renameMeal, updateMealItems, deleteMeal, scaleNutr, FoodLibrary, FoodItem, SavedMealItem, searchCustom,
  SavedMeal, mealUsage, relogMealEverywhere, logMeal, withRs, sumNutr, timeOnDay, mealLabel, MEAL_LABELS, timeForDay, todayFoodDay,
} from '../src/services/foodLog';
import { searchFoodsEx, defaultServing, norm } from '../src/services/foodDb';
import { parseMeal, looksLikeMeal } from '../src/services/foodParse';

const r0 = (v?: number) => (v == null ? '–' : String(Math.round(v)));
const itemOf = (f: FoodItem, grams: number): SavedMealItem => ({ key: f.key, name: f.name, src: f.src, grams, per100: f.per100, ...(f.unit === 'ml' ? { unit: 'ml' as const } : {}) });

export default function FoodMealScreen() {
  const { id, replace } = useLocalSearchParams<{ id: string; replace?: string }>();
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
  const [showStats, setShowStats] = useState(false);
  const [orig, setOrig] = useState<SavedMeal | null>(null);       // the meal as saved — finds its logged instances
  const [pickMeal, setPickMeal] = useState<false | 'replace' | 'delete'>(false);   // ⇄ replace by another meal (required to delete a used one)
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));
  useEffect(() => {
    loadLibrary().then(l => {
      setLib(l);
      const m = l.meals.find(x => x.id === id);
      if (m && replace === '1') setPickMeal('delete');
      if (m) { setOrig(m); setName(m.name); setRows(m.items.map(it => ({ it, gTxt: it.grams != null ? String(r0(it.grams)) : '' }))); }
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
  // each component's nutrients (your resistant-starch / caffeine values merged in) — the 📊 breakdown
  const itemNutr = items.map(it => ({ name: it.name, n: it.per100 && it.grams != null ? scaleNutr(withRs(it.key, it.per100), it.grams) : (it.n ?? {}) }));
  const kcal = sumNutr(itemNutr.map(x => x.n)).kcal ?? 0;   // resistant starch at 2 kcal/g, as on the day

  const save = async () => {
    Keyboard.dismiss();
    if (!items.length) { Alert.alert('No components', 'Add at least one component.'); return; }
    try {
      if (isNew) { const m = await addMeal(name || 'My meal', items); router.replace({ pathname: '/food-meal' as any, params: { id: m.id } }); return; }
      await renameMeal(id, name);
      await updateMealItems(id, items);
      setDirty(false);
      // the meal was LOGGED before → offer to redo those days from the corrected meal (values recalculated)
      const before = orig;
      const next: SavedMeal | null = before ? { ...before, name: name || before.name, items } : null;
      const u = before ? await mealUsage(before).catch(() => ({ instances: 0, days: 0 })) : { instances: 0, days: 0 };
      // ALWAYS redo the logged instances from the corrected meal (Geert: "the recorded meals are modified and the days
      // recalculated") — values recalculated, components left out at the time stay out
      const n = before && next && u.instances ? await relogMealEverywhere(before, next).catch(() => 0) : 0;
      if (next) setOrig(next);
      Alert.alert('Saved', `${name} · ${items.length} components · ${r0(kcal)} kcal${n ? `\n${n} logged meal${n === 1 ? '' : 's'} on ${u.days} day${u.days > 1 ? 's' : ''} recalculated.` : ''}`);
    } catch (e: any) { Alert.alert('Not saved', String(e?.message ?? e)); }
  };
  const del = async () => {
    Keyboard.dismiss();
    const u = orig ? await mealUsage(orig).catch(() => ({ instances: 0, days: 0 })) : { instances: 0, days: 0 };
    if (u.instances) {   // logged before → only with a replacement meal (one-for-one, recalculated)
      Alert.alert(`"${name}" is in use`, `Logged ${u.instances}× on ${u.days} day${u.days > 1 ? 's' : ''}. Pick the meal that replaces it there.`, [
        { text: 'Cancel', style: 'cancel' }, { text: 'Choose replacement', onPress: () => setPickMeal('delete') },
      ]);
      return;
    }
    Alert.alert(`Delete "${name}"?`, 'The saved meal is deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteMeal(id).catch(() => {}); router.back(); } },
    ]);
  };
  // ＋ log this saved meal on a day: which day → what time (default now) → which meal
  const logToDay = () => {
    Keyboard.dismiss();
    if (!orig) return;
    if (dirty) { Alert.alert('Save first', 'Save the changes to the meal, then add it to a day.'); return; }
    const today = todayFoodDay();
    const y = new Date(today + 'T12:00:00'); y.setDate(y.getDate() - 1);
    const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const pick = (day: string, dayName: string) => {
      const def = timeForDay(day).slice(11, 16);
      Alert.prompt(`${dayName} — time`, 'When? (e.g. 12:30)', (v?: string) => {
        if (v == null) return;
        const t = timeOnDay(day, v);
        if (!t) { Alert.alert('Time', 'Use a time like 12:30'); return; }
        Alert.alert('Which meal?', undefined, [
          ...MEAL_LABELS.map(l => ({ text: l === mealLabel(t) ? `${l} ✓` : l, onPress: async () => {
            try { const es = await logMeal(orig, day, 'meal', [], { t, label: l }); Alert.alert('Added', `${orig.name} → ${dayName} · ${l} ${t.slice(11, 16)} (${es.length} items).`); }
            catch (e: any) { Alert.alert('Not added', String(e?.message ?? e)); }
          } })),
          { text: 'Cancel', style: 'cancel' as const },
        ]);
      }, 'plain-text', def);
    };
    Alert.alert(`Add "${orig.name}" to…`, undefined, [
      { text: 'Today', onPress: () => pick(today, 'Today') },
      { text: 'Yesterday', onPress: () => pick(yesterday, 'Yesterday') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const replaceWith = (to: SavedMeal, thenDelete: boolean) => Alert.alert(`Replace by "${to.name}"?`,
    `Every logged "${name}" becomes "${to.name}": its components, values recalculated (components you'd left out stay out).${thenDelete ? ` Then "${name}" is deleted.` : ''}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: async () => {
        if (!orig) return;
        const n = await relogMealEverywhere(orig, to).catch(() => 0);
        if (thenDelete) { await deleteMeal(id).catch(() => {}); setPickMeal(false); router.back(); }
        else { setPickMeal(false); Alert.alert('Replaced', `${n} logged meal${n === 1 ? '' : 's'} now "${to.name}".`); }
      } },
    ]);

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: isNew ? 'New meal' : 'Edit meal' }} />
      <Text style={s.lbl}>Name</Text>
      <TextInput style={s.input} value={name} onChangeText={v => { setName(v); setDirty(true); }} placeholder="e.g. Sunday breakfast" placeholderTextColor={c.textFaint} />

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

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[s.lbl, { flex: 1 }]}>Components · {r0(kcal)} kcal</Text>
        {rows.length > 0 && <TouchableOpacity onPress={() => { Keyboard.dismiss(); setShowStats(true); }} hitSlop={8}><Text style={[s.ghostTxt, { marginTop: 12 }]}>📊 Breakdown</Text></TouchableOpacity>}
      </View>
      {!rows.length && <Text style={s.hint}>None yet — search above, type a list, or 🎤 say them all.</Text>}
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

      <TouchableOpacity style={[s.save, !dirty && !isNew && { opacity: 0.5 }]} onPress={save}><Text style={s.saveTxt}>{isNew ? 'Create meal' : 'Save meal'}</Text></TouchableOpacity>
      {!isNew && <TouchableOpacity style={[s.save, { marginTop: 12, backgroundColor: c.surfaceAlt }]} onPress={logToDay}><Text style={[s.saveTxt, { color: c.accent }]}>＋ Add this meal to a day…</Text></TouchableOpacity>}
      {!isNew && <TouchableOpacity style={s.ghost} onPress={() => setPickMeal('replace')}><Text style={s.ghostTxt}>⇄ Replace by another meal everywhere</Text></TouchableOpacity>}
      {!isNew && <TouchableOpacity style={s.ghost} onPress={() => { del().catch(() => {}); }}><Text style={[s.ghostTxt, { color: '#e5484d' }]}>🗑 Delete meal</Text></TouchableOpacity>}
      {/* 📊 the meal's calories / macros / energy split / contributors */}
      <Modal visible={showStats} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowStats(false)}>
        <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Text style={[s.lbl, { flex: 1, marginTop: 0 }]}>{name || 'Meal'} — breakdown</Text>
            <TouchableOpacity onPress={() => setShowStats(false)} hitSlop={10}><Text style={s.ghostTxt}>Close</Text></TouchableOpacity>
          </View>
          {showStats && <NutritionBreakdown items={itemNutr} total={sumNutr(itemNutr.map(x => x.n))} />}
        </ScrollView>
      </Modal>
      <Modal visible={!!pickMeal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickMeal(false)}>
        <ScrollView style={s.screen} contentContainerStyle={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[s.lbl, { flex: 1, marginTop: 0 }]}>Replace "{name}" by…</Text>
            <TouchableOpacity onPress={() => setPickMeal(false)} hitSlop={10}><Text style={s.ghostTxt}>Cancel</Text></TouchableOpacity>
          </View>
          {(lib?.meals ?? []).filter(m => m.id !== id).map(m => (
            <TouchableOpacity key={m.id} style={s.result} onPress={() => replaceWith(m, pickMeal === 'delete')}>
              <Text style={s.compName}>🍽️ {m.name}</Text>
              <Text style={s.hint}>{m.items.length} components — {m.items.map(i => i.name.split(',')[0]).join(', ')}</Text>
            </TouchableOpacity>
          ))}
          {(lib?.meals ?? []).filter(m => m.id !== id).length === 0 && <Text style={s.hint}>No other saved meal yet — create one first (＋ New meal).</Text>}
        </ScrollView>
      </Modal>
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
