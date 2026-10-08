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
import { ModeSwitcher } from '../src/components/ModeSwitcher';
import { ModeHeader } from '../src/components/ModeHeader';
import { SwipeRow } from '../src/components/SwipeRow';
import { useDictation, cleanDictation } from '../src/components/useDictation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { DayNav } from '../src/components/DayNav';
import { PhotoTest } from '../src/components/PhotoTest';
import * as ImagePicker from 'expo-image-picker';
import { detectBarcodes, scanBarcodeLive } from '../modules/runcoach-pdf';
import { searchFoodsEx, defaultServing, foodByKey, norm, CIQUAL_CREDIT } from '../src/services/foodDb';
import {
  loadDay, loadLibrary, logFood, logRecent, logMeal, removeEntries, updateEntry, addWater, copyEntries, saveMeal,
  deleteMeal, toggleFav, favouriteList, setDayComplete, dayTotals, groupMeals, mealLabel, usualNow, quickItem,
  scaleNutr, todayFoodDay, timeForDay, foodDayOf, addCustomFood, searchCustom, logFoods, setServing, servingOverrides, mealTagAt, MEAL_TAGS,
  updateMealItems, SavedMealItem, setFavourites, removeRecent, netNutr, withRs,
  DayLog, FoodLibrary, FoodEntry, FoodItem, Recent, SavedMeal, Nutr, FavItem,
} from '../src/services/foodLog';
import { sportsByKey } from '../src/services/foodSports';
import { lookupBarcode, searchOff, rememberProduct, cachedProducts, validBarcode, OFF_CREDIT, OFF_URL, OffProduct, isEcho100, DRINK_NAME } from '../src/services/foodOff';
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
const FIXED_UNITS = new Set(['g', 'kg', 'ml', 'cl', 'l', 'tbsp', 'tsp', 'glass', 'cup', 'can', 'bottle', 'wine-bottle', 'carton', 'juicebox', 'handful', 'dash']);
/** "330 ml" / "80 g" — the amount in the unit the food was entered in. */
const amt = (grams?: number, unit?: string) => (grams ? `${r0(grams)} ${unit === 'ml' ? 'ml' : 'g'}` : '');
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
  const [adding, setAdding] = useState<boolean | SavedMeal>(false);   // a SavedMeal = open straight in its preview
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const [photoTest, setPhotoTest] = useState(false);
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
      setAdding(sg.meal);   // preview first: untick what you don't have before it's logged
    } else {
      const e = await logRecent(sg.recent, date, 'suggest');
      showUndo({ msg: `Logged ${e.name.split(',')[0]}${e.grams ? ` · ${amt(e.grams, e.unit)}` : ''}`, date: foodDayOf(e.t), ids: [e.id] });
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
      {/* the shared mode header (Biology's), day navigation as its second row */}
      <ModeHeader title="Food" actions={[
        { icon: '📚', onPress: () => router.push('/food-library' as any), label: 'Food database' },   // foods & meals: add / edit / delete
        { icon: '＋', onPress: () => setAdding(true), label: 'Log food' },
      ]}>
        <DayNav date={isToday ? undefined : date} todayKey={today} />
      </ModeHeader>
      {/* the food DATABASE (foods + meals, like the exercise database) — reachable without logging anything */}
      <TouchableOpacity style={s.dbLink} onPress={() => router.push('/food-library' as any)}>
        <Text style={s.dbLinkTxt}>📚 Food database — your foods & meals: add · edit · delete  ›</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 120 }}>

        {/* Totals — neutral, no "over budget" red */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={s.kcal}>{r0(totals?.kcal)}</Text><Text style={s.kcalUnit}>kcal</Text>
          </View>
          <Text style={s.macros}>Carbs {r0(totals?.carb)} g · Protein {r0(totals?.prot)} g · Fat {r0(totals?.fat)} g</Text>
          <Text style={s.sub}>💧 {r1((totals?.waterMl ?? 0) / 1000)} L drinks · Sodium {r1((totals?.na ?? 0) / 1000)} g · Fibre {r0(totals?.fib)} g{totals?.rs ? ` + ${r0(totals.rs)} g resistant starch (not in carbs)` : ''}</Text>
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
            <SwipeRow key={row.id} onDelete={() => confirmWaterDelete(row.id, row.ml)}>
              <TouchableOpacity style={[s.waterRow, { backgroundColor: c.bg }]} onLongPress={() => confirmWaterDelete(row.id, row.ml)}>
                <Text style={s.waterTxt}>{hhmm(row.t)}  💧 {row.ml} mL</Text>
              </TouchableOpacity>
            </SwipeRow>
          );
          const kcal = r0(row.items.reduce((a, e) => a + (netNutr(e.n).kcal ?? 0), 0));   // resistant starch at 2 kcal/g
          return (
            <View key={row.items[0].id} style={s.mealCard}>
              <TouchableOpacity style={s.mealHead} onPress={() => mealMenu(row.items)}>
                <Text style={s.mealTitle}>{hhmm(row.t)}  {mealLabel(row.t)}</Text>
                <Text style={s.mealKcal}>{kcal} kcal  ⋯</Text>
              </TouchableOpacity>
              {row.items.map(e => (
                // swipe left → Delete (it used to hide inside the edit sheet)
                <SwipeRow key={e.id} onDelete={() => once(async () => { await removeEntries(foodDayOf(e.t), [e.id]); })}>
                  <TouchableOpacity style={[s.entry, { backgroundColor: c.surface }]} onPress={() => setEditing(e)}>
                    <Text style={s.entryName} numberOfLines={1}>{e.name}</Text>
                    <Text style={s.entryMeta}>{e.grams ? `${amt(e.grams, e.unit)} · ` : ''}{r0(netNutr(e.n).kcal)} kcal{e.n.rs ? ` · ${r0(e.n.rs)} g resistant starch` : ''}</Text>
                  </TouchableOpacity>
                </SwipeRow>
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

        <TouchableOpacity style={s.testBtn} onPress={() => setPhotoTest(true)}>
          <Text style={s.testTxt}>🧪 Photo test — one-time check before photo meals are built</Text>
        </TouchableOpacity>
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

      {photoTest && <PhotoTest onClose={() => setPhotoTest(false)} />}
      {adding && lib && <AddSheet date={date} lib={lib} startMeal={typeof adding === 'object' ? adding : undefined} onClose={() => { Keyboard.dismiss(); setAdding(false); reload(); }} />}
      {editing && (
        <EditSheet entry={editing} date={date} isFav={!!lib?.favs.includes(editing.key)} own={lib?.custom.find(x => x.key === editing.key)}
          onClose={() => { Keyboard.dismiss(); setEditing(null); reload(); }} />
      )}
      {!adding && !editing && <ModeSwitcher current="food" />}
    </View>
  );
}

// ─── Add sheet ────────────────────────────────────────────────────────────────────────────────────
type Tab = 'recent' | 'fav' | 'meals';
type Mode =
  | { m: 'search' }
  | { m: 'portion'; item: FoodItem | OffProduct; grams?: number }
  | { m: 'quick'; name?: string; ean?: string }
  | { m: 'label'; ean?: string; name?: string }
  | { m: 'editItem'; entry: FoodEntry }
  | { m: 'online'; query: string; results: OffProduct[] | null; error?: string }
  | { m: 'meal'; meal: SavedMeal };   // a saved meal, previewed: untick / re-weigh / add components before logging

function AddSheet({ date, lib: lib0, onClose, startMeal }: { date: string; lib: FoodLibrary; onClose: () => void; startMeal?: SavedMeal }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [lib, setLib] = useState(lib0);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('recent');
  const [mode, setMode] = useState<Mode>(startMeal ? { m: 'meal', meal: startMeal } : { m: 'search' });
  // 🎤 dictate a meal ("two eggs, toast with butter and a coffee") → the same live parser as typing
  const dict = useDictation(text => { const t = cleanDictation(text); setAsOne(false); setQ(t); setDq(t); setMode({ m: 'search' }); });
  const [batches, setBatches] = useState<FoodEntry[][]>([]);   // each log action = one batch → Undo removes a batch
  const [offCache, setOffCache] = useState<OffProduct[]>([]);
  const [lookingUp, setLookingUp] = useState(false);
  const [dq, setDq] = useState('');                     // debounced query: search runs ~150 ms after typing stops
  useEffect(() => { const t = setTimeout(() => setDq(q), 150); return () => clearTimeout(t); }, [q]);
  const onlineTok = useRef(0);
  // Parts of a typed meal that had no match: kept as "Still to find" chips (with their typed grams) until the user
  // finds each one or dismisses it — nothing typed ever silently disappears.
  const [pending, setPendingState] = useState<{ query: string; grams?: number }[]>([]);
  const pendingRef = useRef<{ query: string; grams?: number }[]>([]);
  const setPending = (next: { query: string; grams?: number }[]) => { pendingRef.current = next; setPendingState(next); };
  // The chip being worked on — EXPLICIT (set when a chip is tapped/jumped to), so rewording the search ("quinoaxyz"
  // → "quinoa") or going online keeps its typed grams and still ticks it off. Cleared on ✕ or once found.
  const [activeChip, setActiveChipState] = useState<string | null>(null);
  const activeChipRef = useRef<string | null>(null);
  const setActiveChip = (q: string | null) => { activeChipRef.current = q; setActiveChipState(q); };
  // NOT cleared when the box is emptied: clearing it to retype other words is exactly how a chip gets found.
  // The active chip is highlighted with a "Finding …" hint; ✕ drops it.
  const [asOne, setAsOne] = useState(false);           // "search the whole phrase as ONE food" (fish and chips…)
  useEffect(() => { setAsOne(false); }, [dq]);
  const batchesRef = useRef<FoodEntry[][]>([]);
  const inflight = useRef<Promise<void> | null>(null);
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
  const activePending = pending.find(p => p.query === activeChip);
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
  // A typed meal ("2 eieren, toast met boter") is parsed LIVE and shown inline — never hidden behind a button,
  // and search results for the whole phrase are not shown (they only matched part of it and confused things).
  const parsed = useMemo(() => (phrase ? parseMeal(dqt, boost, t => ownMatches(t)[0]) : []), [phrase, dqt, boost, ownMatches]);
  const showParse = phrase && parsed.length > 0 && !asOne;
  const recentOf = (key: string) => lib.recents.find(r => r.key === key);

  const refreshLib = async () => setLib(await loadLibrary());
  const guard = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    const p = (async () => { try { await fn(); } catch (e) { saveFailed(e); } finally { busy.current = false; } })();
    inflight.current = p;
    await p;
  };
  const pushBatch = (es: FoodEntry[]) => { batchesRef.current = [...batchesRef.current, es]; setBatches(batchesRef.current); };
  const setBatchesBoth = (next: FoodEntry[][]) => { batchesRef.current = next; setBatches(next); };
  /** After an add: if it was one of the "still to find" parts, tick it off and jump to the next one. */
  const logged = async (es: FoodEntry[]) => {
    if (es.length) pushBatch(es);
    // refs, not render state: this runs from list callbacks memoised on earlier renders
    const act = activeChipRef.current;
    const rest = act ? pendingRef.current.filter(p => p.query !== act) : pendingRef.current;
    if (act) setPending(rest);
    const next = act ? rest[0]?.query ?? '' : '';
    setActiveChip(next || null);
    setQ(next); setDq(next); setMode({ m: 'search' });
    await refreshLib();
  };
  const chipGrams = () => pendingRef.current.find(p => p.query === activeChipRef.current)?.grams;

  const pick = (item: FoodItem, longPress = false) => guard(async () => {
    const rec = recentOf(item.key);
    const typed = chipGrams();                          // "200 g quinoa" typed in the meal → keep the 200 g
    if (!longPress && !typed && rec?.grams) {
      if (item.src === 'off') await rememberProduct(item as OffProduct).catch(() => undefined);
      await logged([await logFood(item, { grams: rec.grams, via: 'search', date, groupId })]); return;
    }
    Keyboard.dismiss();
    setMode({ m: 'portion', item, grams: typed ?? rec?.grams });
  });
  /** unit + piece size of one of your own foods (from its saved definition, else the recent's snapshot) */
  const ownExtras = (key: string, snap?: { unit?: 'g' | 'ml'; serving?: { g: number; label: string } }) => {
    const own = lib.custom.find(x => x.key === key);
    const unit = own?.unit ?? snap?.unit, serving = own?.serving ?? snap?.serving;
    return { ...(unit === 'ml' ? { unit: 'ml' as const } : {}), ...(serving ? { serving } : {}) };
  };
  const pickRecent = (r: { key: string; name: string; src: FoodItem['src']; per100?: Nutr; n?: Nutr; grams?: number; unit?: 'g' | 'ml'; serving?: { g: number; label: string } }, longPress = false) => guard(async () => {
    // a remembered serving (or a fixed quick-add) logs in one tap; a favourite never logged before asks the amount
    if ((!longPress && r.grams) || !r.per100) {
      const asRecent: Recent = { key: r.key, name: r.name, src: r.src, per100: r.per100, n: r.n, grams: r.grams, ...ownExtras(r.key, r), count: 0, last: '', hrs: [] };
      await logged([await logRecent(asRecent, date, 'recent', groupId)]);
      return;
    }
    Keyboard.dismiss();
    setMode({ m: 'portion', item: { key: r.key, src: r.src, id: idOf(r.key), name: r.name, per100: r.per100, ...ownExtras(r.key, r) }, grams: r.grams });
  });
  // a saved meal opens as a PREVIEW: untick what you don't have / eat later, adjust grams, add by voice — then log
  const pickMeal = (m: SavedMeal) => { Keyboard.dismiss(); setMode({ m: 'meal', meal: m }); };
  const undoLast = () => guard(async () => {
    const cur = batchesRef.current;
    const last = cur[cur.length - 1]; if (!last) return;
    const byDay = new Map<string, string[]>();
    for (const e of last) { const d = e.key === 'water' ? date : foodDayOf(e.t); byDay.set(d, [...(byDay.get(d) ?? []), e.id]); }
    for (const [d, ids] of byDay) await removeEntries(d, ids);
    setBatchesBoth(batchesRef.current.slice(0, -1));
  });
  const added = batches.flat();
  const removeItem = (e: FoodEntry) => guard(async () => {
    await removeEntries(e.key === 'water' ? date : foodDayOf(e.t), [e.id]);
    setBatchesBoth(batchesRef.current.map(b => b.filter(x => x.id !== e.id)).filter(b => b.length));
  });
  const perOf = (e: FoodEntry): Nutr => foodByKey(e.key)?.per100
    ?? (e.grams && e.grams > 0 ? Object.fromEntries(Object.entries(e.n).map(([k, v]) => [k, (v as number) * 100 / e.grams!])) as Nutr : e.n);
  const editItem = (e: FoodEntry, grams: number) => guard(async () => {
    const per100 = perOf(e);
    await updateEntry(foodDayOf(e.t), e.id, { grams, per100 });
    setBatchesBoth(batchesRef.current.map(b => b.map(x => (x.id === e.id ? { ...x, grams, n: scaleNutr(per100, grams) } : x))));
    setMode({ m: 'search' });
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
  /** Scan = take a photo of the barcode; iOS Vision reads it on the phone → the same lookup as typed digits. */
  const scanning = useRef(false);
  const scan = async () => {
    if (scanning.current) return;                       // a double tap must not open the camera twice
    scanning.current = true;
    try { await scanInner(); } finally { scanning.current = false; }
  };
  const scanInner = async () => {
    Keyboard.dismiss();
    // 1) the LIVE scanner (point → reads instantly); 2) if this phone/build can't run it, a photo of the barcode
    const live = await scanBarcodeLive();
    if (live === null) return;                                    // cancelled
    if (typeof live === 'string' && live !== 'unsupported' && live !== 'unavailable') {
      const code = live.replace(/\D/g, '');
      if (/^\d{8,14}$/.test(code)) { setQ(code); setDq(code); await lookup(code); return; }
    }
    if (live === 'unavailable') { Alert.alert('Camera not available', 'Check that RunCoach may use the camera (iOS Settings › RunCoach) and no other app is using it — or type the digits under the barcode.'); return; }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert('Camera not allowed', 'Allow camera access for RunCoach in iOS Settings, or type the digits under the barcode.'); return; }
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    if (r.canceled || !r.assets?.[0]?.uri) return;
    setLookingUp(true);
    const codes = await detectBarcodes(r.assets[0].uri);
    setLookingUp(false);
    if (codes == null) { Alert.alert('Needs the new app build', 'Barcode photos need the latest app build on this phone. Until then, type the digits under the barcode.'); return; }
    const code = codes.map(x => x.replace(/\D/g, '')).find(x => /^\d{8,14}$/.test(x));
    if (!code) {
      Alert.alert('No barcode found', 'Hold the barcode flat, fill most of the picture with it and avoid glare — or type the digits under it.', [
        { text: 'Try again', onPress: () => { scan().catch(() => {}); } }, { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    setQ(code); setDq(code);
    await lookup(code);
  };

  // Branded products INLINE in the result list (like the big apps): fetched on the keyboard's Search key or the
  // footer tap — never per keystroke (Open Food Facts forbids search-as-you-type).
  const [offRes, setOffRes] = useState<{ q: string; items: OffProduct[]; loading: boolean; err?: string } | null>(null);
  const offTok = useRef(0);
  const fetchProducts = async (query: string) => {
    const qq = query.trim();
    if (qq.length < 3 || /^\d+$/.test(qq)) return;
    if (offRes?.q === qq && (offRes.loading || !offRes.err)) return;   // same query again → no new requests (rate limit)
    const tok = ++offTok.current;
    setOffRes({ q: qq, items: [], loading: true });
    try {
      const items = await searchOff(qq);
      if (tok === offTok.current) setOffRes({ q: qq, items, loading: false });
    } catch (e: any) {
      if (tok === offTok.current) setOffRes({ q: qq, items: [], loading: false, err: e?.message ?? String(e) });
    }
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

  type Li = { key: string; title: string; sub: string; badge?: string; onPress: () => void; onLong?: () => void; star?: boolean; header?: boolean; onDelete?: () => void; delLabel?: string };
  const list: Li[] = useMemo(() => {
    const favs = new Set(lib.favs);
    const foodRow = (f: FoodItem, badge?: string): Li => ({
      key: f.key, title: f.name, badge, star: favs.has(f.key),
      sub: `${f.brand ? `${f.brand} · ` : ''}${r0(f.per100.kcal)} kcal/100 ${f.unit === 'ml' ? 'ml' : 'g'} · ${macroLine(f.per100)}${recentOf(f.key)?.grams ? ` · last ${amt(recentOf(f.key)!.grams, f.unit)}` : ''}`,
      onPress: () => pick(f), onLong: () => pick(f, true),
    });
    if (dqt.length >= 2 && !digits) {
      const seen = new Set(mine.map(f => f.key));
      const local = [...mine.map(f => foodRow(f, f.src === 'custom' ? 'mine' : 'product')), ...search.items.filter(f => !seen.has(f.key)).map(f => foodRow(f))];
      local.forEach(r => seen.add(r.key));
      const prods = offRes && offRes.q === dqt ? offRes.items.filter(p => !seen.has(p.key)).map(p => foodRow(p, 'product')) : [];
      const head: Li[] = offRes && offRes.q === dqt
        ? [{ key: '__prod', title: offRes.loading ? 'Searching products…' : prods.length ? 'Products (Open Food Facts)' : offRes.err ? `Product search failed — ${offRes.err}` : 'No branded products found — try fewer words, or ✏️ Add your own', sub: '', onPress: () => {}, header: true }]
        : [];
      return [...local, ...head, ...prods];
    }
    if (digits) return [];
    if (tab === 'meals') return lib.meals.map(m => ({
      key: m.id, title: `🍽️ ${m.name}`,
      sub: `${m.items.length} items · ${r0(m.items.reduce((a, it) => a + ((it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams).kcal : it.n?.kcal) ?? 0), 0))} kcal`,
      onPress: () => pickMeal(m), onDelete: () => guard(async () => { await deleteMeal(m.id); await refreshLib(); }),
      onLong: () => Alert.alert(m.name, 'Delete this saved meal?', [{ text: 'Delete', style: 'destructive', onPress: () => guard(async () => { await deleteMeal(m.id); await refreshLib(); }) }, { text: 'Cancel', style: 'cancel' }]),
    }));
    // Favourites, the ones TAGGED for this meal first (My foods), then foods tagged for this meal that aren't starred
    const nowTag = mealTagAt(timeForDay(date));
    const tagged = (k: string) => (lib.tags?.[k] ?? []).includes(nowTag);
    const favList: FavItem[] = [...favouriteList(lib), ...lib.favs.filter(k => !favouriteList(lib).some(f => f.key === k)).map(k => foodByKey(k)).filter((f): f is FoodItem => !!f).map(f => ({ key: f.key, name: f.name, src: f.src, per100: f.per100 }))];
    const extraTagged: FavItem[] = Object.values(lib.kept ?? {}).filter(f => tagged(f.key) && !lib.favs.includes(f.key))
      .map(f => ({ ...f, grams: lib.recents.find(r => r.key === f.key)?.grams ?? f.grams }));   // your latest serving
    const src: FavItem[] | Recent[] = tab === 'fav'
      ? [...favList.filter(f => tagged(f.key)), ...extraTagged, ...favList.filter(f => !tagged(f.key))]
      : lib.recents.slice(0, 40);
    const tagLbl = MEAL_TAGS.find(m => m.id === nowTag)?.label.toLowerCase();
    return (src as FavItem[]).map(r => ({
      key: r.key, title: `${r.name}${tab === 'fav' && tagged(r.key) ? `  · ${tagLbl}` : ''}`, star: favs.has(r.key),
      sub: r.grams ? `${amt(r.grams, ownExtras(r.key, r).unit)} · ${r0(r.per100 ? scaleNutr(r.per100, r.grams).kcal : r.n?.kcal)} kcal` : r.per100 ? `${r0(r.per100.kcal)} kcal/100 g` : `${r0(r.n?.kcal)} kcal`,
      onPress: () => pickRecent(r), onLong: () => pickRecent(r, true),
      // swipe: Favourites → un-star · Recents → drop from recents
      onDelete: () => guard(async () => { if (tab === 'fav') await setFavourites([{ key: r.key, snap: { name: r.name, src: r.src, ...(r.per100 ? { per100: r.per100 } : {}), ...(r.n ? { n: r.n } : {}), ...(r.unit ? { unit: r.unit } : {}), ...(r.serving ? { serving: r.serving } : {}) } }], false); else await removeRecent(r.key); await refreshLib(); }),
      delLabel: tab === 'fav' ? 'Unstar' : 'Remove',
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dqt, digits, search, mine, tab, lib, offRes]);

  // wait for a save that is still running, so the day view reloads with the last item in it
  const close = async () => { Keyboard.dismiss(); try { await inflight.current; } catch { /* reported already */ } onClose(); };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={50} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[s.sheet, { backgroundColor: c.bg }]}>
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>Add food</Text>
          <TouchableOpacity onPress={close} hitSlop={12}><Text style={s.done}>{added.length ? `Done · ${added.length} added` : 'Done'}</Text></TouchableOpacity>
        </View>

        {/* confirmation + Undo sit ABOVE the list so the keyboard never hides them */}
        {/* THIS MEAL: everything added in this sheet, always visible — tap to change the amount, ✕ to remove */}
        {added.length > 0 && mode.m !== 'editItem' && (
          <View style={s.basket}>
            <View style={s.basketHead}>
              <Text style={s.basketTitle}>✓ This meal · {added.length} item{added.length === 1 ? '' : 's'} · {r0(added.reduce((a, e) => a + (e.n.kcal ?? 0), 0))} kcal</Text>
              <TouchableOpacity onPress={undoLast} hitSlop={10}><Text style={s.toastBtn}>Undo{batches[batches.length - 1]?.length > 1 ? ` last ${batches[batches.length - 1].length}` : ' last'}</Text></TouchableOpacity>
            </View>
            {!showParse && <ScrollView style={{ maxHeight: 132 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {added.map(e => (
                <View key={e.id} style={s.basketRow}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => {
                    if (!e.grams || e.key === 'water') { Alert.alert(e.name, 'This one has no weight to change — remove it (✕) and add it again if needed.'); return; }
                    Keyboard.dismiss(); setMode({ m: 'editItem', entry: e });
                  }}>
                    <Text style={s.basketName} numberOfLines={1}>{e.name.split(',').slice(0, 2).join(',')}</Text>
                  </TouchableOpacity>
                  <Text style={s.basketMeta}>{e.grams ? `${amt(e.grams, e.unit)} · ` : ''}{e.key === 'water' ? '' : `${r0(e.n.kcal)} kcal`}</Text>
                  <TouchableOpacity onPress={() => removeItem(e)} hitSlop={10}><Text style={s.basketX}>✕</Text></TouchableOpacity>
                </View>
              ))}
            </ScrollView>}
          </View>
        )}

        {mode.m === 'portion' ? (
          <PortionPanel key={`p${mode.item.key}`} item={mode.item} initial={mode.grams} isFav={lib.favs.includes(mode.item.key)} forChip={activeChip ?? undefined}
            onFav={() => guard(async () => { await toggleFav(mode.item.key, { name: mode.item.name, src: mode.item.src, per100: mode.item.per100, ...(mode.item.unit ? { unit: mode.item.unit } : {}), ...(mode.item.serving ? { serving: mode.item.serving } : {}) }); await refreshLib(); })}
            onCancel={() => setMode({ m: 'search' })}
            onConfirm={g => guard(async () => {
              if (mode.item.src === 'off') await rememberProduct(mode.item as OffProduct);
              await logged([await logFood(mode.item, { grams: g, via: mode.item.src === 'off' ? 'ean' : 'search', date, groupId })]);
            })} />
        ) : mode.m === 'quick' ? (
          <QuickPanel key={`q${mode.name ?? ''}`} name0={mode.name} onCancel={() => setMode({ m: 'search' })}
            onPer100={name => setMode({ m: 'label', name, ean: mode.ean })}
            onConfirm={(label, n) => guard(async () => { await logged([await logFood(quickItem(label, n), { via: 'quick', date, groupId })]); })} />
        ) : mode.m === 'label' ? (
          <LabelPanel key={`l${mode.name ?? ''}${mode.ean ?? ''}`} ean={mode.ean} name={mode.name} onCancel={() => setMode({ m: 'search' })}
            onTotals={name => setMode({ m: 'quick', name, ean: mode.ean })}
            onSave={f => guard(async () => { const item = await addCustomFood(f); await refreshLib(); setMode({ m: 'portion', item, grams: item.serving?.g }); })} />
        ) : mode.m === 'editItem' ? (
          <PortionPanel key={`e${mode.entry.id}`} item={{ key: mode.entry.key, src: mode.entry.src, id: idOf(mode.entry.key), name: mode.entry.name, per100: perOf(mode.entry), ...ownExtras(mode.entry.key, { unit: mode.entry.unit }) }}
            initial={mode.entry.grams} isFav={lib.favs.includes(mode.entry.key)} confirmLabel="Save"
            onFav={() => guard(async () => { await toggleFav(mode.entry.key, { name: mode.entry.name, src: mode.entry.src, per100: perOf(mode.entry) }); await refreshLib(); })}
            onCancel={() => setMode({ m: 'search' })}
            onDelete={() => { removeItem(mode.entry); setMode({ m: 'search' }); }}
            onConfirm={g => editItem(mode.entry, g)} />
        ) : mode.m === 'meal' ? (
          <MealPanel meal={mode.meal} onCancel={() => setMode({ m: 'search' })}
            onSaveItems={items => guard(async () => { await updateMealItems(mode.meal.id, items); await refreshLib(); })}
            onConfirm={items => guard(async () => { await logged(await logMeal({ ...mode.meal, items }, date)); })} />
        ) : mode.m === 'online' ? (
          <OnlinePanel query={mode.query} results={mode.results} error={mode.error} onCancel={() => setMode({ m: 'search' })}
            onPick={p => { setMode({ m: 'portion', item: p, grams: chipGrams() ?? recentOf(p.key)?.grams }); }} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'stretch' }}>
            <TextInput
              style={[s.search, { flex: 1 }]} value={q} onChangeText={setQ}
              placeholder={added.length ? 'Add another item…' : 'Search food or product…'}
              placeholderTextColor={c.textFaint} autoFocus autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing"
              onSubmitEditing={() => { if (digits) lookup(qt); else if (!phrase) fetchProducts(qt); }}
            />
            <TouchableOpacity style={s.scanBtn} onPress={() => { scan().catch(e => { setLookingUp(false); Alert.alert('Scan failed', String(e?.message ?? e)); }); }}>
              <Text style={s.scanIcon}>▥</Text><Text style={s.scanTxt}>Scan</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.scanBtn, dict.state === 'recording' && { backgroundColor: '#ef4444', borderColor: '#ef4444' }]} onPress={() => { Keyboard.dismiss(); dict.toggle(); }}>
              <Text style={s.scanIcon}>{dict.state === 'recording' ? '⏹' : dict.state === 'transcribing' ? '…' : '🎤'}</Text>
              <Text style={[s.scanTxt, dict.state === 'recording' && { color: '#fff' }]}>{dict.state === 'recording' ? 'Stop' : 'Say it'}</Text>
            </TouchableOpacity>
            </View>
            {dict.state !== 'idle' && <Text style={s.hint}>{dict.state === 'recording' ? '● Listening — name every component ("2 eggs, toast with butter, 200 ml milk…"), then tap Stop' : 'Transcribing…'}</Text>}
            <View style={s.actions}>
              <TouchableOpacity style={s.action} onPress={() => { Keyboard.dismiss(); setMode({ m: 'quick', name: digits ? undefined : qt || undefined }); }}><Text style={s.actionTxt}>✏️ Add your own</Text></TouchableOpacity>
              {[250, 500].map(ml => (
                <TouchableOpacity key={ml} style={s.action} onPress={() => guard(async () => {
                  const w = await addWater(date, ml);
                  pushBatch([{ id: w.id, t: w.t, key: 'water', name: `Water ${ml} mL`, src: 'quick', n: {}, via: 'quick' }]);
                })}>
                  <Text style={s.actionTxt}>💧 {ml}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {pending.length > 0 && (
              <View style={s.pendingBox}>
                <Text style={s.pendingHead}>Still to find from your meal:</Text>
                <View style={s.chips}>
                  {pending.map(p => (
                    <View key={p.query} style={[s.pendingChip, p === activePending && { borderColor: c.accent }]}>
                      <TouchableOpacity onPress={() => { Keyboard.dismiss(); setActiveChip(p.query); setQ(p.query); setDq(p.query); }}>
                        <Text style={s.pendingTxt}>{p.grams ? `${p.grams} g ` : ''}{p.query}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => { setPending(pendingRef.current.filter(x => x.query !== p.query)); if (activeChipRef.current === p.query) setActiveChip(null); }} hitSlop={8}><Text style={s.basketX}>✕</Text></TouchableOpacity>
                    </View>
                  ))}
                </View>
                {activePending && <Text style={s.hint}>Finding "{activePending.query}": pick the right food below{activePending.grams ? ` — ${activePending.grams} g is kept` : ''}, or change the words / search online.</Text>}
              </View>
            )}
            {digits && (
              <TouchableOpacity style={s.bigRow} onPress={() => lookup(qt)} disabled={lookingUp}>
                {lookingUp ? <ActivityIndicator /> : <Text style={s.bigRowTxt}>▥ Look up barcode {qt}</Text>}
                {!validBarcode(qt) && <Text style={s.warn}>The check digit doesn't match — double-check the number.</Text>}
                <Text style={s.resultSub}>Asks Open Food Facts (only the barcode is sent).</Text>
              </TouchableOpacity>
            )}
            {showParse && (
              <ParsePanel key={dqt} items={parsed}
                onAsOne={() => setAsOne(true)}
                onConfirm={(items, missing, saveAs) => guard(async () => {
                  // one atomic write for the matched items; every unmatched part becomes a "still to find" chip
                  // (with its typed grams) and the search jumps to the first one — nothing is dropped
                  const es = items.length ? await logFoods(items.map(it => ({ item: it.food!, grams: it.grams })), { via: 'parse', date, groupId }) : [];
                  if (es.length) pushBatch(es);
                  if (saveAs && es.length) await saveMeal(saveAs, es);   // …and kept as a saved meal to re-use
                  // keep typed grams only when the unit has a fixed weight (g, ml, tbsp, glass…) — "2 sneetjes xyz" has none
                  const add = missing.map(m => ({ query: m.query, ...(m.unit && FIXED_UNITS.has(m.unit) ? { grams: m.grams } : {}) }));
                  const all = [...add, ...pendingRef.current.filter(p => !add.some(a => a.query === p.query))];
                  setPending(all);
                  const next = all[0]?.query ?? '';
                  setActiveChip(next || null);
                  setQ(next); setDq(next); setMode({ m: 'search' });
                  await refreshLib();
                })} />
            )}
            {dqt.length >= 2 && !digits && !showParse && search.ignored.length > 0 && (
              <Text style={s.hint}>Ignored: {search.ignored.join(', ')} — not in the food table.</Text>
            )}
            {dqt.length >= 2 && !digits && !showParse && search.notCombined.length > 0 && (
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
            {!showParse && <FlatList
              data={list} keyExtractor={it => it.key} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
              ListEmptyComponent={digits ? null : <Text style={s.empty}>{qt.length >= 2 ? 'No match in the food table. Press Search for branded products, or ✏️ Add your own.' : tab === 'meals' ? 'No saved meals yet — open a logged meal (⋯) and choose "Save as meal".' : tab === 'fav' ? 'No favourites yet — ★ a food here in its portion view, or in ★ My foods (top right of Food) without logging it.' : 'Foods you log appear here, with the serving you used.'}</Text>}
              ListFooterComponent={qt.length >= 3 && !digits ? (
                offRes && offRes.q === dqt ? null : (
                <TouchableOpacity style={s.onlineBtn} onPress={() => { Keyboard.dismiss(); fetchProducts(qt); }}>
                  <Text style={s.onlineTxt}>🔎 Show branded products for "{qt}"</Text>
                  <Text style={s.resultSub}>Open Food Facts · or press Search on the keyboard · sends only these words</Text>
                </TouchableOpacity>)
              ) : null}
              renderItem={({ item }) => item.header ? (
                <Text style={s.prodHead}>{item.title}</Text>
              ) : (
                <SwipeRow disabled={!item.onDelete} onDelete={() => item.onDelete?.()} label={item.delLabel ?? 'Delete'}>
                  <TouchableOpacity style={[s.result, { backgroundColor: c.bg }]} onPress={item.onPress} onLongPress={item.onLong}>
                    <Text style={s.resultTitle} numberOfLines={2}>{item.star ? '★ ' : ''}{item.badge ? <Text style={s.badge}>{item.badge === 'mine' ? 'MINE  ' : 'PRODUCT  '}</Text> : null}{item.title}</Text>
                    <Text style={s.resultSub} numberOfLines={1}>{item.sub}</Text>
                  </TouchableOpacity>
                </SwipeRow>
              )}
            />}
            {dqt.length >= 2 && !digits && !showParse && list.length > 0 && <Text style={s.hint}>Tap = add (your usual serving) · long-press = choose the amount</Text>}
          </>
        )}
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Portion panel ────────────────────────────────────────────────────────────────────────────────
function PortionPanel({ item, initial, isFav, onFav, onCancel, onConfirm, onDelete, confirmLabel = 'Log', forChip }: {
  item: FoodItem | OffProduct; initial?: number; isFav: boolean; onFav: () => void; onCancel: () => void;
  onConfirm: (g: number) => void; onDelete?: () => void; confirmLabel?: string; forChip?: string;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [def, setDef] = useState(() => defaultServing(item));   // your own serving size if set, else label/table
  const u = item.unit === 'ml' ? 'ml' : 'g';
  // A food with a real serving / piece / pack ("1 bottle = 240 ml", or the size YOU set) can be entered in SERVINGS
  // (¼ · ½ · 1 · 1½ …) as well as in grams. A bare "100 g" fallback is no serving.
  const own = !!servingOverrides[item.key];
  // OFF's bare "1 serving = 100 g" (also on products cached before that was filtered) is the per-100 echo, not a
  // real size → no serving; ask for the pack size instead (a 240 g yoghurt-drink bottle).
  const echo = !own && item.src === 'off' && def.label === '1 serving' && isEcho100(def.g);
  const drink = item.unit === 'ml' || DRINK_NAME.test(`${item.name} ${item.nameAlt ?? ''}`);
  const piece = !echo && def.g > 0 && (own || /^1\s+\S/.test(def.label)) ? def : null;
  const pieceName = piece ? piece.label.replace(/^1\s+/, '') || 'serving' : '';
  const askName = pieceName || (drink ? 'bottle' : 'serving');   // what the size editor calls one portion
  const unknownSize = item.src === 'off' && !piece;             // OFF product with no usable pack/serving size
  const quarterOf = (gr: number) => !!piece && Math.abs(gr / piece.g * 4 - Math.round(gr / piece.g * 4)) < 0.02;
  const [bySrv, setBySrv] = useState(() => !!piece && (initial == null || quarterOf(initial)));
  const fmtS = (v: number) => String(Math.round(v * 100) / 100);
  const [txt, setTxt] = useState(() => (bySrv && piece ? fmtS((initial ?? piece.g) / piece.g) : String(r0(initial ?? (echo ? 100 : def.g)))));
  const [fav, setFav] = useState(isFav);
  // the "1 serving = … g" editor (text) while open — OPEN from the start (empty) when OFF doesn't know the size
  const [editSrv, setEditSrv] = useState<string | null>(() => (unknownSize && initial == null ? '' : null));
  const qty = parseFloat(txt.replace(',', '.'));
  const g = bySrv && piece ? qty * piece.g : qty;
  const valid = isFinite(g) && g > 0 && g < 5000;
  const raw = valid ? scaleNutr(withRs(item.key, item.per100), g) : {};
  const n = netNutr(raw);   // resistant starch out of the carbs / energy
  const switchUnit = (toSrv: boolean) => {
    if (!piece || toSrv === bySrv) return;
    if (isFinite(g) && g > 0) setTxt(toSrv ? fmtS(g / piece.g) : String(r0(g)));
    setBySrv(toSrv);
  };
  const saveSrv = async () => {
    const v = parseFloat((editSrv ?? '').replace(',', '.'));
    if (!(isFinite(v) && v > 0 && v < 5000)) return;
    const sv = { g: Math.round(v * 10) / 10, label: `1 ${askName}` };
    Keyboard.dismiss();
    try { await setServing(item.key, sv); } catch { Alert.alert('Not saved', 'Could not save the serving size — try again.'); return; }
    setDef(sv); setEditSrv(null);
    if (bySrv) setTxt('1'); else { setTxt(fmtS(1)); setBySrv(true); }
  };
  const resetSrv = async () => {
    Keyboard.dismiss();
    try { await setServing(item.key, null); } catch { Alert.alert('Not saved', 'Could not reset the serving size — try again.'); return; }
    const d = defaultServing(item);
    setDef(d); setEditSrv(null);
    const p2 = d.g > 0 && /^1\s+\S/.test(d.label) && !(item.src === 'off' && d.label === '1 serving' && isEcho100(d.g));
    if (!p2) { setBySrv(false); setTxt(String(r0(d.g))); } else if (bySrv) setTxt('1');
  };
  const chipsRaw: { v: number; label: string }[] = bySrv && piece
    ? [0.25, 0.5, 0.75, 1, 1.5, 2].map(k => ({ v: k * piece.g, label: `${({ 0.25: '¼', 0.5: '½', 0.75: '¾', 1.5: '1½' } as Record<number, string>)[k] ?? k} · ${r0(k * piece.g)} ${u}` }))
    : piece
    ? [
        { v: piece.g, label: `1 ${pieceName} · ${r0(piece.g)} ${u}` },
        { v: piece.g / 2, label: `½ · ${r0(piece.g / 2)} ${u}` },
        { v: piece.g * 2, label: `2 · ${r0(piece.g * 2)} ${u}` },
        ...(initial && ![piece.g, piece.g / 2, piece.g * 2].some(x => r0(x) === r0(initial)) ? [{ v: initial, label: `${r0(initial)} ${u}` }] : []),
        { v: 100, label: `100 ${u}` },
      ]
    : [...new Set([def.g, ...(initial ? [initial] : []), Math.round(def.g / 2), def.g * 2, 50, 100, 150, 200].map(r0))].filter(x => x > 0).slice(0, 7).map(v => ({ v, label: `${v} ${u}` }));
  // one chip per amount (a 100 ml piece must not also get the fixed "100 ml" chip → duplicate key + double highlight)
  const same = (a: number, b: number) => (bySrv && piece ? Math.abs(a - b) < piece.g * 0.01 : r0(a) === r0(b));   // tiny servings: compare by count
  const chips = chipsRaw.filter((ch, i) => chipsRaw.findIndex(o => same(o.v, ch.v)) === i);
  const setChip = (v: number) => setTxt(bySrv && piece ? fmtS(v / piece.g) : String(r0(v)));
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
      {item.src === 'builtin' && <Text style={s.hint}>Typical label values (estimate) — {sportsByKey(item.key)?.note ?? ''} For exact values, use 🏷️ Label with your product.</Text>}
      {forChip && <Text style={s.warn}>For "{forChip}" from your typed meal — Cancel if this is something else.</Text>}
      {off?.rcn8 && <Text style={s.warn}>Store codes starting with 2 are reused across countries — check this is really your product.</Text>}
      {off?.incomplete && <Text style={s.warn}>Open Food Facts is missing some values for this product — check them against the pack, or enter the label.</Text>}
      {off?.implausible && <Text style={s.warn}>These values don't add up (energy vs carbs/protein/fat) — probably mis-entered on Open Food Facts. Check the pack, or enter the label.</Text>}
      <Text style={[s.resultSub, { marginTop: 4 }]}>Per 100 {u}{off ? ' (or 100 mL)' : ''}: {r0(item.per100.kcal)} kcal · {macroLine(item.per100)}</Text>

      {piece && (
        <View style={[s.tabs, { marginTop: 10 }]}>
          {([false, true] as const).map(v => (
            <TouchableOpacity key={String(v)} onPress={() => switchUnit(v)} style={[s.tab, { flex: 1, alignItems: 'center' }, bySrv === v && s.tabOn]}>
              <Text style={[s.tabTxt, bySrv === v && s.tabTxtOn]}>{v ? `Servings (${pieceName})` : u === 'ml' ? 'Millilitres' : 'Grams'}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={s.gramsRow}>
        <TextInput style={s.gramsInput} value={txt} onChangeText={setTxt} keyboardType="decimal-pad" selectTextOnFocus />
        <Text style={s.gramsUnit}>{bySrv && piece ? (isFinite(qty) && qty === 1 ? pieceName : `× ${pieceName}`) : u}</Text>
        <Text style={s.gramsHint}>{bySrv && piece ? (valid ? `= ${r0(g)} ${u}` : '') : piece ? `1 ${pieceName} = ${r0(piece.g)} ${u}` : def.label !== '100 g' && !echo ? `${def.label} ≈ ${def.g} g` : ''}</Text>
      </View>
      {editSrv == null ? (
        <TouchableOpacity onPress={() => setEditSrv(piece ? String(r0(piece.g)) : '')} hitSlop={6}>
          <Text style={[s.hint, { color: c.accent }]}>{piece ? `✎ 1 ${pieceName} = ${r0(piece.g)} ${u}${own ? ' (yours)' : ''} — change` : `✎ Set the ${askName} size for this food`}</Text>
        </TouchableOpacity>
      ) : (
        <>
        {unknownSize && <Text style={s.warn}>Open Food Facts doesn't know the {askName} size of this product. Enter it once (it's on the label) and it's remembered — then you log it as 1 {askName}, ½, 2 …</Text>}
        <View style={[s.gramsRow, { marginTop: 4 }]}>
          <Text style={s.gramsHint}>1 {askName} =</Text>
          <TextInput style={[s.gramsInput, { minWidth: 70 }]} value={editSrv} onChangeText={setEditSrv} keyboardType="decimal-pad" selectTextOnFocus autoFocus={!unknownSize} placeholder="240" />
          <Text style={s.gramsUnit}>{u}</Text>
          <TouchableOpacity onPress={saveSrv} hitSlop={6}><Text style={[s.chipTxt, { color: c.accent, fontWeight: '700' }]}>Save</Text></TouchableOpacity>
          {own && <TouchableOpacity onPress={resetSrv} hitSlop={6}><Text style={[s.chipTxt, { marginLeft: 10 }]}>Reset</Text></TouchableOpacity>}
          <TouchableOpacity onPress={() => { Keyboard.dismiss(); setEditSrv(null); }} hitSlop={6}><Text style={[s.chipTxt, { marginLeft: 10 }]}>✕</Text></TouchableOpacity>
        </View>
        </>
      )}
      <View style={s.chips}>
        {chips.map(ch => (
          <TouchableOpacity key={ch.label} style={[s.chip, same(g, ch.v) && s.chipOn]} onPress={() => setChip(ch.v)}>
            <Text style={[s.chipTxt, same(g, ch.v) && { color: c.onAccent }]}>{ch.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {valid && (
        <View style={s.preview}>
          <Text style={s.previewKcal}>{r0(n.kcal)} kcal</Text>
          <Text style={s.previewSub}>Carbs {r1(n.carb)} g{raw.rs ? ` (+ ${r1(raw.rs)} g resistant starch, not counted)` : ''} · Protein {r1(n.prot)} g · Fat {r1(n.fat)} g · Fibre {r1(n.fib)} g · Sodium {r0(n.na)} mg</Text>
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

// ─── Typed meal → inline preview ──────────────────────────────────────────────────────────────────
function ParsePanel({ items: items0, onConfirm, onAsOne }: {
  items: ParsedItem[]; onConfirm: (items: ParsedItem[], missing: ParsedItem[], saveAs?: string) => void; onAsOne: () => void;
}) {
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
  const missing = items.filter(x => !x.food);
  const kcal = final.reduce((a, x) => a + (scaleNutr(x.food!.per100, x.grams).kcal ?? 0), 0);
  return (
    <View style={s.parseBox}>
      <Text style={s.parseHead}>Recognised {items.filter(x => x.food).length} of {items.length} — check the amounts</Text>
      <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" nestedScrollEnabled>
        {items.map((it, i) => it.food ? (
          <View key={i} style={[s.parseRow, !it.on && { opacity: 0.45 }]}>
            <TouchableOpacity onPress={() => upd(i, { on: !it.on })} hitSlop={8}><Text style={s.check}>{it.on ? '☑' : '☐'}</Text></TouchableOpacity>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => cycle(i)}>
              <Text style={s.resultTitle} numberOfLines={2}>{it.food.name}{!it.sure ? '  ?' : ''}</Text>
              <Text style={s.resultSub} numberOfLines={1}>"{it.text}"{it.alternatives.length ? '  · tap = other match' : ''}</Text>
            </TouchableOpacity>
            <TextInput style={[s.parseGrams, (!okG(gOf(it.gTxt)) || gOf(it.gTxt) > MAX_ITEM_GRAMS) && it.on && { borderColor: '#d97706' }]} value={it.gTxt} onChangeText={v => upd(i, { gTxt: v })} keyboardType="decimal-pad" selectTextOnFocus />
            <Text style={s.gramsUnitSm}>g</Text>
          </View>
        ) : (
          <View key={i} style={s.parseRow}>
            <Text style={[s.check, { color: '#d97706' }]}>?</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.resultTitle, { color: '#d97706' }]} numberOfLines={1}>No match for "{it.query}"</Text>
              <Text style={s.resultSub}>Kept — you'll search it right after adding the rest</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <TouchableOpacity style={[s.btn, { flex: 0, marginTop: 10 }, ((!final.length && !missing.length) || bad) && { opacity: 0.4 }]} disabled={(!final.length && !missing.length) || bad}
        onPress={() => { Keyboard.dismiss(); onConfirm(final, missing); }}>
        <Text style={s.btnTxt}>{bad ? 'Check the amounts'
          : final.length ? `Add ${final.length} item${final.length === 1 ? '' : 's'} · ${r0(kcal)} kcal${missing.length ? ` — then find ${missing.length} more` : ''}`
          : `Search the ${missing.length} part${missing.length === 1 ? '' : 's'} one by one`}</Text>
      </TouchableOpacity>
      {final.length >= 2 && !bad && (
        // a dictated / typed meal of many components → log it AND keep it as a saved meal to re-use
        <TouchableOpacity hitSlop={8} onPress={() => { Keyboard.dismiss();
          Alert.prompt('Save as a meal', 'Name it to re-use it later (Meals tab):', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Add + save', onPress: (name?: string) => onConfirm(final, missing, (name ?? '').trim() || 'My meal') },
          ], 'plain-text', '');
        }}>
          <Text style={[s.asOne, { fontWeight: '700' }]}>＋ Add and save as a meal…</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={() => { Keyboard.dismiss(); onAsOne(); }} hitSlop={8}>
        <Text style={s.asOne}>It's one dish — search the whole text as one food</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Saved meal → preview (untick / re-weigh / add by voice) ─────────────────────────────────────
function MealPanel({ meal, onCancel, onConfirm, onSaveItems }: {
  meal: SavedMeal; onCancel: () => void; onConfirm: (items: SavedMealItem[]) => void; onSaveItems: (items: SavedMealItem[]) => void;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [rows, setRows] = useState(meal.items.map(it => ({ it, on: true, gTxt: it.grams != null ? String(r0(it.grams)) : '' })));
  const [dirty, setDirty] = useState(false);   // components added / removed / re-weighed vs the saved meal
  const upd = (i: number, p: Partial<typeof rows[number]>) => { setRows(prev => prev.map((x, j) => (j === i ? { ...x, ...p } : x))); setDirty(true); };
  const gOf = (t: string) => parseFloat(t.replace(',', '.'));
  // 🎤 add components by voice → parsed against the food table; unmatched parts are reported
  const dict = useDictation(text => {
    const parsed = parseMeal(cleanDictation(text));
    const add = parsed.filter(p => p.food).map(p => ({ it: { key: p.food!.key, name: p.food!.name, src: p.food!.src, grams: p.grams, per100: p.food!.per100, ...(p.food!.unit === 'ml' ? { unit: 'ml' as const } : {}) } as SavedMealItem, on: true, gTxt: String(r0(p.grams)) }));
    if (add.length) { setRows(prev => [...prev, ...add]); setDirty(true); }
    const miss = parsed.filter(p => !p.food).map(p => p.query);
    if (miss.length) Alert.alert('Not found', `No match for: ${miss.join(', ')} — add those from the search after logging.`);
  });
  const final: SavedMealItem[] = rows.filter(r => r.on).map(r => (r.it.per100 && r.gTxt && gOf(r.gTxt) > 0 ? { ...r.it, grams: gOf(r.gTxt) } : r.it));
  const kcal = final.reduce((a, it) => a + ((it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams).kcal : it.n?.kcal) ?? 0), 0);
  return (
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={s.portionName}>🍽️ {meal.name}</Text>
      <Text style={s.hint}>Untick what you don't have or eat later, adjust grams, or 🎤 add components — then add it to {mealLabel(timeForDay(todayFoodDay())).toLowerCase()}.</Text>
      {rows.map((r, i) => (
        <SwipeRow key={`${r.it.key}-${i}`} onDelete={() => { setRows(prev => prev.filter((_, j) => j !== i)); setDirty(true); }} label="Remove">
        <View style={[s.parseRow, { backgroundColor: c.bg }, !r.on && { opacity: 0.45 }]}>
          <TouchableOpacity onPress={() => upd(i, { on: !r.on })} hitSlop={8}><Text style={s.check}>{r.on ? '☑' : '☐'}</Text></TouchableOpacity>
          <Text style={[s.resultTitle, { flex: 1 }]} numberOfLines={2}>{r.it.name}</Text>
          {r.it.per100 ? (
            <>
              <TextInput style={s.parseGrams} value={r.gTxt} onChangeText={v => upd(i, { gTxt: v })} keyboardType="decimal-pad" selectTextOnFocus />
              <Text style={s.gramsUnitSm}>{r.it.unit === 'ml' ? 'ml' : 'g'}</Text>
            </>
          ) : <Text style={s.resultSub}>{r0(r.it.n?.kcal)} kcal</Text>}
        </View>
        </SwipeRow>
      ))}
      <TouchableOpacity style={[s.action, { alignSelf: 'flex-start', marginTop: 8 }, dict.state === 'recording' && { backgroundColor: '#ef4444', borderColor: '#ef4444' }]} onPress={() => { Keyboard.dismiss(); dict.toggle(); }}>
        <Text style={[s.actionTxt, dict.state === 'recording' && { color: '#fff' }]}>{dict.state === 'recording' ? '⏹ Stop — add these' : dict.state === 'transcribing' ? 'Transcribing…' : '🎤 Add components by voice'}</Text>
      </TouchableOpacity>
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, !final.length && { opacity: 0.4 }]} disabled={!final.length} onPress={() => { Keyboard.dismiss(); onConfirm(final); }}>
          <Text style={s.btnTxt}>Add {final.length} · {r0(kcal)} kcal</Text>
        </TouchableOpacity>
      </View>
      {dirty && final.length > 0 && (
        <TouchableOpacity onPress={() => { Keyboard.dismiss(); onSaveItems(final); setDirty(false); Alert.alert('Saved', `"${meal.name}" now has ${final.length} component${final.length === 1 ? '' : 's'}.`); }} hitSlop={8}>
          <Text style={[s.asOne, { fontWeight: '700' }]}>💾 Save these changes to "{meal.name}"</Text>
        </TouchableOpacity>
      )}
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
/** "Total amount" ⇄ "Per 100 g / ml" — the two ways to add your own food, switchable in place. */
function OwnSwitch({ mode, onChange }: { mode: 'total' | 'per100'; onChange: (m: 'total' | 'per100') => void }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.tabs}>
      {(['total', 'per100'] as const).map(m => (
        <TouchableOpacity key={m} onPress={() => { if (m !== mode) { Keyboard.dismiss(); onChange(m); } }} style={[s.tab, { flex: 1, alignItems: 'center' }, mode === m && s.tabOn]}>
          <Text style={[s.tabTxt, mode === m && s.tabTxtOn]}>{m === 'total' ? 'Total amount' : 'Per 100 g / ml'}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function LabelPanel({ ean, name: name0, onCancel, onSave, onTotals }: {
  ean?: string; name?: string; onCancel: () => void; onTotals: (name: string) => void;
  onSave: (f: { name: string; brand?: string; ean?: string; per100: Nutr; unit: 'g' | 'ml'; serving?: { g: number; label: string } }) => void;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [name, setName] = useState(name0 ?? '');
  const [brand, setBrand] = useState('');
  const [unit, setUnit] = useState<'g' | 'ml'>('g');
  const [pieceTxt, setPieceTxt] = useState('');
  const [pieceName, setPieceName] = useState('');
  const pieceAmt = parseFloat(pieceTxt.replace(',', '.'));
  const serving = isFinite(pieceAmt) && pieceAmt > 0 && pieceAmt < 5000
    ? { g: pieceAmt, label: `1 ${pieceName.trim() || (unit === 'ml' ? 'bottle' : 'piece')}` } : undefined;
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
      <Text style={s.portionName}>Add your own</Text>
      <OwnSwitch mode="per100" onChange={() => onTotals(name)} />
      <Text style={s.hint}>Values as printed on the pack. Saved as your own food{ean ? ` for barcode ${ean}` : ''} — next time it's one tap. It stays on this phone.</Text>
      <Text style={s.fieldLab}>Name</Text>
      <TextInput style={s.field} value={name} onChangeText={setName} placeholder="e.g. Boni high protein drink" placeholderTextColor={c.textFaint} />
      <Text style={s.fieldLab}>The label gives values per</Text>
      <View style={s.tabs}>
        {(['g', 'ml'] as const).map(x => (
          <TouchableOpacity key={x} onPress={() => setUnit(x)} style={[s.tab, unit === x && s.tabOn]}>
            <Text style={[s.tabTxt, unit === x && s.tabTxtOn]}>100 {x}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={s.fieldLab}>One piece / pack is (optional — then you log "1 bottle" instead of typing {unit})</Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput style={[s.field, { width: 100 }]} value={pieceTxt} onChangeText={setPieceTxt} keyboardType="decimal-pad" placeholder={unit === 'ml' ? '330' : '250'} placeholderTextColor={c.textFaint} />
        <Text style={s.gramsUnitSm}>{unit}</Text>
        <TextInput style={[s.field, { flex: 1 }]} value={pieceName} onChangeText={setPieceName} placeholder={unit === 'ml' ? 'bottle / can / glass' : 'piece / bar / pot'} placeholderTextColor={c.textFaint} autoCapitalize="none" />
      </View>
      <Text style={s.fieldLab}>Brand (optional)</Text>
      <TextInput style={s.field} value={brand} onChangeText={setBrand} placeholderTextColor={c.textFaint} />
      <Text style={[s.fieldLab, { marginTop: 14 }]}>Per 100 {unit}:</Text>
      {FIELDS.map(f => (
        <View key={f.k} style={s.labelRow}>
          <Text style={[s.fieldLab, { flex: 1, marginTop: 0 }]}>{f.lab}</Text>
          <TextInput style={[s.field, { width: 110 }]} value={v[f.k] ?? ''} onChangeText={x => setV(p => ({ ...p, [f.k]: x }))} keyboardType="decimal-pad" placeholder="–" placeholderTextColor={c.textFaint} />
        </View>
      ))}
      <View style={s.btnRow}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => { Keyboard.dismiss(); onCancel(); }}><Text style={s.btnGhostTxt}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={[s.btn, !valid && { opacity: 0.4 }]} disabled={!valid} onPress={() => { Keyboard.dismiss(); onSave({ name, brand: brand.trim() || undefined, ean, per100, unit, serving }); }}>
          <Text style={s.btnTxt}>Save & choose amount</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─── Quick add ────────────────────────────────────────────────────────────────────────────────────
function QuickPanel({ name0, onCancel, onConfirm, onPer100 }: { name0?: string; onCancel: () => void; onConfirm: (label: string, n: Nutr) => void; onPer100: (name: string) => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [label, setLabel] = useState(name0 ?? '');
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
      <Text style={s.portionName}>Add your own</Text>
      <OwnSwitch mode="total" onChange={() => onPer100(label)} />
      <Text style={s.hint}>Type the totals for what you ate. Only have "per 100 g / ml" on the pack? Switch above — you can also set "1 bottle = 330 ml".</Text>
      <Text style={s.fieldLab}>Name (optional — repeats show up in Recents)</Text>
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
function EditSheet({ entry, date, isFav, own, onClose }: { entry: FoodEntry; date: string; isFav: boolean; own?: FoodItem; onClose: () => void }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  // per-100 from the table when we have it (exact), else back-computed from the entry
  const tableItem = foodByKey(entry.key);
  const per100: Nutr = tableItem?.per100
    ?? (entry.grams && entry.grams > 0 ? Object.fromEntries(Object.entries(entry.n).map(([k, v]) => [k, (v as number) * 100 / entry.grams!])) as Nutr : entry.n);
  const item: FoodItem = tableItem ?? { key: entry.key, src: entry.src, id: idOf(entry.key), name: entry.name, per100, ...(entry.unit ? { unit: entry.unit } : {}), ...(own?.serving ? { serving: own.serving } : {}) };
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
  dbLink:    { marginHorizontal: 16, marginTop: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  dbLinkTxt: { color: c.accent, fontWeight: '700', fontSize: 14 },
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
  testBtn:   { marginTop: 22, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, alignItems: 'center' },
  testTxt:   { color: c.textSub, fontSize: 13, fontWeight: '600' },
  credit:    { color: c.textFaint, fontSize: 11, lineHeight: 15, marginTop: 24, textAlign: 'center' },
  creditSmall: { color: c.textFaint, fontSize: 11, lineHeight: 15, marginTop: 14 },
  toast:     { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.text, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
  toastTxt:  { color: c.bg, fontSize: 14, fontWeight: '600', flex: 1 },
  toastBtn:  { color: c.accent, fontSize: 15, fontWeight: '800' },
  // left: the Modes button sits bottom-RIGHT on every mode screen
  fab:       { position: 'absolute', left: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
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
  scanBtn:   { paddingHorizontal: 14, borderRadius: 12, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  scanIcon:  { color: c.onAccent, fontSize: 20, fontWeight: '800', lineHeight: 22 },
  scanTxt:   { color: c.onAccent, fontSize: 12, fontWeight: '800' },
  prodHead:  { color: c.textSub, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', paddingTop: 14, paddingBottom: 4 },
  onlineBtn: { paddingVertical: 14 },
  onlineTxt: { color: c.accent, fontSize: 14.5, fontWeight: '700' },
  basket:    { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: '#16a34a', padding: 10, marginBottom: 10 },
  basketHead:{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  basketTitle: { color: c.text, fontSize: 14, fontWeight: '800', flex: 1 },
  basketRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  basketName:{ color: c.text, fontSize: 13.5 },
  basketMeta:{ color: c.textSub, fontSize: 12.5, fontVariant: ['tabular-nums'] },
  basketX:   { color: c.textFaint, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  parseBox:  { marginTop: 10, backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.accent, padding: 10, flexShrink: 1 },
  asOne:     { color: c.accent, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 10 },
  pendingBox:{ marginTop: 10, padding: 10, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: '#d97706' },
  pendingHead: { color: '#d97706', fontSize: 13, fontWeight: '800', marginBottom: 6 },
  pendingChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
  pendingTxt:  { color: c.text, fontSize: 13.5, fontWeight: '600' },
  parseHead: { color: c.text, fontSize: 14, fontWeight: '800', marginBottom: 2 },
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
