/**
 * File-reading wrapper for plan adherence: pulls the prescription-history log and runs the pure
 * `parseAdherence`. Kept separate from `adherence.ts` so that module stays import-free and node-testable
 * (this one imports the expo-backed coachFiles).
 */
import { readKnowledgeContent } from './coachFiles';
import { parseAdherence, Adherence } from './adherence';

export async function computeAdherence(todayISO: string, windowDays = 28): Promise<Adherence | null> {
  try {
    const raw = await readKnowledgeContent('prescription-history').catch(() => '');
    return parseAdherence(raw || '', todayISO, windowDays);
  } catch { return null; }
}
