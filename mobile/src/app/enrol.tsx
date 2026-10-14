import { useRef, useState, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { enrolThisPhone, INVITE_PREFIX } from '@/lib/session';
import { useTheme, type Colors, size } from '@/lib/theme';

/**
 * Enrol this phone with the one-time invite an admin created
 * (npm run staff:invite on the server, or the admin screen in Phase 8).
 * Scan the QR, or type the code printed under it.
 */
export default function Enrol() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // the scanner fires many times per second

  async function enrol(token: string) {
    if (inFlight.current || !token) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await enrolThisPhone(token.trim());
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.body}>Scan the invite QR your admin gave you.</Text>

      {permission?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (data.startsWith(INVITE_PREFIX)) enrol(data.slice(INVITE_PREFIX.length));
          }}
        />
      ) : (
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonLabel}>Allow camera</Text>
        </Pressable>
      )}

      <Text style={styles.muted}>Or type the code</Text>
      <TextInput
        style={styles.input}
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Invite code"
        placeholderTextColor={colors.muted}
      />
      <Pressable style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => enrol(code)}>
        <Text style={styles.buttonLabel}>Enrol this phone</Text>
      </Pressable>

      {busy && <ActivityIndicator color={colors.accent} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
  page: { flex: 1, padding: size.pad, gap: 12 },
  body: { color: colors.text, fontSize: size.body },
  muted: { color: colors.muted, fontSize: 14 },
  camera: { height: 260, borderRadius: 8, overflow: 'hidden' },
  input: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    fontSize: size.body,
    padding: 12,
  },
  button: { backgroundColor: colors.accent, borderRadius: 8, padding: size.pad, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonLabel: { color: colors.bg, fontSize: size.button, fontWeight: '700' },
  error: { color: colors.danger, fontSize: size.body },
});
