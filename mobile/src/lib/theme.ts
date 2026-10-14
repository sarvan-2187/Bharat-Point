/**
 * Colours and sizes. Dark is the sunlight-friendly "retro ATM" look; light is
 * the same layout on paper white. The choice (system / light / dark) is kept
 * on this phone. Screens call useTheme() and build their styles from the
 * returned colours, never inline hex.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { getItem, setItem } from './storage';

const dark = {
  bg: '#0B0F0C',
  panel: '#141A16',
  text: '#F1FAF2',
  muted: '#B4C9B9',
  accent: '#FFC94D', // amber, the "screen glow"
  ok: '#4ADE80',
  warn: '#FBBF24',
  danger: '#F87171',
  border: '#2A3B30',
};

const light: typeof dark = {
  bg: '#F4F7F3',
  panel: '#FFFFFF',
  text: '#14201A',
  muted: '#475A4D',
  accent: '#A8560A', // deep amber: readable as text and as a button fill on white
  ok: '#15803D',
  warn: '#A16207',
  danger: '#B91C1C',
  border: '#D3DED6',
};

export type Colors = typeof dark;
export type Mode = 'system' | 'light' | 'dark';

export const size = {
  small: 16,
  body: 18,
  title: 28,
  button: 22,
  pad: 16,
  radius: 16,
} as const;

const KEY = 'bp.theme.mode';

interface ThemeValue {
  colors: Colors;
  scheme: 'light' | 'dark';
  mode: Mode;
  setMode: (mode: Mode) => void;
}

const ThemeContext = createContext<ThemeValue>({ colors: dark, scheme: 'dark', mode: 'system', setMode: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>('system');

  useEffect(() => {
    getItem(KEY)
      .then((v) => (v === 'light' || v === 'dark' || v === 'system' ? setModeState(v) : undefined))
      .catch(() => {}); // a missing preference just means "follow the phone"
  }, []);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    setItem(KEY, next).catch(() => {});
  }, []);

  const value = useMemo<ThemeValue>(() => {
    const scheme = mode === 'system' ? (system === 'light' ? 'light' : 'dark') : mode;
    return { colors: scheme === 'light' ? light : dark, scheme, mode, setMode };
  }, [mode, system, setMode]);

  return createElement(ThemeContext.Provider, { value }, children);
}

export const useTheme = () => useContext(ThemeContext);
