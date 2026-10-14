import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Linking, TextInput, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { StateBadge } from '@/components/badge';
import { Button } from '@/components/button';
import { listTransactions, rupees, type Tx } from '@/lib/counter';
import { raiseSupportTicket, reportTransaction } from '@/lib/customer';
import { customerStatus, useI18n } from '@/lib/i18n';
import { useTheme, type Colors, size } from '@/lib/theme';

const SUPPORT_PHONE = process.env.EXPO_PUBLIC_SUPPORT_PHONE ?? '1800000000';

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

  const [issue, setIssue] = useState('');
  const [sent, setSent] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  function raise() {
    raiseSupportTicket(issue.trim())
      .then(() => {
        setIssue('');
        setSent(true);
      })
      .catch((e) => setError((e as Error).message));
  }

  function ask(id: string) {
    Alert.alert(t('report'), t('report_ask'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('report_yes'),
        style: 'destructive',
        onPress: () =>
          reportTransaction(id)
            .then(load)
            .catch((e) => setError((e as Error).message)),
      },
    ]);
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
          <Text style={styles.tip}>🛡  {t('report_tip')}</Text>
          {error && <Text style={styles.error}>{error}</Text>}
          {txs?.length === 0 && <Text style={styles.muted}>{t('none')}</Text>}
        </View>
      }
      ListFooterComponent={
        <View style={styles.support}>
          <Text style={styles.section}>{t('help')}</Text>
          <View style={styles.pair}>
            <View style={styles.flex}>
              <Button label={t('call_support')} kind="secondary" onPress={() => Linking.openURL(`tel:${SUPPORT_PHONE}`)} />
            </View>
            <View style={styles.flex}>
              <Button label={t('raise_ticket')} kind="secondary" onPress={() => setFormOpen((o) => !o)} />
            </View>
          </View>
          {formOpen && (
            <>
              <TextInput
                value={issue}
                onChangeText={(v) => {
                  setIssue(v);
                  setSent(false);
                }}
                placeholder={t('ticket_prompt')}
                placeholderTextColor={colors.muted}
                multiline
                maxLength={500}
                style={styles.input}
              />
              {sent && <Text style={styles.sent}>{t('ticket_sent')}</Text>}
              <Button label={t('send')} onPress={raise} disabled={!issue.trim()} />
            </>
          )}
          <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} style={styles.reportBtn}>
            <Text style={styles.link}>{t('settings')}</Text>
          </Pressable>
        </View>
      }
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
          {item.disputed ? (
            <Text style={styles.reported}>{t('reported')}</Text>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => ask(item.id)} style={styles.reportBtn}>
              <Text style={styles.reportLabel}>{t('report')}</Text>
            </Pressable>
          )}
        </View>
      )}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: size.pad, gap: 12, paddingBottom: 40 },
    header: { gap: 12 },
    flex: { flex: 1 },
    pair: { flexDirection: 'row', gap: 10 },
    support: { gap: 12, marginTop: 8 },
    section: { color: colors.text, fontSize: size.body, fontWeight: '700' },
    input: { minHeight: 96, color: colors.text, backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: size.radius, padding: 14, fontSize: size.body, textAlignVertical: 'top' },
    muted: { color: colors.muted, fontSize: size.small },
    error: { color: colors.danger, fontSize: size.body },
    row: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: size.radius, padding: size.pad, gap: 4 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
    amount: { color: colors.text, fontSize: size.title, fontWeight: '700' },
    tip: { color: colors.muted, fontSize: size.small, lineHeight: 22, backgroundColor: colors.panel, borderRadius: size.radius, padding: size.pad },
    reportBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    reportLabel: { color: colors.danger, fontSize: size.small, fontWeight: '600' },
    link: { color: colors.accent, fontSize: size.body, fontWeight: '700' },
    sent: { color: colors.ok, fontSize: size.small },
    reported: { color: colors.muted, fontSize: size.small, fontStyle: 'italic', marginTop: 4 },
  });
