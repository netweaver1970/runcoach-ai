import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { TimelineEvent, HealthStatus, AthleteStatus } from '../types';

const FILE = `${FileSystem.documentDirectory}runcoach-timeline.json`;
const STATUS_KEY = 'athlete_status_v1';

// Friendly labels — the HealthStatus values stay stable for storage/history; the UI + LLM use these.
export const STATUS_LABEL: Record<HealthStatus, string> = {
  running: 'Active', sick: 'Sick', injured: 'Injured', holiday: 'On a break',
};
export const STATUS_ORDER: HealthStatus[] = ['running', 'sick', 'injured', 'holiday'];
export const EVENT_CATEGORIES = ['medical', 'holiday', 'travel', 'life', 'other'] as const;

const p2 = (n: number) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const newEventId = () => `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const fmtDate = (iso: string) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };

async function read(): Promise<TimelineEvent[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(FILE);
    return JSON.parse(raw) as TimelineEvent[];
  } catch { return []; }
}

async function write(events: TimelineEvent[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(events));
  } catch {}
}

export async function loadEvents(): Promise<TimelineEvent[]> {
  const evs = await read();
  return evs.sort((a, b) => b.date.localeCompare(a.date)); // newest first
}

export async function saveEvent(ev: TimelineEvent): Promise<void> {
  const evs = await read();
  const idx = evs.findIndex(e => e.id === ev.id);
  if (idx >= 0) evs[idx] = ev;
  else evs.push(ev);
  await write(evs);
}

export async function deleteEvent(id: string): Promise<void> {
  const evs = await read();
  await write(evs.filter(e => e.id !== id));
}

export async function clearAllEvents(): Promise<void> {
  await write([]);
}

// ─── Life events (medical / holiday / travel …) ────────────────────────────────
export async function addLifeEvent(e: { title: string; date: string; endDate?: string; category?: string; note?: string }): Promise<void> {
  await saveEvent({
    id: newEventId(), date: e.date, type: 'event',
    title: e.title.trim(), endDate: e.endDate || undefined, category: e.category, note: e.note,
  });
}

// ─── Overall athlete status (home button) ──────────────────────────────────────
// Stored in SecureStore for fast reads + auto-reverts to Active once `until` passes. Every change is ALSO
// logged as a 'status' timeline event so the history lives behind the timeline button.
export async function getAthleteStatus(): Promise<AthleteStatus> {
  try {
    const raw = await SecureStore.getItemAsync(STATUS_KEY);
    if (!raw) return { status: 'running', since: '' };
    const s = JSON.parse(raw) as AthleteStatus;
    if (s.until && s.until < todayISO()) { await SecureStore.deleteItemAsync(STATUS_KEY).catch(() => {}); return { status: 'running', since: '' }; }
    return s;
  } catch { return { status: 'running', since: '' }; }
}

export async function setAthleteStatus(status: HealthStatus, until?: string): Promise<void> {
  const since = todayISO();
  if (status === 'running' && !until) {
    await SecureStore.deleteItemAsync(STATUS_KEY).catch(() => {});   // back to normal → clear
  } else {
    await SecureStore.setItemAsync(STATUS_KEY, JSON.stringify({ status, since, until } as AthleteStatus)).catch(() => {});
  }
  await saveEvent({ id: newEventId(), date: since, type: 'status', status, action: 'start', endDate: until, note: until ? `until ${fmtDate(until)}` : undefined });
}

// ─── Compact LLM context (economical) ──────────────────────────────────────────
// Current status (only when not plain Active) + life events within ±120 days. Fed to chat, the coaching
// report and the daily coach so training advice factors in medical/holiday/travel context.
export function buildTimelineContext(events: TimelineEvent[], status: AthleteStatus | null, nowISO?: string): string {
  const now = nowISO ?? todayISO();
  const lines: string[] = [];
  if (status && status.status !== 'running') {
    lines.push(`Current status: ${STATUS_LABEL[status.status]}${status.since ? ` since ${fmtDate(status.since)}` : ''}${status.until ? ` (until ${fmtDate(status.until)})` : ''} — do not prescribe hard/high-volume training against this.`);
  }
  const base = new Date(now + 'T00:00:00');
  const lo = new Date(base); lo.setDate(lo.getDate() - 120);
  const hi = new Date(base); hi.setDate(hi.getDate() + 120);
  const inWin = (d?: string) => { if (!d) return false; const t = new Date(d + 'T00:00:00'); return t >= lo && t <= hi; };
  const evs = (events ?? []).filter(e => e.type === 'event' && (inWin(e.date) || inWin(e.endDate))).slice(0, 12);
  for (const e of evs) {
    const range = e.endDate && e.endDate !== e.date ? `${fmtDate(e.date)}–${fmtDate(e.endDate)}` : fmtDate(e.date);
    lines.push(`${range}: ${e.title ?? e.note ?? 'event'}${e.category ? ` (${e.category})` : ''}`);
  }
  if (!lines.length) return '';
  return `\n\nATHLETE TIMELINE (life context — factor into training advice):\n${lines.map(l => `  ${l}`).join('\n')}`;
}
