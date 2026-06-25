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
import { cors } from 'hono/cors';
import type { AppEnv } from './types';
import { requireAuth } from './middleware';
import {
  hashPassword, verifyPassword, signJwt, newRefreshToken, sha256Hex, newId,
} from './crypto';

const ACCESS_TTL = 60 * 60;            // 1 hour
const REFRESH_TTL = 60 * 24 * 60 * 60; // 60 days (seconds)

const app = new Hono<AppEnv>();
app.use('*', cors());

app.get('/', (c) => c.json({ ok: true, service: 'runcoach-api', version: 1 }));

// ── helpers ──────────────────────────────────────────────────────────────────────
function isEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

async function issueTokens(c: Context<AppEnv>, userId: string, role: string) {
  const accessToken = await signJwt({ sub: userId, role }, c.env.JWT_SECRET, ACCESS_TTL);
  const refreshToken = newRefreshToken();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(newId(), userId, await sha256Hex(refreshToken), now + REFRESH_TTL, now).run();
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL };
}

const num = (v: unknown): number | null => (v == null || isNaN(Number(v)) ? null : Number(v));

function chunkBind<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── auth ───────────────────────────────────────────────────────────────────────
app.post('/auth/signup', async (c) => {
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
  ).bind(id, email, await hashPassword(password), role, name, now).run();

  const tokens = await issueTokens(c, id, role);
  return c.json({ user: { id, email, name, role }, ...tokens });
});

app.post('/auth/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const row = await c.env.DB
    .prepare('SELECT id, email, pw_hash, role, name FROM users WHERE email = ?')
    .bind(email)
    .first<any>();
  // Generic failure — never reveal whether the email exists.
  const ok = row ? await verifyPassword(password, row.pw_hash) : false;
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);
  const tokens = await issueTokens(c, row.id, row.role);
  return c.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role }, ...tokens });
});

app.post('/auth/refresh', async (c) => {
  const body = (await c.req.json().catch(() => null)) as any;
  const refreshToken = String(body?.refreshToken || '');
  if (!refreshToken) return c.json({ error: 'missing refreshToken' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB
    .prepare('SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(refreshToken))
    .first<any>();
  if (!row || row.expires_at < now) {
    if (row) await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(row.id).run();
    return c.json({ error: 'invalid refresh token' }, 401);
  }
  // Rotate: invalidate the used token, issue a fresh pair.
  await c.env.DB.prepare('DELETE FROM refresh_tokens WHERE id = ?').bind(row.id).run();
  const user = await c.env.DB
    .prepare('SELECT id, email, name, role FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<any>();
  if (!user) return c.json({ error: 'invalid refresh token' }, 401);
  const tokens = await issueTokens(c, user.id, user.role);
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

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error('worker error', err);
  return c.json({ error: 'internal error' }, 500);
});

export default app;
