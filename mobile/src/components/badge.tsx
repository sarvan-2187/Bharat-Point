import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { stateLabel } from '@/lib/counter';
import { useTheme, type Colors } from '@/lib/theme';

const GOOD = new Set(['COMPLETED', 'REVERSED', 'CASH_RETURNED']);
const BAD = new Set(['PROVIDER_DECLINED', 'REJECTED', 'RECONCILIATION_REQUIRED', 'CASH_NOT_DISBURSED']);
const DONE = new Set(['CANCELLED', 'EXPIRED', 'SUPERSEDED']);

/** A transaction state as a coloured pill: green done, red needs attention, grey ended, amber in progress. */
export function StateBadge({ state, label }: { state: string; label?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tone = GOOD.has(state) ? colors.ok : BAD.has(state) ? colors.danger : DONE.has(state) ? colors.muted : colors.accent;
  return (
    <View style={[styles.pill, { backgroundColor: tone + '26' }]}>
      <Text style={[styles.text, { color: tone }]}>{label ?? stateLabel(state)}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  pill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  text: { fontSize: 14, fontWeight: '700' },
});
