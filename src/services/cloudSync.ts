/**
 * Push the athlete's derived data to the cloud so a coach can see it (Milestone 1).
 *
 * Syncs ONLY derived rows — runs (full RunWorkout blobs) and daily metrics (CTL/ATL/TSB
 * + today's recovery/strain/sleep). HealthKit caches are never uploaded; they recompute
 * on-device. Upserts are idempotent, so re-syncing is safe.
 */
import * as SecureStore from 'expo-secure-store';
import { api } from './api';
import { isLoggedIn } from './auth';
import type { HealthSnapshot, RunWorkout, DailyLoad } from '../types';

const K_LAST_SYNC = 'cloud_last_sync_at';

export interface SyncResult {
  runs: number;
  days: number;
  at: string;
}

export async function getLastSync(): Promise<string | null> {
  return SecureStore.getItemAsync(K_LAST_SYNC);
}

const dayKey = (iso: string): string => iso.slice(0, 10);

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Upload everything derivable from a snapshot. Safe to call after each scan.
 * Throws if not signed in or the cloud URL is unset (callers fire-and-forget).
 */
export async function syncSnapshot(snap: HealthSnapshot): Promise<SyncResult> {
  if (!(await isLoggedIn())) throw new Error('Not signed in');
  const now = Date.now();

  // ── runs ───────────────────────────────────────────────────────────────────
  const runRows = (snap.runs || [])
    .filter((r: RunWorkout) => r.uuid && r.date)
    .map((r: RunWorkout) => ({ id: r.uuid, date: r.date, json: r, updatedAt: now }));

  let runs = 0;
  for (const part of chunk(runRows, 50)) {
    const res = await api<{ upserted: number }>('/sync/runs', { method: 'POST', body: { runs: part } });
    runs += res.upserted || 0;
  }

  // ── daily metrics ────────────────────────────────────────────────────────────
  // CTL/ATL/TSB history from the training-load series; today's row enriched with the
  // live recovery / strain / sleep readings (history only carries those for today).
  const today = dayKey(new Date().toISOString());
  const rec = snap.todayRecovery;
  const dayRows = (snap.trainingLoad || []).map((d: DailyLoad) => {
    const row: Record<string, number | string> = {
      date: d.date, ctl: d.ctl, atl: d.atl, tsb: d.tsb, updatedAt: now,
    };
    if (d.date === today) {
      if (snap.strain) row.strain = snap.strain.real;
      if (rec) {
        if (rec.recoveryScore != null) row.recovery = rec.recoveryScore;
        if (rec.weightedRMSSD) row.hrv = rec.weightedRMSSD;
        if (rec.overnightHR) row.rhr = rec.overnightHR;
        if (rec.sleep?.totalMinutes) row.sleepMin = rec.sleep.totalMinutes;
      }
    }
    return row;
  });

  let days = 0;
  for (const part of chunk(dayRows, 50)) {
    const res = await api<{ upserted: number }>('/sync/days', { method: 'POST', body: { days: part } });
    days += res.upserted || 0;
  }

  const at = new Date().toISOString();
  await SecureStore.setItemAsync(K_LAST_SYNC, at);
  return { runs, days, at };
}

/** Athlete: the coach-authored plan (CoachPlan blob) for a given date, or null. */
export async function fetchCoachPlanForDate(date: string): Promise<any | null> {
  if (!(await isLoggedIn())) return null;
  try {
    const r = await api<{ plans: { date: string; source: string; plan: any }[] }>(`/sync/plans?from=${encodeURIComponent(date)}`);
    const hit = (r.plans || []).find((p) => p.date === date && p.source === 'coach' && p.plan);
    return hit?.plan ?? null;
  } catch {
    return null;
  }
}

/** Fire-and-forget variant for post-scan hooks — never throws, returns null on any failure. */
export async function trySyncSnapshot(snap: HealthSnapshot): Promise<SyncResult | null> {
  try {
    if (!(await isLoggedIn())) return null;
    return await syncSnapshot(snap);
  } catch {
    return null;
  }
}
