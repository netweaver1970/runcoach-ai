import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';

export const MODES = [
  { key: 'home', emoji: '🏠', label: 'Home', route: null as string | null },
  { key: 'strength', emoji: '🏋️', label: 'Strength', route: '/fitness' },
  { key: 'food', emoji: '🍽️', label: 'Food', route: '/food' },
  { key: 'biology', emoji: '🧬', label: 'Biology', route: '/biology' },
];
const AUTO_CLOSE_MS = 4000;

/**
 * Floating mode switcher: the ☰ button slides open a compact 4-icon panel beside it (no full-screen sheet), which
 * closes by itself after a few seconds if nothing is tapped, or on a second ☰ tap.
 */
export function ModeSwitcher({ current = 'home' }: { current?: string }) {
  const { c } = useTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Animated.timing(anim, { toValue: open ? 1 : 0, duration: open ? 220 : 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (open) timer.current = setTimeout(() => setOpen(false), AUTO_CLOSE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [open, anim]);

  const go = (route: string | null) => {
    setOpen(false);
    if (route) router.push(route as any);
    else if (current !== 'home') router.dismissTo?.('/' as any);
  };

  return (
    <View pointerEvents="box-none" style={s.wrap}>
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[s.panel, { backgroundColor: c.surface, borderColor: c.border, opacity: anim,
          transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }, { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}
      >
        {MODES.map(m => {
          const here = m.key === current;
          return (
            <TouchableOpacity key={m.key} disabled={here} onPress={() => go(m.route)} style={s.item} accessibilityLabel={`${m.label} mode`}>
              <View style={[s.icon, { backgroundColor: here ? c.accent : c.surfaceAlt, borderColor: here ? c.accent : c.border }]}>
                <Text style={s.emoji}>{m.emoji}</Text>
              </View>
              <Text style={[s.lbl, { color: here ? c.accent : c.textSub }]}>{m.label}</Text>
            </TouchableOpacity>
          );
        })}
      </Animated.View>
      <TouchableOpacity
        style={[s.fab, { backgroundColor: c.accent }]}
        onPress={() => setOpen(o => !o)}
        accessibilityLabel={open ? 'Close modes' : 'Switch mode'}
      >
        <Text style={{ color: c.onAccent, fontSize: 18, fontWeight: '800' }}>{open ? '✕' : '☰'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap:  { position: 'absolute', bottom: 22, right: 18, flexDirection: 'row', alignItems: 'center', gap: 10 },
  panel: { flexDirection: 'row', gap: 4, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 30, borderWidth: 1,
           shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  item:  { alignItems: 'center', width: 56 },
  icon:  { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  emoji: { fontSize: 20 },
  lbl:   { fontSize: 10, fontWeight: '700', marginTop: 2 },
  fab:   { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
           shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 5 },
});
