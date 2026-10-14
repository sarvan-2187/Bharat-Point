import { useState, useMemo } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/button';
import {
  callCustomer,
  cancelTransaction,
  createTransaction,
  findCustomers,
  rupees,
  signTransaction,
  TXN_LABEL,
  type Account,
  type CustomerMatch,
  type TxnType,
} from '@/lib/counter';
import { useTheme, type Colors, size } from '@/lib/theme';

/**
 * New transaction: find the customer by mobile number, pick the account,
 * enter whole rupees, then sign on this phone and ring the customer, who
 * confirms the amount on the call. The transaction screen takes over from there.
 */
export default function NewTransaction() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { type } = useLocalSearchParams<{ type?: string }>();
  const txnType: TxnType = type === 'CASH_IN' ? 'CASH_IN' : 'CASH_OUT';

  const [phone, setPhone] = useState('');
  const [matches, setMatches] = useState<CustomerMatch[] | null>(null);
  const [chosen, setChosen] = useState<{ customer: CustomerMatch; account: Account } | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountRupees = /^[1-9][0-9]{0,6}$/.test(amount) ? Number(amount) : null;

  async function find() {
    setBusy(true);
    setError(null);
    setMatches(null);
    try {
      setMatches(await findCustomers(phone));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signAndCall() {
    if (!chosen || amountRupees === null) return;
    setBusy(true);
    setError(null);
    const input = {
      txnType,
      amountMinor: amountRupees * 100,
      customerId: chosen.customer.customerId,
      accountLinkId: chosen.account.accountLinkId,
    };
    try {
      const tx = await createTransaction(input);
      // Sign only what the agent typed: if the server recorded anything else, cancel it.
      if (tx.txnType !== input.txnType || tx.amountMinor !== input.amountMinor || tx.customerId !== input.customerId) {
        await cancelTransaction(tx.id);
        throw new Error('The server recorded a different transaction, so it was cancelled and not signed.');
      }
      try {
        await signTransaction(tx);
        await callCustomer(tx.id);
      } catch (e) {
        Alert.alert('Not finished', `${(e as Error).message}\nYou can continue on the transaction screen.`);
      }
      router.replace({ pathname: '/agent/[id]', params: { id: tx.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: `New ${TXN_LABEL[txnType].toLowerCase()}` }} />

      {!chosen && (
        <>
          <Text style={styles.label}>CUSTOMER&apos;S MOBILE NUMBER</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="98765 43210"
            placeholderTextColor={colors.muted}
            onSubmitEditing={find}
            accessibilityLabel="Customer's mobile number"
          />
          <Button label="Find customer" onPress={find} disabled={busy || phone.trim().length < 10} />
          {matches?.length === 0 && <Text style={styles.muted}>No customer on this number.</Text>}
          {matches?.map((customer) => (
            <View key={customer.customerId} style={styles.panel}>
              <Text style={styles.name}>{customer.displayName}</Text>
              {!customer.reachable && <Text style={styles.error}>No phone for the confirmation call. Cannot transact.</Text>}
              {customer.accounts.map((account) => (
                <Pressable
                  key={account.accountLinkId}
                  accessibilityRole="button"
                  disabled={!customer.reachable}
                  style={({ pressed }) => [styles.account, (pressed || !customer.reachable) && styles.dim]}
                  onPress={() => setChosen({ customer, account })}
                >
                  <Text style={styles.accountLabel}>{account.maskedLabel}</Text>
                  <Text style={styles.muted}>{account.bankName}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </>
      )}

      {chosen && (
        <>
          <View style={styles.panel}>
            <Text style={styles.name}>{chosen.customer.displayName}</Text>
            <Text style={styles.muted}>{chosen.account.maskedLabel}</Text>
            <Button label="Change customer" kind="secondary" disabled={busy} onPress={() => setChosen(null)} />
          </View>

          <Text style={styles.label}>AMOUNT (WHOLE RUPEES)</Text>
          <View style={styles.amountRow}>
            <Text style={styles.rupee}>₹</Text>
            <TextInput
              style={styles.amount}
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={7}
              placeholder="0"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Amount in rupees"
            />
          </View>
          <Text style={styles.muted}>
            {txnType === 'CASH_OUT'
              ? 'The customer will be called and must key this amount. Hand over no cash until the screen says so.'
              : 'Take the cash first. The customer will be called and must key this amount.'}
          </Text>
          <Button
            label={amountRupees ? `Sign and call for ${rupees(amountRupees * 100)}` : 'Enter an amount'}
            onPress={signAndCall}
            disabled={busy || amountRupees === null}
          />
        </>
      )}

      {busy && <ActivityIndicator color={colors.accent} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  page: { padding: size.pad, gap: 12 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  input: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, fontSize: size.title, padding: 12 },
  panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 8 },
  name: { color: colors.text, fontSize: size.button, fontWeight: '700' },
  account: { borderColor: colors.accent, borderWidth: 2, borderRadius: 8, padding: 12, minHeight: 56 },
  accountLabel: { color: colors.accent, fontSize: size.body, fontWeight: '700' },
  dim: { opacity: 0.5 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rupee: { color: colors.accent, fontSize: 48, fontWeight: '700' },
  amount: { flex: 1, color: colors.text, fontSize: 48, fontWeight: '700', borderBottomColor: colors.accent, borderBottomWidth: 2 },
});
