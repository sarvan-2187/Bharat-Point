/**
 * The one way the app talks to the backend.
 *
 * Phones reach the backend over the LAN, so EXPO_PUBLIC_API_URL must be the
 * laptop's LAN address (e.g. http://192.168.1.20:4000), never localhost: on
 * the phone, localhost is the phone itself.
 *
 * Errors come back in the backend's single shape { failureCode, message },
 * so screens switch on failureCode rather than parsing strings. The session
 * bearer token (stored in expo-secure-store) is added here once staff
 * sign-in exists.
 */
const BASE = process.env.EXPO_PUBLIC_API_URL;

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
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
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
