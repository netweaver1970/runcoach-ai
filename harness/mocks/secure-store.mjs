// In-memory SecureStore, seeded from the scenario (globalThis.__HARNESS_SEED.secureStore) so the engine
// reads the same settings the device would: shrink_to_fit_v1, periodization_v1, plan_mode_v1, load_cap_pct…
const seed = (globalThis.__HARNESS_SEED && globalThis.__HARNESS_SEED.secureStore) || {};
const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));

export async function getItemAsync(key) { return store.has(key) ? store.get(key) : null; }
export async function setItemAsync(key, value) { store.set(key, String(value)); }
export async function deleteItemAsync(key) { store.delete(key); }
