import { useCallback, useState, useMemo } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/button';
import {
  callCustomer,
  cancelTransaction,
  cashNotPaid,
  cashReturned,
  FAILURE_TEXT,
  FINAL_STATES,
  getReceipt,
  getTransaction,
  handOver,
  RECEIPT_STATES,
  rupees,
  signTransaction,
  TXN_LABEL,
  type SignedReceipt,
  type Tx,
} from '@/lib/counter';
import { useTheme, type Colors, size } from '@/lib/theme';

type Tone = 'wait' | 'act' | 'ok' | 'stop';
const toneColors = (colors: Colors): Record<Tone, string> => ({ wait: colors.border, act: colors.accent, ok: colors.ok, stop: colors.danger });

function callText(tx: Tx): string {
  const c = tx.confirmation;
  if (!c) return 'Calling the customer…';
  const left = Math.max(0, Math.round((Date.parse(c.expiresAt) - Date.now()) / 1000));
  const step =
    c.callState === 'IN_PROGRESS'
      ? 'The customer is on the call, keying the amount.'
      : c.callState === 'NO_ANSWER'
        ? 'No answer.'
        : (c.dial ?? 1) > 1
          ? 'Ringing the customer again…'
          : 'Ringing the customer…';
  return `${step} About ${left}s left.`;
}

/** What the agent must know right now, from the server's state. Cash moves only on an "act" with a button. */
function status(tx: Tx): { tone: Tone; title: string; detail?: string } {
  const amount = rupees(tx.amountMinor);
  const why = tx.failureCode ? (FAILURE_TEXT[tx.failureCode] ?? tx.failureCode) : undefined;
  const noCash = tx.txnType === 'CASH_OUT' ? 'Do not hand over cash.' : undefined;
  switch (tx.state) {
    case 'CREATED':
      return tx.agentSigned
        ? { tone: 'act', title: 'Signed. Call the customer to confirm.' }
        : { tone: 'act', title: 'Not signed yet.', detail: 'Sign on this phone, then the customer is called.' };
    case 'AWAITING_CUSTOMER':
      return { tone: 'wait', title: 'Waiting for the customer', detail: `${callText(tx)} ${noCash ?? ''}`.trim() };
    case 'CUSTOMER_CONFIRMED':
    case 'PROVIDER_PENDING':
    case 'PROVIDER_APPROVED':
      if (tx.state === 'PROVIDER_APPROVED' && tx.txnType === 'CASH_OUT') {
        return { tone: 'act', title: `Bank approved. Hand ${amount} to ${tx.customerName}.`, detail: 'Then confirm below.' };
      }
      return { tone: 'wait', title: 'Customer confirmed. Waiting for the bank…', detail: noCash };
    case 'UNKNOWN_OUTCOME':
      return { tone: 'wait', title: "The bank's answer was lost. Checking with the bank…", detail: noCash };
    case 'CASH_NOT_DISBURSED':
    case 'REVERSAL_PENDING':
      return { tone: 'wait', title: 'Cash not paid. Refunding the customer at the bank…' };
    case 'CASH_RETURN_REQUIRED':
      return { tone: 'act', title: `The bank declined the deposit. Give ${amount} back to ${tx.customerName}.`, detail: why };
    case 'COMPLETED':
      return { tone: 'ok', title: tx.txnType === 'CASH_OUT' ? `${amount} paid out. Completed.` : `${amount} deposited. Completed.` };
    case 'REVERSED':
      return { tone: 'ok', title: "Refunded. The customer's account is back where it was." };
    case 'CASH_RETURNED':
      return { tone: 'ok', title: 'Cash returned to the customer.' };
    case 'PROVIDER_DECLINED':
      return { tone: 'stop', title: 'The bank declined.', detail: [why, noCash].filter(Boolean).join(' ') };
    case 'REJECTED':
      return { tone: 'stop', title: 'Not confirmed.', detail: [why, noCash].filter(Boolean).join(' ') };
    case 'EXPIRED':
      return { tone: 'stop', title: 'Expired before the customer confirmed.', detail: noCash };
    case 'CANCELLED':
      return { tone: 'stop', title: 'Cancelled.' };
    case 'SUPERSEDED':
      return { tone: 'stop', title: 'Replaced by a newer transaction.' };
    case 'RECONCILIATION_REQUIRED':
      return { tone: 'stop', title: 'Needs a manual check by the bank.', detail: [why, noCash].filter(Boolean).join(' ') };
    default:
      return { tone: 'wait', title: tx.state };
  }
}

