import * as FileSystem from 'expo-file-system';

// Lightweight supplement tracker: a user-defined list + a per-supplement log of the ISO dates taken.
// Kept SEPARATE from the timeline events so daily intakes don't clutter the life-events history, and so
// one-tap logging stays instant. Fed to the coach as a compact adherence line.

const FILE = `${FileSystem.documentDirectory}runcoach-supplements.json`;

export interface SupplementData {
  list: string[];                     // supplement names, in display order
  log:  Record<string, string[]>;     // name → ISO dates taken (YYYY-MM-DD)
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

async function read(): Promise<SupplementData> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { list: [], log: {} };
    const d = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as SupplementData;
    return { list: d.list ?? [], log: d.log ?? {} };
  } catch { return { list: [], log: {} }; }
}
async function write(d: SupplementData): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(d)); } catch { /* ignore */ }
}

export async function loadSupplements(): Promise<SupplementData> { return read(); }

export async function addSupplement(name: string): Promise<void> {
  const n = name.trim(); if (!n) return;
  const d = await read();
  if (!d.list.some(x => x.toLowerCase() === n.toLowerCase())) { d.list.push(n); await write(d); }
}
export async function removeSupplement(name: string): Promise<void> {
  const d = await read();
  d.list = d.list.filter(x => x !== name);
  delete d.log[name];
  await write(d);
}

/** One-tap: mark taken today, or un-mark if tapped again. Returns the new taken-today state. */
export async function toggleSupplementToday(name: string): Promise<boolean> {
  const d = await read();
  const t = todayISO();
  const dates = new Set(d.log[name] ?? []);
  let taken: boolean;
  if (dates.has(t)) { dates.delete(t); taken = false; } else { dates.add(t); taken = true; }
  d.log[name] = [...dates].sort();
  await write(d);
  return taken;
}

export function takenToday(d: SupplementData, name: string, today = todayISO()): boolean {
  return (d.log[name] ?? []).includes(today);
}
/** Days-taken out of the last `days` window (for the little "5/7" adherence badge). */
export function adherence(d: SupplementData, name: string, days = 7, now = todayISO()): number {
  const base = new Date(now + 'T00:00:00');
  const lo = new Date(base); lo.setDate(lo.getDate() - (days - 1));
  return (d.log[name] ?? []).filter(iso => { const t = new Date(iso + 'T00:00:00'); return t >= lo && t <= base; }).length;
}

/** Compact LLM line: "SUPPLEMENTS (7d): Creatine 6/7; Vitamin D 7/7 · today: Creatine". Empty if no list. */
export function buildSupplementContext(d: SupplementData, days = 7, now = todayISO()): string {
  if (!d.list.length) return '';
  const parts = d.list.map(n => `${n} ${adherence(d, n, days, now)}/${days}`);
  const takenT = d.list.filter(n => takenToday(d, n, now));
  return `\n\nSUPPLEMENTS (${days}d adherence): ${parts.join('; ')}${takenT.length ? ` · taken today: ${takenT.join(', ')}` : ''}`;
}
