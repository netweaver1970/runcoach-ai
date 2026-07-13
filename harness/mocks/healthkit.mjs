// Stand-in for src/services/healthkit.ts — the deterministic engine never actually calls these on the
// tof-basis path (the duration series is supplied directly), so empty results are fine.
export async function fetchOurDailyComponents() { return null; }
export async function fetchDailyDurationHistory() { return []; }
export async function fetchDailyWorkDistanceHistory() { return []; }
export async function loadSnapshotCache() { return null; }
export function buildHeartbeatQualityMap() { return new Map(); }   // bodyBattery.ts imports (never called on the deterministic path)
export function isGoodHRVSample() { return true; }
export function extractWeatherTempC() { return undefined; }
export async function fetchWorkoutDetail() { return { hr: [], power: [], pace: [], totalMs: 0, activities: [], kmSplits: [], pauseIntervals: [] }; }
export async function fetchActivityHistory() { return []; }   // agent.ts (query_activities) imports; never called on the deterministic path
