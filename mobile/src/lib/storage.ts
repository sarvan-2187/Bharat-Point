import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getItem(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(key, options);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value);
      }
    } catch {
      // ignore
    }
    return;
  }
  return SecureStore.setItemAsync(key, value, options);
}

export async function deleteItem(key: string, options?: SecureStore.SecureStoreOptions): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore
    }
    return;
  }
  return SecureStore.deleteItemAsync(key, options);
}
