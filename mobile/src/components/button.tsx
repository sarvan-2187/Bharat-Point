import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, size } from '@/lib/theme';

/** The app's two buttons: a solid amber primary and an outlined secondary (red when `danger`). */
export function Button({
  label,
  onPress,
  kind = 'primary',
  danger = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  danger?: boolean;
  disabled?: boolean;
}) {
  const primary = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : [styles.secondary, danger && { borderColor: colors.danger }],
        (pressed || disabled) && styles.dim,
      ]}
    >
      <Text style={[primary ? styles.primaryLabel : styles.secondaryLabel, danger && !primary && { color: colors.danger }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: 8, padding: size.pad, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
  primary: { backgroundColor: colors.accent },
  secondary: { borderColor: colors.border, borderWidth: 1 },
  dim: { opacity: 0.5 },
  primaryLabel: { color: colors.bg, fontSize: size.button, fontWeight: '700' },
  secondaryLabel: { color: colors.text, fontSize: size.body },
});
