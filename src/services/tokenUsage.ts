/**
 * LLM token accounting — what each call cost, and what the month has cost so far.
 *
 * Built after Geert exhausted his Anthropic credits earlier than expected (2026-07-24) with no way to see
 * where the spend went. Every provider returns a `usage` block on every response and we were discarding
 * it, so the app had no idea what it was spending.
 *
 * ⚠️ WHAT THIS CANNOT DO: show your remaining Anthropic CREDIT. A normal API key (sk-ant-api…) has no
 * endpoint for the account balance — usage and cost live behind the Admin API, which needs an
 * organisation admin key (sk-ant-admin…). That is a far more powerful credential than a phone app should
 * hold, so we deliberately don't ask for one. What you get instead is an accurate record of what THIS APP
 * spent, which is the part it can actually measure. The console remains the source of truth for balance.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}llm-usage.json`;

export interface CallUsage {
  input:      number;   // uncached input tokens
  output:     number;
  cacheRead:  number;   // input served from the prompt cache — ~10% of the input price
  cacheWrite: number;   // input written INTO the cache — ~125% of the input price
  model:      string;
  at:         string;   // ISO
  feature:    string;   // 'chat' | 'run-analysis' | 'coach-plan' | 'zones' | …
}
interface UsageLog { calls: CallUsage[] }

// Keep a rolling window: enough to answer "this month", small enough to stay cheap to read/write.
const MAX_CALLS = 400;

// ── Pricing ───────────────────────────────────────────────────────────────────
// USD per MILLION tokens. These are ESTIMATES for display only — provider prices change, and the app
// cannot fetch them, so treat the cost figure as an indication and the console as authoritative.
// Matched longest-prefix-first, so 'claude-haiku' wins over the 'claude' fallback.
export const PRICES_AS_OF = '2026-01';
const PRICING: { match: string; in: number; out: number }[] = [
  { match: 'claude-opus',    in: 15,   out: 75 },
  { match: 'claude-sonnet',  in: 3,    out: 15 },
  { match: 'claude-haiku',   in: 1,    out: 5 },
  { match: 'gpt-4o-mini',    in: 0.15, out: 0.6 },
  { match: 'gpt-4o',         in: 2.5,  out: 10 },
  { match: 'claude',         in: 3,    out: 15 },   // unknown Claude → Sonnet-ish
];

/** Estimated USD for one call. Cache reads bill ~0.1x input, cache writes ~1.25x. */
export function costOf(u: CallUsage): number {
  const m = (u.model ?? '').toLowerCase();
  const p = PRICING.find(x => m.includes(x.match));
  if (!p) return 0;
  return (u.input * p.in + u.cacheRead * p.in * 0.1 + u.cacheWrite * p.in * 1.25 + u.output * p.out) / 1_000_000;
}

export const totalTokens = (u: CallUsage): number => u.input + u.cacheRead + u.cacheWrite + u.output;

async function read(): Promise<UsageLog> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(FILE)) as UsageLog; }
  catch { return { calls: [] }; }
}

// Serialised read-modify-write. Several features can finish within milliseconds of each other (the
// agentic loop fires one record per step), and a plain read→push→write loses entries — the same
// lost-update shape that silently froze forecastLog at 7 points.
let chain: Promise<void> = Promise.resolve();
let lastCall: CallUsage | null = null;

/** Record one call. Never throws — accounting must not be able to break a coaching feature. */
export function recordUsage(u: CallUsage): void {
  lastCall = u;
  const next = chain.then(async () => {
    try {
      const log = await read();
      log.calls.push(u);
      if (log.calls.length > MAX_CALLS) log.calls = log.calls.slice(-MAX_CALLS);
      await FileSystem.writeAsStringAsync(FILE, JSON.stringify(log));
    } catch { /* disk full / sandbox — accounting is best-effort */ }
  });
  chain = next.catch(() => {});
}

/** The most recent call, for the "what did that cost?" line under a chat reply. */
export const lastCallUsage = (): CallUsage | null => lastCall;

export interface UsageSummary {
  calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; usd: number;
  byFeature: { feature: string; calls: number; tokens: number; usd: number }[];
}

/** Totals since `sinceISO` (default: start of the current month), newest-first by cost. */
export async function usageSince(sinceISO?: string): Promise<UsageSummary> {
  const from = sinceISO ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const calls = (await read()).calls.filter(c => c.at >= from);
  const sum: UsageSummary = { calls: calls.length, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, byFeature: [] };
  const byF = new Map<string, { calls: number; tokens: number; usd: number }>();
  for (const c of calls) {
    sum.input += c.input; sum.output += c.output;
    sum.cacheRead += c.cacheRead; sum.cacheWrite += c.cacheWrite;
    const usd = costOf(c);
    sum.usd += usd;
    const f = byF.get(c.feature) ?? { calls: 0, tokens: 0, usd: 0 };
    f.calls++; f.tokens += totalTokens(c); f.usd += usd;
    byF.set(c.feature, f);
  }
  sum.byFeature = [...byF.entries()].map(([feature, v]) => ({ feature, ...v })).sort((a, b) => b.usd - a.usd);
  return sum;
}

export async function clearUsage(): Promise<void> {
  try { await FileSystem.deleteAsync(FILE, { idempotent: true }); } catch { /* ignore */ }
}

/** Compact one-liner for under a chat reply, e.g. "2.6k in · 380 out · ~$0.014". */
export function formatUsage(u: CallUsage | null): string {
  if (!u) return '';
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const inTot = u.input + u.cacheRead + u.cacheWrite;
  const usd = costOf(u);
  const cached = u.cacheRead > 0 ? ` (${Math.round(u.cacheRead / Math.max(1, inTot) * 100)}% cached)` : '';
  return `${k(inTot)} in${cached} · ${k(u.output)} out · ~$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}
