/**
 * The one way the app talks to the backend.
 *
 * Phones reach the backend over the LAN, so EXPO_PUBLIC_API_URL must be the
 * laptop's LAN address (e.g. http://192.168.1.20:4000), never localhost: on
 * the phone, localhost is the phone itself.
 *
 * Errors come back in the backend's single shape { failureCode, message },
 * so screens switch on failureCode rather than parsing strings. The staff
 * session token lives in expo-secure-store and is sent as a Bearer token.
 */
import * as SecureStore from 'expo-secure-store';

const BASE = process.env.EXPO_PUBLIC_API_URL;
const TOKEN = 'bp.session.token';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const getSessionToken = () => SecureStore.getItemAsync(TOKEN, STORE);
export const setSessionToken = (token: string) => SecureStore.setItemAsync(TOKEN, token, STORE);
export const clearSessionToken = () => SecureStore.deleteItemAsync(TOKEN, STORE);

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly failureCode: string,
    message: string
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!BASE) {
    throw new ApiError(0, 'CONFIG', 'EXPO_PUBLIC_API_URL is not set. See mobile/.env.example.');
  }
  const token = await getSessionToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', `Cannot reach ${BASE}. Same Wi-Fi as the laptop?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.failureCode ?? 'HTTP_ERROR', body.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}
