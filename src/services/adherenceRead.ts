/**
 * File-reading wrapper for plan adherence: pulls the prescription-history log and runs the pure
 * `parseAdherence`. Kept separate from `adherence.ts` so that module stays import-free and node-testable
 * (this one imports the expo-backed coachFiles).
 */
import { readKnowledgeContent } from './coachFiles';
import { loadSnapshotCache } from './healthkit';
import { parseAdherence, Adherence } from './adherence';

export async function computeAdherence(todayISO: string, windowDays = 28): Promise<Adherence | null> {
  try {
    const [raw, snap] = await Promise.all([
      readKnowledgeContent('prescription-history').catch(() => ''),
      loadSnapshotCache().catch(() => null),
    ]);
    // Days the athlete ACTUALLY ran — the source of truth for "executed" (the log's ✅ is unreliable).
    const ranDates = new Set<string>((snap?.runs ?? []).map((r: any) => String(r.date || '').slice(0, 10)).filter(Boolean));
    return parseAdherence(raw || '', todayISO, ranDates, windowDays);
  } catch { return null; }
}
