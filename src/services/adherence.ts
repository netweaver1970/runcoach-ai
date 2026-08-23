/**
 * Plan adherence (planned-vs-actual) — the "did you actually do the plan?" roll-up the app was missing vs
 * TrainingPeaks. Reads the human-readable prescription history log (coachFiles `prescription-history`,
 * lines `- YYYY-MM-DD · <structure> · ✅ executed | ⬜ planned`) and summarises, over a trailing window, how
 * many prescribed RUN sessions were executed, which were missed, and the current execution streak.
 *
 * Deliberately session-execution based (reliable: the mark flips when the prescribed run is logged) rather
 * than a load-percentage — actual load already lives on the Volume-vs-Budget card. Pure `parseAdherence`
 * (unit-testable; coachFiles is dynamically imported only inside `computeAdherence`).
 */
export interface Adherence {
  windowDays: number;
  prescribed: number;                        // non-rest run sessions prescribed in the window (past days only)
  executed: number;
  pct: number;                               // executed / prescribed × 100
  streak: number;                            // consecutive most-recent prescribed sessions executed
  misses: { date: string; what: string }[];  // prescribed-but-not-executed past sessions (newest first)
}

/** Coarse session type from the freeform prescription structure text. */
export function classifyPrescription(structure: string): string {
  const s = (structure || '').toLowerCase();
  if (/interval|\bz4\b|\bz5\b|rep/.test(s)) return 'Intervals';
  if (/tempo|threshold|\bz3\b/.test(s)) return 'Tempo';
  if (/long/.test(s)) return 'Long';
  if (/recovery|recover/.test(s)) return 'Recovery';
  if (/^rest$|\brest\b/.test(s)) return 'Rest';
  return 'Run';
}

const shiftISO = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Pure: parse a prescription-history log into an adherence summary. A prescribed run day counts as EXECUTED
 * when the athlete actually RAN that day (`ranDates`) OR the log already carries the ✅ mark — because the
 * log's ✅ flag is set opportunistically and is often missing even when the run happened, so actual runs are
 * the source of truth. null if no qualifying entries.
 */
export function parseAdherence(rawLog: string, todayISO: string, ranDates: Set<string>, windowDays = 28): Adherence | null {
  if (!rawLog) return null;
  const cut = shiftISO(todayISO, -windowDays);
  const entries = rawLog.split('\n')
    .map(l => l.match(/^-\s*(\d{4}-\d{2}-\d{2})\s*·\s*(.+?)\s*·\s*(✅|⬜)/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ date: m[1], what: classifyPrescription(m[2]), done: m[3] === '✅' || ranDates.has(m[1]) }))
    .filter(e => e.date >= cut && e.date < todayISO && e.what !== 'Rest');   // past run days only
  if (!entries.length) return null;

  const prescribed = entries.length;
  const executed = entries.filter(e => e.done).length;
  const chron = entries.slice().sort((a, b) => a.date.localeCompare(b.date));
  let streak = 0;
  for (let i = chron.length - 1; i >= 0; i--) { if (chron[i].done) streak++; else break; }
  const misses = chron.filter(e => !e.done).map(e => ({ date: e.date, what: e.what })).reverse();

  return { windowDays, prescribed, executed, pct: Math.round((executed / prescribed) * 100), streak, misses };
}

/** One concise line for the LLM coach context (null if no data). */
export function adherenceForLLM(a: Adherence | null): string | null {
  if (!a || !a.prescribed) return null;
  const miss = a.misses.length ? ` Missed: ${a.misses.slice(0, 3).map(m => `${m.what} ${m.date.slice(5)}`).join(', ')}.` : '';
  return `Plan adherence (last ${a.windowDays}d): ${a.executed}/${a.prescribed} prescribed sessions executed (${a.pct}%), current streak ${a.streak}.${miss}`;
}
