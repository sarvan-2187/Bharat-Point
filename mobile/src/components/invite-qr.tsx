import { useMemo } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import type { Invite } from '@/lib/admin';
import { useTheme, type Colors, size } from '@/lib/theme';

/** A one-time enrolment invite for the new staff member's phone to scan (Enrol this phone). */
export function InviteQr({ invite, who }: { invite: Invite; who: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Invite for {who}</Text>
      <Image source={{ uri: invite.qrDataUrl }} style={styles.qr} accessibilityLabel={`Enrolment QR code for ${who}`} />
      <Text style={styles.muted}>Scan on their phone: Enrol this phone. Works once, until {new Date(invite.expiresAt).toLocaleTimeString()}.</Text>
      <Text style={styles.muted}>Or type this code:</Text>
      <Text style={styles.code} selectable>
        {invite.token}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  panel: { backgroundColor: colors.panel, borderColor: colors.accent, borderWidth: 2, borderRadius: 8, padding: size.pad, gap: 8, alignItems: 'center' },
  title: { color: colors.accent, fontSize: size.button, fontWeight: '700' },
  qr: { width: 260, height: 260, backgroundColor: colors.text, borderRadius: 4 }, // QR needs a light quiet zone
  muted: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  code: { color: colors.text, fontSize: 14, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
