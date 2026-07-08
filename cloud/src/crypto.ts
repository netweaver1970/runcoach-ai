/**
 * Minimal, careful auth primitives — all via Web Crypto (native on Workers, no deps).
 *
 *   • Passwords  — PBKDF2-SHA256, random per-user salt, constant-time verify.
 *   • Access JWT — HMAC-SHA256, short TTL, verified with crypto.subtle.verify.
 *   • Refresh    — 256-bit random token, stored only as a SHA-256 hash, rotated on use.
 *
 * PBKDF2 iterations stay at 100k ON PURPOSE: the Workers free-plan CPU budget makes OWASP's 600k a
 * real "CPU time exceeded" risk in production (random login failures — worse than the finding). The
 * offline-cracking defense is a PEPPER instead: when the PW_PEPPER Worker secret is set, the PBKDF2
 * output is HMAC-SHA256'd with it before storage (format pbkdf2p$). The pepper lives only in Worker
 * secrets — a leaked D1 dump alone is then uncrackable at ANY iteration count, which beats 600k
 * unpeppered for that threat model at ~zero CPU. Old un-peppered hashes verify fine and are
 * re-hashed to the peppered format on the next successful login (passwordNeedsRehash).
 */

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64url ──────────────────────────────────────────────────────────────────
function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── passwords ──────────────────────────────────────────────────────────────────
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, HASH_BITS);
  return new Uint8Array(bits);
}

async function pepperize(bits: Uint8Array, pepper: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bits));
}

/** Stored as `pbkdf2$<iters>$<salt>$<hash>` (no pepper) or `pbkdf2p$<iters>$<salt>$<hmac>` (peppered). */
export async function hashPassword(password: string, pepper?: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  let bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  if (pepper) bits = await pepperize(bits, pepper);
  const scheme = pepper ? 'pbkdf2p' : 'pbkdf2';
  return `${scheme}$${PBKDF2_ITERATIONS}$${toB64url(salt)}$${toB64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string, pepper?: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || (parts[0] !== 'pbkdf2' && parts[0] !== 'pbkdf2p')) return false;
  if (parts[0] === 'pbkdf2p' && !pepper) return false; // peppered hash but no secret configured
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = fromB64url(parts[2]);
  const expected = fromB64url(parts[3]);
  let actual = await pbkdf2(password, salt, iterations);
  if (parts[0] === 'pbkdf2p') actual = await pepperize(actual, pepper!);
  return timingSafeEqual(actual, expected);
}

/** True when the stored hash is below current policy (un-peppered while a pepper is configured, or
 *  fewer iterations) — re-hash on the next successful login, when we briefly have the password. */
export function passwordNeedsRehash(stored: string, pepperAvailable: boolean): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  if (pepperAvailable && parts[0] === 'pbkdf2') return true;
  const iterations = parseInt(parts[1], 10);
  return Number.isFinite(iterations) && iterations < PBKDF2_ITERATIONS;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────────────
export interface JwtPayload { sub: string; role: string; iat: number; exp: number; }

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signJwt(claims: { sub: string; role: string }, secret: string, ttlSec: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { sub: claims.sub, role: claims.role, iat: now, exp: now + ttlSec };
  const h = toB64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = toB64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return `${data}.${toB64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  // Whole body guarded: malformed base64 in a crafted token made fromB64url/atob THROW, which
  // bubbled to the global error handler as a 500 — an invalid token must simply be a 401.
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromB64url(parts[2]), enc.encode(data));
    if (!ok) return null;
    const payload: JwtPayload = JSON.parse(dec.decode(fromB64url(parts[1])));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── refresh tokens & ids ─────────────────────────────────────────────────────────
export function newRefreshToken(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newId(): string {
  return crypto.randomUUID();
}
