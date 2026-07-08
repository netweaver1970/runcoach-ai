/**
 * Thin HTTP client for the RunCoachAI cloud API (Cloudflare Worker).
 *
 * - Base URL defaults to the deployed Worker (DEFAULT_BASE_URL) so the app works out of the box
 *   (incl. fresh TestFlight installs); a user-entered URL (Settings → Cloud) overrides it. Stored
 *   in SecureStore. The token gates access, so the app still works fully offline / logged-out.
 * - Attaches the access token, and on a 401 transparently refreshes once and retries.
 * - Tokens live in the iOS Keychain via expo-secure-store.
 */
import * as SecureStore from 'expo-secure-store';

const K_BASE = 'cloud_base_url';
const K_ACCESS = 'cloud_access_token';
const K_REFRESH = 'cloud_refresh_token';

// Geert's deployed Cloudflare Worker — the built-in default so the app + TestFlight builds work
// without anyone hand-typing it. A URL entered in Settings → Cloud is stored and overrides this.
export const DEFAULT_BASE_URL = 'https://runcoach-api.runcoach-1970.workers.dev';
export async function getBaseUrl(): Promise<string> {
  const v = await SecureStore.getItemAsync(K_BASE);
  return v && v.trim() ? v.trim().replace(/\/+$/, '') : DEFAULT_BASE_URL;
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

// Single-flight token refresh. A batched cloudSync fires several requests at once; once the access
// token expires they ALL 401 together. Without a shared lock each one refreshes independently — the
// first rotates the refresh token and the rest present the now-stale one, which the server's
// reuse-detection reads as a stolen-token replay and revokes the whole family (silent logout). So
// concurrent callers must await the SAME rotation; the winner stores the new tokens and everyone
// retries with them.
let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(base: string): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(base).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefresh(base: string): Promise<boolean> {
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
