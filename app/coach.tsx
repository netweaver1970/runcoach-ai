import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView,
  TextInput, ActivityIndicator, Alert, Share,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { getCurrentUser, CloudUser } from '../src/services/auth';
import {
  createInvite, acceptInvite, listLinks, listAthletes, removeLink, CoachLink, AthleteRef,
} from '../src/services/coachLink';

// Both roles are always available: anyone can be coached AND coach others (the account's
// signup `role` is only a hint — the cloud links aren't role-restricted).
export default function CoachScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [links, setLinks] = useState<CoachLink[]>([]);
  const [athletes, setAthletes] = useState<AthleteRef[]>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [busyInvite, setBusyInvite] = useState(false);
  const [busyRedeem, setBusyRedeem] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getCurrentUser().then(async (u) => {
      setUser(u);
      if (!u) return;
      try {
        const ls = await listLinks();
        setLinks(ls);
        const pend = ls.find((l) => l.role === 'athlete' && l.status === 'pending');
        setInvite(pend?.inviteCode ?? null);
        setAthletes(await listAthletes());
      } catch { /* show empty */ }
    }).finally(() => setLoading(false));
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const genInvite = async () => {
    setBusyInvite(true);
    try { setInvite(await createInvite()); }
    catch (e: any) { Alert.alert('Could not create code', e?.message ?? String(e)); }
    finally { setBusyInvite(false); }
  };

  const shareInvite = () => {
    if (!invite) return;
    Share.share({ message: `Coach me on RunCoachAI — enter this invite code in the app: ${invite}` }).catch(() => {});
  };

  const redeem = async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    setBusyRedeem(true);
    try {
      const ath = await acceptInvite(code);
      setCodeInput('');
      Alert.alert('Linked', `You're now coaching ${ath.name || ath.email}.`);
      load();
    } catch (e: any) {
      Alert.alert('Could not link', e?.message ?? String(e));
    } finally { setBusyRedeem(false); }
  };

  const unlink = (id: string, who: string) => {
    Alert.alert('Unlink', `Remove the link with ${who}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlink', style: 'destructive', onPress: async () => { try { await removeLink(id); load(); } catch (e: any) { Alert.alert('Failed', e?.message ?? String(e)); } } },
    ]);
  };

  const myCoaches = links.filter((l) => l.role === 'athlete' && l.status === 'accepted');

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Human Coach</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        {loading ? (
          <ActivityIndicator size="small" color={c.accent} style={{ marginTop: 24 }} />
        ) : !user ? (
          <View style={s.card}>
            <Text style={s.hint}>Sign in to your cloud account first.</Text>
            <TouchableOpacity style={s.btn} onPress={() => router.replace('/account' as any)}>
              <Text style={s.btnText}>Open Cloud Account</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* ── Be coached ──────────────────────────────────────────────────── */}
            <Text style={s.bigSection}>Be coached</Text>
            <View style={s.card}>
              <Text style={s.label}>Invite your coach</Text>
              <Text style={s.hint}>
                Generate a code and share it with your coach. Once they enter it, they can see your runs and
                daily readiness — read-only. You can unlink any time.
              </Text>
              {invite ? (
                <>
                  <Text style={s.code}>{invite}</Text>
                  <TouchableOpacity style={s.btn} onPress={shareInvite}>
                    <Text style={s.btnText}>Share code</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={genInvite} disabled={busyInvite}>
                    <Text style={[s.btnText, { color: c.accent }]}>New code</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity style={[s.btn, busyInvite && { opacity: 0.6 }]} disabled={busyInvite} onPress={genInvite}>
                  <Text style={s.btnText}>{busyInvite ? 'Generating…' : 'Generate invite code'}</Text>
                </TouchableOpacity>
              )}
            </View>

            <Text style={s.section}>Your coaches</Text>
            {myCoaches.length === 0 ? (
              <Text style={s.empty}>No coach linked yet. Share an invite code above.</Text>
            ) : (
              myCoaches.map((l) => (
                <View key={l.id} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{l.coach?.name || l.coach?.email}</Text>
                    {!!l.coach?.name && <Text style={s.rowSub}>{l.coach?.email}</Text>}
                  </View>
                  <TouchableOpacity onPress={() => unlink(l.id, l.coach?.name || l.coach?.email || 'this coach')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={s.unlink}>Unlink</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            {/* ── Coach others ────────────────────────────────────────────────── */}
            <Text style={[s.bigSection, { marginTop: 22 }]}>Coach others</Text>
            <View style={s.card}>
              <Text style={s.label}>Link an athlete</Text>
              <Text style={s.hint}>Enter the invite code an athlete generated to start following their training.</Text>
              <TextInput
                style={s.codeField}
                value={codeInput}
                onChangeText={(t) => setCodeInput(t.toUpperCase())}
                placeholder="ABC123"
                placeholderTextColor="#999"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={8}
              />
              <TouchableOpacity style={[s.btn, busyRedeem && { opacity: 0.6 }]} disabled={busyRedeem} onPress={redeem}>
                <Text style={s.btnText}>{busyRedeem ? 'Linking…' : 'Link athlete'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.section}>My athletes</Text>
            {athletes.length === 0 ? (
              <Text style={s.empty}>No athletes yet. Link one with an invite code above.</Text>
            ) : (
              athletes.map((a) => (
                <TouchableOpacity
                  key={a.id}
                  style={s.row}
                  activeOpacity={0.7}
                  onPress={() => router.push({ pathname: '/coach-athlete' as any, params: { id: a.id, name: a.name || a.email } })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{a.name || a.email}</Text>
                    {!!a.name && <Text style={s.rowSub}>{a.email}</Text>}
                  </View>
                  <Text style={s.chev}>›</Text>
                </TouchableOpacity>
              ))
            )}
          </>
        )}
      </ScrollView>
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

  bigSection: { fontSize: 18, fontWeight: '800', color: c.text, marginBottom: 10, marginLeft: 2 },
  card: {
    backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  label: { fontSize: 11, fontWeight: '700', color: c.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  hint: { fontSize: 12.5, color: c.textSub, lineHeight: 18, marginBottom: 10 },
  section: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 8, marginLeft: 2 },
  empty: { fontSize: 13, color: c.textFaint, marginLeft: 2, marginBottom: 8 },

  code: {
    fontSize: 34, fontWeight: '800', letterSpacing: 6, color: c.text, textAlign: 'center',
    marginVertical: 12, fontVariant: ['tabular-nums'],
  },
  codeField: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, fontSize: 22, letterSpacing: 4, fontWeight: '700',
    color: c.text, textAlign: 'center', marginBottom: 12,
  },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  rowName: { fontSize: 15, fontWeight: '700', color: c.text },
  rowSub: { fontSize: 12, color: c.textFaint, marginTop: 2 },
  chev: { fontSize: 20, color: c.textFaint },
  unlink: { fontSize: 13, color: '#E2553B', fontWeight: '700' },

  btn: { backgroundColor: c.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  btnGhost: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent, marginTop: 8 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
