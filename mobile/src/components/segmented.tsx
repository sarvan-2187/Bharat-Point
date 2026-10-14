import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Colors, size } from '@/lib/theme';

/** A row of mutually exclusive choices (language, appearance). Large touch targets. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.item, on && styles.itemOn]}
          >
            <Text style={[styles.label, on && styles.labelOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', gap: 8 },
    item: {
      flex: 1,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: size.radius,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.panel,
      paddingHorizontal: 6,
    },
    itemOn: { borderColor: colors.accent, backgroundColor: colors.bg },
    label: { color: colors.muted, fontSize: size.body, fontWeight: '600' },
    labelOn: { color: colors.accent, fontWeight: '700' },
  });
