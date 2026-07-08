export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
    PW_PEPPER?: string; // optional Worker secret — peppers password hashes (see crypto.ts)
}

/** Hono generic: D1 binding + per-request auth vars set by requireAuth. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    role: string;
  };
};
