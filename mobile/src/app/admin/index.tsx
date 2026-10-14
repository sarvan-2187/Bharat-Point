import { useCallback, useState, useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '@/components/button';
import {
  ALERT_TEXT,
  approveReplenishment,
  listAlerts,
  listReplenishments,
  listStaff,
  rejectReplenishment,
  type Alert,
  type Replenishment,
  type StaffEntry,
} from '@/lib/admin';
import { rupees } from '@/lib/counter';
import { loadMe } from '@/lib/session';
import { useTheme, type Colors, size } from '@/lib/theme';

const KIND_LABEL = { CASH_DRAWER: 'cash', FLOAT: 'e-float' } as const;

/**
 * Admin home: what needs attention (alerts), what needs a second admin
 * (replenishments someone else requested), and every staff member.
 */
export default function AdminHome() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [pending, setPending] = useState<Replenishment[]>([]);
  const [staff, setStaff] = useState<StaffEntry[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, r, s, me] = await Promise.all([listAlerts(), listReplenishments(), listStaff(), loadMe()]);
      setAlerts(a);
      setPending(r.filter((x) => x.status === 'PENDING'));
      setStaff(s);
      setMyId(me?.userId ?? null);
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

  async function decide(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await load();
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
    >
      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.label}>ALERTS</Text>
      {alerts.length === 0 && <Text style={styles.muted}>Nothing needs attention.</Text>}
      {alerts.map((a, i) => (
        <View key={`${a.kind}-${a.agentCode}-${a.transactionId ?? i}`} style={[styles.row, { borderColor: a.severity === 'HIGH' ? colors.danger : colors.accent }]}>
          <Text style={[styles.rowTitle, { color: a.severity === 'HIGH' ? colors.danger : colors.accent }]}>{ALERT_TEXT[a.kind] ?? a.kind}</Text>
          <Text style={styles.body}>
            {a.agentCode} · {a.detail}
          </Text>
          <Text style={styles.muted}>Since {new Date(a.since).toLocaleString()}</Text>
        </View>
      ))}

      <Text style={styles.label}>WAITING FOR APPROVAL</Text>
      {pending.length === 0 && <Text style={styles.muted}>No replenishment requests.</Text>}
      {pending.map((r) => {
        const mine = r.requestedBy === myId;
        return (
          <View key={r.id} style={styles.row}>
            <Text style={styles.rowTitle}>
              {rupees(r.amountMinor)} {KIND_LABEL[r.accountKind]} for {r.agentCode}
            </Text>
            <Text style={styles.muted}>
              Requested by {r.requestedByCode}
              {r.note ? ` · ${r.note}` : ''}
            </Text>
            {mine ? (
              <Text style={styles.muted}>You requested this: another admin must approve it.</Text>
            ) : (
              <View style={styles.actions}>
                <View style={styles.flex}>
                  <Button label="Approve" disabled={busy} onPress={() => decide(() => approveReplenishment(r.id))} />
                </View>
                <View style={styles.flex}>
                  <Button label="Reject" kind="secondary" danger disabled={busy} onPress={() => decide(() => rejectReplenishment(r.id))} />
                </View>
              </View>
            )}
          </View>
        );
      })}

      <Text style={styles.label}>STAFF</Text>
      <Button label="Add staff" kind="secondary" onPress={() => router.push('/admin/new-staff')} />
      {staff.map((s) => (
        <Pressable
          key={s.userId}
          accessibilityRole="button"
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push({ pathname: '/admin/staff/[id]', params: { id: s.userId } })}
        >
          <View style={styles.rowTop}>
            <Text style={styles.rowTitle}>{s.displayName}</Text>
            <Text style={[styles.muted, s.status === 'SUSPENDED' && { color: colors.danger }]}>{s.status}</Text>
          </View>
          <Text style={styles.muted}>
            {s.staffCode} · {s.role.replace('_', ' ')}
            {s.agent ? ` · drawer ${rupees(s.agent.drawerMinor)}` : ''}
            {s.bankCode ? ` · ${s.bankCode}` : ''}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  page: { padding: size.pad, gap: 8 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2, marginTop: size.pad },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  row: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, gap: 4 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rowTitle: { color: colors.text, fontSize: size.body, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  flex: { flex: 1 },
});
