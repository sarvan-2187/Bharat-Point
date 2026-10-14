import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LanguageProvider } from '@/lib/i18n';
import { ThemeProvider, useTheme } from '@/lib/theme';

function Screens() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.text },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'BharatPoint' }} />
        <Stack.Screen name="enrol" options={{ title: 'Staff enrolment' }} />
        <Stack.Screen name="signup" options={{ title: '' }} />
        <Stack.Screen name="settings" options={{ title: '' }} />
        <Stack.Screen name="customer/index" options={{ title: 'BharatPoint' }} />
        <Stack.Screen name="agent/index" options={{ title: 'Agent ATM' }} />
        <Stack.Screen name="agent/new" options={{ title: 'New transaction' }} />
        <Stack.Screen name="agent/[id]" options={{ title: 'Transaction' }} />
        <Stack.Screen name="admin/index" options={{ title: 'Admin' }} />
        <Stack.Screen name="admin/new-staff" options={{ title: 'Add staff' }} />
        <Stack.Screen name="admin/staff/[id]" options={{ title: 'Staff member' }} />
        <Stack.Screen name="bank/index" options={{ title: 'Bank operations' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <Screens />
      </LanguageProvider>
    </ThemeProvider>
  );
}
