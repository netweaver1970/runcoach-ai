/**
 * FOOD DATABASE (Foods | Meals) — like the exercise database: browse, add, edit, delete (swipe left on a row).
 * Foods tab = MY FOODS — foods maintained on their own, independent of logging (Geert 2026-10-08): star a food as a favourite and
 * tag it with the meal types it belongs to (several: breakfast AND snack…) without first adding it to a meal or a day;
 * select one or many foods and star / tag them at once. Lists every food you have (own foods, favourites, recents,
 * scanned products, foods you tagged); a search also reaches the whole food table, so any food can be starred/tagged.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Alert, Keyboard, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SwipeRow } from '../src/components/SwipeRow';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  loadLibrary, setFavourites, setMealTags, forgetFoods, FoodLibrary, FavItem, KeptFood, MealTag, MEAL_TAGS, Nutr,
  deleteCustomFood, deleteMeal, scaleNutr, foodUsage, mealUsage,
} from '../src/services/foodLog';
import { searchFoodsEx, foodByKey, norm, allDrinks, drinkCategory, DRINK_CATS, DrinkCat } from '../src/services/foodDb';
import { ASIA_ITEMS, ASIA_CATS } from '../src/services/foodAsia';
import { cachedProducts } from '../src/services/foodOff';

interface Row { key: string; name: string; sub: string; snap: KeptFood['snap']; table?: boolean; cat?: string }
type Filter = 'all' | 'fav' | MealTag | 'untagged' | 'sgmy';

const r0 = (v?: number) => (v == null ? '–' : String(Math.round(v)));
const subOf = (f: { per100?: Nutr; n?: Nutr; unit?: 'g' | 'ml'; brand?: string }) =>
  `${f.brand ? `${f.brand} · ` : ''}${f.per100 ? `${r0(f.per100.kcal)} kcal/100 ${f.unit === 'ml' ? 'ml' : 'g'} · P ${r0(f.per100.prot)} C ${r0(f.per100.carb)} F ${r0(f.per100.fat)}` : f.n ? `${r0(f.n.kcal)} kcal` : ''}`;
const snapOf = (f: any): KeptFood['snap'] => ({ name: f.name, src: f.src, ...(f.per100 ? { per100: f.per100 } : {}), ...(f.n ? { n: f.n } : {}),
  ...(f.unit ? { unit: f.unit } : {}), ...(f.serving ? { serving: f.serving } : {}), ...(f.grams ? { grams: f.grams } : {}) });

export default function FoodLibraryScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [lib, setLib] = useState<FoodLibrary | null>(null);
  const [prods, setProds] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');   // debounced query (the table search isn't run on every keystroke)
  useEffect(() => { const t = setTimeout(() => setDq(q), 150); return () => clearTimeout(t); }, [q]);
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<Set<string> | null>(null);   // null = not selecting
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'foods' | 'drinks' | 'meals'>('foods');
  const [dcat, setDcat] = useState<DrinkCat | 'All'>('All');   // Drinks tab: category filter
  const router = useRouter();

  useFocusEffect(useCallback(() => {
    loadLibrary().then(setLib).catch(() => {});
    cachedProducts().then(setProds).catch(() => {});
    return () => Keyboard.dismiss();   // never leave with the keyboard up (iOS freeze)
  }, []));

  // every food you have, once (newest knowledge wins: own food > kept/fav snapshot > recent > product cache)
  const mine = useMemo<Row[]>(() => {
    if (!lib) return [];
    const m = new Map<string, Row>();
    const add = (key: string, f: any) => { if (!m.has(key) && f?.name) m.set(key, { key, name: f.name, sub: subOf(f), snap: snapOf(f) }); };
    for (const f of lib.custom) add(f.key, f);
    for (const f of Object.values(lib.kept ?? {})) add(f.key, f);
    for (const f of Object.values(lib.favItems ?? {})) add(f.key, f);
    for (const r of lib.recents) add(r.key, r);
    for (const k of lib.favs) add(k, foodByKey(k));
    for (const k of Object.keys(lib.tags ?? {})) add(k, foodByKey(k));
    for (const p of prods) add(p.key, p);
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [lib, prods]);

  const favs = useMemo(() => new Set(lib?.favs ?? []), [lib]);
  const tagsOf = (k: string) => lib?.tags?.[k] ?? [];
  const qn = norm(dq.trim());
  const rows = useMemo<Row[]>(() => {
    const words = qn.split(' ').filter(Boolean);
    const hit = (r: Row) => !words.length || words.every(w => norm(r.name).split(' ').some(x => x.startsWith(w)));
    // SG/MY: browse the built-in Singapore / Malaysia foods by category (their drinks are on the Drinks tab)
    if (filter === 'sgmy') {
      return ASIA_ITEMS.filter(x => x.unit !== 'ml' && (!words.length || words.every(w => norm(`${x.name} ${x.aliases.join(' ')}`).split(' ').some(y => y.startsWith(w)))))
        .sort((a, b) => ASIA_CATS.indexOf(a.asiaCat) - ASIA_CATS.indexOf(b.asiaCat))
        .map(f => ({ key: f.key, name: f.name, sub: subOf(f), snap: snapOf(f), table: true, cat: f.asiaCat }));
    }
    const pass = (r: Row) => filter === 'all' ? true : filter === 'fav' ? favs.has(r.key) : filter === 'untagged' ? !tagsOf(r.key).length : tagsOf(r.key).includes(filter);
    const own = mine.filter(r => hit(r) && pass(r));
    // a search also reaches the food table → star / tag a food you've never logged
    if (words.length && dq.trim().length >= 2 && (filter === 'all' || filter === 'untagged')) {
      const seen = new Set(own.map(r => r.key));
      const table = searchFoodsEx(dq.trim(), 25).items.filter(f => !seen.has(f.key) && !mine.some(r => r.key === f.key))
        .map(f => ({ key: f.key, name: f.name, sub: subOf(f), snap: snapOf(f), table: true }));
      return [...own, ...table];
    }
    return own;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, qn, filter, favs, lib]);

  // single-row taps are never dropped: the library's write queue applies them in order; only the bulk bar waits
  const run = async (fn: () => Promise<FoodLibrary>, bulk = false) => {
    if (bulk) { if (busy) return; setBusy(true); }
    try { setLib(await fn()); } catch (e: any) { Alert.alert('Not saved', String(e?.message ?? e)); } finally { if (bulk) setBusy(false); }
  };
  const kf = (r: Row): KeptFood => ({ key: r.key, snap: r.snap });
  // swipe → Delete: your own food is deleted; any other food leaves your list (star / tags / recent) — the food table keeps it
  const delOne = async (r: Row) => {
    const own = !!lib?.custom.some(x => x.key === r.key);
    // your own food used on logged days / in meals → deleting needs a one-for-one replacement (picked in its editor)
    if (own) {
      const u = await foodUsage(r.key).catch(() => ({ entries: 0, days: 0, meals: [] as string[] }));
      if (u.entries || u.meals.length) { router.push({ pathname: '/food-item' as any, params: { key: r.key, replace: '1' } }); return; }
    }
    run(() => (own ? deleteCustomFood(r.key) : forgetFoods([r.key])));
  };
  const selected = sel ? rows.filter(r => sel.has(r.key)) : [];   // only VISIBLE rows act (a filter/search hides the rest)
  const toggleSel = (k: string) => setSel(cur => { const n = new Set(cur ?? []); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  // bulk: a star / tag goes ON for all selected unless ALL of them already have it (then OFF)
  const bulkStar = () => { const on = !selected.every(r => favs.has(r.key)); run(() => setFavourites(selected.map(kf), on), true); };
  const bulkTag = (t: MealTag) => { const all = selected.every(r => tagsOf(r.key).includes(t)); run(() => setMealTags(selected.map(kf), [t], all ? 'remove' : 'add'), true); };
  const bulkForget = () => { Keyboard.dismiss(); Alert.alert(`Clear ${selected.length} food${selected.length > 1 ? 's' : ''}?`, 'Un-stars, untags and drops them from recents. Logged days are not touched. Scanned products and your own foods (✏️) stay listed — just without star or tags.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: () => run(() => forgetFoods(selected.map(r => r.key)), true).then(() => setSel(new Set())) },
  ]); };

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'fav', label: '★' }, ...MEAL_TAGS.map(t => ({ id: t.id as Filter, label: t.label })), { id: 'untagged', label: 'No meal' }, { id: 'sgmy', label: 'SG/MY' },
  ];
  const meals = lib?.meals ?? [];
  const tabs = (
    <View style={s.tabsRow}>
      {(['foods', 'drinks', 'meals'] as const).map(t => (
        <TouchableOpacity key={t} style={[s.tabBtn, tab === t && s.tabOn]} onPress={() => { Keyboard.dismiss(); setTab(t); setSel(null); }}>
          <Text style={[s.tabTxt, tab === t && { color: c.onAccent }]}>{t === 'foods' ? 'Foods' : t === 'drinks' ? 'Drinks' : 'Meals'}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={s.newBtn} onPress={() => router.push({ pathname: (tab === 'meals' ? '/food-meal' : '/food-item') as any, params: tab === 'meals' ? { id: 'new' } : tab === 'drinks' ? { key: 'new', drink: '1' } : { key: 'new' } })}>
        <Text style={s.newTxt}>＋ New {tab === 'meals' ? 'meal' : tab === 'drinks' ? 'drink' : 'food'}</Text>
      </TouchableOpacity>
    </View>
  );
  // ── DRINKS: every drink in the food table (waters, coffee & tea, soft drinks, juices, milk drinks, beer & cider, wine,
  //    spirits) + the built-in cocktails + your own drinks / products, by category; alcohol % and caffeine shown
  if (tab === 'drinks') {
    const own = mine.filter(r => r.snap.unit === 'ml').map(r => foodByKey(r.key) ?? ({ key: r.key, src: r.snap.src, id: r.key, name: r.name, per100: r.snap.per100 ?? {}, unit: 'ml' } as any));
    const all = [...own, ...allDrinks().filter(d => !own.some(o => o.key === d.key))];
    const qw = norm(q.trim()).split(' ').filter(Boolean);
    const list = all.filter(d => (dcat === 'All' || drinkCategory(d) === dcat) && (!qw.length || qw.every(w => norm(`${d.name} ${d.nameAlt ?? ''}`).includes(w))))
      .sort((a, b) => DRINK_CATS.indexOf(drinkCategory(a)) - DRINK_CATS.indexOf(drinkCategory(b)) || a.name.localeCompare(b.name));
    return (
      <View style={s.screen}>
        {tabs}
        <View style={s.top}>
          <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search drinks — beer, wine, mojito, cola…" placeholderTextColor={c.textFaint} clearButtonMode="while-editing" autoCorrect={false} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {(['All', ...DRINK_CATS] as const).map(k => (
            <TouchableOpacity key={k} style={[s.chip, dcat === k && s.chipOn]} onPress={() => setDcat(k)}>
              <Text style={[s.chipTxt, dcat === k && { color: c.onAccent }]}>{k}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <FlatList data={list} keyExtractor={d => d.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item: d, index }) => {
            const cat = drinkCategory(d), head = index === 0 || drinkCategory(list[index - 1]) !== cat;
            const abv = (d.per100.alc ?? 0) / 0.789;   // g alcohol per 100 ml → % vol
            return (
              <>
                {head && <Text style={s.head}>{cat}</Text>}
                <TouchableOpacity style={s.row} activeOpacity={0.7} onPress={() => router.push({ pathname: '/food-item' as any, params: { key: d.key } })}>
                  <Text style={s.star}>{favs.has(d.key) ? '★' : cat === 'Cocktails' ? '🍸' : abv > 0.5 ? '🍺' : '🥤'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name} numberOfLines={2}>{d.name}</Text>
                    <Text style={s.meta} numberOfLines={1}>{r0(d.per100.kcal)} kcal/100 ml · carbs {r0(d.per100.carb)} g{abv > 0.5 ? ` · ${abv.toFixed(1)} % vol` : ''}{(d.per100.caf ?? 0) > 0 ? ` · ☕ ${r0(d.per100.caf)} mg` : ''}</Text>
                  </View>
                </TouchableOpacity>
              </>
            );
          }} />
      </View>
    );
  }
  if (tab === 'meals') return (
    <View style={s.screen}>
      {tabs}
      <FlatList data={meals} keyExtractor={m => m.id} contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={<Text style={s.empty}>No saved meals yet — ＋ New meal (type or 🎤 say the components), or save one while logging.</Text>}
        renderItem={({ item: m }) => {
          const kcal = m.items.reduce((a, it) => a + ((it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams).kcal : it.n?.kcal) ?? 0), 0);
          return (
            <SwipeRow onDelete={async () => {
              // logged before → deleting needs a replacement meal (picked in its editor); else delete
              const u = await mealUsage(m).catch(() => ({ instances: 0, days: 0 }));
              if (u.instances) { router.push({ pathname: '/food-meal' as any, params: { id: m.id, replace: '1' } }); return; }
              run(async () => { await deleteMeal(m.id); return loadLibrary(); });
            }}>
              <TouchableOpacity style={s.row} activeOpacity={0.7} onPress={() => router.push({ pathname: '/food-meal' as any, params: { id: m.id } })}>
                <Text style={s.star}>🍽️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>{m.name}</Text>
                  <Text style={s.meta} numberOfLines={2}>{m.items.length} components · {r0(kcal)} kcal — {m.items.map(i => i.name.split(',')[0]).join(', ')}</Text>
                </View>
                <Text style={s.meta}>›</Text>
              </TouchableOpacity>
            </SwipeRow>
          );
        }} />
      <Text style={[s.meta, { textAlign: 'center', padding: 8 }]}>Swipe a row left to delete · tap to edit</Text>
    </View>
  );
  return (
    <View style={s.screen}>
      {tabs}
      <View style={s.top}>
        <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search your foods + the food table" placeholderTextColor={c.textFaint}
          clearButtonMode="while-editing" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} />
        <TouchableOpacity onPress={() => { Keyboard.dismiss(); setSel(cur => (cur ? null : new Set())); }} hitSlop={8}>
          <Text style={s.selBtn}>{sel ? 'Done' : 'Select'}</Text>
        </TouchableOpacity>
      </View>
      <View style={s.chips}>
        {FILTERS.map(f => (
          <TouchableOpacity key={f.id} style={[s.chip, filter === f.id && s.chipOn]} onPress={() => setFilter(f.id)}>
            <Text style={[s.chipTxt, filter === f.id && { color: c.onAccent }]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {sel && (
        <View style={s.selRow}>
          <Text style={s.meta}>{selected.length} selected</Text>
          <TouchableOpacity onPress={() => setSel(new Set(rows.map(r => r.key)))} hitSlop={6}><Text style={s.link}>Select all ({rows.length})</Text></TouchableOpacity>
          {selected.length > 0 && <TouchableOpacity onPress={() => setSel(new Set())} hitSlop={6}><Text style={s.link}>Clear selection</Text></TouchableOpacity>}
        </View>
      )}
      <FlatList
        data={rows} keyExtractor={r => r.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: sel ? 140 : 40 }}
        ListEmptyComponent={<Text style={s.empty}>{q.trim().length >= 2 ? 'No match.' : filter === 'all' ? 'No foods yet — search above to find any food and ★ / tag it.' : 'Nothing here yet.'}</Text>}
        renderItem={({ item: r, index }) => {
          const on = favs.has(r.key), tg = tagsOf(r.key), picked = !!sel?.has(r.key);
          const head = r.cat ? (r.cat !== rows[index - 1]?.cat ? r.cat : null) : r.table && !rows[index - 1]?.table ? 'From the food table' : null;
          return (
            <>
              {head && <Text style={s.head}>{head}</Text>}
              <SwipeRow disabled={!!sel || r.table || r.snap.src === 'off'} onDelete={() => delOne(r)} label={lib?.custom.some(x => x.key === r.key) ? 'Delete' : 'Remove'}>
              <TouchableOpacity style={[s.row, picked && s.rowOn]} activeOpacity={0.7}
                onPress={() => (sel ? toggleSel(r.key) : router.push({ pathname: '/food-item' as any, params: { key: r.key } }))} onLongPress={() => { setSel(cur => new Set([...(cur ?? []), r.key])); }}>
                {sel ? <Text style={s.check}>{picked ? '☑' : '☐'}</Text> : (
                  <TouchableOpacity onPress={() => run(() => setFavourites([kf(r)], !on))} hitSlop={10}>
                    <Text style={[s.star, on && { color: c.accent }]}>{on ? '★' : '☆'}</Text>
                  </TouchableOpacity>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={2}>{r.name}</Text>
                  {r.sub ? <Text style={s.meta} numberOfLines={1}>{r.sub}</Text> : null}
                </View>
                {/* meal tags, several per food — tap to toggle (outside select mode) */}
                <View style={s.tags}>
                  {MEAL_TAGS.map(t => {
                    const has = tg.includes(t.id);
                    return (
                      <TouchableOpacity key={t.id} disabled={!!sel} hitSlop={4} style={[s.tag, has && s.tagOn]}
                        onPress={() => run(() => setMealTags([kf(r)], [t.id], has ? 'remove' : 'add'))}>
                        <Text style={[s.tagTxt, has && { color: c.onAccent }]}>{t.short}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </TouchableOpacity>
              </SwipeRow>
            </>
          );
        }}
      />
      {sel && selected.length > 0 && (
        <View style={s.bar}>
          <TouchableOpacity style={s.barBtn} onPress={bulkStar} disabled={busy}>
            <Text style={s.barTxt}>{selected.every(r => favs.has(r.key)) ? '☆ Unstar' : '★ Star'}</Text>
          </TouchableOpacity>
          {MEAL_TAGS.map(t => {
            const all = selected.length > 0 && selected.every(r => tagsOf(r.key).includes(t.id));
            return (
              <TouchableOpacity key={t.id} style={[s.barBtn, all && s.barBtnOn]} onPress={() => bulkTag(t.id)} disabled={busy}>
                <Text style={[s.barTxt, all && { color: c.onAccent }]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={s.barBtn} onPress={bulkForget} disabled={busy}><Text style={[s.barTxt, { color: '#e5484d' }]}>Clear</Text></TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  tabsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  tabBtn:  { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  tabOn:   { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:  { color: c.text, fontWeight: '700', fontSize: 14 },
  newBtn:  { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: c.accent },
  newTxt:  { color: c.onAccent, fontWeight: '800', fontSize: 13 },
  top:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  search:  { flex: 1, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: c.text, fontSize: 15 },
  selBtn:  { color: c.accent, fontSize: 15, fontWeight: '700' },
  chips:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingVertical: 10 },
  chip:    { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  chipOn:  { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt: { color: c.text, fontSize: 13, fontWeight: '600' },
  selRow:  { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingBottom: 6 },
  link:    { color: c.accent, fontSize: 13, fontWeight: '600' },
  head:    { color: c.textSub, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  row:     { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.bg },
  rowOn:   { backgroundColor: c.surfaceAlt },
  check:   { color: c.accent, fontSize: 20, width: 24 },
  star:    { color: c.textFaint, fontSize: 22, width: 24 },
  name:    { color: c.text, fontSize: 15, fontWeight: '600' },
  meta:    { color: c.textSub, fontSize: 12.5 },
  tags:    { flexDirection: 'row', gap: 4 },
  tag:     { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  tagOn:   { backgroundColor: c.accent, borderColor: c.accent },
  tagTxt:  { color: c.textSub, fontSize: 11, fontWeight: '800' },
  empty:   { color: c.textSub, textAlign: 'center', padding: 30 },
  bar:     { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 12, paddingBottom: 30, backgroundColor: c.surface, borderTopWidth: 1, borderColor: c.border },
  barBtn:  { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  barBtnOn:{ backgroundColor: c.accent, borderColor: c.accent },
  barTxt:  { color: c.text, fontSize: 13, fontWeight: '700' },
});
