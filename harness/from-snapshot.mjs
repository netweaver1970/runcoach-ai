// Convert a raw HealthSnapshot export (runcoach-snapshot-*.json) into a harness scenario. A HealthSnapshot
// lacks the coach SETTINGS (shrink/cap/schedule), so those are supplied here (defaults = Geert's device);
// override via a second JSON arg. NOTE: time-on-feet is derived from run TOTAL duration — approximate;
// the in-app "Export Coach Debug Snapshot" button captures the exact assembled series instead.
//   node harness/from-snapshot.mjs <healthsnapshot.json> [settings.json] > scenario.local.json
import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const overrides = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};

const day = (s) => (s ?? '').slice(0, 10);
const today = day(snap.fetchedAt) || new Date().toISOString().slice(0, 10);

// Daily total run minutes for the 14 days ending today.
const byDay = new Map();
for (const r of snap.runs ?? []) {
  const d = day(r.date);
  byDay.set(d, (byDay.get(d) ?? 0) + Math.round((r.duration ?? 0) / 60));
}
const recentTimeOnFeet = [];
for (let i = 13; i >= 0; i--) {
  const dt = new Date(today + 'T00:00:00'); dt.setDate(dt.getDate() - i);
  const k = dt.toISOString().slice(0, 10);
  recentTimeOnFeet.push({ date: k, min: byDay.get(k) ?? 0 });
}

const s = snap.strain ?? {};
const scenario = {
  _note: 'Derived from a raw HealthSnapshot (runcoach-snapshot). ToF = run TOTAL minutes (approx). Settings = device defaults; override with a settings.json arg.',
  date: today,
  capPct: 20,
  shrinkToFit: true,
  planMode: 'leisure',
  readiness: s.readiness,
  strainReal: s.real,
  advisableLow: s.safeLow,
  advisableHigh: s.safeHigh,
  acwr: s.acwr,
  weather: { tempC: 19, apparentC: 18, humidity: 78, windKmh: 21, description: 'Light drizzle', place: 'Merelbeke-Melle' },
  schedule: '# Preferred Weekly Structure\n\nMonday: intervals\nTuesday: recovery/z2 or rest\nWednesday: tempo\nThursday: recovery/z2 or rest\nFriday: Long\nSaturday: recovery/z2 or rest\nSunday: recovery/z2 or rest\n',
  recentTimeOnFeet,
  ...overrides,
};
process.stdout.write(JSON.stringify(scenario, null, 2) + '\n');