export default function TransactionScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tx, setTx] = useState<Tx | null>(null);
  const [receipt, setReceipt] = useState<SignedReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const latest = await getTransaction(id);
      setTx(latest);
      if (RECEIPT_STATES.has(latest.state)) setReceipt(await getReceipt(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  // Poll every 2 s while this screen is open and the server may still move the transaction.
  const final = tx !== null && FINAL_STATES.has(tx.state);
  useFocusEffect(
    useCallback(() => {
      if (final) return;
      load();
      const timer = setInterval(load, 2000);
      return () => clearInterval(timer);
    }, [load, final])
  );

  async function act(action: (tx: Tx) => Promise<unknown>) {
    if (!tx) return;
    setBusy(true);
    setError(null);
    try {
      await action(tx);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (!tx) {
    return (
      <View style={styles.center}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.accent} />}
      </View>
    );
  }

  const s = status(tx);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.panel}>
        <Text style={styles.label}>{TXN_LABEL[tx.txnType].toUpperCase()}</Text>
        <Text style={styles.amount}>{rupees(tx.amountMinor)}</Text>
        <Text style={styles.body}>{tx.customerName}</Text>
        <Text style={styles.muted}>{tx.accountLabel}</Text>
      </View>

      <View style={[styles.panel, { borderColor: toneColors(colors)[s.tone], borderWidth: 2 }]} accessibilityLiveRegion="polite">
        <Text style={[styles.title, { color: s.tone === 'wait' ? colors.text : toneColors(colors)[s.tone] }]}>{s.title}</Text>
        {s.detail ? <Text style={styles.body}>{s.detail}</Text> : null}
        {!final && s.tone === 'wait' && <ActivityIndicator color={colors.accent} />}
      </View>

      {tx.state === 'CREATED' && !tx.agentSigned && <Button label="Sign on this phone" disabled={busy} onPress={() => act(signTransaction)} />}
      {tx.state === 'CREATED' && tx.agentSigned && <Button label="Call the customer" disabled={busy} onPress={() => act((t) => callCustomer(t.id))} />}
      {tx.state === 'PROVIDER_APPROVED' && tx.txnType === 'CASH_OUT' && (
        <>
          <Button label={`I handed over ${rupees(tx.amountMinor)}`} disabled={busy} onPress={() => act(handOver)} />
          <Button label="I could not pay the cash" kind="secondary" danger disabled={busy} onPress={() => act(cashNotPaid)} />
        </>
      )}
      {tx.state === 'CASH_RETURN_REQUIRED' && (
        <Button label={`I gave back ${rupees(tx.amountMinor)}`} disabled={busy} onPress={() => act(cashReturned)} />
      )}
      {(tx.state === 'CREATED' || tx.state === 'AWAITING_CUSTOMER') && (
        <Button label="Cancel transaction" kind="secondary" danger disabled={busy} onPress={() => act((t) => cancelTransaction(t.id))} />
      )}
      {tx.supersededBy && (
        <Button
          label="Open the newer transaction"
          kind="secondary"
          onPress={() => router.replace({ pathname: '/agent/[id]', params: { id: tx.supersededBy! } })}
        />
      )}

      {busy && <ActivityIndicator color={colors.accent} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {receipt && (
        <View style={styles.panel}>
          <Text style={styles.label}>RECEIPT{receipt.receipt.simulated ? ' · DEMO, NOT A REAL TRANSACTION' : ''}</Text>
          <Text style={styles.body} selectable>
            {TXN_LABEL[receipt.receipt.txnType]} {rupees(receipt.receipt.amountMinor)} · {receipt.receipt.state}
            {'\n'}
            {receipt.receipt.customerName} · {receipt.receipt.accountLabel}
            {'\n'}
            Agent {receipt.receipt.agentCode}, {receipt.receipt.agentLocation}
            {'\n'}
            {receipt.receipt.bankCode} ref {receipt.receipt.bankRef ?? '-'}
            {'\n'}
            {new Date(receipt.receipt.issuedAt).toLocaleString()}
          </Text>
          <Text style={styles.muted} selectable>
            Signed (key {receipt.keyId}): {receipt.signature.slice(0, 32)}…
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  page: { padding: size.pad, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: size.pad },
  panel: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: size.pad, gap: 6 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2 },
  amount: { color: colors.accent, fontSize: 48, fontWeight: '700' },
  title: { fontSize: size.button, fontWeight: '700' },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
});
