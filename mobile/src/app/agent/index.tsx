import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '@/components/button';
import { listTransactions, rupees, stateLabel, TXN_LABEL, type Tx } from '@/lib/counter';
import { colors, size } from '@/lib/theme';

/**
 * Agent home: start a cash-out or cash-in, or pick up a recent transaction
 * (for example after the app was closed while the customer was on the call).
 */
export default function AgentHome() {
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTxs(await listTransactions());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
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

  return (
    <FlatList
      contentContainerStyle={styles.page}
      data={txs ?? []}
      keyExtractor={(t) => t.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <Button label="New cash-out" onPress={() => router.push({ pathname: '/agent/new', params: { type: 'CASH_OUT' } })} />
          <Button label="New cash-in" kind="secondary" onPress={() => router.push({ pathname: '/agent/new', params: { type: 'CASH_IN' } })} />
          <Text style={styles.label}>RECENT</Text>
          {error && <Text style={styles.error}>{error}</Text>}
          {txs?.length === 0 && <Text style={styles.muted}>No transactions yet.</Text>}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push({ pathname: '/agent/[id]', params: { id: item.id } })}
        >
          <View style={styles.rowTop}>
            <Text style={styles.amount}>{rupees(item.amountMinor)}</Text>
            <Text style={styles.state}>{stateLabel(item.state)}</Text>
          </View>
          <Text style={styles.muted}>
            {TXN_LABEL[item.txnType]} · {item.customerName} · {new Date(item.createdAt).toLocaleTimeString()}
          </Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: 8 },
  header: { gap: 12, marginBottom: 4 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2, marginTop: size.pad },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  row: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, gap: 4 },
  pressed: { opacity: 0.7 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  amount: { color: colors.text, fontSize: size.button, fontWeight: '700' },
  state: { color: colors.accent, fontSize: 14 },
});
