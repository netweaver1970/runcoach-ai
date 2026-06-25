/**
 * Cloud account session for RunCoachAI.
 *
 * The app is fully usable signed-out (local-only); cloud sign-in is opt-in and only
 * gates the cloud-sync features. Current user + tokens are kept in the iOS Keychain.
 */
import * as SecureStore from 'expo-secure-store';
import { api, setTokens, clearTokens, getRefreshToken } from './api';

const K_USER = 'cloud_user';

export type CloudRole = 'athlete' | 'coach';
export interface CloudUser {
  id: string;
  email: string;
  name?: string | null;
  role: CloudRole;
}

export async function getCurrentUser(): Promise<CloudUser | null> {
  const raw = await SecureStore.getItemAsync(K_USER);
  if (!raw) return null;
  try { return JSON.parse(raw) as CloudUser; } catch { return null; }
}
async function setCurrentUser(u: CloudUser | null): Promise<void> {
  if (u) await SecureStore.setItemAsync(K_USER, JSON.stringify(u));
  else await SecureStore.deleteItemAsync(K_USER);
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getCurrentUser()) != null;
}

async function adopt(data: any): Promise<CloudUser> {
  await setTokens(data.accessToken, data.refreshToken);
  await setCurrentUser(data.user);
  return data.user as CloudUser;
}

export async function signup(
  email: string,
  password: string,
  opts?: { name?: string; role?: CloudRole },
): Promise<CloudUser> {
  const data = await api('/auth/signup', {
    method: 'POST',
    auth: false,
    body: { email, password, name: opts?.name, role: opts?.role },
  });
  return adopt(data);
}

export async function login(email: string, password: string): Promise<CloudUser> {
  const data = await api('/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password },
  });
  return adopt(data);
}

export async function logout(): Promise<void> {
  try {
    const refreshToken = await getRefreshToken();
    if (refreshToken) await api('/auth/logout', { method: 'POST', body: { refreshToken } });
  } catch { /* best-effort revoke */ }
  await clearTokens();
  await setCurrentUser(null);
}

/** Re-fetch the user from the server (validates the session); null if it fails. */
export async function refreshMe(): Promise<CloudUser | null> {
  try {
    const data = await api('/auth/me');
    if (data?.user) { await setCurrentUser(data.user); return data.user as CloudUser; }
  } catch { /* offline or expired */ }
  return null;
}
