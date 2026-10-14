import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { Stack, router } from 'expo-router';
import { Button } from '@/components/button';
import { Segmented } from '@/components/segmented';
import { isWeakPin, listBanks, signUpCustomer, tenDigits, type Bank } from '@/lib/customer';
import { LANGS, useI18n } from '@/lib/i18n';
import { useTheme, type Colors, size } from '@/lib/theme';

/** Customer sign-up: name, mobile, bank, language. The phone itself becomes the sign-in key. */
export default function SignUp() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t, lang, setLang } = useI18n();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [ext, setExt] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [bank, setBank] = useState<string | null>(null);
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBanks()
      .then((b) => {
        setBanks(b);
        if (b.length === 1) setBank(b[0]!.code);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const pinOk = /^[0-9]{4}$/.test(pin);
  const pinProblem = pinOk && isWeakPin(pin) ? t('pin_weak') : pin2.length === 4 && pin !== pin2 ? t('pin_mismatch') : null;
  const ready =
    name.trim().length >= 2 && tenDigits(phone) !== null && bank !== null && (ext === '' || /^[0-9]{3,6}$/.test(ext)) && pinOk && pin === pin2 && !isWeakPin(pin);

  async function submit() {
    if (!ready || !bank) return;
    setBusy(true);
    setError(null);
    try {
      await signUpCustomer({ displayName: name, phone, bankCode: bank, language: lang, pin, sipExtension: ext });
      router.replace('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ title: t('sign_up') }} />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t('signup_title')}</Text>

        <Text style={styles.label}>{t('language')}</Text>
        <Segmented options={LANGS.map((l) => ({ value: l.code, label: l.name }))} value={lang} onChange={setLang} />

        <Text style={styles.label}>{t('name')}</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoComplete="name"
          maxLength={80}
          placeholderTextColor={colors.muted}
        />

        <Text style={styles.label}>{t('phone')}</Text>
        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
          maxLength={16}
          placeholder="98765 43210"
          placeholderTextColor={colors.muted}
        />

        <Text style={styles.label}>{t('bank')}</Text>
        {banks === null && !error && <ActivityIndicator color={colors.accent} />}
        {banks?.map((b) => (
          <Pressable
            key={b.code}
            accessibilityRole="radio"
            accessibilityState={{ selected: bank === b.code }}
            onPress={() => setBank(b.code)}
            style={[styles.bank, bank === b.code && styles.bankOn]}
          >
            <Text style={[styles.bankLabel, bank === b.code && { color: colors.accent }]}>{b.displayName}</Text>
          </Pressable>
        ))}

        <Text style={styles.label}>{t('pin')}</Text>
        <TextInput
          style={styles.input}
          value={pin}
          onChangeText={(v) => setPin(v.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={4}
          autoComplete="off"
          importantForAutofill="no"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.label}>{t('pin_again')}</Text>
        <TextInput
          style={styles.input}
          value={pin2}
          onChangeText={(v) => setPin2(v.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={4}
          autoComplete="off"
          importantForAutofill="no"
          placeholderTextColor={colors.muted}
        />
        <Text style={pinProblem ? styles.error : styles.note}>{pinProblem ?? t('pin_hint')}</Text>

        <Text style={styles.label}>{t('ext')}</Text>
        <TextInput
          style={styles.input}
          value={ext}
          onChangeText={setExt}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="6001"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.note}>{t('ext_hint')}</Text>

        {error && <Text style={styles.error}>{error}</Text>}
        <Button label={busy ? '…' : t('create')} disabled={!ready || busy} onPress={submit} />
        <Text style={styles.note}>{t('secure_note')}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    page: { padding: size.pad, gap: 10, paddingBottom: 40 },
    title: { color: colors.text, fontSize: size.title, fontWeight: '700', marginBottom: 6 },
    label: { color: colors.text, fontSize: size.small, fontWeight: '700', marginTop: 8 },
    input: {
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: size.radius,
      backgroundColor: colors.panel,
      color: colors.text,
      fontSize: size.body,
      minHeight: 56,
      paddingHorizontal: 14,
    },
    note: { color: colors.muted, fontSize: size.small },
    error: { color: colors.danger, fontSize: size.body },
    bank: {
      borderColor: colors.border,
      borderWidth: 1.5,
      borderRadius: size.radius,
      backgroundColor: colors.panel,
      minHeight: 56,
      justifyContent: 'center',
      paddingHorizontal: 14,
    },
    bankOn: { borderColor: colors.accent },
    bankLabel: { color: colors.text, fontSize: size.body, fontWeight: '600' },
  });
