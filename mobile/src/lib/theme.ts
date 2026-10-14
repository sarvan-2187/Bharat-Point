/**
 * Retro-ATM palette: high contrast, large type, readable in sunlight on a
 * cheap phone. Every screen takes colours from here, never inline hex.
 */
export const colors = {
  bg: '#0B0F0C',
  panel: '#141A16',
  text: '#E8F5E9',
  muted: '#9DB5A3',
  accent: '#FFC94D', // amber, the "screen glow"
  ok: '#4ADE80',
  danger: '#F87171',
  border: '#2A3A2F',
} as const;

export const size = {
  body: 18,
  title: 28,
  button: 22,
  pad: 16,
} as const;
