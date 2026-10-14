import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, router, useFocusEffect, type Href } from 'expo-router';
import { Button } from '@/components/button';
import { Segmented } from '@/components/segmented';
import { api, ApiError } from '@/lib/api';
import { loadLanguage } from '@/lib/customer';
import { LANGS, useI18n } from '@/lib/i18n';
import { isEnrolled, loadMe, signIn, signOut, type Me, type Role } from '@/lib/session';
import { useTheme, type Colors, size } from '@/lib/theme';

/**
 * Entry screen: who is signed in on this phone and the one area their role
 * may use. New customers create an account here; staff enrol with an invite.
 * The server enforces roles regardless of what this screen shows; this only
 * avoids offering doors that will not open.
 */
const ROLE_AREA: Record<Exclude<Role, 'CUSTOMER'>, { href: Href; label: string; hint: string }> = {
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t, lang, setLang } = useI18n();
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
      // A customer's saved language follows them to a new phone.
      if (me?.role === 'CUSTOMER') loadLanguage().then(setLang).catch(() => {});
    } catch (e) {
      setStaff({ state: 'error', message: (e as Error).message });
    }
  }, [setLang]);

  // Re-check whenever this screen comes back into view (e.g. after signing up).
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

  const guest = staff.state === 'not-enrolled' || staff.state === 'signed-out';
  const me = staff.state === 'signed-in' ? staff.me : null;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.hero}>
        <Text style={styles.brand}>BharatPoint</Text>
        <Text style={styles.title}>{me ? `${t('hello')}, ${me.displayName}` : t('welcome_title')}</Text>
        {!me && <Text style={styles.sub}>{t('welcome_sub')}</Text>}
        {me && me.role !== 'CUSTOMER' && (
          <Text style={styles.sub}>
            {me.staffCode} · {me.role.replace('_', ' ')}
          </Text>
        )}
      </View>

      {guest && <Segmented options={LANGS.map((l) => ({ value: l.code, label: l.name }))} value={lang} onChange={setLang} />}

      {staff.state === 'loading' && <ActivityIndicator color={colors.accent} />}
      {staff.state === 'error' && <Text style={styles.error}>{staff.message}</Text>}

      {staff.state === 'not-enrolled' && (
        <View style={styles.actions}>
          <Button label={t('sign_up')} onPress={() => router.push('/signup')} />
          <Button label={t('staff_enrol')} kind="secondary" onPress={() => router.push('/enrol')} />
        </View>
      )}

      {staff.state === 'signed-out' && (
        <View style={styles.actions}>
          <Button label={busy ? '…' : t('sign_in')} disabled={busy} onPress={() => run(signIn)} />
          <Text style={styles.note}>{t('secure_note')}</Text>
        </View>
      )}

      {me && (
        <View style={styles.actions}>
          {me.role === 'CUSTOMER' ? (
            <Button label={t('my_transactions')} onPress={() => router.push('/customer' as Href)} />
          ) : (
            <Link href={ROLE_AREA[me.role].href} asChild>
              <Pressable style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
                <Text style={styles.tileLabel}>{ROLE_AREA[me.role].label}</Text>
                <Text style={styles.tileHint}>{ROLE_AREA[me.role].hint}</Text>
              </Pressable>
            </Link>
          )}
          <Button label={t('sign_out')} kind="secondary" disabled={busy} onPress={() => run(signOut)} />
        </View>
      )}

      {actionError && <Text style={styles.error}>{actionError}</Text>}

      <View style={styles.footer}>
        <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} style={styles.link}>
          <Text style={styles.linkLabel}>{t('settings')}</Text>
        </Pressable>
        <View style={styles.status}>
          <View
            style={[
              styles.dot,
              { backgroundColor: health.state === 'up' ? colors.ok : health.state === 'down' ? colors.danger : colors.muted },
            ]}
          />
          <Text style={styles.note}>
            {health.state === 'up' ? 'Server connected' : health.state === 'down' ? `Server unreachable: ${health.reason}` : 'Checking server…'}
          </Text>
        </View>
        <Text style={styles.note}>Demo build. All banks, customers and verifications are simulated.</Text>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: size.pad, gap: 24, paddingBottom: 40 },
    hero: { gap: 8, paddingTop: 24, paddingBottom: 8 },
    brand: { color: colors.accent, fontSize: 16, letterSpacing: 3, fontWeight: '700', textTransform: 'uppercase' },
    title: { color: colors.text, fontSize: 32, lineHeight: 40, fontWeight: '800' },
    sub: { color: colors.muted, fontSize: size.body },
    actions: { gap: 12 },
    note: { color: colors.muted, fontSize: size.small },
    error: { color: colors.danger, fontSize: size.body },
    tile: {
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: size.radius,
      padding: size.pad,
      minHeight: 80,
      justifyContent: 'center',
      gap: 2,
    },
    pressed: { opacity: 0.7 },
    tileLabel: { color: colors.accent, fontSize: size.button, fontWeight: '700' },
    tileHint: { color: colors.muted, fontSize: size.small },
    footer: { gap: 10, marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border },
    link: { minHeight: 48, justifyContent: 'center' },
    linkLabel: { color: colors.accent, fontSize: size.body, fontWeight: '700' },
    status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 10, height: 10, borderRadius: 5 },
  });
