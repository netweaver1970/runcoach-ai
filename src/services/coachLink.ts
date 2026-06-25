/**
 * Coach ↔ athlete linking (Milestone 2).
 *
 * Athletes generate a short invite code; a coach redeems it. A linked coach can then read
 * (only) that athlete's recent runs + daily metrics. Either party can unlink.
 */
import { api } from './api';

export interface LinkParty { id: string; name?: string | null; email: string; }
export type LinkStatus = 'pending' | 'accepted';

export interface CoachLink {
  id: string;
  status: LinkStatus;
  inviteCode?: string | null;
  role: 'athlete' | 'coach'; // the CALLER's role in this link
  coach: LinkParty | null;
  athlete: LinkParty;
}

export interface AthleteRef { linkId: string; id: string; name?: string | null; email: string; }

export interface AthleteDayRow {
  date: string;
  recovery?: number | null; strain?: number | null;
  ctl?: number | null; atl?: number | null; tsb?: number | null;
  sleepMin?: number | null; hrv?: number | null; rhr?: number | null;
}

export interface PlanRow {
  date: string;
  source: 'self' | 'coach';
  authorId?: string | null;
  plan: any;            // CoachPlan blob
  updatedAt?: number;
}

export interface AthleteSummary {
  athlete: LinkParty;
  runs: any[];          // RunWorkout blobs (+ id/date)
  days: AthleteDayRow[];
  plans: PlanRow[];     // existing prescriptions (recent + upcoming)
}

/** Athlete: generate (or re-fetch) a pending invite code to hand to a coach. */
export async function createInvite(): Promise<string> {
  const r = await api<{ code: string }>('/links/invite', { method: 'POST' });
  return r.code;
}

/** Coach: redeem an athlete's invite code. */
export async function acceptInvite(code: string): Promise<LinkParty> {
  const r = await api<{ athlete: LinkParty }>('/links/accept', { method: 'POST', body: { code: code.trim() } });
  return r.athlete;
}

/** All links involving me (as athlete or coach). */
export async function listLinks(): Promise<CoachLink[]> {
  const r = await api<{ links: CoachLink[] }>('/links');
  return r.links ?? [];
}

/** Coach: my accepted athletes. */
export async function listAthletes(): Promise<AthleteRef[]> {
  const r = await api<{ athletes: AthleteRef[] }>('/coach/athletes');
  return r.athletes ?? [];
}

/** Coach: one athlete's recent runs + daily metrics (requires an accepted link). */
export async function getAthleteSummary(athleteId: string): Promise<AthleteSummary> {
  return api<AthleteSummary>(`/coach/athlete/${encodeURIComponent(athleteId)}`);
}

/** Either party: remove a link. */
export async function removeLink(id: string): Promise<void> {
  await api(`/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Coach: write/replace a prescription (CoachPlan blob) for an athlete on a date. */
export async function prescribePlan(athleteId: string, date: string, plan: any): Promise<void> {
  await api(`/coach/athlete/${encodeURIComponent(athleteId)}/plan`, { method: 'POST', body: { date, plan } });
}

/** Coach: remove a prescription for a date. */
export async function unprescribe(athleteId: string, date: string): Promise<void> {
  await api(`/coach/athlete/${encodeURIComponent(athleteId)}/plan?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
}
