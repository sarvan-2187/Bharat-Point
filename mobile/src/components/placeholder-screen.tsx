import { StyleSheet, Text, View } from 'react-native';
import { colors, size } from '@/lib/theme';

/** Stand-in for a role area until its phase is built. Delete when the last one is gone. */
export function PlaceholderScreen({ phase, what }: { phase: string; what: string }) {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Not built yet</Text>
      <Text style={styles.body}>{what}</Text>
      <Text style={styles.phase}>{phase}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: size.pad, gap: 8, justifyContent: 'center' },
  title: { color: colors.accent, fontSize: size.title, fontWeight: '700' },
  body: { color: colors.text, fontSize: size.body },
  phase: { color: colors.muted, fontSize: 14 },
});
