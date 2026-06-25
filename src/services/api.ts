/**
 * Thin HTTP client for the RunCoachAI cloud API (Cloudflare Worker).
 *
 * - Base URL is user-configured (Settings → Cloud) and stored in SecureStore, so the app
 *   ships without a hardcoded server and works fully offline / logged-out.
 * - Attaches the access token, and on a 401 transparently refreshes once and retries.
 * - Tokens live in the iOS Keychain via expo-secure-store.
 */
import * as SecureStore from 'expo-secure-store';

const K_BASE = 'cloud_base_url';
const K_ACCESS = 'cloud_access_token';
const K_REFRESH = 'cloud_refresh_token';

export async function getBaseUrl(): Promise<string | null> {
  const v = await SecureStore.getItemAsync(K_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : null;
}
export async function setBaseUrl(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean) await SecureStore.setItemAsync(K_BASE, clean);
  else await SecureStore.deleteItemAsync(K_BASE);
}

export async function setTokens(access: string, refresh: string): Promise<void> {
  await SecureStore.setItemAsync(K_ACCESS, access);
  await SecureStore.setItemAsync(K_REFRESH, refresh);
}
export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(K_REFRESH);
}
export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(K_ACCESS);
  await SecureStore.deleteItemAsync(K_REFRESH);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function tryRefresh(base: string): Promise<boolean> {
  const refresh = await SecureStore.getItemAsync(K_REFRESH);
  if (!refresh) return false;
  try {
    const res = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data?.accessToken && data?.refreshToken) {
      await setTokens(data.accessToken, data.refreshToken);
      return true;
    }
  } catch { /* network — fall through */ }
  return false;
}

export interface ApiOpts {
  method?: string;
  body?: unknown;
  auth?: boolean; // default true
}

export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  const base = await getBaseUrl();
  if (!base) throw new ApiError(0, 'Cloud server URL not set (Settings → Cloud).');

  const method = opts.method || 'GET';
  const useAuth = opts.auth !== false;

  const buildHeaders = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useAuth) {
      const access = await SecureStore.getItemAsync(K_ACCESS);
      if (access) h['Authorization'] = `Bearer ${access}`;
    }
    return h;
  };

  const doFetch = async () =>
    fetch(`${base}${path}`, {
      method,
      headers: await buildHeaders(),
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    throw new ApiError(0, 'Network error — is the server URL correct and online?');
  }

  if (res.status === 401 && useAuth) {
    if (await tryRefresh(base)) {
      try { res = await doFetch(); } catch { throw new ApiError(0, 'Network error.'); }
    }
  }

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`);
  }
  return data as T;
}
