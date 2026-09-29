/**
 * Food mode — nutrition log (Option A, docs/nutrition/REPORT.md §5).
 *
 * Day view: totals · "usually now" one-tap chips · a 24 h timeline of meals with run markers · copy from
 * yesterday. The ＋ opens the add sheet — ONE box that understands:
 *   • food words (NL/FR/EN) → local CIQUAL table + your custom foods + products you looked up before
 *   • a phrase ("2 eieren, toast met boter") → keyless parser → review list → log all
 *   • barcode digits → Open Food Facts lookup (explicit tap) → confirm product → portion
 * plus recents / ★ / saved meals when empty, "Search online" (OFF), a pack-label form, quick-add and water.
 * Log-on-pick with a remembered serving + Undo. Everything except OFF works keyless and offline.
 *
 * Keyboard rules (the freeze lesson): Keyboard.dismiss() on every exit path, no automaticallyAdjustKeyboardInsets.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Modal, TextInput, FlatList, Keyboard, Alert, Switch,
  Image, ActivityIndicator, Linking, KeyboardAvoidingView,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { DayNav } from '../src/components/DayNav';
import { searchFoodsEx, defaultServing, foodByKey, norm, CIQUAL_CREDIT } from '../src/services/foodDb';
import {
  loadDay, loadLibrary, logFood, logRecent, logMeal, removeEntries, updateEntry, addWater, copyEntries, saveMeal,
  deleteMeal, toggleFav, favouriteList, setDayComplete, dayTotals, groupMeals, mealLabel, usualNow, quickItem,
  scaleNutr, todayFoodDay, timeForDay, foodDayOf, addCustomFood, searchCustom, logFoods,
  DayLog, FoodLibrary, FoodEntry, FoodItem, Recent, SavedMeal, Nutr, FavItem,
} from '../src/services/foodLog';
import { lookupBarcode, searchOff, rememberProduct, cachedProducts, validBarcode, OFF_CREDIT, OFF_URL, OffProduct } from '../src/services/foodOff';
import { parseMeal, looksLikeMeal, ParsedItem, MAX_ITEM_GRAMS } from '../src/services/foodParse';
import { loadSnapshotCache, fetchBodyMassHistory, peekDailyComponents } from '../src/services/healthkit';
import { loadCachedPlan } from '../src/services/coach';
import { fuelAdvice, getFuelLongMin, FuelAdvice } from '../src/services/foodFuel';
import { trainingDayKey } from '../src/services/trainingLoad';

const r0 = (v?: number) => Math.round(v ?? 0);
const r1 = (v?: number) => (v == null ? '–' : (Math.round(v * 10) / 10).toString());
const hhmm = (iso: string) => iso.slice(11, 16);
const prevDay = (d: string) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(y, m - 1, dd - 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const macroLine = (n: Nutr) => `C ${r0(n.carb)} · P ${r0(n.prot)} · F ${r0(n.fat)}`;
const dateKeyCal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);
const openUrl = (u: string) => { Linking.openURL(u).catch(() => {}); };
const saveFailed = (e: unknown) => Alert.alert('Not saved', `The food log couldn't be written (${String((e as any)?.message ?? e)}). Nothing was changed.`);

interface RunMark { t: string; km: number; min: number; label: string }
type Undo = { msg: string; date: string; ids: string[] } | null;

/** HealthKit dates arrive as UTC ISO; show them in local wall time like food entries. */
function toLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export default function FoodMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ date?: string }>();
  const today = todayFoodDay();
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today;
  const isToday = date === today;

  const [day, setDay] = useState<DayLog | null>(null);
  const [yday, setYday] = useState<DayLog | null>(null);
  const [lib, setLib] = useState<FoodLibrary | null>(null);
  const [runs, setRuns] = useState<RunMark[]>([]);
  const [fuel, setFuel] = useState<FuelAdvice | null>(null);
  const [burn, setBurn] = useState<{ kcal: number; at: number } | null>(null);   // watch active + basal kcal (stored, not recomputed)
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const [undo, setUndo] = useState<Undo>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    const id = ++reqId.current;                          // a late load for a previous date must not win
    const [d, y, l] = await Promise.all([loadDay(date), isToday ? loadDay(prevDay(date)) : Promise.resolve(null), loadLibrary()]);
    if (id !== reqId.current) return;
    setDay(d); setYday(y); setLib(l);
  }, [date, isToday]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  useEffect(() => {
    let live = true;
    loadSnapshotCache().then(snap => {
      if (!live) return;
      setRuns((snap?.runs ?? []).filter(r => trainingDayKey(r.date) === date)
        .map(r => ({ t: toLocal(r.date), km: r.distance / 1000, min: r.duration / 60, label: r.label ?? 'Run' })));
    }).catch(() => live && setRuns([]));
    return () => { live = false; };
  }, [date]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  // Between 00:00 and 04:00 the food day (4 am rule) is still YESTERDAY while the plan and energy stores are keyed
  // by calendar date → don't show today-only readouts then (they'd describe the wrong day).
  const calToday = dateKeyCal(new Date());
  const sameDay = date === calToday;
  // Fuel advice for today's planned session — only intervals / very long runs (the athlete runs fasted otherwise).
  // Re-read on every focus: the plan can be regenerated (e.g. readiness turns green) while Food stays mounted.
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(useCallback(() => { setFocusTick(t => t + 1); }, []));
  useEffect(() => {
    let live = true;
    if (!isToday || !sameDay) { setFuel(null); return; }
    (async () => {
      const [plan, longMin, wts] = await Promise.all([
        loadCachedPlan(date).catch(() => null), getFuelLongMin(), fetchBodyMassHistory(3).catch(() => [] as any[]),
      ]);
      const kg = (wts as { value: number }[]).filter(w => w.value > 0).slice(-1)[0]?.value;
      if (live) setFuel(fuelAdvice(plan, kg, longMin));
    })().catch(() => {});
    return () => { live = false; };
  }, [date, isToday, sameDay, focusTick]);
  // Watch expenditure (active + basal) — a READ-ONLY peek at the daily-components store: opening Food must never
  // kick off a HealthKit recompute (CPU-watchdog history). The main app scan keeps the store fresh.
  useEffect(() => {
    let live = true;
    peekDailyComponents().then(dc => { const v = dc.days?.[date]?.totalEnergy; if (live) setBurn(v > 0 ? { kcal: v, at: dc.updatedAt } : null); }).catch(() => {});
    return () => { live = false; };
  }, [date, focusTick]);

  const showUndo = (u: Undo) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u);
    undoTimer.current = setTimeout(() => setUndo(null), 4500);
  };
  const doUndo = async () => {
    if (!undo) return;
    try { await removeEntries(undo.date, undo.ids); } catch (e) { saveFailed(e); }
    setUndo(null);
    reload();
  };
  /** One in-flight write at a time from the day view (a double tap must not log twice). */
  const once = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try { await fn(); } catch (e) { saveFailed(e); } finally { busy.current = false; reload(); }
  };

  const totals = useMemo(() => (day ? dayTotals(day) : null), [day]);
  const suggestions = useMemo(() => (lib && isToday ? usualNow(lib) : []), [lib, isToday]);
  const meals = useMemo(() => (day ? groupMeals(day.entries) : []), [day]);
  const ymeals = useMemo(() => (yday ? groupMeals(yday.entries) : []), [yday]);

  type Row = { kind: 'meal'; t: string; items: FoodEntry[] } | { kind: 'run'; t: string; run: RunMark } | { kind: 'water'; t: string; id: string; ml: number };
  const rows: Row[] = useMemo(() => [
    ...meals.map(m => ({ kind: 'meal' as const, t: m[0].t, items: m })),
    ...runs.map(r => ({ kind: 'run' as const, t: r.t, run: r })),
    ...(day?.water ?? []).map(w => ({ kind: 'water' as const, t: w.t, id: w.id, ml: w.ml })),
  ].sort((a, b) => a.t.localeCompare(b.t)), [meals, runs, day]);

  const onSuggestion = (sg: ReturnType<typeof usualNow>[number]) => once(async () => {
    if (sg.kind === 'meal') {
      const es = await logMeal(sg.meal, date, 'suggest');
      showUndo({ msg: `Logged ${sg.meal.name}`, date: foodDayOf(es[0]?.t ?? timeForDay(date)), ids: es.map(e => e.id) });
    } else {
      const e = await logRecent(sg.recent, date, 'suggest');
      showUndo({ msg: `Logged ${e.name.split(',')[0]}${e.grams ? ` · ${r0(e.grams)} g` : ''}`, date: foodDayOf(e.t), ids: [e.id] });
    }
  });

  const mealMenu = (items: FoodEntry[]) => {
    const kcal = r0(items.reduce((a, e) => a + (e.n.kcal ?? 0), 0));
    Alert.alert(`${mealLabel(items[0].t)} · ${kcal} kcal`, items.map(e => `• ${e.name}`).join('\n'), [
      { text: 'Save as meal', onPress: () => promptSaveMeal(items) },
      ...(!isToday ? [{ text: 'Copy to today', onPress: () => once(async () => { const es = await copyEntries(items, today, timeForDay(today)); showUndo({ msg: 'Copied to today', date: today, ids: es.map(e => e.id) }); }) }] : []),
      { text: 'Delete meal', style: 'destructive' as const, onPress: () => once(async () => { await removeEntries(date, items.map(e => e.id)); }) },
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };
  const promptSaveMeal = (items: FoodEntry[]) => {
    const def = mealLabel(items[0].t);
    if (!Alert.prompt) { once(async () => { await saveMeal(def, items); }); return; }
    Alert.prompt('Save meal', 'Name it — it shows up under Meals and as a one-tap suggestion.', (name?: string) => {
      if (name == null) return;
      once(async () => { await saveMeal(name || def, items); });
    }, 'plain-text', def);
  };
  const confirmWaterDelete = (id: string, ml: number) =>
    Alert.alert(`Remove ${ml} mL water?`, undefined, [
      { text: 'Remove', style: 'destructive', onPress: () => once(async () => { await removeEntries(date, [id]); }) },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: 120 }}>
        <View style={s.topRow}>
          <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠  Home</Text></TouchableOpacity>
          <Text style={s.title}>🍽️ Food</Text>
          <View style={{ width: 90 }} />
        </View>
        <DayNav date={isToday ? undefined : date} todayKey={today} />

        {/* Totals — neutral, no "over budget" red */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={s.kcal}>{r0(totals?.kcal)}</Text><Text style={s.kcalUnit}>kcal</Text>
          </View>
          <Text style={s.macros}>Carbs {r0(totals?.carb)} g · Protein {r0(totals?.prot)} g · Fat {r0(totals?.fat)} g</Text>
          <Text style={s.sub}>💧 {r1((totals?.waterMl ?? 0) / 1000)} L drinks · Sodium {r1((totals?.na ?? 0) / 1000)} g · Fibre {r0(totals?.fib)} g</Text>
          {burn != null && !(isToday && !sameDay) && (
            isToday
              ? <Text style={s.sub}>⌚ Watch energy so far: {r0(burn.kcal)} kcal (active + resting{burn.at > 0 ? `, as of ${new Date(burn.at).toTimeString().slice(0, 5)}` : ''})</Text>
              : day?.complete
                ? <Text style={s.sub}>⚖︎ Intake {r0(totals?.kcal)} − watch {r0(burn.kcal)} = <Text style={s.bold}>{(totals?.kcal ?? 0) - burn.kcal >= 0 ? '+' : ''}{r0((totals?.kcal ?? 0) - burn.kcal)} kcal</Text>  (watch energy is an estimate, ±15–20 %)</Text>
                : <Text style={s.sub}>⌚ Watch energy {r0(burn.kcal)} kcal — mark the day fully logged to see the balance.</Text>
          )}
          <View style={s.completeRow}>
            <Text style={s.completeTxt}>Day fully logged</Text>
            <Switch value={!!day?.complete} onValueChange={v => once(async () => { await setDayComplete(date, v); })}
              trackColor={{ false: c.switchTrack, true: c.accent }} />
          </View>
          <Text style={s.hint}>Only fully-logged days will count toward energy balance.</Text>
        </View>

        {fuel && fuel.kind !== 'none' && (
          <View style={[s.card, s.fuelCard]}>
            <Text style={s.fuelTitle}>⚡ {fuel.title}</Text>
            {fuel.lines.map((l, i) => <Text key={i} style={s.fuelLine}>• {l}</Text>)}
            <Text style={s.hint}>Shown only for intervals and very long runs — the rest you run fasted.</Text>
          </View>
        )}

        {suggestions.length > 0 && (
          <View style={{ marginTop: 14 }}>
            <Text style={s.section}>Usually now</Text>
            <View style={s.chips}>
              {suggestions.map(sg => (
                <TouchableOpacity key={sg.kind === 'meal' ? sg.meal.id : sg.recent.key} style={s.chip} onPress={() => onSuggestion(sg)}>
                  <Text style={s.chipTxt}>{sg.kind === 'meal' ? `🍽️ ${sg.meal.name}` : sg.recent.name.split(',')[0]}  ＋</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <Text style={[s.section, { marginTop: 16 }]}>{isToday ? 'Today' : 'This day'}</Text>
        {rows.length === 0 && <Text style={s.empty}>Nothing logged yet. Tap ＋ to add food{isToday && ymeals.length ? ', or copy a meal from yesterday below' : ''}.</Text>}
        {rows.map(row => {
          if (row.kind === 'run') return (
            <View key={`run${row.t}`} style={s.runRow}>
              <Text style={s.runTxt}>{hhmm(row.t)}  🏃 {row.run.label} · {r1(row.run.km)} km · {r0(row.run.min)} min</Text>
            </View>
          );
          if (row.kind === 'water') return (
            <TouchableOpacity key={row.id} style={s.waterRow} onLongPress={() => confirmWaterDelete(row.id, row.ml)}>
              <Text style={s.waterTxt}>{hhmm(row.t)}  💧 {row.ml} mL</Text>
            </TouchableOpacity>
          );
          const kcal = r0(row.items.reduce((a, e) => a + (e.n.kcal ?? 0), 0));
          return (
            <View key={row.items[0].id} style={s.mealCard}>
              <TouchableOpacity style={s.mealHead} onPress={() => mealMenu(row.items)}>
                <Text style={s.mealTitle}>{hhmm(row.t)}  {mealLabel(row.t)}</Text>
                <Text style={s.mealKcal}>{kcal} kcal  ⋯</Text>
              </TouchableOpacity>
              {row.items.map(e => (
                <TouchableOpacity key={e.id} style={s.entry} onPress={() => setEditing(e)}>
                  <Text style={s.entryName} numberOfLines={1}>{e.name}</Text>
                  <Text style={s.entryMeta}>{e.grams ? `${r0(e.grams)} g · ` : ''}{r0(e.n.kcal)} kcal</Text>
                </TouchableOpacity>
              ))}
            </View>
          );
        })}

        {isToday && ymeals.length > 0 && (
          <View style={{ marginTop: 18 }}>
            <Text style={s.section}>From yesterday</Text>
            {ymeals.map(m => (
              <View key={m[0].id} style={s.yRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.yTitle}>{mealLabel(m[0].t)} · {r0(m.reduce((a, e) => a + (e.n.kcal ?? 0), 0))} kcal</Text>
                  <Text style={s.ySub} numberOfLines={1}>{m.map(e => e.name.split(',')[0]).join(', ')}</Text>
                </View>
                <TouchableOpacity style={s.copyBtn} onPress={() => once(async () => {
                  const es = await copyEntries(m, date);
                  showUndo({ msg: `Copied ${mealLabel(m[0].t).toLowerCase()}`, date, ids: es.map(e => e.id) });
                })}><Text style={s.copyTxt}>Copy</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <Text style={s.credit}>Generic foods: {CIQUAL_CREDIT}. Products: {OFF_CREDIT} Totals are calculated by RunCoach.</Text>
      </ScrollView>

      {undo && (
        <View style={[s.toast, { bottom: insets.bottom + 90 }]}>
          <Text style={s.toastTxt} numberOfLines={1}>{undo.msg}</Text>
          <TouchableOpacity onPress={doUndo} hitSlop={10}><Text style={s.toastBtn}>Undo</Text></TouchableOpacity>
        </View>
      )}

      <TouchableOpacity style={[s.fab, { bottom: insets.bottom + 24 }]} onPress={() => setAdding(true)} activeOpacity={0.85}>
        <Text style={s.fabTxt}>＋</Text>
      </TouchableOpacity>

      {adding && lib && <AddSheet date={date} lib={lib} onClose={() => { Keyboard.dismiss(); setAdding(false); reload(); }} />}
      {editing && (
        <EditSheet entry={editing} date={date} isFav={!!lib?.favs.includes(editing.key)}
          onClose={() => { Keyboard.dismiss(); setEditing(null); reload(); }} />
      )}
    </View>
  );
}

// ─── Add sheet ────────────────────────────────────────────────────────────────────────────────────
type Tab = 'recent' | 'fav' | 'meals';
type Mode =
  | { m: 'search' }
  | { m: 'portion'; item: FoodItem | OffProduct; grams?: number }
  | { m: 'quick' }
  | { m: 'label'; ean?: string; name?: string }
  | { m: 'parse'; items: ParsedItem[] }
  | { m: 'online'; query: string; results: OffProduct[] | null; error?: string };

function AddSheet({ date, lib: lib0, onClose }: { date: string; lib: FoodLibrary; onClose: () => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [lib, setLib] = useState(lib0);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('recent');
  const [mode, setMode] = useState<Mode>({ m: 'search' });
  const [batches, setBatches] = useState<FoodEntry[][]>([]);   // each log action = one batch → Undo removes a batch
  const [offCache, setOffCache] = useState<OffProduct[]>([]);
  const [lookingUp, setLookingUp] = useState(false);
  const [dq, setDq] = useState('');                     // debounced query: search runs ~150 ms after typing stops
  useEffect(() => { const t = setTimeout(() => setDq(q), 150); return () => clearTimeout(t); }, [q]);
  const onlineTok = useRef(0);
  const groupId = useRef(`g${Date.now().toString(36)}`).current;   // everything added in one sheet = one meal
  const busy = useRef(false);

  useEffect(() => { cachedProducts().then(setOffCache).catch(() => {}); }, []);

  const boost = useMemo(() => {
    const b: Record<string, number> = {};
    for (const r of lib.recents) b[r.key] = Math.min(3, 1 + Math.log2(1 + r.count));
    for (const k of lib.favs) b[k] = (b[k] ?? 0) + 1.5;
    return b;
  }, [lib]);
  const qt = q.trim();
  const dqt = dq.trim();
  const digits = /^\d{8,14}$/.test(qt);
  const phrase = dqt.length >= 4 && !/^\d+$/.test(dqt) && looksLikeMeal(dqt);
  // a meal phrase goes to the parser; search then doesn't try word-dropping fallbacks on it
  const search = useMemo(() => (dqt.length >= 2 && !/^\d{8,14}$/.test(dqt) ? searchFoodsEx(dqt, 40, boost, { fallback: !phrase }) : { items: [], ignored: [], notCombined: [] }), [dqt, phrase, boost]);
  // your own foods: custom label foods + products you looked up before (offline copies)
  const ownMatches = useCallback((text: string): FoodItem[] => {
    const words = norm(text).split(' ').filter(Boolean);
    if (!words.length) return [];
    const offHits = offCache.filter(p => { const w = norm(`${p.name} ${p.brand ?? ''}`).split(' '); return words.every(t => w.some(x => x.startsWith(t))); });
    const seen = new Set<string>();
    return [...searchCustom(lib, text, norm), ...offHits].filter(f => (seen.has(f.key) ? false : (seen.add(f.key), true))).slice(0, 6);
  }, [offCache, lib]);
  const mine = useMemo(() => (dqt.length < 2 || /^\d{8,14}$/.test(dqt) ? [] as FoodItem[] : ownMatches(dqt)), [dqt, ownMatches]);
  const recentOf = (key: string) => lib.recents.find(r => r.key === key);

  const refreshLib = async () => setLib(await loadLibrary());
  const guard = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try { await fn(); } catch (e) { saveFailed(e); } finally { busy.current = false; }
  };
  const logged = async (es: FoodEntry[]) => { if (es.length) setBatches(prev => [...prev, es]); setQ(''); setDq(''); setMode({ m: 'search' }); await refreshLib(); };

  const pick = (item: FoodItem, longPress = false) => guard(async () => {
    const rec = recentOf(item.key);
    if (!longPress && rec?.grams) { await logged([await logFood(item, { grams: rec.grams, via: 'search', date, groupId })]); return; }
    Keyboard.dismiss();
    setMode({ m: 'portion', item, grams: rec?.grams });
  });
  const pickRecent = (r: { key: string; name: string; src: FoodItem['src']; per100?: Nutr; n?: Nutr; grams?: number }, longPress = false) => guard(async () => {
    // a remembered serving (or a fixed quick-add) logs in one tap; a favourite never logged before asks the amount
    if ((!longPress && r.grams) || !r.per100) {
      const asRecent: Recent = { key: r.key, name: r.name, src: r.src, per100: r.per100, n: r.n, grams: r.grams, count: 0, last: '', hrs: [] };
      await logged([await logRecent(asRecent, date, 'recent', groupId)]);
      return;
    }
    Keyboard.dismiss();
    setMode({ m: 'portion', item: { key: r.key, src: r.src, id: idOf(r.key), name: r.name, per100: r.per100 }, grams: r.grams });
  });
  const pickMeal = (m: SavedMeal) => guard(async () => { await logged(await logMeal(m, date)); });
  const undoLast = () => guard(async () => {
    const last = batches[batches.length - 1]; if (!last) return;
    const byDay = new Map<string, string[]>();
    for (const e of last) { const d = e.key === 'water' ? date : foodDayOf(e.t); byDay.set(d, [...(byDay.get(d) ?? []), e.id]); }
    for (const [d, ids] of byDay) await removeEntries(d, ids);
    setBatches(prev => prev.slice(0, -1));
  });
  const lookup = async (code: string, refresh = false) => {
    Keyboard.dismiss();
    // a pack label you entered for this barcode wins — no network needed
    const own = lib.custom.find(c => c.id === `ean${code}`);
    if (own && !refresh) { setMode({ m: 'portion', item: own, grams: recentOf(own.key)?.grams }); return; }
    setLookingUp(true);
    try {
      const { item, cached } = await lookupBarcode(code, refresh);
      if (item) { setOffCache(await cachedProducts()); setMode({ m: 'portion', item, grams: recentOf(item.key)?.grams }); }
      else Alert.alert('Not in Open Food Facts', `No product with barcode ${code}. Enter it from the pack label — it's saved on this phone for next time.`, [
        { text: 'Enter label', onPress: () => setMode({ m: 'label', ean: code }) },
        ...(cached ? [{ text: 'Check online again', onPress: () => { lookup(code, true); } }] : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    } catch (e: any) {
      Alert.alert('Lookup failed', `${e?.message ?? e}\n\nNo connection? Use Quick add or enter the label.`);
    } finally { setLookingUp(false); }
  };
  const goOnline = async () => {
    Keyboard.dismiss();
    const query = qt;
    const tok = ++onlineTok.current;                    // Back (or a new search) while loading → drop the late result
    setMode({ m: 'online', query, results: null });
    let next: Mode;
    try { next = { m: 'online', query, results: await searchOff(query) }; }
    catch (e: any) { next = { m: 'online', query, results: [], error: e?.message ?? String(e) }; }
    if (tok === onlineTok.current) setMode(prev => (prev.m === 'online' && prev.query === query ? next : prev));
  };

  type Li = { key: string; title: string; sub: string; badge?: string; onPress: () => void; onLong?: () => void; star?: boolean };
  const list: Li[] = useMemo(() => {
    const favs = new Set(lib.favs);
    const foodRow = (f: FoodItem, badge?: string): Li => ({
      key: f.key, title: f.name, badge, star: favs.has(f.key),
      sub: `${f.brand ? `${f.brand} · ` : ''}${r0(f.per100.kcal)} kcal/100 g · ${macroLine(f.per100)}${recentOf(f.key)?.grams ? ` · last ${r0(recentOf(f.key)!.grams)} g` : ''}`,
      onPress: () => pick(f), onLong: () => pick(f, true),
    });
    if (dqt.length >= 2 && !digits) {
      const seen = new Set(mine.map(f => f.key));
      return [...mine.map(f => foodRow(f, f.src === 'custom' ? 'mine' : 'product')), ...search.items.filter(f => !seen.has(f.key)).map(f => foodRow(f))];
    }
    if (digits) return [];
    if (tab === 'meals') return lib.meals.map(m => ({
      key: m.id, title: `🍽️ ${m.name}`,
      sub: `${m.items.length} items · ${r0(m.items.reduce((a, it) => a + ((it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams).kcal : it.n?.kcal) ?? 0), 0))} kcal`,
      onPress: () => pickMeal(m),
      onLong: () => Alert.alert(m.name, 'Delete this saved meal?', [{ text: 'Delete', style: 'destructive', onPress: () => guard(async () => { await deleteMeal(m.id); await refreshLib(); }) }, { text: 'Cancel', style: 'cancel' }]),
    }));
    const src: FavItem[] | Recent[] = tab === 'fav'
      ? [...favouriteList(lib), ...lib.favs.filter(k => !favouriteList(lib).some(f => f.key === k)).map(k => foodByKey(k)).filter((f): f is FoodItem => !!f).map(f => ({ key: f.key, name: f.name, src: f.src, per100: f.per100 }))]
      : lib.recents.slice(0, 40);
    return (src as FavItem[]).map(r => ({
      key: r.key, title: r.name, star: favs.has(r.key),
      sub: r.grams ? `${r0(r.grams)} g · ${r0(r.per100 ? scaleNutr(r.per100, r.grams).kcal : r.n?.kcal)} kcal` : r.per100 ? `${r0(r.per100.kcal)} kcal/100 g` : `${r0(r.n?.kcal)} kcal`,
      onPress: () => pickRecent(r), onLong: () => pickRecent(r, true),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dqt, digits, search, mine, tab, lib]);

  const close = () => { Keyboard.dismiss(); onClose(); };
  const lastBatch = batches[batches.length - 1];

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={50} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[s.sheet, { backgroundColor: c.bg }]}>
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>Add food</Text>
          <TouchableOpacity onPress={close} hitSlop={12}><Text style={s.done}>Done</Text></TouchableOpacity>
        </View>

        {/* confirmation + Undo sit ABOVE the list so the keyboard never hides them */}
        {lastBatch && (
          <View style={s.loggedBar}>
            <Text style={s.loggedTxt} numberOfLines={1}>✓ {lastBatch.length > 1 ? `${lastBatch.length} items` : lastBatch[0].name.split(',')[0]}{batches.length > 1 ? `  ·  ${batches.reduce((a, b) => a + b.length, 0)} added` : ''}</Text>
            <TouchableOpacity onPress={undoLast} hitSlop={10}><Text style={s.toastBtn}>Undo</Text></TouchableOpacity>
          </View>
        )}

        {mode.m === 'portion' ? (
          <PortionPanel item={mode.item} initial={mode.grams} isFav={lib.favs.includes(mode.item.key)}
            onFav={() => guard(async () => { await toggleFav(mode.item.key, { name: mode.item.name, src: mode.item.src, per100: mode.item.per100 }); await refreshLib(); })}
            onCancel={() => setMode({ m: 'search' })}
            onConfirm={g => guard(async () => {
              if (mode.item.src === 'off') await rememberProduct(mode.item as OffProduct);
              await logged([await logFood(mode.item, { grams: g, via: mode.item.src === 'off' ? 'ean' : 'search', date, groupId })]);
            })} />
        ) : mode.m === 'quick' ? (
          <QuickPanel onCancel={() => setMode({ m: 'search' })}
            onConfirm={(label, n) => guard(async () => { await logged([await logFood(quickItem(label, n), { via: 'quick', date, groupId })]); })} />
        ) : mode.m === 'label' ? (
          <LabelPanel ean={mode.ean} name={mode.name} onCancel={() => setMode({ m: 'search' })}
            onSave={f => guard(async () => { const item = await addCustomFood(f); await refreshLib(); setMode({ m: 'portion', item }); })} />
        ) : mode.m === 'parse' ? (
          <ParsePanel items={mode.items} onCancel={() => setMode({ m: 'search' })}
            onConfirm={items => guard(async () => {
              // one atomic write: all items or none (a failure can't leave a half-logged phrase behind)
              await logged(await logFoods(items.filter(it => it.food).map(it => ({ item: it.food!, grams: it.grams })), { via: 'parse', date, groupId }));
            })} />
        ) : mode.m === 'online' ? (
          <OnlinePanel query={mode.query} results={mode.results} error={mode.error} onCancel={() => setMode({ m: 'search' })}
            onPick={p => { setMode({ m: 'portion', item: p, grams: recentOf(p.key)?.grams }); }} />
        ) : (
          <>
            <TextInput
              style={s.search} value={q} onChangeText={setQ}
              placeholder="banaan · 2 eieren, toast met boter · 5410…"
              placeholderTextColor={c.textFaint} autoFocus autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing"
            />
            <View style={s.actions}>
              <TouchableOpacity style={s.action} onPress={() => { Keyboard.dismiss(); setMode({ m: 'quick' }); }}><Text style={s.actionTxt}>⚡ Quick</Text></TouchableOpacity>
              <TouchableOpacity style={s.action} onPress={() => { Keyboard.dismiss(); setMode({ m: 'label', ean: digits ? qt : undefined, name: digits ? undefined : qt }); }}><Text style={s.actionTxt}>🏷️ Label</Text></TouchableOpacity>
              {[250, 500].map(ml => (
                <TouchableOpacity key={ml} style={s.action} onPress={() => guard(async () => {
                  const w = await addWater(date, ml);
                  setBatches(prev => [...prev, [{ id: w.id, t: w.t, key: 'water', name: `Water ${ml} mL`, src: 'quick', n: {}, via: 'quick' }]]);
                })}>
                  <Text style={s.actionTxt}>💧 {ml}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {digits && (
              <TouchableOpacity style={s.bigRow} onPress={() => lookup(qt)} disabled={lookingUp}>
                {lookingUp ? <ActivityIndicator /> : <Text style={s.bigRowTxt}>▥ Look up barcode {qt}</Text>}
                {!validBarcode(qt) && <Text style={s.warn}>The check digit doesn't match — double-check the number.</Text>}
                <Text style={s.resultSub}>Asks Open Food Facts (only the barcode is sent).</Text>
              </TouchableOpacity>
            )}
            {phrase && (
              <TouchableOpacity style={s.bigRow} onPress={() => { Keyboard.dismiss(); setMode({ m: 'parse', items: parseMeal(qt, boost, t => ownMatches(t)[0]) }); }}>
                <Text style={s.bigRowTxt}>✨ Log "{qt.length > 40 ? qt.slice(0, 40) + '…' : qt}" as a meal →</Text>
                <Text style={s.resultSub}>Splits it into foods with amounts you can check first. Works offline.</Text>
              </TouchableOpacity>
            )}
            {dqt.length >= 2 && !digits && !phrase && search.ignored.length > 0 && (
              <Text style={s.hint}>Ignored: {search.ignored.join(', ')} — not in the food table.</Text>
            )}
            {dqt.length >= 2 && !digits && !phrase && search.notCombined.length > 0 && (
              <Text style={s.hint}>Left out "{search.notCombined.join(', ')}" — no single food has all the words. Tip: "a, b" logs them separately.</Text>
            )}

            {qt.length < 2 && (
              <View style={s.tabs}>
                {(['recent', 'fav', 'meals'] as Tab[]).map(t => (
                  <TouchableOpacity key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]}>
                    <Text style={[s.tabTxt, tab === t && s.tabTxtOn]}>{t === 'recent' ? 'Recents' : t === 'fav' ? '★ Favourites' : 'Meals'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <FlatList
              data={list} keyExtractor={it => it.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
              ListEmptyComponent={digits ? null : <Text style={s.empty}>{qt.length >= 2 ? 'No match in the food table. Try another word, search online, or use Quick add / Label.' : tab === 'meals' ? 'No saved meals yet — open a logged meal (⋯) and choose "Save as meal".' : tab === 'fav' ? 'No favourites yet — ★ a food in its portion view.' : 'Foods you log appear here, with the serving you used.'}</Text>}
              ListFooterComponent={qt.length >= 3 && !digits ? (
                <TouchableOpacity style={s.onlineBtn} onPress={goOnline}>
                  <Text style={s.onlineTxt}>🌐 Search online (Open Food Facts) for "{qt}"</Text>
                  <Text style={s.resultSub}>Branded products · sends only these words</Text>
                </TouchableOpacity>
              ) : null}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.result} onPress={item.onPress} onLongPress={item.onLong}>
                  <Text style={s.resultTitle} numberOfLines={2}>{item.star ? '★ ' : ''}{item.badge ? <Text style={s.badge}>{item.badge === 'mine' ? 'MINE  ' : 'PRODUCT  '}</Text> : null}{item.title}</Text>
                  <Text style={s.resultSub} numberOfLines={1}>{item.sub}</Text>
                </TouchableOpacity>
              )}
            />
            {dqt.length >= 2 && !digits && list.length > 0 && <Text style={s.hint}>Tap = log (your usual serving) · long-press = choose the amount</Text>}
          </>
        )}
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Portion panel ────────────────────────────────────────────────────────────────────────────────
function PortionPanel({ item, initial, isFav, onFav, onCancel, onConfirm, onDelete, confirmLabel = 'Log' }: {
  item: FoodItem | OffProduct; initial?: number; isFav: boolean; onFav: () => void; onCancel: () => void;
  onConfirm: (g: number) => void; onDelete?: () => void; confirmLabel?: string;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const def = defaultServing(item);
  const [txt, setTxt] = useState(String(r0(initial ?? def.g)));
  const [fav, setFav] = useState(isFav);
  const g = parseFloat(txt.replace(',', '.'));
  const valid = isFinite(g) && g > 0 && g < 5000;
  const n = valid ? scaleNutr(item.per100, g) : {};
  const chips = [...new Set([def.g, ...(initial ? [initial] : []), Math.round(def.g / 2), def.g * 2, 50, 100, 150, 200].map(r0))].filter(x => x > 0).slice(0, 7);
  const off = item.src === 'off' ? (item as OffProduct) : null;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        {off?.image && <Image source={{ uri: off.image }} style={s.prodImg} />}
        <View style={{ flex: 1 }}>
          <Text style={s.portionName}>{item.name}</Text>
          {item.brand && <Text style={s.resultSub}>{item.brand}{off?.quantity ? ` · ${off.quantity}` : ''}</Text>}
        </View>
        <TouchableOpacity onPress={() => { setFav(f => !f); onFav(); }} hitSlop={10}><Text style={{ fontSize: 24, color: fav ? c.accent : c.textFaint }}>{fav ? '★' : '☆'}</Text></TouchableOpacity>
      </View>
      {item.nameAlt && item.nameAlt !== item.name && <Text style={s.resultSub}>{item.nameAlt}</Text>}
      {off?.rcn8 && <Text style={s.warn}>Store codes starting with 2 are reused across countries — check this is really your product.</Text>}
      {off?.incomplete && <Text style={s.warn}>Open Food Facts is missing some values for this product — check them against the pack, or enter the label.</Text>}
      {off?.implausible && <Text style={s.warn}>These values don't add up (energy vs carbs/protein/fat) — probably mis-entered on Open Food Facts. Check the pack, or enter the label.</Text>}
      <Text style={[s.resultSub, { marginTop: 4 }]}>Per 100 g{off ? ' (or 100 mL)' : ''}: {r0(item.per100.kcal)} kcal · {macroLine(item.per100)}</Text>

      <View style={s.gramsRow}>
        <TextInput style={s.gramsInput} value={txt} onChangeText={setTxt} keyboardType="decimal-pad" selectTextOnFocus />
        <Text style={s.gramsUnit}>g</Text>
        <Text style={s.gramsHint}>{def.label !== '100 g' ? `${def.label} ≈ ${def.g} g` : ''}</Text>
      </View>
      <View style={s.chips}>
        {chips.map(v => (
          <TouchableOpacity key={v} style={[s.chip, r0(g) === v && s.chipOn]} onPress={() => setTxt(String(v))}>
            <Text style={[s.chipTxt, r0(g) === v && { color: c.onAccent }]}>{v} g</Text>
          </TouchableOpacity>
        ))}
      </View>
      {valid && (
        <View style={s.preview}>
          <Text style={s.previewKcal}>{r0(n.kcal)} kcal</Text>
          <Text style={s.previewSub}>Carbs {r1(n.carb)} g · Protein {r1(n.prot)} g · Fat {r1(n.fat)} g · Fibre {r1(n.fib)} g · Sodium {r0(n.na)} mg</Text>
        </View>
      )}
      <View style={s.btnRow}>
        {onDelete && <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={() => { Keyboard.dismiss(); onDelete(); }}><Text style={s.btnDangerTxt}>Delete</Text></TouchableOpacity>}
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, !valid && { opacity: 0.4 }]} disabled={!valid} onPress={() => { Keyboard.dismiss(); onConfirm(Math.round(g * 10) / 10); }}>
          <Text style={s.btnTxt}>{confirmLabel}</Text>
        </TouchableOpacity>
      </View>
      {off && (
        <TouchableOpacity onPress={() => openUrl(`${OFF_URL}/product/${idOf(off.key)}`)}>
          <Text style={s.creditSmall}>{OFF_CREDIT} Tap to view or correct this product on openfoodfacts.org.</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

// ─── Parsed phrase review ─────────────────────────────────────────────────────────────────────────
function ParsePanel({ items: items0, onCancel, onConfirm }: { items: ParsedItem[]; onCancel: () => void; onConfirm: (items: ParsedItem[]) => void }) {
  const s = useThemedStyles(makeStyles);
  const [items, setItems] = useState(items0.map(it => ({ ...it, on: !!it.food, gTxt: String(it.grams) })));
  const upd = (i: number, patch: Partial<typeof items[number]>) => setItems(prev => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const cycle = (i: number) => {
    const it = items[i];
    const all = [it.food, ...it.alternatives].filter((f): f is FoodItem => !!f);
    if (all.length < 2) return;
    const next = all[1];
    upd(i, { food: next, alternatives: [...all.slice(2), all[0]], ...(it.unit ? {} : { gTxt: String(r0(it.qty * defaultServing(next).g)) }) });
  };
  const gOf = (t: string) => parseFloat(t.replace(',', '.'));
  const okG = (g: number) => isFinite(g) && g > 0 && g < 5000;       // same bound as the portion panel
  const final = items.filter(x => x.on && x.food).map(x => ({ ...x, grams: gOf(x.gTxt) })).filter(x => okG(x.grams));
  const bad = items.some(x => x.on && x.food && !okG(gOf(x.gTxt)));
  const kcal = final.reduce((a, x) => a + (scaleNutr(x.food!.per100, x.grams).kcal ?? 0), 0);
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={s.portionName}>Check the amounts</Text>
      <Text style={s.hint}>Tap a food name to switch to the next match. Items marked ? had no amount — a typical serving is filled in.</Text>
      {items.map((it, i) => (
        <View key={i} style={[s.parseRow, !it.on && { opacity: 0.45 }]}>
          <TouchableOpacity onPress={() => upd(i, { on: !it.on })} hitSlop={8}><Text style={s.check}>{it.on ? '☑' : '☐'}</Text></TouchableOpacity>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => cycle(i)}>
            <Text style={s.resultTitle} numberOfLines={2}>{it.food ? it.food.name : `No match for "${it.query}"`}{!it.sure && it.food ? '  ?' : ''}</Text>
            <Text style={s.resultSub} numberOfLines={1}>"{it.text}"{it.alternatives.length ? '  · tap for other matches' : ''}</Text>
          </TouchableOpacity>
          <TextInput style={[s.parseGrams, (!okG(gOf(it.gTxt)) || gOf(it.gTxt) > MAX_ITEM_GRAMS) && it.on && { borderColor: '#d97706' }]} value={it.gTxt} onChangeText={v => upd(i, { gTxt: v })} keyboardType="decimal-pad" selectTextOnFocus />
          <Text style={s.gramsUnitSm}>g</Text>
        </View>
      ))}
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Back</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, (!final.length || bad) && { opacity: 0.4 }]} disabled={!final.length || bad} onPress={() => { Keyboard.dismiss(); onConfirm(final); }}>
          <Text style={s.btnTxt}>{bad ? 'Check the amounts' : `Log ${final.length} · ${r0(kcal)} kcal`}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Online (OFF) results ─────────────────────────────────────────────────────────────────────────
function OnlinePanel({ query, results, error, onCancel, onPick }: { query: string; results: OffProduct[] | null; error?: string; onCancel: () => void; onPick: (p: OffProduct) => void }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={{ flex: 1 }}>
      <View style={s.sheetHead}>
        <Text style={s.resultTitle}>Open Food Facts: "{query}"</Text>
        <TouchableOpacity onPress={onCancel} hitSlop={10}><Text style={s.done}>Back</Text></TouchableOpacity>
      </View>
      {results == null ? <ActivityIndicator style={{ marginTop: 30 }} /> : (
        <FlatList
          data={results} keyExtractor={p => p.key}
          ListEmptyComponent={<Text style={s.empty}>{error ? `Search failed: ${error}` : 'No products found. Try the brand name, or enter the label.'}</Text>}
          renderItem={({ item: p }) => (
            <TouchableOpacity style={s.result} onPress={() => onPick(p)}>
              <Text style={s.resultTitle} numberOfLines={2}>{p.name}</Text>
              <Text style={s.resultSub} numberOfLines={1}>{p.brand ? `${p.brand} · ` : ''}{p.quantity ? `${p.quantity} · ` : ''}{r0(p.per100.kcal)} kcal/100 g · {macroLine(p.per100)}</Text>
            </TouchableOpacity>
          )}
          ListFooterComponent={<Text style={s.creditSmall}>{OFF_CREDIT}</Text>}
        />
      )}
    </View>
  );
}

// ─── Pack label → custom food ─────────────────────────────────────────────────────────────────────
function LabelPanel({ ean, name: name0, onCancel, onSave }: { ean?: string; name?: string; onCancel: () => void; onSave: (f: { name: string; brand?: string; ean?: string; per100: Nutr }) => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [name, setName] = useState(name0 ?? '');
  const [brand, setBrand] = useState('');
  const [v, setV] = useState<Record<string, string>>({});
  const num = (k: string) => { const x = parseFloat((v[k] ?? '').replace(',', '.')); return isFinite(x) && x >= 0 ? x : undefined; };
  // EU label order (Regulation 1169/2011 Art. 30) + fibre
  const FIELDS: { k: keyof Nutr; lab: string }[] = [
    { k: 'kcal', lab: 'Energy kcal' }, { k: 'fat', lab: 'Fat g' }, { k: 'sat', lab: '  of which saturates g' },
    { k: 'carb', lab: 'Carbohydrate g' }, { k: 'sug', lab: '  of which sugars g' }, { k: 'fib', lab: 'Fibre g' },
    { k: 'prot', lab: 'Protein g' }, { k: 'salt', lab: 'Salt g' },
  ];
  const per100: Nutr = {};
  for (const f of FIELDS) { const x = num(f.k); if (x != null) per100[f.k] = x; }
  if (per100.salt != null) per100.na = Math.round(per100.salt / 2.5 * 1000);
  const valid = name.trim().length > 0 && (per100.kcal ?? 0) > 0 && (per100.kcal ?? 0) < 1000;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 60 }}>
      <Text style={s.portionName}>From the pack label</Text>
      <Text style={s.hint}>Per 100 g / 100 mL, as printed. Saved as your own food{ean ? ` for barcode ${ean}` : ''} — it stays on this phone.</Text>
      <Text style={s.fieldLab}>Name</Text>
      <TextInput style={s.field} value={name} onChangeText={setName} placeholder="e.g. Boni muesli" placeholderTextColor={c.textFaint} />
      <Text style={s.fieldLab}>Brand (optional)</Text>
      <TextInput style={s.field} value={brand} onChangeText={setBrand} placeholderTextColor={c.textFaint} />
      {FIELDS.map(f => (
        <View key={f.k} style={s.labelRow}>
          <Text style={[s.fieldLab, { flex: 1, marginTop: 0 }]}>{f.lab}</Text>
          <TextInput style={[s.field, { width: 110 }]} value={v[f.k] ?? ''} onChangeText={x => setV(p => ({ ...p, [f.k]: x }))} keyboardType="decimal-pad" placeholder="–" placeholderTextColor={c.textFaint} />
        </View>
      ))}
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, !valid && { opacity: 0.4 }]} disabled={!valid} onPress={() => { Keyboard.dismiss(); onSave({ name, brand: brand.trim() || undefined, ean, per100 }); }}>
          <Text style={s.btnTxt}>Save & choose amount</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Quick add ────────────────────────────────────────────────────────────────────────────────────
function QuickPanel({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (label: string, n: Nutr) => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [label, setLabel] = useState('');
  const [f, setF] = useState<{ kcal: string; carb: string; prot: string; fat: string }>({ kcal: '', carb: '', prot: '', fat: '' });
  const num = (v: string) => { const x = parseFloat(v.replace(',', '.')); return isFinite(x) && x >= 0 ? x : undefined; };
  const n: Nutr = {};
  (['kcal', 'carb', 'prot', 'fat'] as const).forEach(k => { const x = num(f[k]); if (x != null) n[k] = x; });
  // Energy from macros if only macros are given (4/4/9)
  if (n.kcal == null && (n.carb || n.prot || n.fat)) n.kcal = Math.round((n.carb ?? 0) * 4 + (n.prot ?? 0) * 4 + (n.fat ?? 0) * 9);
  const valid = (n.kcal ?? 0) > 0 && (n.kcal ?? 0) < 10000;
  const field = (k: keyof typeof f, lab: string) => (
    <View style={{ flex: 1 }}>
      <Text style={s.fieldLab}>{lab}</Text>
      <TextInput style={s.field} value={f[k]} onChangeText={v => setF(p => ({ ...p, [k]: v }))} keyboardType="decimal-pad" placeholder="–" placeholderTextColor={c.textFaint} />
    </View>
  );
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={s.portionName}>Quick add</Text>
      <Text style={s.fieldLab}>Label (optional — "Gel", "Sports drink"… repeats show up in Recents)</Text>
      <TextInput style={s.field} value={label} onChangeText={setLabel} placeholder="Quick add" placeholderTextColor={c.textFaint} />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        {field('kcal', 'kcal')}{field('carb', 'Carbs g')}{field('prot', 'Protein g')}{field('fat', 'Fat g')}
      </View>
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, !valid && { opacity: 0.4 }]} disabled={!valid} onPress={() => { Keyboard.dismiss(); onConfirm(label, n); }}>
          <Text style={s.btnTxt}>Log {valid ? `${r0(n.kcal)} kcal` : ''}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Edit an entry ────────────────────────────────────────────────────────────────────────────────
function EditSheet({ entry, date, isFav, onClose }: { entry: FoodEntry; date: string; isFav: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  // per-100 from the table when we have it (exact), else back-computed from the entry
  const tableItem = foodByKey(entry.key);
  const per100: Nutr = tableItem?.per100
    ?? (entry.grams && entry.grams > 0 ? Object.fromEntries(Object.entries(entry.n).map(([k, v]) => [k, (v as number) * 100 / entry.grams!])) as Nutr : entry.n);
  const item: FoodItem = tableItem ?? { key: entry.key, src: entry.src, id: idOf(entry.key), name: entry.name, per100 };
  const run = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { saveFailed(e); } onClose(); };
  const del = () => run(() => removeEntries(date, [entry.id]));
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.sheet, { backgroundColor: c.bg }]}>
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>{hhmm(entry.t)} · edit</Text>
          <TouchableOpacity onPress={() => { Keyboard.dismiss(); onClose(); }} hitSlop={12}><Text style={s.done}>Close</Text></TouchableOpacity>
        </View>
        {entry.grams ? (
          <PortionPanel item={item} initial={entry.grams} isFav={isFav} confirmLabel="Save"
            onFav={() => { toggleFav(entry.key, { name: item.name, src: item.src, per100 }).catch(() => {}); }}
            onCancel={onClose} onDelete={del}
            onConfirm={g => run(() => updateEntry(date, entry.id, { grams: g, per100 }))} />
        ) : (
          <View>
            <Text style={s.portionName}>{entry.name}</Text>
            <Text style={s.resultSub}>{r0(entry.n.kcal)} kcal · {macroLine(entry.n)}</Text>
            <View style={s.btnRow}>
              <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={del}><Text style={s.btnDangerTxt}>Delete</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={onClose}><Text style={s.btnGhostTxt}>Close</Text></TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  topRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  homeBtn:   { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, width: 90 },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 15 },
  title:     { color: c.text, fontSize: 18, fontWeight: '800' },
  card:      { backgroundColor: c.surface, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: c.border },
  kcal:      { color: c.text, fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'] },
  kcalUnit:  { color: c.textSub, fontSize: 15, fontWeight: '600' },
  macros:    { color: c.text, fontSize: 14, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  sub:       { color: c.textSub, fontSize: 13, marginTop: 4, fontVariant: ['tabular-nums'] },
  completeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  completeTxt: { color: c.text, fontSize: 14, fontWeight: '600' },
  bold:      { color: c.text, fontWeight: '800' },
  fuelCard:  { marginTop: 14, borderColor: '#f59e0b' },
  fuelTitle: { color: c.text, fontSize: 15, fontWeight: '800', marginBottom: 6 },
  fuelLine:  { color: c.text, fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  hint:      { color: c.textFaint, fontSize: 12, marginTop: 6, lineHeight: 16 },
  warn:      { color: '#d97706', fontSize: 12.5, marginTop: 6, lineHeight: 17, fontWeight: '600' },
  section:   { color: c.textSub, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
  chips:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:      { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  chipOn:    { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:   { color: c.text, fontSize: 14, fontWeight: '600' },
  empty:     { color: c.textFaint, fontSize: 14, lineHeight: 20, paddingVertical: 12, textAlign: 'center' },
  runRow:    { paddingVertical: 8, paddingHorizontal: 12, borderLeftWidth: 3, borderLeftColor: '#3B82F6', marginVertical: 6, backgroundColor: c.surfaceAlt, borderRadius: 8 },
  runTxt:    { color: c.text, fontSize: 13.5, fontWeight: '600' },
  waterRow:  { paddingVertical: 6, paddingHorizontal: 12, marginVertical: 3 },
  waterTxt:  { color: c.textSub, fontSize: 13.5 },
  mealCard:  { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, marginVertical: 5, overflow: 'hidden' },
  mealHead:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, backgroundColor: c.surfaceAlt },
  mealTitle: { color: c.text, fontSize: 14.5, fontWeight: '700' },
  mealKcal:  { color: c.textSub, fontSize: 13.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  entry:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, gap: 10 },
  entryName: { color: c.text, fontSize: 14, flex: 1 },
  entryMeta: { color: c.textSub, fontSize: 13, fontVariant: ['tabular-nums'] },
  yRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surface, borderRadius: 12, padding: 10, marginVertical: 4, borderWidth: 1, borderColor: c.border },
  yTitle:    { color: c.text, fontSize: 14, fontWeight: '700' },
  ySub:      { color: c.textSub, fontSize: 12.5, marginTop: 2 },
  copyBtn:   { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 10, backgroundColor: c.accent },
  copyTxt:   { color: c.onAccent, fontWeight: '800', fontSize: 13.5 },
  credit:    { color: c.textFaint, fontSize: 11, lineHeight: 15, marginTop: 24, textAlign: 'center' },
  creditSmall: { color: c.textFaint, fontSize: 11, lineHeight: 15, marginTop: 14 },
  toast:     { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.text, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  toastTxt:  { color: c.bg, fontSize: 14, fontWeight: '600', flex: 1 },
  toastBtn:  { color: c.accent, fontSize: 15, fontWeight: '800' },
  fab:       { position: 'absolute', right: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  fabTxt:    { color: c.onAccent, fontSize: 30, fontWeight: '600', marginTop: -2 },
  sheet:     { flex: 1, padding: 16 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 10 },
  sheetTitle:{ color: c.text, fontSize: 18, fontWeight: '800' },
  done:      { color: c.accent, fontSize: 16, fontWeight: '700' },
  search:    { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: c.text },
  actions:   { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  action:    { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  actionTxt: { color: c.text, fontSize: 13.5, fontWeight: '600' },
  bigRow:    { marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent },
  bigRowTxt: { color: c.text, fontSize: 15, fontWeight: '700' },
  tabs:      { flexDirection: 'row', gap: 6, marginTop: 12, marginBottom: 4 },
  tab:       { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:     { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:    { color: c.textSub, fontSize: 13.5, fontWeight: '700' },
  tabTxtOn:  { color: c.onAccent },
  result:    { paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  resultTitle: { color: c.text, fontSize: 15, fontWeight: '600' },
  resultSub: { color: c.textSub, fontSize: 12.5, marginTop: 2, fontVariant: ['tabular-nums'] },
  badge:     { color: c.accent, fontSize: 11, fontWeight: '800' },
  onlineBtn: { paddingVertical: 14 },
  onlineTxt: { color: c.accent, fontSize: 14.5, fontWeight: '700' },
  loggedBar: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, marginBottom: 10 },
  loggedTxt: { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  portionName: { color: c.text, fontSize: 18, fontWeight: '800' },
  prodImg:   { width: 56, height: 56, borderRadius: 8, backgroundColor: c.surfaceAlt },
  gramsRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 10 },
  gramsInput:{ backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, paddingHorizontal: 14, paddingVertical: 10, fontSize: 22, fontWeight: '700', color: c.text, minWidth: 110, fontVariant: ['tabular-nums'] },
  gramsUnit: { color: c.textSub, fontSize: 18, fontWeight: '700' },
  gramsUnitSm: { color: c.textSub, fontSize: 14, fontWeight: '700' },
  gramsHint: { color: c.textFaint, fontSize: 13, flex: 1, textAlign: 'right' },
  preview:   { marginTop: 14, backgroundColor: c.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border },
  previewKcal: { color: c.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  previewSub:  { color: c.textSub, fontSize: 13, marginTop: 4, lineHeight: 18, fontVariant: ['tabular-nums'] },
  parseRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  check:     { color: c.accent, fontSize: 22 },
  parseGrams:{ backgroundColor: c.surface, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, fontWeight: '700', color: c.text, width: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
  labelRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  btnRow:    { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn:       { flex: 1, paddingVertical: 13, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center' },
  btnTxt:    { color: c.onAccent, fontSize: 16, fontWeight: '800' },
  btnGhost:  { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  btnGhostTxt: { color: c.text, fontSize: 16, fontWeight: '700' },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#dc2626' },
  btnDangerTxt: { color: '#dc2626', fontSize: 16, fontWeight: '700' },
  fieldLab:  { color: c.textSub, fontSize: 12.5, fontWeight: '600', marginTop: 10, marginBottom: 4 },
  field:     { backgroundColor: c.surface, borderRadius: 10, borderWidth: 1, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: c.text },
});
