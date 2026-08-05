import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, SafeAreaView, Alert, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Stack, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  loadEvents, deleteEvent, addLifeEvent, saveEvent, STATUS_LABEL, EVENT_CATEGORIES,
} from '../src/services/timelineEvents';
import {
  loadSupplements, addSupplement, removeSupplement, toggleSupplementToday, takenToday, adherence, todayISO, SupplementData,
  setDose, getDose, lastDose,
} from '../src/services/supplements';
import { TimelineEvent } from '../src/types';

const p2 = (n: number) => String(n).padStart(2, '0');
const toISO = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fmt = (iso?: string) => { if (!iso) return ''; try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };

const STATUS_ICON: Record<string, string> = { running: '🏃', injured: '🩹', sick: '🤒', holiday: '🌴' };
const CAT_ICON: Record<string, string> = { medical: '🏥', holiday: '🌴', travel: '✈️', life: '📌', other: '•' };

export default function TimelineScreen() {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(new Date());
  const [end, setEnd] = useState<Date | null>(null);
  const [cat, setCat] = useState<string>('life');
  const [picker, setPicker] = useState<null | 'start' | 'end'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [supps, setSupps] = useState<SupplementData>({ list: [], log: {} });

  const refresh = useCallback(() => { loadEvents().then(setEvents); loadSupplements().then(setSupps); }, []);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const DOSED_SUPP = /yohimb/i;   // supplements we prompt a mg dose for (HR-correction is dose-dependent)

  const toggleSupp = async (n: string) => {
    // Dosed stimulant (yohimbine) → capture the mg on log so the run-analysis HR-correction is
    // dose-dependent (5–20 mg all correct differently). A cup of coffee is assumed alongside it.
    if (!takenToday(supps, n) && DOSED_SUPP.test(n)) {
      Alert.prompt(
        `${n} dose`,
        'mg taken today (a cup of coffee is assumed with it)',
        async (val?: string) => {
          const mg = Math.max(0, Math.min(50, parseFloat((val ?? '').replace(',', '.')) || lastDose(supps, n)));
          await setDose(n, todayISO(), mg);
          await toggleSupplementToday(n);
          loadSupplements().then(setSupps);
        },
        'plain-text', String(Math.round(lastDose(supps, n))), 'number-pad',
      );
      return;
    }
    // Optimistic → instant feedback; persist in the background.
    setSupps(prev => {
      const t = todayISO(); const dates = new Set(prev.log[n] ?? []);
      dates.has(t) ? dates.delete(t) : dates.add(t);
      return { ...prev, log: { ...prev.log, [n]: [...dates] } };
    });
    await toggleSupplementToday(n);
  };
  const addSupp = () => {
    Alert.prompt('Add supplement', 'Name, e.g. Creatine, Vitamin D, Omega-3', async (name?: string) => {
      if (name?.trim()) { await addSupplement(name); loadSupplements().then(setSupps); }
    });
  };
  const removeSupp = (n: string) => {
    Alert.alert('Remove supplement', `Remove "${n}" and its log?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { await removeSupplement(n); loadSupplements().then(setSupps); } },
    ]);
  };

  const resetForm = () => { setTitle(''); setEnd(null); setCat('life'); setStart(new Date()); setPicker(null); setEditingId(null); };
  const startEdit = (ev: TimelineEvent) => {
    setEditingId(ev.id);
    setTitle(ev.title ?? '');
    setStart(new Date(ev.date + 'T00:00:00'));
    setEnd(ev.endDate ? new Date(ev.endDate + 'T00:00:00') : null);
    setCat(ev.category ?? 'life');
    setPicker(null);
  };

  const submit = async () => {
    if (!title.trim()) { Alert.alert('Add a title', 'Give the event a short name first.'); return; }
    if (end && toISO(end) < toISO(start)) { Alert.alert('Check the dates', 'The end date is before the start date.'); return; }
    if (editingId) {
      await saveEvent({ id: editingId, date: toISO(start), type: 'event', title: title.trim(), endDate: end ? toISO(end) : undefined, category: cat });
    } else {
      await addLifeEvent({ title, date: toISO(start), endDate: end ? toISO(end) : undefined, category: cat });
    }
    resetForm();
    refresh();
  };

  const remove = (ev: TimelineEvent) => {
    Alert.alert('Delete event', `Remove "${ev.title ?? (ev.status ? STATUS_LABEL[ev.status] : 'event')}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteEvent(ev.id); refresh(); } },
    ]);
  };

  return (
    <SafeAreaView style={s.container}>
      <Stack.Screen options={{ title: 'Timeline' }} />
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={s.scroll} contentInsetAdjustmentBehavior="never">

        {/* Supplements — one-tap daily logging */}
        <Text style={s.sectionTitle}>Supplements</Text>
        <View style={s.card}>
          <View style={s.suppRow}>
            {supps.list.map(n => {
              const on = takenToday(supps, n);
              const dose = on && DOSED_SUPP.test(n) ? getDose(supps, n, todayISO()) : 0;
              return (
                <TouchableOpacity key={n} style={[s.suppChip, on && s.suppChipOn]} activeOpacity={0.7}
                  onPress={() => toggleSupp(n)} onLongPress={() => removeSupp(n)} delayLongPress={400}>
                  <Text style={[s.suppText, on && s.suppTextOn]}>{on ? '✓ ' : ''}{n}{dose > 0 ? ` ${dose}mg` : ''}</Text>
                  <Text style={[s.suppAdh, on && s.suppTextOn]}>{adherence(supps, n, 7)}/7</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={s.suppAdd} onPress={addSupp}><Text style={s.suppAddText}>＋ Add</Text></TouchableOpacity>
          </View>
          {supps.list.length > 0 && <Text style={s.suppHint}>Tap to log today · long-press to remove</Text>}
          {supps.list.length === 0 && <Text style={s.suppHint}>Add your supplements — then one tap a day logs them.</Text>}
        </View>

        {/* Add / edit event */}
        <Text style={s.sectionTitle}>{editingId ? 'Edit event' : 'Add an event'}</Text>
        <View style={s.card}>
          <TextInput
            style={s.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Hair transplant in Turkey"
            placeholderTextColor={c.textFaint}
            returnKeyType="done"
          />
          <View style={s.dateRow}>
            <TouchableOpacity style={s.dateBtn} onPress={() => setPicker('start')}>
              <Text style={s.dateLbl}>Start</Text><Text style={s.dateVal}>{fmt(toISO(start))}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dateBtn} onPress={() => (end ? setEnd(null) : setPicker('end'))}>
              <Text style={s.dateLbl}>End {end ? '' : '(optional)'}</Text>
              <Text style={s.dateVal}>{end ? fmt(toISO(end)) : '— tap to add'}</Text>
            </TouchableOpacity>
          </View>
          {picker && (
            <DateTimePicker
              value={picker === 'start' ? start : (end ?? start)}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onChange={(_e, d) => {
                if (Platform.OS !== 'ios') setPicker(null);
                if (d) { picker === 'start' ? setStart(d) : setEnd(d); }
              }}
            />
          )}
          {picker === 'start' && Platform.OS === 'ios' && (
            <TouchableOpacity onPress={() => setPicker(null)}><Text style={s.pickerDone}>Done</Text></TouchableOpacity>
          )}
          {picker === 'end' && Platform.OS === 'ios' && (
            <TouchableOpacity onPress={() => setPicker(null)}><Text style={s.pickerDone}>Done</Text></TouchableOpacity>
          )}
          <View style={s.catRow}>
            {EVENT_CATEGORIES.map(k => (
              <TouchableOpacity key={k} style={[s.chip, cat === k && s.chipActive]} onPress={() => setCat(k)}>
                <Text style={[s.chipText, cat === k && s.chipTextActive]}>{CAT_ICON[k] ?? '•'} {k}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {editingId && (
              <TouchableOpacity style={[s.addBtn, s.cancelBtn]} onPress={resetForm}>
                <Text style={[s.addBtnText, { color: c.textSub }]}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[s.addBtn, { flex: 1 }]} onPress={submit}>
              <Text style={s.addBtnText}>{editingId ? 'Save changes' : '+ Add event'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* History */}
        <Text style={s.sectionTitle}>History</Text>
        {events.length === 0 ? (
          <Text style={s.empty}>No events yet. Add life events above, or set your status on the home screen — status changes are logged here.</Text>
        ) : (
          <View style={s.card}>
            {events.map((ev, i) => {
              const isStatus = ev.type === 'status';
              const icon = isStatus ? (STATUS_ICON[ev.status ?? 'running'] ?? '•') : (CAT_ICON[ev.category ?? ''] ?? '📌');
              const name = isStatus
                ? `Status: ${ev.status ? STATUS_LABEL[ev.status] : 'Active'}`
                : (ev.title ?? ev.note ?? 'Event');
              const range = ev.endDate && ev.endDate !== ev.date ? `${fmt(ev.date)} – ${fmt(ev.endDate)}` : fmt(ev.date);
              return (
                <View key={ev.id} style={[s.evRow, i > 0 && s.evBorder, editingId === ev.id && s.evEditing]}>
                  <Text style={s.evIcon}>{icon}</Text>
                  <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.6} disabled={!isStatus ? false : true} onPress={() => !isStatus && startEdit(ev)}>
                    <Text style={s.evName}>{name}{!isStatus ? '  ✎' : ''}</Text>
                    <Text style={s.evMeta}>{range}{ev.category && !isStatus ? ` · ${ev.category}` : ''}{ev.note ? ` · ${ev.note}` : ''}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => remove(ev)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={s.del}>✕</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 14, paddingBottom: 40 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', marginTop: 8, marginBottom: 6, marginLeft: 4 },
  card: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.border },
  input: { backgroundColor: c.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.text, marginBottom: 10 },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateBtn: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 10 },
  dateLbl: { fontSize: 11, color: c.textFaint, fontWeight: '600' },
  dateVal: { fontSize: 14, color: c.text, marginTop: 2 },
  pickerDone: { color: c.accent, fontWeight: '700', textAlign: 'right', paddingVertical: 6 },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  chipActive: { backgroundColor: c.accent, borderColor: c.accent },
  chipText: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  chipTextActive: { color: c.onAccent },
  addBtn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 12 },
  cancelBtn: { backgroundColor: c.surfaceAlt, paddingHorizontal: 20 },
  addBtnText: { color: c.onAccent, fontWeight: '700', fontSize: 15 },
  evEditing: { backgroundColor: c.surfaceAlt, borderRadius: 8, marginTop: 2 },
  empty: { color: c.textFaint, fontSize: 14, lineHeight: 20, paddingHorizontal: 6, marginBottom: 8 },
  evRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  evBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  evIcon: { fontSize: 20, width: 26, textAlign: 'center' },
  evName: { fontSize: 15, color: c.text, fontWeight: '600' },
  evMeta: { fontSize: 12, color: c.textSub, marginTop: 1 },
  del: { fontSize: 16, color: c.textFaint, paddingHorizontal: 4 },
  suppRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suppChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  suppChipOn: { backgroundColor: c.accent, borderColor: c.accent },
  suppText: { fontSize: 14, fontWeight: '600', color: c.text },
  suppTextOn: { color: c.onAccent },
  suppAdh: { fontSize: 11, fontWeight: '700', color: c.textFaint },
  suppAdd: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 18, borderWidth: 1, borderColor: c.accent, borderStyle: 'dashed' },
  suppAddText: { fontSize: 14, fontWeight: '700', color: c.accent },
  suppHint: { fontSize: 11, color: c.textFaint, marginTop: 10 },
});
