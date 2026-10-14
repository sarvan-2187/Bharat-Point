import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, type Href } from 'expo-router';
import { api, ApiError } from '@/lib/api';
import { colors, size } from '@/lib/theme';

/**
 * Entry screen. For now it proves the phone can reach the backend (the first
 * thing that breaks at a demo) and links to the four role areas. Staff
 * sign-in replaces the open links in the auth phase; the server enforces
 * roles regardless of what this screen shows.
 */
const ROLES: { href: Href; label: string; hint: string }[] = [
  { href: '/agent', label: 'Agent ATM', hint: 'Cash-in / cash-out for a customer' },
  { href: '/customer', label: 'Customer phone', hint: 'Simulated confirmation call' },
  { href: '/admin', label: 'Admin', hint: 'Agents, limits, cash and float' },
  { href: '/bank', label: 'Bank operations', hint: 'Requests, reversals, reconciliation' },
];

type Health = { state: 'checking' } | { state: 'up' } | { state: 'down'; reason: string };

export default function Home() {
  const [health, setHealth] = useState<Health>({ state: 'checking' });

  useEffect(() => {
    api<{ ok: boolean }>('/health')
      .then(() => setHealth({ state: 'up' }))
      .catch((e: ApiError) => setHealth({ state: 'down', reason: e.message }));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.status}>
        <Text style={styles.statusLabel}>SERVER</Text>
        <Text
          style={[
            styles.statusValue,
            { color: health.state === 'up' ? colors.ok : health.state === 'down' ? colors.danger : colors.muted },
          ]}
        >
          {health.state === 'up' ? 'Connected' : health.state === 'down' ? 'Unreachable' : 'Checking…'}
        </Text>
        {health.state === 'down' && <Text style={styles.reason}>{health.reason}</Text>}
      </View>

      {ROLES.map((r) => (
        <Link key={r.label} href={r.href} asChild>
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Text style={styles.buttonLabel}>{r.label}</Text>
            <Text style={styles.buttonHint}>{r.hint}</Text>
          </Pressable>
        </Link>
      ))}

      <Text style={styles.footer}>Demo build. All banks, customers and verifications are simulated.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: size.pad },
  status: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad },
  statusLabel: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  statusValue: { fontSize: size.title, fontWeight: '700' },
  reason: { color: colors.muted, fontSize: 14, marginTop: 4 },
  button: {
    backgroundColor: colors.panel,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: 8,
    padding: size.pad,
    minHeight: 72,
  },
  pressed: { opacity: 0.7 },
  buttonLabel: { color: colors.accent, fontSize: size.button, fontWeight: '700' },
  buttonHint: { color: colors.muted, fontSize: 16, marginTop: 2 },
  footer: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: size.pad },
});
