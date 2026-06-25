# RunCoachAI Cloud API

A tiny Cloudflare Worker + D1 database that backs the app's **external-coach mode**:
accounts, and syncing the athlete's derived training data to the cloud. Free tier, no
credit card. The phone app works fully without this — cloud sign-in is opt-in.

## What's here
- `src/index.ts` — Hono router: `/auth/*` and `/sync/*`.
- `src/crypto.ts` — PBKDF2 password hashing, HMAC-SHA256 JWTs, rotating refresh tokens (Web Crypto, no deps).
- `src/middleware.ts` — Bearer-token guard.
- `migrations/0001_init.sql` — the D1 schema.

## One-time setup (you run these — they need your Cloudflare login)
```bash
cd cloud
npm install

npx wrangler login                 # opens a browser; authorizes wrangler

npm run db:create                  # creates the "runcoach" D1 database
#   → copy the printed database_id into wrangler.toml (replace REPLACE_WITH_ID_FROM_db:create)

npm run db:migrate                 # applies migrations/0001_init.sql to the remote DB

npm run secret:jwt                 # paste a long random string when prompted
#   generate one with:  openssl rand -base64 48

npm run deploy                     # prints https://runcoach-api.<your-subdomain>.workers.dev
```

Then in the **app**: Settings → Cloud & Coach → Open Cloud Account → paste that URL into
**Server URL**, and create your account.

## Local development
```bash
cp .dev.vars.example .dev.vars     # set a dev JWT_SECRET
npm run db:migrate:local           # local SQLite copy
npm run dev                        # http://127.0.0.1:8787
```

## API (Milestone 1)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | – | create account → `{ user, accessToken, refreshToken }` |
| POST | `/auth/login` | – | sign in |
| POST | `/auth/refresh` | – | rotate tokens (old refresh is invalidated) |
| POST | `/auth/logout` | Bearer | revoke a refresh token |
| GET  | `/auth/me` | Bearer | current user |
| POST | `/sync/runs` | Bearer | batch-upsert runs `{ runs: [{id,date,json,updatedAt}] }` |
| POST | `/sync/days` | Bearer | batch-upsert daily metrics |
| GET  | `/sync/plans?from=` | Bearer | pull prescriptions (empty until a coach writes them, M3) |

Every `/sync` route is scoped to the caller's own `athlete_id`. Coach access to other
athletes (via `coach_links`) and prescription write-down land in Milestones 2–3.

## Security notes
- Passwords: PBKDF2-SHA256, random per-user salt, constant-time verify. Never stored in plain text.
  Iterations are capped (100k) to fit the Workers per-request CPU budget — raise on a paid plan.
- Access JWT: HS256, 1-hour TTL. Refresh: 256-bit random, stored only as a SHA-256 hash, **rotated on every use**.
- `JWT_SECRET` is a Worker secret, never committed. `.dev.vars` is gitignored.
- Login returns a generic error (no account-existence leak).
- **TODO (follow-up):** add login rate-limiting (needs KV or a D1 attempt counter).

## Free-tier limits (plenty for personal / small-circle use)
D1: 5 GB storage, 5M row-reads/day, 100k writes/day. Workers: 100k requests/day.
