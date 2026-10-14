import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { StateBadge } from '@/components/badge';
import { Button } from '@/components/button';
import { listTransactions, rupees, type Tx } from '@/lib/counter';
import { customerStatus, useI18n } from '@/lib/i18n';
import { useTheme, type Colors, size } from '@/lib/theme';

/** The customer's own transactions, newest first, with plain-language status. */
export default function CustomerHome() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t } = useI18n();
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
      keyExtractor={(x) => x.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <Stack.Screen options={{ title: t('my_transactions') }} />
          {error && <Text style={styles.error}>{error}</Text>}
          {txs?.length === 0 && <Text style={styles.muted}>{t('none')}</Text>}
        </View>
      }
      ListFooterComponent={<Button label={t('settings')} kind="secondary" onPress={() => router.push('/settings')} />}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.amount}>{rupees(item.amountMinor)}</Text>
            <StateBadge state={item.state} label={t(customerStatus(item.state))} />
          </View>
          <Text style={styles.muted}>
            {t(item.txnType === 'CASH_OUT' ? 'cash_out' : 'cash_in')} · {item.accountLabel}
          </Text>
          <Text style={styles.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
        </View>
      )}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: size.pad, gap: 10 },
    header: { gap: 8 },
    muted: { color: colors.muted, fontSize: size.small },
    error: { color: colors.danger, fontSize: size.body },
    row: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: size.radius, padding: size.pad, gap: 6 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    amount: { color: colors.text, fontSize: size.button, fontWeight: '700' },
  });
