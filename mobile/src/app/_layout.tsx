import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '@/lib/theme';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.panel },
          headerTintColor: colors.accent,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'BharatPoint' }} />
        <Stack.Screen name="enrol" options={{ title: 'Enrol this phone' }} />
        <Stack.Screen name="agent/index" options={{ title: 'Agent ATM' }} />
        <Stack.Screen name="admin/index" options={{ title: 'Admin' }} />
        <Stack.Screen name="bank/index" options={{ title: 'Bank operations' }} />
        <Stack.Screen name="customer/index" options={{ title: 'Customer phone (simulator)' }} />
      </Stack>
    </>
  );
}
