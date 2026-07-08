/**
 * RunCoachAI cloud API (Cloudflare Worker + D1).
 *
 * Milestone 1 — accounts + athlete → cloud data sync.
 *   POST /auth/signup | /auth/login | /auth/refresh | /auth/logout
 *   GET  /auth/me
 *   POST /sync/runs   — batch upsert runs (RunWorkout blobs)
 *   POST /sync/days   — batch upsert daily metrics
 *   GET  /sync/plans  — pull prescriptions (empty until a coach writes them in M3)
 *
 * Every /sync route is scoped to the caller's own athlete_id. Coach access to other
 * athletes (via coach_links) arrives in Milestone 2.
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from './types';
import { requireAuth } from './middleware';
import {
  hashPassword, verifyPassword, passwordNeedsRehash, signJwt, newRefreshToken, sha256Hex, newId,
} from './crypto';

const ACCESS_TTL = 60 * 60;            // 1 hour
const REFRESH_TTL = 60 * 24 * 60 * 60; // 60 days (seconds)

const app = new Hono<AppEnv>();
// No CORS middleware ON PURPOSE: the only clients are the native iOS app and CLI tools, which don't
// send an Origin. The old blanket cors() (Access-Control-Allow-Origin: * on every route) let any
// website script a logged-in browser session against this API. Add a narrow allowlist if a web UI ever ships.

app.get('/', (c) => c.json({ ok: true, service: 'runcoach-api', version: 1 }));

// ── helpers ──────────────────────────────────────────────────────────────────────
function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

async function issueTokens(c: Context<AppEnv>, userId: string, role: string, familyId?: string) {
  const accessToken = await signJwt({ sub: userId, role }, c.env.JWT_SECRET, ACCESS_TTL);
  const refreshToken = newRefreshToken();
  const now = Math.floor(Date.now() / 1000);
  const id = newId();
  // family_id ties every rotation of one login session together — replaying an already-rotated
  // member of the family is proof of theft and revokes the whole family (see /auth/refresh).
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, family_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, userId, await sha256Hex(refreshToken), now + REFRESH_TTL, now, familyId ?? id).run();
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL };
}

const num = (v: unknown): number | null => (v == null || isNaN(Number(v)) ? null : Number(v));

function chunkBind<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── rate limiting (D1 fixed-window; fail-open so a missing table can't lock everyone out) ──────────
const RL_CFG = {
  login:  { limit: 10, windowSec: 15 * 60 },  // per ip:email
  signup: { limit: 5,  windowSec: 60 * 60 },  // per ip
  accept: { limit: 10, windowSec: 60 * 60 },  // per account — 10-char codes + 15-min expiry make brute force moot anyway
} as const;
async function rateLimited(c: Context<AppEnv>, scope: keyof typeof RL_CFG, key: string): Promise<boolean> {
  const cfg = RL_CFG[scope];
  const now = Math.floor(Date.now() / 1000);
  const winStart = now - (now % cfg.windowSec);
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO rate_limits (scope, key, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    ).bind(scope, key, winStart).first<any>();
    return (row?.count ?? 0) > cfg.limit;
  } catch { return false; }
}
const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') || 'unknown';

// PBKDF2 work for a nonexistent email too, so login latency can't reveal whether an account exists.
let dummyHashP: Promise<string> | null = null;
const dummyHash = (pepper?: string) => (dummyHashP ??= hashPassword('timing-equalizer-not-a-real-account', pepper));

// ── auth ───────────────────────────────────────────────────────────────────────
app.post('/auth/signup', async (c) => {
  if (await rateLimited(c, 'signup', clientIp(c))) return c.json({ error: 'too many attempts — try again later' }, 429);
  const body = (await c.req.json().catch(() => null)) as any;
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const name = body?.name ? String(body.name).slice(0, 80) : null;
  const role = body?.role === 'coach' ? 'coach' : 'athlete';
  if (!isEmail(email)) return c.json({ error: 'invalid email' }, 400);
  if (password.length < 8) return c.json({ error: 'password must be at least 8 characters' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return c.json({ error: 'email already registered' }, 409);

  const id = newId();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, pw_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, email, await hashPassword(password, c.env.PW_PEPPER), role, name, now).run();

  const tokens = await issueTokens(c, id, role);
  return c.json({ user: { id, email, name, role }, ...tokens });
});

app.post('/auth/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (await rateLimited(c, 'login', `${clientIp(c)}:${email}`)) {
    return c.json({ error: 'too many attempts — try again later' }, 429);
  }
  const row = await c.env.DB
    .prepare('SELECT id, email, pw_hash, role, name FROM users WHERE email = ?')
    .bind(email)
    .first<any>();
  // Generic failure — and burn the SAME PBKDF2 work when the email doesn't exist, so response
  // timing doesn't reveal which emails are registered (the message alone never did).
  const ok = row
    ? await verifyPassword(password, row.pw_hash, c.env.PW_PEPPER)
    : (await verifyPassword(password, await dummyHash(c.env.PW_PEPPER)), false);
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);
  // Transparent upgrade: once PW_PEPPER is configured, legacy un-peppered hashes re-hash to the
  // peppered format on the next successful login (the only moment we have the password).
  if (passwordNeedsRehash(row.pw_hash, !!c.env.PW_PEPPER)) {
    await c.env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?')
      .bind(await hashPassword(password, c.env.PW_PEPPER), row.id).run().catch(() => {});
  }
  const tokens = await issueTokens(c, row.id, row.role);
  return c.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role }, ...tokens });
});

app.post('/auth/refresh', async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const refreshToken = String(body?.refreshToken || '');
  if (!refreshToken) return c.json({ error: 'missing refreshToken' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB
    .prepare('SELECT id, user_id, expires_at, family_id, used_at FROM refresh_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(refreshToken))
    .first<any>();
  if (!row || row.expires_at < now) {
    if (row) await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(row.id).run();
    return c.json({ error: 'invalid refresh token' }, 401);
  }
  // REUSE DETECTION (OAuth2 BCP): a token that was already rotated coming back means it was stolen
  // (or the legit client replayed after theft) — revoke the ENTIRE family so the thief's chain dies too.
  if (row.used_at != null) {
    await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id = ? OR id = ?')
      .bind(row.family_id ?? row.id, row.id).run();
    return c.json({ error: 'invalid refresh token' }, 401);
  }
  // Rotate: MARK the used token (kept until expiry for reuse detection) and issue a fresh pair
  // in the same family. Opportunistically purge expired rows to keep the table small.
  await c.env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ?').bind(now, row.id).run();
  await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').bind(now).run().catch(() => {});
  const user = await c.env.DB
    .prepare('SELECT id, email, name, role FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<any>();
  if (!user) return c.json({ error: 'invalid refresh token' }, 401);
  const tokens = await issueTokens(c, user.id, user.role, row.family_id ?? row.id);
  return c.json({ user, ...tokens });
});

app.post('/auth/logout', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  if (body?.refreshToken) {
    await c.env.DB
      .prepare('DELETE FROM refresh_tokens WHERE token_hash = ? AND user_id = ?')
      .bind(await sha256Hex(String(body.refreshToken)), c.get('userId'))
      .run();
  }
  return c.json({ ok: true });
});

// Kill every session (all refresh-token families) for the caller — e.g. after a suspected leak.
app.post('/auth/revoke-all', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(c.get('userId')).run();
  return c.json({ ok: true });
});

app.get('/auth/me', requireAuth, async (c) => {
  const user = await c.env.DB
    .prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first();
  if (!user) return c.json({ error: 'not found' }, 404);
  return c.json({ user });
});

// ── sync (scoped to the caller's own athlete_id) ──────────────────────────────────
app.post('/sync/runs', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const runs: any[] = Array.isArray(body?.runs) ? body.runs : [];
  const athleteId = c.get('userId');
  const stmt = c.env.DB.prepare(
    `INSERT INTO runs (id, athlete_id, date, json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(athlete_id, id) DO UPDATE SET
       date=excluded.date, json=excluded.json, updated_at=excluded.updated_at`,
  );
  const binds = [];
  for (const r of runs) {
    if (!r?.id || !r?.date) continue;
    binds.push(stmt.bind(String(r.id), athleteId, String(r.date), JSON.stringify(r.json ?? r), num(r.updatedAt) ?? Date.now()));
  }
  for (const part of chunkBind(binds, 50)) await c.env.DB.batch(part);
  return c.json({ ok: true, upserted: binds.length });
});

app.post('/sync/days', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const days: any[] = Array.isArray(body?.days) ? body.days : [];
  const athleteId = c.get('userId');
  const stmt = c.env.DB.prepare(
    `INSERT INTO athlete_days
       (athlete_id, date, recovery, strain, ctl, atl, tsb, sleep_min, hrv, rhr, json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(athlete_id, date) DO UPDATE SET
       recovery=excluded.recovery, strain=excluded.strain, ctl=excluded.ctl, atl=excluded.atl,
       tsb=excluded.tsb, sleep_min=excluded.sleep_min, hrv=excluded.hrv, rhr=excluded.rhr,
       json=excluded.json, updated_at=excluded.updated_at`,
  );
  const binds = [];
  for (const d of days) {
    if (!d?.date) continue;
    binds.push(stmt.bind(
      athleteId, String(d.date),
      num(d.recovery), num(d.strain), num(d.ctl), num(d.atl), num(d.tsb),
      num(d.sleepMin), num(d.hrv), num(d.rhr),
      d.json != null ? JSON.stringify(d.json) : null,
      num(d.updatedAt) ?? Date.now(),
    ));
  }
  for (const part of chunkBind(binds, 50)) await c.env.DB.batch(part);
  return c.json({ ok: true, upserted: binds.length });
});

app.get('/sync/plans', requireAuth, async (c) => {
  const from = c.req.query('from') || '1970-01-01';
  const { results } = await c.env.DB
    .prepare('SELECT date, source, author_id, json, updated_at FROM plans WHERE athlete_id = ? AND date >= ? ORDER BY date')
    .bind(c.get('userId'), from)
    .all<any>();
  const plans = (results || []).map((r) => ({
    date: r.date,
    source: r.source,
    authorId: r.author_id,
    plan: safeParse(r.json),
    updatedAt: r.updated_at,
  }));
  return c.json({ plans });
});

function safeParse(s: unknown) {
  try { return JSON.parse(String(s)); } catch { return null; }
}

// ── coach <-> athlete linking (Milestone 2) ───────────────────────────────────
// Athletes generate a short invite code; a coach redeems it. The coach can then read
// (only) that athlete's recent runs + daily metrics. Either party can unlink.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
function inviteCode(len = 10): string {
  const r = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += INVITE_ALPHABET[r[i] % INVITE_ALPHABET.length];
  return s;
}
async function hasAcceptedLink(c: Context<AppEnv>, coachId: string, athleteId: string): Promise<boolean> {
  const row = await c.env.DB
    .prepare("SELECT id FROM coach_links WHERE coach_id = ? AND athlete_id = ? AND status = 'accepted'")
    .bind(coachId, athleteId).first();
  return !!row;
}

// Athlete generates (or re-fetches) a pending invite code to hand to a coach.
const INVITE_TTL_SEC = 15 * 60;
app.post('/links/invite', requireAuth, async (c) => {
  const athleteId = c.get('userId');
  const now = Math.floor(Date.now() / 1000);
  const existing = await c.env.DB
    .prepare("SELECT id, invite_code, code_expires_at FROM coach_links WHERE athlete_id = ? AND coach_id IS NULL AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .bind(athleteId).first<any>();
  // Re-serve only a still-valid code; an expired (or legacy no-expiry) pending row gets a FRESH code —
  // the old behavior re-served the same 6-char code forever, an unbounded brute-force window.
  if (existing?.invite_code && existing.code_expires_at != null && existing.code_expires_at > now) {
    return c.json({ code: existing.invite_code, expiresAt: existing.code_expires_at });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = inviteCode();
    const expires = now + INVITE_TTL_SEC;
    try {
      if (existing?.id) {
        await c.env.DB.prepare("UPDATE coach_links SET invite_code = ?, code_expires_at = ?, created_at = ? WHERE id = ?")
          .bind(code, expires, now, existing.id).run();
      } else {
        await c.env.DB.prepare(
          "INSERT INTO coach_links (id, coach_id, athlete_id, status, invite_code, created_at, code_expires_at) VALUES (?, NULL, ?, 'pending', ?, ?, ?)",
        ).bind(newId(), athleteId, code, now, expires).run();
      }
      return c.json({ code, expiresAt: expires });
    } catch { /* unique collision — retry */ }
  }
  return c.json({ error: 'could not generate code' }, 500);
});

