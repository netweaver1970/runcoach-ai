export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
}

/** Hono generic: D1 binding + per-request auth vars set by requireAuth. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    role: string;
  };
};
