import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme, type Colors, size } from '@/lib/theme';

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  base: { borderRadius: size.radius, paddingHorizontal: size.pad, paddingVertical: 14, alignItems: 'center', minHeight: 56, justifyContent: 'center' },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1 },
  dim: { opacity: 0.5 },
  primaryLabel: { color: colors.bg, fontSize: size.body, fontWeight: '700' },
  secondaryLabel: { color: colors.text, fontSize: size.body, fontWeight: '600' },
});