// Coach redeems an athlete's invite code.
app.post('/links/accept', requireAuth, async (c) => {
  const coachId = c.get('userId');
  if (await rateLimited(c, 'accept', coachId)) return c.json({ error: 'too many attempts — try again later' }, 429);
  const body = (await c.req.json().catch(() => null)) as any;
  const code = String(body?.code || '').trim().toUpperCase();
  if (!code) return c.json({ error: 'missing code' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB
    .prepare("SELECT id, athlete_id FROM coach_links WHERE invite_code = ? AND status = 'pending' AND coach_id IS NULL AND code_expires_at IS NOT NULL AND code_expires_at > ?")
    .bind(code, now).first<any>();
  if (!row) return c.json({ error: 'invalid, expired, or already-used code' }, 404);
  if (row.athlete_id === coachId) return c.json({ error: "you can't coach your own account" }, 400);
  await c.env.DB.prepare("UPDATE coach_links SET coach_id = ?, status = 'accepted' WHERE id = ?")
    .bind(coachId, row.id).run();
  const athlete = await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(row.athlete_id).first();
  return c.json({ ok: true, athlete });
});

// All links involving the caller (as athlete: my coaches + pending code; as coach: my athletes).
app.get('/links', requireAuth, async (c) => {
  const uid = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.invite_code, l.coach_id, l.athlete_id,
            ca.name AS coach_name, ca.email AS coach_email,
            au.name AS athlete_name, au.email AS athlete_email
     FROM coach_links l
     LEFT JOIN users ca ON ca.id = l.coach_id
     LEFT JOIN users au ON au.id = l.athlete_id
     WHERE l.coach_id = ? OR l.athlete_id = ?
     ORDER BY l.created_at DESC`,
  ).bind(uid, uid).all<any>();
  const links = (results || []).map((r) => ({
    id: r.id, status: r.status, inviteCode: r.invite_code,
    role: r.athlete_id === uid ? 'athlete' : 'coach',
    coach: r.coach_id ? { id: r.coach_id, name: r.coach_name, email: r.coach_email } : null,
    athlete: { id: r.athlete_id, name: r.athlete_name, email: r.athlete_email },
  }));
  return c.json({ links });
});

// Coach: accepted athletes.
app.get('/coach/athletes', requireAuth, async (c) => {
  const coachId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT l.id AS link_id, u.id, u.name, u.email
     FROM coach_links l JOIN users u ON u.id = l.athlete_id
     WHERE l.coach_id = ? AND l.status = 'accepted'
     ORDER BY COALESCE(u.name, u.email)`,
  ).bind(coachId).all<any>();
  return c.json({ athletes: (results || []).map((r) => ({ linkId: r.link_id, id: r.id, name: r.name, email: r.email })) });
});

// Coach: one athlete's recent data (read-only; requires an accepted link).
app.get('/coach/athlete/:id', requireAuth, async (c) => {
  const coachId = c.get('userId');
  const athleteId = c.req.param('id');
  if (!(await hasAcceptedLink(c, coachId, athleteId))) return c.json({ error: 'not linked to this athlete' }, 403);
  const athlete = await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(athleteId).first();
  const runs = await c.env.DB.prepare('SELECT id, date, json FROM runs WHERE athlete_id = ? ORDER BY date DESC LIMIT 20').bind(athleteId).all<any>();
  const days = await c.env.DB.prepare('SELECT date, recovery, strain, ctl, atl, tsb, sleep_min, hrv, rhr FROM athlete_days WHERE athlete_id = ? ORDER BY date DESC LIMIT 30').bind(athleteId).all<any>();
  const plans = await c.env.DB.prepare('SELECT date, source, author_id, json, updated_at FROM plans WHERE athlete_id = ? ORDER BY date DESC LIMIT 21').bind(athleteId).all<any>();
  return c.json({
    athlete,
    runs: (runs.results || []).map((r) => ({ id: r.id, date: r.date, ...safeParse(r.json) })),
    days: (days.results || []).map((d) => ({ date: d.date, recovery: d.recovery, strain: d.strain, ctl: d.ctl, atl: d.atl, tsb: d.tsb, sleepMin: d.sleep_min, hrv: d.hrv, rhr: d.rhr })),
    plans: (plans.results || []).map((p) => ({ date: p.date, source: p.source, authorId: p.author_id, plan: safeParse(p.json), updatedAt: p.updated_at })),
  });
});

// Coach writes / updates a prescription for an athlete on a date (Milestone 3).
app.post('/coach/athlete/:id/plan', requireAuth, async (c) => {
  const coachId = c.get('userId');
  const athleteId = c.req.param('id');
  if (!(await hasAcceptedLink(c, coachId, athleteId))) return c.json({ error: 'not linked to this athlete' }, 403);
  const body = (await c.req.json().catch(() => null)) as any;
  const date = String(body?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  if (body?.plan == null || typeof body.plan !== 'object') return c.json({ error: 'missing plan' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO plans (athlete_id, date, source, author_id, json, updated_at)
     VALUES (?, ?, 'coach', ?, ?, ?)
     ON CONFLICT(athlete_id, date) DO UPDATE SET
       source='coach', author_id=excluded.author_id, json=excluded.json, updated_at=excluded.updated_at`,
  ).bind(athleteId, date, coachId, JSON.stringify(body.plan), Date.now()).run();
  return c.json({ ok: true });
});

// Coach removes a prescription for a date.
app.delete('/coach/athlete/:id/plan', requireAuth, async (c) => {
  const coachId = c.get('userId');
  const athleteId = c.req.param('id');
  if (!(await hasAcceptedLink(c, coachId, athleteId))) return c.json({ error: 'not linked to this athlete' }, 403);
  const date = (c.req.query('date') || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'invalid date' }, 400);
  await c.env.DB.prepare("DELETE FROM plans WHERE athlete_id = ? AND date = ? AND source = 'coach'").bind(athleteId, date).run();
  return c.json({ ok: true });
});

// Either party unlinks.
app.delete('/links/:id', requireAuth, async (c) => {
  const uid = c.get('userId');
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM coach_links WHERE id = ? AND (coach_id = ? OR athlete_id = ?)').bind(id, uid, uid).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error('worker error', err);
  return c.json({ error: 'internal error' }, 500);
});

export default app;
