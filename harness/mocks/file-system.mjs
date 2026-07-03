// In-memory FileSystem, seeded from the scenario (globalThis.__HARNESS_SEED.files, keyed by full uri).
// documentDirectory is 'mem://', so coachFiles' `${documentDirectory}coach-knowledge/running-schedule.md`
// maps to the seeded key 'mem://coach-knowledge/running-schedule.md'.
const seed = (globalThis.__HARNESS_SEED && globalThis.__HARNESS_SEED.files) || {};
const files = new Map(Object.entries(seed));

export const documentDirectory = 'mem://';
export async function getInfoAsync(uri) {
  return { exists: files.has(uri) || uri.endsWith('/'), uri, isDirectory: uri.endsWith('/') };
}
export async function readAsStringAsync(uri) {
  if (!files.has(uri)) throw new Error('ENOENT: ' + uri);
  return files.get(uri);
}
export async function writeAsStringAsync(uri, content) { files.set(uri, String(content)); }
export async function makeDirectoryAsync() { /* noop */ }
export async function deleteAsync(uri) { files.delete(uri); }
