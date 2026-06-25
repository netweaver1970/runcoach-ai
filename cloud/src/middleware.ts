import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from './crypto';
import type { AppEnv } from './types';

/** Require a valid Bearer access token; sets `userId` / `role` on the context. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  const payload = await verifyJwt(m[1], c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', payload.sub);
  c.set('role', payload.role);
  await next();
};
