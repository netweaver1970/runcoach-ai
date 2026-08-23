/**
 * Export a season/block plan as a standard iCalendar (.ics) file — the pragmatic, portable way to make the
 * plan "compatible": it imports into Apple / Google / Outlook calendars (and any calendar-aware tool).
 *
 * NOTE on TrainingPeaks: TP has NO open plan-import format, and a native structured-workout file (.fit) is
 * a heavy binary format with marginal payoff for an Apple-Watch-native run app. So a universal .ics calendar
 * is the interop that actually makes sense — see the season-plan screen's export button.
 *
 * Pure string generation (RFC 5545, CRLF line endings) so it's unit-testable; the caller supplies the
 * DTSTAMP so the output is deterministic.
 */
import type { SeasonPlan } from './seasonPlan';

const icsDate = (iso: string) => iso.replace(/-/g, '');             // YYYYMMDD (all-day VALUE=DATE)
const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
const shiftDay = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * @param stamp DTSTAMP in iCal UTC form, e.g. "20260823T120000Z" — pass from the caller so tests are stable.
 */
export function seasonPlanToIcs(plan: SeasonPlan, title: string, stamp: string): string {
  const out: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RunCoachAI//Season Plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const ev = (uid: string, startISO: string, endISO: string, summary: string, desc: string) => {
    out.push(
      'BEGIN:VEVENT', `UID:${uid}@runcoachai`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(startISO)}`, `DTEND;VALUE=DATE:${icsDate(endISO)}`,
      `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(desc)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
  };
  const nWeeks = plan.weeks.length;
  plan.weeks.forEach((w, i) => {
    const summary = `🏃 ${w.phase}${w.deload ? ' (deload)' : ''} · load ${w.loadTarget}`;
    const desc = `${title} — week ${nWeeks - i} to race.\nPhase: ${w.phase}${w.deload ? ' (recovery/deload week)' : ''}.\nWeekly load target ${w.loadTarget} (same units as CTL/ATL) · projected CTL ${w.ctl} · TSB ${w.tsb >= 0 ? '+' : ''}${w.tsb}.`;
    // Week-spanning all-day banner: Monday → next Monday (DTEND exclusive).
    ev(`runcoach-week-${w.monday}`, w.monday, shiftDay(w.monday, 7), summary, desc);
  });
  ev(`runcoach-race-${plan.race.date}`, plan.race.date, shiftDay(plan.race.date, 1),
     `🏁 ${title}`, `Race day. Projected: CTL ${plan.race.ctl}, form TSB ${plan.race.tsb >= 0 ? '+' : ''}${plan.race.tsb}.`);
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}
