import * as FileSystem from 'expo-file-system';
import { TimelineEvent } from '../types';

const FILE = `${FileSystem.documentDirectory}runcoach-timeline.json`;

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
