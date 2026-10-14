import { useCallback, useState, useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { StateBadge } from '@/components/badge';
import { Button } from '@/components/button';
import { FAULT_LABEL, getFault, sectionOf, setFault, type Fault, type FaultMode, type Section } from '@/lib/bank';
import { listTransactions, rupees, stateLabel, TXN_LABEL, type Tx } from '@/lib/counter';
import { useTheme, type Colors, size } from '@/lib/theme';

const SECTIONS: { key: Section; title: string; empty: string }[] = [
  { key: 'INCOMING', title: 'INCOMING REQUESTS', empty: 'No requests in flight.' },
  { key: 'RECONCILIATION', title: 'NEEDS RECONCILIATION', empty: 'Nothing to reconcile.' },
  { key: 'REVERSALS', title: 'REVERSALS', empty: 'No reversals.' },
  { key: 'DONE', title: 'FINISHED', empty: 'Nothing finished yet.' },
];

/**
 * Bank operations: the bank's view of its own customers' transactions (masked
 * account labels only) and, in demo mode, switches to make the mock bank fail.
 */
export default function BankHome() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [fault, setFaultState] = useState<Fault | null>(null); // null: demo switches unavailable
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTxs(await listTransactions());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setFaultState(await getFault().catch(() => null)); // 404 outside DEMO_MODE
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function arm(mode: FaultMode | null) {
    setBusy(true);
    try {
      setFaultState(await setFault(mode));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
    >
      {error && <Text style={styles.error}>{error}</Text>}

      {SECTIONS.map(({ key, title, empty }) => {
        const rows = txs.filter((t) => sectionOf(t.state) === key);
        return (
          <View key={key} style={styles.section}>
            <Text style={styles.label}>{title}</Text>
            {rows.length === 0 && <Text style={styles.muted}>{empty}</Text>}
            {rows.map((t) => (
              <View key={t.id} style={[styles.row, key === 'RECONCILIATION' && { borderColor: colors.danger }]}>
                <View style={styles.rowTop}>
                  <Text style={styles.amount}>{rupees(t.amountMinor)}</Text>
                  <StateBadge state={t.state} />
                </View>
                <Text style={styles.muted}>
                  {TXN_LABEL[t.txnType]} · {t.customerName} · {t.accountLabel}
                </Text>
                <Text style={styles.muted}>
                  {new Date(t.createdAt).toLocaleString()}
                  {t.confirmation ? ` · customer ${stateLabel(t.confirmation.status)}` : ''}
                  {t.failureCode ? ` · ${t.failureCode}` : ''}
                </Text>
              </View>
            ))}
          </View>
        );
      })}

      {fault && (
        <View style={styles.section}>
          <Text style={styles.label}>DEMO: MAKE THE BANK FAIL</Text>
          <Text style={styles.muted}>
            {fault.mode ? `Next ${fault.count} request(s): ${FAULT_LABEL[fault.mode]}` : 'Bank is behaving normally.'}
          </Text>
          {(Object.keys(FAULT_LABEL) as FaultMode[]).map((m) => (
            <Button key={m} label={FAULT_LABEL[m]} kind="secondary" disabled={busy} onPress={() => arm(m)} />
          ))}
          <Button label="Back to normal" disabled={busy || !fault.mode} onPress={() => arm(null)} />
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  page: { padding: size.pad, gap: 8 },
  section: { gap: 8 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2, marginTop: size.pad },
  muted: { color: colors.muted, fontSize: size.small },
  error: { color: colors.danger, fontSize: size.body },
  row: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: size.radius, padding: size.pad, gap: 6 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { color: colors.text, fontSize: size.button, fontWeight: '700' },
});
