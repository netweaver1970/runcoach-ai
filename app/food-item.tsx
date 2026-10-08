/**
 * FOOD EDITOR (Food database → Foods → a food / ＋ New food). Your OWN foods: name, brand, g/ml, per-100 values,
 * serving — all editable, deletable. A food-table / product food: values read-only (make an editable copy), but its
 * ★, meal tags and YOUR serving size are yours to set; "Remove" takes it off your list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Keyboard, Modal } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  loadLibrary, addCustomFood, updateCustomFood, deleteCustomFood, forgetFoods, setFavourites, setMealTags, setServing,
  FoodLibrary, FoodItem, KeptFood, MEAL_TAGS, MealTag, Nutr, NutrKey, servingOverrides, rsOverrides, setResistantStarch, MICROS, cafOverrides, setCaffeine,
  foodUsage, replaceFoodEverywhere, renameInLogs, searchCustom,
} from '../src/services/foodLog';
import { foodByKey, searchFoodsEx, norm } from '../src/services/foodDb';
import { cachedProducts } from '../src/services/foodOff';

const FIELDS: { k: NutrKey; label: string; unit: string }[] = [
  { k: 'kcal', label: 'Energy', unit: 'kcal' }, { k: 'prot', label: 'Protein', unit: 'g' }, { k: 'carb', label: 'Carbs', unit: 'g' },
  { k: 'sug', label: '  of which sugars', unit: 'g' }, { k: 'rs', label: '  of which resistant starch', unit: 'g' }, { k: 'fat', label: 'Fat', unit: 'g' }, { k: 'sat', label: '  of which saturated', unit: 'g' },
  { k: 'fib', label: 'Fibre', unit: 'g' }, { k: 'salt', label: 'Salt', unit: 'g' }, { k: 'caf', label: 'Caffeine', unit: 'mg' },
];
const num = (t: string) => { const v = parseFloat(t.replace(',', '.')); return Number.isFinite(v) && v >= 0 ? v : undefined; };
const txt = (v?: number) => (v == null ? '' : String(Math.round(v * 10) / 10));

export default function FoodItemScreen() {
  const { key, replace } = useLocalSearchParams<{ key: string; replace?: string }>();
  const isNew = key === 'new';
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [lib, setLib] = useState<FoodLibrary | null>(null);
  const [base, setBase] = useState<(Partial<FoodItem> & { n?: Nutr }) | null>(null);   // the food as found (any source)
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [unit, setUnit] = useState<'g' | 'ml'>('g');
  const [vals, setVals] = useState<Partial<Record<NutrKey, string>>>({});
  const [srv, setSrv] = useState('');
  // ⇄ replace this food everywhere by another (required before deleting a food that's used on logged days)
  const [picking, setPicking] = useState<null | { usage: { entries: number; days: number; meals: string[] }; thenDelete: boolean }>(null);
  const [rq, setRq] = useState('');
  const openReplace = async (thenDelete: boolean) => { Keyboard.dismiss(); setRq(''); setPicking({ usage: await foodUsage(key), thenDelete }); };
  useEffect(() => { if (replace === '1' && !isNew) openReplace(true).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [replace, key]);
  const own = isNew || !!lib?.custom.some(x => x.key === key);

  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));
  useEffect(() => {
    (async () => {
      const l = await loadLibrary();
      setLib(l);
      if (isNew) return;
      const prods = await cachedProducts().catch(() => []);
      const f: any = l.custom.find(x => x.key === key) ?? l.kept?.[key] ?? l.favItems?.[key] ?? l.recents.find(r => r.key === key) ?? foodByKey(key) ?? prods.find(p => p.key === key);
      if (!f) return;
      setBase(f);
      setName(f.name ?? ''); setBrand(f.brand ?? ''); setUnit(f.unit === 'ml' ? 'ml' : 'g');
      const p100: Nutr = f.per100 ?? {};
      setVals({ ...Object.fromEntries([...FIELDS.map(x => x.k), ...MICROS.map(m => m.k)].map(k => [k, txt(p100[k])])), ...(rsOverrides[key] != null ? { rs: txt(rsOverrides[key]) } : {}), ...(cafOverrides[key] != null ? { caf: txt(cafOverrides[key]) } : {}) });
      const sv = servingOverrides[key] ?? f.serving;
      setSrv(sv?.g ? String(sv.g) : '');
    })().catch(() => {});
  }, [key, isNew]);

  const snap = (): KeptFood => ({ key, snap: { name: name || base?.name || 'Food', src: (base?.src ?? 'custom') as any, ...(base?.per100 ? { per100: base.per100 } : {}), ...(base?.n ? { n: base.n } : {}), ...(unit === 'ml' ? { unit: 'ml' as const } : {}) } });
  const fav = !!lib?.favs.includes(key);
  const tags = lib?.tags?.[key] ?? [];
  const per100 = (): Nutr => Object.fromEntries([...FIELDS.map(x => x.k), ...MICROS.map(m => m.k)].map(k => [k, num(vals[k] ?? '')]).filter(([, v]) => v != null)) as Nutr;
  const [showMicros, setShowMicros] = useState(false);

  const save = async () => {
    Keyboard.dismiss();
    try {
      const p = per100();
      const sg = num(srv);
      if (p.rs != null && p.rs > (p.carb ?? 0) + 0.5) { Alert.alert('Check resistant starch', 'It is PART of the carbs — it can\'t be more than the carbs per 100.'); return; }
      if (isNew) {
        if (!name.trim() || p.kcal == null) { Alert.alert('Missing', 'A name and the energy (kcal per 100) are needed.'); return; }
        const it = await addCustomFood({ name, brand: brand || undefined, per100: p, unit, ...(sg ? { serving: { g: sg, label: '1 serving' } } : {}) });
        router.replace({ pathname: '/food-item' as any, params: { key: it.key } });
        return;
      }
      if (own) {
        if (!name.trim() || p.kcal == null) { Alert.alert('Missing', 'A name and the energy (kcal per 100) are needed.'); return; }
        await updateCustomFood(key, { name, brand, per100: p, unit, serving: sg ? { g: sg, label: base?.serving?.label ?? '1 serving' } : null });
        // corrected values / unit → every logged use of this food is RECALCULATED (and renamed), saved meals follow
        const valuesChanged = JSON.stringify(base?.per100 ?? {}) !== JSON.stringify(p) || (base?.unit === 'ml' ? 'ml' : 'g') !== unit;
        if (valuesChanged) await replaceFoodEverywhere(key, { key, name: name.trim() || base?.name || 'Food', src: 'custom', per100: p, unit });
        else if (base?.name && name.trim() && name.trim() !== base.name) await renameInLogs(key, name.trim());   // logged days show the new name
        setBase(b => (b ? { ...b, name: name.trim() || b.name, per100: p, unit } : b));
        await setServing(key, sg ? { g: sg, label: base?.serving?.label ?? '1 serving' } : null);   // an older own-serving override must not win
      }
      if (!own) {
        const rsv = num(vals.rs ?? '');
        const carb = base?.per100?.carb ?? 0;
        if (rsv != null && rsv > carb + 0.5) { Alert.alert('Check resistant starch', `It's part of the carbs, so it can't be more than the ${Math.round(carb)} g carbs per 100.`); return; }
        await setResistantStarch(key, rsv ?? null);
        // caffeine: your value for this food (only stored when it differs from the table / label value)
        const cv = num(vals.caf ?? '');
        await setCaffeine(key, cv != null && cv !== (base?.per100?.caf ?? null) ? cv : null);
      }
      if (!own) await setServing(key, sg ? { g: sg, label: base?.serving?.label && !/^100 g$/.test(base.serving.label) ? base.serving.label : '1 serving' } : null);
      setLib(await loadLibrary());
      Alert.alert('Saved', name || base?.name || '');
    } catch (e: any) { Alert.alert('Not saved', String(e?.message ?? e)); }
  };
  const del = async () => {
    Keyboard.dismiss();
    // your own food that's USED on logged days / in saved meals → only with a replacement (one-for-one)
    if (own) {
      const u = await foodUsage(key).catch(() => ({ entries: 0, days: 0, meals: [] as string[] }));
      if (u.entries || u.meals.length) {
        Alert.alert(`"${name}" is in use`, `${u.entries ? `${u.entries} logged item${u.entries > 1 ? 's' : ''} on ${u.days} day${u.days > 1 ? 's' : ''}` : ''}${u.entries && u.meals.length ? ' and ' : ''}${u.meals.length ? `the meal${u.meals.length > 1 ? 's' : ''} ${u.meals.join(', ')}` : ''}. Pick the food that replaces it — the logged amounts stay, their values are recalculated from it.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Choose replacement', onPress: () => { openReplace(true).catch(() => {}); } },
        ]);
        return;
      }
    }
    Alert.alert(own ? `Delete "${name}"?` : `Remove "${name}" from your foods?`, own ? 'Your own food is deleted. Days you already logged keep their entries.' : 'Un-stars and untags it and drops it from recents. The food table keeps it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: own ? 'Delete' : 'Remove', style: 'destructive', onPress: async () => { await (own ? deleteCustomFood(key) : forgetFoods([key])).catch(() => {}); router.back(); } },
    ]);
  };
  const copyEditable = async () => {
    const it = await addCustomFood({ name: `${name} (mine)`, ...(brand ? { brand } : {}), per100: per100(), unit, ...(num(srv) ? { serving: { g: num(srv)!, label: '1 serving' } } : {}) });
    router.replace({ pathname: '/food-item' as any, params: { key: it.key } });
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Stack.Screen options={{ title: isNew ? 'New food' : own ? 'Edit food' : 'Food' }} />
      {/* ★ + meal tags — for any food, independent of logging */}
      {!isNew && (
        <View style={s.rowWrap}>
          <TouchableOpacity style={[s.chip, fav && s.chipOn]} onPress={() => setFavourites([snap()], !fav).then(setLib).catch(() => {})}>
            <Text style={[s.chipTxt, fav && { color: c.onAccent }]}>{fav ? '★ Favourite' : '☆ Favourite'}</Text>
          </TouchableOpacity>
          {MEAL_TAGS.map(t => {
            const on = tags.includes(t.id as MealTag);
            return (
              <TouchableOpacity key={t.id} style={[s.chip, on && s.chipOn]} onPress={() => setMealTags([snap()], [t.id], on ? 'remove' : 'add').then(setLib).catch(() => {})}>
                <Text style={[s.chipTxt, on && { color: c.onAccent }]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <Text style={s.lbl}>Name</Text>
      <TextInput style={[s.input, !own && s.ro]} value={name} onChangeText={setName} editable={own} placeholder="e.g. Overnight oats" placeholderTextColor={c.textFaint} />
      <Text style={s.lbl}>Brand (optional)</Text>
      <TextInput style={[s.input, !own && s.ro]} value={brand} onChangeText={setBrand} editable={own} placeholderTextColor={c.textFaint} />
      <View style={[s.rowWrap, { marginTop: 12 }]}>
        {(['g', 'ml'] as const).map(u => (
          <TouchableOpacity key={u} disabled={!own} style={[s.chip, unit === u && s.chipOn]} onPress={() => setUnit(u)}>
            <Text style={[s.chipTxt, unit === u && { color: c.onAccent }]}>{u === 'g' ? 'Solid (per 100 g)' : 'Liquid (per 100 ml)'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.lbl}>Per 100 {unit}</Text>
      {FIELDS.map(f => (
        <View key={f.k} style={s.field}>
          <Text style={s.fieldLbl}>{f.label}</Text>
          <TextInput style={[s.num, !own && f.k !== 'rs' && f.k !== 'caf' && s.ro]} value={vals[f.k] ?? ''} editable={own || f.k === 'rs' || f.k === 'caf'} keyboardType="decimal-pad" selectTextOnFocus
            onChangeText={v => setVals(p => ({ ...p, [f.k]: v }))} placeholder="–" placeholderTextColor={c.textFaint} />
          <Text style={s.unit}>{f.unit}</Text>
        </View>
      ))}
      {/* minerals & vitamins per 100 — CIQUAL 2025 / Open Food Facts; editable for your own foods */}
      <TouchableOpacity onPress={() => setShowMicros(v => !v)} hitSlop={6}>
        <Text style={s.lbl}>{showMicros ? '▾' : '▸'} Minerals & vitamins per 100 {unit} ({MICROS.filter(m => (vals[m.k] ?? '') !== '').length}/{MICROS.length} known)</Text>
      </TouchableOpacity>
      {showMicros && MICROS.map(m => (
        <View key={m.k} style={s.field}>
          <Text style={s.fieldLbl}>{m.label}</Text>
          <TextInput style={[s.num, !own && s.ro]} value={vals[m.k] ?? ''} editable={own} keyboardType="decimal-pad" selectTextOnFocus
            onChangeText={v => setVals(p => ({ ...p, [m.k]: v }))} placeholder="–" placeholderTextColor={c.textFaint} />
          <Text style={s.unit}>{m.unit}</Text>
        </View>
      ))}
      {showMicros && <Text style={s.hint}>"–" = not measured for this food (it then adds nothing to the day). Source: {own ? 'your values' : base?.src === 'off' ? 'Open Food Facts' : 'CIQUAL 2025 (Anses)'}.</Text>}
      <Text style={s.hint}>Resistant starch is part of the carbs on the label but isn't absorbed — it feeds the gut bacteria (~2 kcal/g). It's left out of your day's carbs and counted at 2 kcal/g. Typical: RAW unmodified potato starch ≈ 60–70 g / 100 g (stirred in cold, never heated) · cooked starch ≈ 0–1 · cooked-then-cooled potato / rice ≈ 1–3 · green banana flour ≈ 40–50. Only enter what the label's carbs INCLUDE (if the label already counts it as fibre, leave this empty).</Text>
      <Text style={s.lbl}>1 serving / pack ({unit})</Text>
      <TextInput style={s.input} value={srv} onChangeText={setSrv} keyboardType="decimal-pad" placeholder="e.g. 240 — leave empty for none" placeholderTextColor={c.textFaint} />
      {!own && <Text style={s.hint}>Values come from {base?.src === 'off' ? 'Open Food Facts' : 'the food table'} — read-only. The serving size is yours.</Text>}

      <TouchableOpacity style={[s.save, !lib && { opacity: 0.4 }]} disabled={!lib} onPress={save}><Text style={s.saveTxt}>{isNew ? 'Create food' : 'Save'}</Text></TouchableOpacity>
      {!own && !isNew && <TouchableOpacity style={s.ghost} onPress={() => copyEditable().catch(() => {})}><Text style={s.ghostTxt}>✏️ Make an editable copy</Text></TouchableOpacity>}
      {!isNew && <TouchableOpacity style={s.ghost} onPress={() => openReplace(false).catch(() => {})}><Text style={s.ghostTxt}>⇄ Replace by another food everywhere</Text></TouchableOpacity>}
      {!isNew && base?.src !== 'off' && <TouchableOpacity style={s.ghost} onPress={() => { del().catch(() => {}); }}><Text style={[s.ghostTxt, { color: '#e5484d' }]}>{own ? '🗑 Delete food' : 'Remove from my foods'}</Text></TouchableOpacity>}
      <ReplacePicker open={!!picking} lib={lib} exclude={key} name={name} usage={picking?.usage} thenDelete={!!picking?.thenDelete} q={rq} setQ={setRq}
        onClose={() => { Keyboard.dismiss(); setPicking(null); }}
        onPick={to => {
          const u = picking!.usage, del2 = picking!.thenDelete;
          Keyboard.dismiss();
          Alert.alert(`Replace by "${to.name}"?`, `${u.entries} logged item${u.entries === 1 ? '' : 's'} (${u.days} day${u.days === 1 ? '' : 's'})${u.meals.length ? ` and ${u.meals.length} saved meal${u.meals.length > 1 ? 's' : ''}` : ''} become "${to.name}": same logged amounts, values RECALCULATED from "${to.name}" (the day totals follow)${u.meals.length ? '; saved meals use the new food' : ''}.${del2 ? ` Then "${name}" is ${own ? 'deleted' : 'removed from your foods'}.` : ''}`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Replace', style: 'destructive', onPress: async () => {
              try {
                await replaceFoodEverywhere(key, { key: to.key, name: to.name, src: to.src, per100: to.per100, ...(to.unit ? { unit: to.unit } : {}) });
                if (del2) await (own ? deleteCustomFood(key) : forgetFoods([key]));
                setPicking(null);
                router.replace({ pathname: '/food-item' as any, params: { key: to.key } });
              } catch (e: any) { Alert.alert('Not replaced', String(e?.message ?? e)); }
            } },
          ]);
        }} />
    </ScrollView>
  );
}

/** Choose the food that replaces this one (your own foods first, then the food table). */
function ReplacePicker({ open, lib, exclude, name, usage, thenDelete, q, setQ, onClose, onPick }: {
  open: boolean; lib: FoodLibrary | null; exclude: string; name: string; usage?: { entries: number; days: number; meals: string[] }; thenDelete: boolean;
  q: string; setQ: (v: string) => void; onClose: () => void; onPick: (f: FoodItem) => void;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const qt = q.trim();
  const results: FoodItem[] = !lib ? [] : qt.length < 2 ? lib.custom.filter(f => f.key !== exclude).slice(0, 20)
    : [...searchCustom(lib, qt, norm), ...searchFoodsEx(qt, 20).items].filter((f, i, a) => f.key !== exclude && a.findIndex(x => x.key === f.key) === i);
  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.screen, { padding: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <Text style={[s.lbl, { flex: 1, marginTop: 0 }]}>Replace "{name}" by…</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}><Text style={s.ghostTxt}>Cancel</Text></TouchableOpacity>
        </View>
        {usage && <Text style={s.hint}>Used in {usage.entries} logged item{usage.entries === 1 ? '' : 's'}{usage.days ? ` on ${usage.days} day${usage.days > 1 ? 's' : ''}` : ''}{usage.meals.length ? ` · meals: ${usage.meals.join(', ')}` : ''}. One-for-one: the logged amounts stay, the values are recalculated from the food you pick{thenDelete ? ` — then "${name}" goes` : ''}.</Text>}
        <TextInput style={[s.input, { marginTop: 10 }]} value={q} onChangeText={setQ} placeholder="Search your foods + the food table" placeholderTextColor={c.textFaint} autoFocus autoCorrect={false} />
        <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 6 }}>
          {qt.length < 2 && <Text style={s.hint}>Your own foods — or type to search everything.</Text>}
          {results.map(f => (
            <TouchableOpacity key={f.key} style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }} onPress={() => onPick(f)}>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={2}>{f.src === 'custom' ? '✏️ ' : ''}{f.name}</Text>
              <Text style={s.hint}>{Math.round(f.per100.kcal ?? 0)} kcal/100 {f.unit === 'ml' ? 'ml' : 'g'}{f.brand ? ` · ${f.brand}` : ''}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  rowWrap:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:     { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  chipOn:   { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:  { color: c.text, fontWeight: '600', fontSize: 13 },
  lbl:      { color: c.textSub, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  input:    { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: c.text, fontSize: 15 },
  ro:       { opacity: 0.6 },
  field:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  fieldLbl: { flex: 1, color: c.text, fontSize: 14 },
  num:      { width: 90, textAlign: 'right', backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, color: c.text, fontSize: 15 },
  unit:     { width: 40, color: c.textSub, marginLeft: 6 },
  hint:     { color: c.textSub, fontSize: 12.5, marginTop: 8 },
  save:     { marginTop: 22, backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  saveTxt:  { color: c.onAccent, fontWeight: '800', fontSize: 16 },
  ghost:    { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
  ghostTxt: { color: c.accent, fontWeight: '700', fontSize: 14 },
});
