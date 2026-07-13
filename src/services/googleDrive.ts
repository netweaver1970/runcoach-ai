/**
 * Google Drive transport for the debug export ([[debugExport.ts]]). Connects the athlete's OWN Google
 * account (per-user isolation) and upserts the redacted dump to `runcoach-debug/latest.json` in their Drive,
 * where Claude (with a Drive connector) can read it on request.
 *
 * OAuth: expo-auth-session, iOS PKCE flow (public client, NO client secret). Scope = drive.file ONLY, so the
 * app can touch ONLY the files it creates — never the rest of the user's Drive. The client ID is public (it
 * ships in every copy of the app); the access/refresh tokens are the sensitive part and live in SecureStore.
 */
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from 'expo-secure-store';

WebBrowser.maybeCompleteAuthSession();

// Geert's Google OAuth **iOS** client ID (public — not a secret).
const IOS_CLIENT_ID = '426250935929-7t0lbdluj8mb8cic52qpf8qc2filg8nh.apps.googleusercontent.com';
// iOS OAuth redirects to the REVERSED client ID scheme (registered in app.json's CFBundleURLTypes).
const REVERSED = 'com.googleusercontent.apps.426250935929-7t0lbdluj8mb8cic52qpf8qc2filg8nh';
const REDIRECT_URI = AuthSession.makeRedirectUri({ native: `${REVERSED}:/oauth2redirect` });
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};
const TOK_KEY = 'gdrive_tokens_v1';
const FOLDER = 'runcoach-debug';
const FILE = 'latest.json';

interface Tokens { accessToken: string; refreshToken?: string; expiresAt: number; }

async function loadTokens(): Promise<Tokens | null> {
  try { const raw = await SecureStore.getItemAsync(TOK_KEY); return raw ? JSON.parse(raw) as Tokens : null; }
  catch { return null; }
}
async function saveTokens(t: { accessToken: string; refreshToken?: string; expiresIn?: number }, prevRefresh?: string): Promise<Tokens> {
  const tok: Tokens = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? prevRefresh,           // Google omits the refresh token on refresh — keep the old one
    expiresAt: Date.now() + ((t.expiresIn ?? 3600) * 1000),
  };
  try { await SecureStore.setItemAsync(TOK_KEY, JSON.stringify(tok)); } catch { /* ignore */ }
  return tok;
}

export async function isDriveConnected(): Promise<boolean> { return (await loadTokens()) != null; }
export async function disconnectDrive(): Promise<void> { try { await SecureStore.deleteItemAsync(TOK_KEY); } catch { /* ignore */ } }

/** Interactive sign-in (opens the Google consent sheet). Stores tokens on success. */
export async function connectDrive(): Promise<void> {
  const request = new AuthSession.AuthRequest({
    clientId: IOS_CLIENT_ID,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: { access_type: 'offline', prompt: 'consent' },   // ask for a refresh token
  });
  const result = await request.promptAsync(DISCOVERY);
  if (result.type !== 'success' || !result.params.code) {
    throw new Error(result.type === 'dismiss' || result.type === 'cancel' ? 'Sign-in cancelled.' : 'Google sign-in failed.');
  }
  const tok = await AuthSession.exchangeCodeAsync({
    clientId: IOS_CLIENT_ID,
    code: result.params.code,
    redirectUri: REDIRECT_URI,
    extraParams: { code_verifier: request.codeVerifier ?? '' },
  }, DISCOVERY);
  await saveTokens(tok);
}

async function validAccessToken(): Promise<string> {
  const stored = await loadTokens();
  if (!stored) throw new Error('Not connected to Google Drive — connect first.');
  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;   // still fresh (60s skew)
  if (!stored.refreshToken) { await disconnectDrive(); throw new Error('Drive session expired — reconnect.'); }
  const refreshed = await AuthSession.refreshAsync({ clientId: IOS_CLIENT_ID, refreshToken: stored.refreshToken }, DISCOVERY);
  const tok = await saveTokens(refreshed, stored.refreshToken);
  return tok.accessToken;
}

async function driveJson(url: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function findOrCreateFolder(token: string): Promise<string> {
  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`, token);
  if (found.files?.length) return found.files[0].id;
  const created = await driveJson('https://www.googleapis.com/drive/v3/files', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return created.id;
}

/** Upsert the redacted dump JSON to Drive's runcoach-debug/latest.json. Returns the folder link. */
export async function uploadDebugToDrive(json: string): Promise<{ folderId: string }> {
  const token = await validAccessToken();
  const folderId = await findOrCreateFolder(token);
  const q = encodeURIComponent(`name='${FILE}' and '${folderId}' in parents and trashed=false`);
  const existing = await driveJson(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id)`, token);
  const id = existing.files?.[0]?.id;
  if (id) {
    await driveJson(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json,
    });
  } else {
    const boundary = 'rc' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: FILE, parents: [folderId] });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    await driveJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', token, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
  }
  return { folderId };
}
