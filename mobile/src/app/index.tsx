import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router, useFocusEffect, type Href } from 'expo-router';
import { api, ApiError } from '@/lib/api';
import { isEnrolled, loadMe, signIn, signOut, type Me, type Role } from '@/lib/session';
import { colors, size } from '@/lib/theme';

/**
 * Entry screen: is the server reachable, who is signed in on this phone, and
 * the one role area they may use. The server enforces roles regardless of
 * what this screen shows; this only avoids offering doors that will not open.
 */
const ROLE_AREA: Record<Role, { href: Href; label: string; hint: string }> = {
  AGENT: { href: '/agent', label: 'Agent ATM', hint: 'Cash-in / cash-out for a customer' },
  ADMIN: { href: '/admin', label: 'Admin', hint: 'Agents, limits, cash and float' },
  BANK_OPERATOR: { href: '/bank', label: 'Bank operations', hint: 'Requests, reversals, reconciliation' },
};

type Health = { state: 'checking' } | { state: 'up' } | { state: 'down'; reason: string };
type Staff =
  | { state: 'loading' }
  | { state: 'not-enrolled' }
  | { state: 'signed-out' }
  | { state: 'signed-in'; me: Me }
  | { state: 'error'; message: string };

export default function Home() {
  const [health, setHealth] = useState<Health>({ state: 'checking' });
  const [staff, setStaff] = useState<Staff>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    api<{ ok: boolean }>('/health')
      .then(() => setHealth({ state: 'up' }))
      .catch((e: ApiError) => setHealth({ state: 'down', reason: e.message }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      if (!(await isEnrolled())) return setStaff({ state: 'not-enrolled' });
      const me = await loadMe();
      setStaff(me ? { state: 'signed-in', me } : { state: 'signed-out' });
    } catch (e) {
      setStaff({ state: 'error', message: (e as Error).message });
    }
  }, []);

  // Re-check whenever this screen comes back into view (e.g. after enrolling).
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.panel}>
        <Text style={styles.label}>SERVER</Text>
        <Text
          style={[
            styles.value,
            { color: health.state === 'up' ? colors.ok : health.state === 'down' ? colors.danger : colors.muted },
          ]}
        >
          {health.state === 'up' ? 'Connected' : health.state === 'down' ? 'Unreachable' : 'Checking…'}
        </Text>
        {health.state === 'down' && <Text style={styles.muted}>{health.reason}</Text>}
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>STAFF</Text>
        {staff.state === 'loading' && <ActivityIndicator color={colors.accent} />}
        {staff.state === 'error' && <Text style={styles.error}>{staff.message}</Text>}
        {staff.state === 'not-enrolled' && (
          <>
            <Text style={styles.body}>This phone is not enrolled yet.</Text>
            <Pressable style={styles.primary} onPress={() => router.push('/enrol')}>
              <Text style={styles.primaryLabel}>Enrol this phone</Text>
            </Pressable>
          </>
        )}
        {staff.state === 'signed-out' && (
          <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => run(signIn)}>
            <Text style={styles.primaryLabel}>Sign in</Text>
          </Pressable>
        )}
        {staff.state === 'signed-in' && (
          <>
            <Text style={styles.value}>{staff.me.displayName}</Text>
            <Text style={styles.muted}>
              {staff.me.staffCode} · {staff.me.role.replace('_', ' ')}
            </Text>
          </>
        )}
        {actionError && <Text style={styles.error}>{actionError}</Text>}
      </View>

      {staff.state === 'signed-in' && (
        <>
          <Link href={ROLE_AREA[staff.me.role].href} asChild>
            <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <Text style={styles.buttonLabel}>{ROLE_AREA[staff.me.role].label}</Text>
              <Text style={styles.buttonHint}>{ROLE_AREA[staff.me.role].hint}</Text>
            </Pressable>
          </Link>
          <Pressable style={styles.secondary} disabled={busy} onPress={() => run(signOut)}>
            <Text style={styles.secondaryLabel}>Sign out</Text>
          </Pressable>
        </>
      )}

      <Text style={styles.footer}>Demo build. All banks, customers and verifications are simulated.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: size.pad },
  panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 8 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  value: { color: colors.text, fontSize: size.title, fontWeight: '700' },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  primary: { backgroundColor: colors.accent, borderRadius: 8, padding: size.pad, alignItems: 'center' },
  primaryLabel: { color: colors.bg, fontSize: size.button, fontWeight: '700' },
  disabled: { opacity: 0.5 },
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
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, alignItems: 'center' },
  secondaryLabel: { color: colors.text, fontSize: size.body },
  footer: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: size.pad },
});
