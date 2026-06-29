import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { getCurrentUser, login, signup, logout, CloudUser, CloudRole } from '../src/services/auth';
import { getBaseUrl, setBaseUrl } from '../src/services/api';
import { syncSnapshot, getLastSync } from '../src/services/cloudSync';
import { loadSnapshotCache } from '../src/services/healthkit';

type Mode = 'login' | 'signup';

export default function AccountScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [baseUrl, setUrl] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<CloudRole>('athlete');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getCurrentUser(), getBaseUrl(), getLastSync()])
      .then(([u, url, ls]) => { setUser(u); setUrl(url ?? ''); setLastSync(ls); })
      .finally(() => setLoading(false));
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submit = async () => {
    const url = baseUrl.trim();
    if (!url) { Alert.alert('Server URL needed', 'Enter your Cloudflare Worker URL first.'); return; }
    if (!/^https?:\/\//i.test(url)) { Alert.alert('Invalid URL', 'The server URL should start with https://'); return; }
    if (!email.trim() || !password) { Alert.alert('Missing details', 'Enter your email and password.'); return; }
    if (mode === 'signup' && password.length < 8) { Alert.alert('Weak password', 'Use at least 8 characters.'); return; }
    if (mode === 'signup' && password !== confirm) { Alert.alert("Passwords don't match", 'Re-enter the same password in both fields.'); return; }
    setBusy(true);
    try {
      await setBaseUrl(url);
      const u = mode === 'signup'
        ? await signup(email.trim(), password, { name: name.trim() || undefined, role })
        : await login(email.trim(), password);
      setUser(u);
      setPassword('');
      setConfirm('');
    } catch (e: any) {
      Alert.alert(mode === 'signup' ? 'Sign-up failed' : 'Sign-in failed', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const doSync = async () => {
    setSyncing(true);
    try {
      const snap = await loadSnapshotCache();
      if (!snap) { Alert.alert('No data yet', 'Open the home screen first so your data is loaded, then sync.'); return; }
      const r = await syncSnapshot(snap);
      setLastSync(r.at);
      Alert.alert('Synced', `${r.runs} runs and ${r.days} days uploaded.`);
    } catch (e: any) {
      Alert.alert('Sync failed', e?.message ?? String(e));
    } finally {
      setSyncing(false);
    }
  };

  const doLogout = () => {
    Alert.alert('Sign out', 'Sign out of your cloud account on this device? Your local data stays.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => { await logout(); setUser(null); } },
    ]);
  };

  const fmtSync = (iso: string | null) => {
    if (!iso) return 'never';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Cloud Account</Text>
        <View style={{ width: 44 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          {loading ? (
            <ActivityIndicator size="small" color={c.accent} style={{ marginTop: 24 }} />
          ) : user ? (
            // ── Signed in ────────────────────────────────────────────────────────
            <>
              <View style={s.card}>
                <Text style={s.label}>Signed in as</Text>
                <Text style={s.email}>{user.email}</Text>
                <View style={s.roleBadge}><Text style={s.roleBadgeText}>{user.role}</Text></View>
                {!!user.name && <Text style={s.sub}>{user.name}</Text>}
              </View>

              <View style={s.card}>
                <Text style={s.label}>Sync</Text>
                <Text style={s.sub}>Last synced: {fmtSync(lastSync)}</Text>
                <Text style={s.hint}>
                  Uploads your runs and daily readiness/strain/CTL-ATL so a coach can see them. Only derived
                  data is sent — never your raw HealthKit caches. Sync also runs automatically after each scan.
                </Text>
                <TouchableOpacity style={[s.btn, syncing && { opacity: 0.6 }]} disabled={syncing} onPress={doSync}>
                  <Text style={s.btnText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={s.card} activeOpacity={0.7} onPress={() => router.push('/coach' as any)}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.label}>Human Coach</Text>
                    <Text style={s.sub}>Invite a coach, or coach other athletes</Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={doLogout}>
                <Text style={[s.btnText, { color: '#E2553B' }]}>Sign out</Text>
              </TouchableOpacity>

              <Text style={s.privacy}>
                Server: {baseUrl || 'not set'}
              </Text>
            </>
          ) : (
            // ── Signed out ───────────────────────────────────────────────────────
            <>
              <Text style={s.intro}>
                Sign in to sync your training to the cloud and (soon) let an external coach view your data and
                prescribe workouts. The app works fully without this — cloud is optional.
              </Text>

              <Text style={s.fieldLabel}>Server URL</Text>
              <TextInput
                style={s.input}
                value={baseUrl}
                onChangeText={setUrl}
                placeholder="https://runcoach-api.runcoach-1970.workers.dev"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <View style={s.segment}>
                <TouchableOpacity
                  style={[s.segBtn, mode === 'login' && s.segBtnActive]}
                  onPress={() => setMode('login')}
                >
                  <Text style={[s.segText, mode === 'login' && s.segTextActive]}>Sign in</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.segBtn, mode === 'signup' && s.segBtnActive]}
                  onPress={() => setMode('signup')}
                >
                  <Text style={[s.segText, mode === 'signup' && s.segTextActive]}>Create account</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.fieldLabel}>Email</Text>
              <TextInput
                style={s.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />

              <Text style={s.fieldLabel}>Password</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder={mode === 'signup' ? 'at least 8 characters' : 'your password'}
                placeholderTextColor="#999"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />

              {mode === 'signup' && (
                <>
                  <Text style={s.fieldLabel}>Confirm password</Text>
                  <TextInput
                    style={s.input}
                    value={confirm}
                    onChangeText={setConfirm}
                    placeholder="re-enter password"
                    placeholderTextColor="#999"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {confirm.length > 0 && password !== confirm && (
                    <Text style={s.mismatch}>Passwords don't match</Text>
                  )}

                  <Text style={s.fieldLabel}>Name (optional)</Text>
                  <TextInput
                    style={s.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="Geert"
                    placeholderTextColor="#999"
                  />
                  <Text style={s.fieldLabel}>I am a…</Text>
                  <View style={s.segment}>
                    <TouchableOpacity
                      style={[s.segBtn, role === 'athlete' && s.segBtnActive]}
                      onPress={() => setRole('athlete')}
                    >
                      <Text style={[s.segText, role === 'athlete' && s.segTextActive]}>Athlete</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.segBtn, role === 'coach' && s.segBtnActive]}
                      onPress={() => setRole('coach')}
                    >
                      <Text style={[s.segText, role === 'coach' && s.segTextActive]}>Human Coach</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {(() => {
                const blocked = busy || (mode === 'signup' && (password.length < 8 || password !== confirm));
                return (
                  <TouchableOpacity style={[s.btn, blocked && { opacity: 0.6 }]} disabled={blocked} onPress={submit}>
                    <Text style={s.btnText}>
                      {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
                    </Text>
                  </TouchableOpacity>
                );
              })()}

              <Text style={s.privacy}>
                Your password is hashed on the server (PBKDF2) and never stored in plain text. Health data is sent
                over HTTPS and only after you sign in.
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  scroll: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 18 },

  card: {
    backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  label: { fontSize: 11, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  email: { fontSize: 18, fontWeight: '700', color: c.text },
  sub: { fontSize: 13, color: c.textSub, marginTop: 4 },
  hint: { fontSize: 12, color: c.textFaint, lineHeight: 17, marginTop: 8 },
  mismatch: { fontSize: 12, color: '#E2553B', marginTop: -6, marginBottom: 10, fontWeight: '600' },
  chev: { fontSize: 22, color: c.textFaint, marginLeft: 8 },
  roleBadge: {
    alignSelf: 'flex-start', marginTop: 6, backgroundColor: c.accent + '22',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5,
  },
  roleBadgeText: { fontSize: 10, fontWeight: '800', color: c.accent, textTransform: 'uppercase', letterSpacing: 0.5 },

  fieldLabel: { fontSize: 13, fontWeight: '600', color: c.textSub, marginBottom: 6, marginTop: 6 },
  input: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: c.text, marginBottom: 12,
  },

  segment: {
    flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 3, marginBottom: 14,
  },
  segBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segBtnActive: { backgroundColor: c.surface, shadowColor: '#000', shadowOpacity: c.shadowOpacity, shadowRadius: 2, elevation: 1 },
  segText: { fontSize: 14, fontWeight: '600', color: c.textSub },
  segTextActive: { color: c.text },

  btn: {
    backgroundColor: c.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4,
  },
  btnGhost: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, marginTop: 4 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  privacy: { fontSize: 11, color: c.textFaint, lineHeight: 16, marginTop: 16 },
});
