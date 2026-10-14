import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/button';
import { InviteQr } from '@/components/invite-qr';
import {
  listStaff,
  newInvite,
  reactivate,
  requestReplenishment,
  resetDevices,
  setLimits,
  suspend,
  type Invite,
  type StaffEntry,
} from '@/lib/admin';
import { rupees } from '@/lib/counter';
import { colors, size } from '@/lib/theme';

const wholeRupees = (v: string) => (/^[1-9][0-9]{0,6}$/.test(v) ? Number(v) * 100 : null);

/** One staff member: invite, suspend or reactivate, reset devices; for agents, limits and replenishment. */
export default function StaffDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [s, setS] = useState<StaffEntry | null>(null);
  const [perTxn, setPerTxn] = useState('');
  const [daily, setDaily] = useState('');
  const [kind, setKind] = useState<'CASH_DRAWER' | 'FLOAT'>('CASH_DRAWER');
  const [amount, setAmount] = useState('');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const entry = (await listStaff()).find((x) => x.userId === id) ?? null;
      setS(entry);
      if (entry?.agent) {
        setPerTxn(String(entry.agent.perTxnLimitMinor / 100));
        setDaily(String(entry.agent.dailyLimitMinor / 100));
      }
      setError(entry ? null : 'Staff member not found.');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  }

  const confirm = (title: string, message: string, action: () => Promise<unknown>) =>
    Alert.alert(title, message, [
      { text: 'Back', style: 'cancel' },
      { text: title, style: 'destructive', onPress: () => run(action) },
    ]);

  if (!s) {
    return <View style={styles.center}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.accent} />}</View>;
  }

  const perTxnMinor = wholeRupees(perTxn);
  const dailyMinor = wholeRupees(daily);
  const amountMinor = wholeRupees(amount);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: s.displayName }} />

      <View style={styles.panel}>
        <Text style={styles.title}>{s.displayName}</Text>
        <Text style={styles.body}>
          {s.staffCode} · {s.role.replace('_', ' ')}
          {s.bankCode ? ` · ${s.bankCode}` : ''}
          {s.agent ? ` · ${s.agent.locationName}` : ''}
        </Text>
        <Text style={[styles.body, { color: s.status === 'ACTIVE' ? colors.ok : colors.danger }]}>{s.status}</Text>
        <Text style={styles.muted}>
          {s.activeDevices} enrolled phone{s.activeDevices === 1 ? '' : 's'} · last sign-in{' '}
          {s.lastSignInAt ? new Date(s.lastSignInAt).toLocaleString() : 'never'}
        </Text>
      </View>

      {s.agent && (
        <>
          <View style={styles.panel}>
            <Text style={styles.label}>CASH AND FLOAT (LEDGER)</Text>
            <Text style={[styles.body, s.agent.drawerMinor < 0 && { color: colors.danger }]}>Drawer {rupees(s.agent.drawerMinor)}</Text>
            <Text style={styles.body}>E-float {rupees(s.agent.floatMinor)}</Text>
            <Text style={styles.muted}>Used today {rupees(s.agent.usedTodayMinor)} of {rupees(s.agent.dailyLimitMinor)}</Text>
          </View>

          <View style={styles.panel}>
            <Text style={styles.label}>LIMITS (WHOLE RUPEES)</Text>
            <View style={styles.pair}>
              <View style={styles.flex}>
                <Text style={styles.muted}>Per transaction</Text>
                <TextInput style={styles.input} value={perTxn} onChangeText={(v) => setPerTxn(v.replace(/[^0-9]/g, ''))} keyboardType="number-pad" accessibilityLabel="Per-transaction limit in rupees" />
              </View>
              <View style={styles.flex}>
                <Text style={styles.muted}>Per day</Text>
                <TextInput style={styles.input} value={daily} onChangeText={(v) => setDaily(v.replace(/[^0-9]/g, ''))} keyboardType="number-pad" accessibilityLabel="Daily limit in rupees" />
              </View>
            </View>
            <Button
              label="Save limits"
              kind="secondary"
              disabled={busy || perTxnMinor === null || dailyMinor === null}
              onPress={() => run(() => setLimits(s.agent!.agentId, perTxnMinor!, dailyMinor!), 'Limits saved.')}
            />
          </View>

          <View style={styles.panel}>
            <Text style={styles.label}>REPLENISH</Text>
            <View style={styles.pair}>
              <View style={styles.flex}>
                <Button label="Cash" kind={kind === 'CASH_DRAWER' ? 'primary' : 'secondary'} onPress={() => setKind('CASH_DRAWER')} />
              </View>
              <View style={styles.flex}>
                <Button label="E-float" kind={kind === 'FLOAT' ? 'primary' : 'secondary'} onPress={() => setKind('FLOAT')} />
              </View>
            </View>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder="Amount in ₹"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Replenishment amount in rupees"
            />
            <Button
              label={amountMinor ? `Request ${rupees(amountMinor)}` : 'Enter an amount'}
              kind="secondary"
              disabled={busy || amountMinor === null}
              onPress={() =>
                run(async () => {
                  await requestReplenishment(s.agent!.agentId, kind, amountMinor!);
                  setAmount('');
                }, 'Requested. Another admin must approve it on their phone.')
              }
            />
          </View>
        </>
      )}

      {invite && <InviteQr invite={invite} who={`${s.displayName} (${s.staffCode})`} />}
      {s.status === 'ACTIVE' && (
        <Button label="New enrolment invite" kind="secondary" disabled={busy} onPress={() => run(async () => setInvite(await newInvite(s.userId)))} />
      )}
      {s.status === 'ACTIVE' ? (
        <Button
          label="Suspend"
          kind="secondary"
          danger
          disabled={busy}
          onPress={() => confirm('Suspend', `${s.displayName} is signed out now and can do nothing until reactivated.`, () => suspend(s.userId))}
        />
      ) : (
        <Button label="Reactivate" kind="secondary" disabled={busy} onPress={() => run(() => reactivate(s.userId), 'Reactivated. They sign in again on their phone.')} />
      )}
      <Button
        label="Reset phones"
        kind="secondary"
        danger
        disabled={busy}
        onPress={() => confirm('Reset phones', 'Every enrolled phone is cut off. They need a new invite to enrol again.', () => resetDevices(s.userId))}
      />

      {busy && <ActivityIndicator color={colors.accent} />}
      {notice && <Text style={styles.ok}>{notice}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: size.pad },
  panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 8 },
  title: { color: colors.accent, fontSize: size.title, fontWeight: '700' },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  ok: { color: colors.ok, fontSize: size.body },
  error: { color: colors.danger, fontSize: size.body },
  input: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, fontSize: size.body, padding: 12 },
  pair: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
