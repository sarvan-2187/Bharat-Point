import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '@/components/button';
import { InviteQr } from '@/components/invite-qr';
import { createStaff, type Invite } from '@/lib/admin';
import type { Role } from '@/lib/session';
import { colors, size } from '@/lib/theme';

const ROLES: { role: Role; label: string; prefix: string }[] = [
  { role: 'AGENT', label: 'Agent', prefix: 'AG-' },
  { role: 'BANK_OPERATOR', label: 'Bank operator', prefix: 'BO-' },
  { role: 'ADMIN', label: 'Admin', prefix: 'AD-' },
];

/** Add a staff member, then show their one-time enrolment QR to scan on their own phone. */
export default function NewStaff() {
  const [role, setRole] = useState<Role>('AGENT');
  const [staffCode, setStaffCode] = useState('AG-');
  const [displayName, setDisplayName] = useState('');
  const [locationName, setLocationName] = useState('');
  const [bankCode, setBankCode] = useState('DEMO-SBI');
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(r: (typeof ROLES)[number]) {
    setRole(r.role);
    setStaffCode(r.prefix);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await createStaff({
        role,
        staffCode: staffCode.trim().toUpperCase(),
        displayName: displayName.trim(),
        ...(role === 'AGENT' ? { locationName: locationName.trim() } : {}),
        ...(role === 'BANK_OPERATOR' ? { bankCode: bankCode.trim().toUpperCase() } : {}),
      });
      setInvite(created.invite);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (invite) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <InviteQr invite={invite} who={`${displayName} (${staffCode.toUpperCase()})`} />
        <Button label="Done" onPress={() => router.back()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>ROLE</Text>
      <View style={styles.roles}>
        {ROLES.map((r) => (
          <View key={r.role} style={styles.flex}>
            <Button label={r.label} kind={role === r.role ? 'primary' : 'secondary'} onPress={() => pick(r)} />
          </View>
        ))}
      </View>

      <Text style={styles.label}>STAFF CODE</Text>
      <TextInput style={styles.input} value={staffCode} onChangeText={setStaffCode} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Staff code" />
      <Text style={styles.muted}>Two letters, a hyphen and 3 to 6 digits, e.g. AG-001.</Text>

      <Text style={styles.label}>NAME</Text>
      <TextInput style={styles.input} value={displayName} onChangeText={setDisplayName} accessibilityLabel="Name" />

      {role === 'AGENT' && (
        <>
          <Text style={styles.label}>VILLAGE / POINT NAME</Text>
          <TextInput style={styles.input} value={locationName} onChangeText={setLocationName} accessibilityLabel="Village or point name" />
        </>
      )}
      {role === 'BANK_OPERATOR' && (
        <>
          <Text style={styles.label}>BANK CODE</Text>
          <TextInput style={styles.input} value={bankCode} onChangeText={setBankCode} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Bank code" />
        </>
      )}

      <Button label="Create and show invite" disabled={busy || !displayName.trim()} onPress={submit} />
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: size.pad, gap: 10 },
  label: { color: colors.muted, fontSize: 14, letterSpacing: 2, marginTop: 6 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, fontSize: size.body },
  input: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, fontSize: size.body, padding: 12 },
  roles: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
