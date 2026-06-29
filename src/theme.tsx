/**
 * App theming — light / dark / follow-system.
 *
 * Screens build their StyleSheet from a `Palette` (semantic colour tokens) via
 * `useThemedStyles(makeStyles)`, so a single toggle re-themes the whole app.
 * The accent is user-selectable (ACCENT_OPTIONS, persisted) and stays the same in
 * light and dark; status colours (green/red/etc.) are also constant — only the
 * structural greyscale (backgrounds, surfaces, text, borders) flips with the theme.
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
  bg:         '#E7E8EE',  // a touch darker so white cards stand out
  surface:    '#FFFFFF',
  surfaceAlt: '#EDEDF2',
  text:       '#16161A',
  textSub:    '#5B616B',
  textFaint:  '#9A9EA6',
  border:     '#D5D6DD',
  gridline:   '#E2E2E8',
  accent:     '#FF6B35',
  onAccent:   '#FFFFFF',
  shadowOpacity: 0.12,
};

const DARK: Palette = {
  mode: 'dark',
  bg:         '#08080A',  // deeper background
  surface:    '#1E1F26',  // lighter cards → more separation
  surfaceAlt: '#15161B',
  text:       '#F5F5F7',
  textSub:    '#A1A6B0',
  textFaint:  '#6B7280',
  border:     '#34353F',  // stronger hairlines
  gridline:   '#2E2F38',
  accent:     '#FF6B35',
  onAccent:   '#FFFFFF',
  shadowOpacity: 0.5,
};

const STORE_KEY = 'theme_mode_v1';
const FONT_KEY  = 'font_scale_v1';
const ACCENT_KEY = 'accent_color_v1';

// User-selectable brand accent. All saturated + dark enough that white text on them (onAccent) stays
// readable, and legible on both the light and dark structural palettes. First entry is the default.
export const ACCENT_OPTIONS = ['#FF6B35', '#E5484D', '#D6409F', '#8E4EC6', '#3E63DD', '#0B7285', '#2F9E44', '#B45309'];
export const DEFAULT_ACCENT = ACCENT_OPTIONS[0];

// Two larger steps above the default — modest enough to avoid layout breakage.
export type FontSizeStep = 0 | 1 | 2;
export const FONT_SCALES: Record<FontSizeStep, number> = { 0: 1, 1: 1.15, 2: 1.3 };

interface ThemeCtx {
  mode:    ThemeMode;        // user choice
  setMode: (m: ThemeMode) => void;
  c:       Palette;          // resolved palette
  accent:    string;         // selected brand accent
  setAccent: (col: string) => void;
  fontStep:    FontSizeStep; // 0 = default, 1 / 2 = larger
  setFontStep: (s: FontSizeStep) => void;
  fontScale:   number;       // resolved multiplier
}

const Ctx = createContext<ThemeCtx>({
  mode: 'system', setMode: () => {}, c: LIGHT,
  accent: DEFAULT_ACCENT, setAccent: () => {},
  fontStep: 0, setFontStep: () => {}, fontScale: 1,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [system, setSystem]  = useState<ColorSchemeName>(Appearance.getColorScheme());
  const [fontStep, setFontStepState] = useState<FontSizeStep>(0);
  const [accent, setAccentState] = useState<string>(DEFAULT_ACCENT);

  // Load persisted choices once
  useEffect(() => {
    SecureStore.getItemAsync(STORE_KEY)
      .then(v => { if (v === 'light' || v === 'dark' || v === 'system') setModeState(v); })
      .catch(() => {});
    SecureStore.getItemAsync(FONT_KEY)
      .then(v => { const n = Number(v); if (n === 0 || n === 1 || n === 2) setFontStepState(n as FontSizeStep); })
      .catch(() => {});
    SecureStore.getItemAsync(ACCENT_KEY)
      .then(v => { if (v && /^#[0-9A-Fa-f]{6}$/.test(v)) setAccentState(v); })
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

  const setFontStep = (s: FontSizeStep) => {
    setFontStepState(s);
    SecureStore.setItemAsync(FONT_KEY, String(s)).catch(() => {});
  };

  const setAccent = (col: string) => {
    setAccentState(col);
    SecureStore.setItemAsync(ACCENT_KEY, col).catch(() => {});
  };

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
  const base = resolved === 'dark' ? DARK : LIGHT;
  const c = useMemo(() => ({ ...base, accent }), [base, accent]); // brand accent overrides the palette default
  const fontScale = FONT_SCALES[fontStep];

  const value = useMemo(
    () => ({ mode, setMode, c, accent, setAccent, fontStep, setFontStep, fontScale }),
    [mode, c, accent, fontStep, fontScale],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}

/**
 * Build a memoised StyleSheet from the current palette, scaled by the global font
 * step. Every screen uses this, so one setting enlarges text app-wide — we multiply
 * fontSize (and lineHeight, to keep leading proportional) on every style that has them.
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (c: Palette) => T,
): T {
  const { c, fontScale } = useTheme();
  return useMemo(() => {
    const raw = factory(c) as Record<string, any>;
    if (fontScale === 1) return StyleSheet.create(raw as any);
    const scaled: Record<string, any> = {};
    for (const k in raw) {
      const s = raw[k];
      if (s && typeof s === 'object' && typeof s.fontSize === 'number') {
        scaled[k] = {
          ...s,
          fontSize: Math.round(s.fontSize * fontScale * 10) / 10,
          ...(typeof s.lineHeight === 'number'
            ? { lineHeight: Math.round(s.lineHeight * fontScale) }
            : {}),
        };
      } else {
        scaled[k] = s;
      }
    }
    return StyleSheet.create(scaled as any);
  }, [c, fontScale, factory]);
}
