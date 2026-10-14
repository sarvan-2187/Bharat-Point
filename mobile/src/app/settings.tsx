import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Stack } from 'expo-router';
import { Segmented } from '@/components/segmented';
import { saveLanguage } from '@/lib/customer';
import { LANGS, useI18n, type Lang } from '@/lib/i18n';
import { loadMe } from '@/lib/session';
import { useTheme, type Colors, type Mode, size } from '@/lib/theme';

/** Preferences: appearance for everyone; language is saved to the server too when a customer is signed in. */
export default function Settings() {
  const { colors, mode, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t, lang, setLang } = useI18n();
  const [isCustomer, setIsCustomer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadMe()
      .then((me) => setIsCustomer(me?.role === 'CUSTOMER'))
      .catch(() => {});
  }, []);

  function pickLanguage(next: Lang) {
    setLang(next);
    setError(null);
    if (isCustomer) saveLanguage(next).catch((e) => setError((e as Error).message));
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: t('settings') }} />

      <Text style={styles.label}>{t('appearance')}</Text>
      <Segmented<Mode>
        options={[
          { value: 'system', label: t('auto') },
          { value: 'light', label: t('light') },
          { value: 'dark', label: t('dark') },
        ]}
        value={mode}
        onChange={setMode}
      />

      <Text style={styles.label}>{t('language')}</Text>
      <Segmented options={LANGS.map((l) => ({ value: l.code, label: l.name }))} value={lang} onChange={pickLanguage} />
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: size.pad, gap: 12 },
    label: { color: colors.text, fontSize: size.body, fontWeight: '700', marginTop: 12 },
    error: { color: colors.danger, fontSize: size.body },
  });
