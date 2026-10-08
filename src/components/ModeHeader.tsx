import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../theme';

// The ONE header of the main mode screens (Biology / Strength / Food), modelled on Biology's: a sticky bar with the
// 🏠 button, the mode title, then the mode's action icons on the right; optional extra rows (range tabs, day nav)
// go in `children`. Keeps every mode's top the same (Geert, 2026-10-08: "harmonize… take the Biology screen").
export interface ModeAction { icon: string; onPress: () => void; off?: boolean; disabled?: boolean; label?: string }
// showHome=false on Home itself (nothing to go back to); insetTop=false when the screen already sits in a SafeAreaView.
export function ModeHeader({ title, actions = [], loading, children, showHome = true, insetTop = true }: {
  title: string; actions?: ModeAction[]; loading?: boolean; children?: React.ReactNode; showHome?: boolean; insetTop?: boolean;
}) {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // the app-wide status bar is 'light' (white, for the orange native headers); this header sits on the theme
  // background → dark icons on a light theme while a mode screen is in front, back to light when it isn't
  useFocusEffect(React.useCallback(() => {
    setStatusBarStyle(c.mode === 'dark' ? 'light' : 'dark');
    return () => setStatusBarStyle('light');
  }, [c.mode]));
  return (
    <View style={[s.header, { paddingTop: (insetTop ? insets.top : 0) + 4 }]}>
      <View style={[s.headerTop, !children && { marginBottom: 0 }]}>
        {showHome && (
          <TouchableOpacity style={s.homeBtn} onPress={() => (router.canGoBack() ? router.back() : router.replace('/' as any))} accessibilityLabel="Home">
            <Text style={s.homeBtnTxt}>🏠</Text>
          </TouchableOpacity>
        )}
        <Text style={s.hTitle} numberOfLines={1}>{title}</Text>
        <View style={{ flex: 1 }} />
        {loading && <ActivityIndicator size="small" color={c.accent} style={{ marginRight: 8 }} />}
        {actions.map((a, i) => (
          <TouchableOpacity key={i} style={[s.btn, a.off && s.btnOff]} disabled={a.disabled} onPress={a.onPress} accessibilityLabel={a.label}>
            <Text style={[s.btnTxt, (a.off || a.disabled) && s.btnTxtOff]}>{a.icon}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {children}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  header:    { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, minHeight: 52, backgroundColor: c.bg, borderBottomWidth: 1, borderColor: c.border },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  homeBtn:   { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 20 },
  hTitle:    { color: c.text, fontSize: 18, fontWeight: '800', flexShrink: 1 },
  btn:       { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  btnOff:    { opacity: 0.55 },
  btnTxt:    { color: c.text, fontSize: 20, fontWeight: '600' },
  btnTxtOff: { opacity: 0.5 },
});
