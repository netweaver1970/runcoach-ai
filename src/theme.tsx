/**
 * App theming — light / dark / follow-system.
 *
 * Screens build their StyleSheet from a `Palette` (semantic colour tokens) via
 * `useThemedStyles(makeStyles)`, so a single toggle re-themes the whole app.
 * Accent (#FF6B35) and status colours (green/red/etc.) are intentionally constant
 * across themes — only the structural greyscale (backgrounds, surfaces, text,
 * borders) flips.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, ColorSchemeName, StyleSheet } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface Palette {
  mode:        'light' | 'dark'; // resolved scheme
  bg:          string;  // screen background
  surface:     string;  // cards / panels
  surfaceAlt:  string;  // inputs / secondary surfaces
  text:        string;  // primary text
  textSub:     string;  // secondary text
  textFaint:   string;  // tertiary / hints
  border:      string;  // hairlines / dividers
  gridline:    string;  // chart gridlines
  accent:      string;  // brand orange
  onAccent:    string;  // text on accent
  shadowOpacity: number;
}

const LIGHT: Palette = {
  mode: 'light',
  bg:         '#F2F2F7',
  surface:    '#FFFFFF',
  surfaceAlt: '#F1F1F4',
  text:       '#1C1C1E',
  textSub:    '#6B7280',
  textFaint:  '#A0A4AB',
  border:     '#E4E4E9',
  gridline:   '#ECECEC',
  accent:     '#FF6B35',
  onAccent:   '#FFFFFF',
  shadowOpacity: 0.08,
};

const DARK: Palette = {
  mode: 'dark',
  bg:         '#0F0F11',
  surface:    '#1A1A1F',
  surfaceAlt: '#131318',
  text:       '#F5F5F7',
  textSub:    '#9CA3AF',
  textFaint:  '#6B7280',
  border:     '#2A2A30',
  gridline:   '#2A2A30',
  accent:     '#FF6B35',
  onAccent:   '#FFFFFF',
  shadowOpacity: 0.4,
};

const STORE_KEY = 'theme_mode_v1';

interface ThemeCtx {
  mode:    ThemeMode;        // user choice
  setMode: (m: ThemeMode) => void;
  c:       Palette;          // resolved palette
}

const Ctx = createContext<ThemeCtx>({ mode: 'system', setMode: () => {}, c: LIGHT });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [system, setSystem]  = useState<ColorSchemeName>(Appearance.getColorScheme());

  // Load persisted choice once
  useEffect(() => {
    SecureStore.getItemAsync(STORE_KEY)
      .then(v => { if (v === 'light' || v === 'dark' || v === 'system') setModeState(v); })
      .catch(() => {});
  }, []);

  // Track the OS scheme for 'system' mode
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSystem(colorScheme));
    return () => sub.remove();
  }, []);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    SecureStore.setItemAsync(STORE_KEY, m).catch(() => {});
  };

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
  const c = resolved === 'dark' ? DARK : LIGHT;

  const value = useMemo(() => ({ mode, setMode, c }), [mode, c]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

/** Build a memoised StyleSheet from the current palette. */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (c: Palette) => T,
): T {
  const { c } = useTheme();
  return useMemo(() => StyleSheet.create(factory(c)), [c, factory]);
}
