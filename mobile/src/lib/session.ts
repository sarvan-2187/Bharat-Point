/**
 * Staff enrolment and sign-in from the phone. See backend/src/auth/routes.ts.
 */
import * as Device from 'expo-device';
import { api, ApiError, clearSessionToken, getSessionToken, setSessionToken } from './api';
import { enrolMessage, getDeviceKeyId, loginMessage, newDeviceKey, saveDeviceKey, signWithDeviceKey, signWithSeed } from './device-key';

export type Role = 'AGENT' | 'ADMIN' | 'BANK_OPERATOR';

export interface Me {
  userId: string;
  staffCode: string;
  displayName: string;
  role: Role;
  bankId: string | null;
  agentId: string | null;
}

export const INVITE_PREFIX = 'bharatpoint-invite:';

const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Turn an invite into this phone's enrolled key, then sign in. */
export async function enrolThisPhone(inviteToken: string): Promise<void> {
  const key = newDeviceKey();
  const signature = await signWithSeed(key.seed, enrolMessage(inviteToken), 'Enrol this phone for BharatPoint');
  const { deviceKeyId } = await post<{ deviceKeyId: string }>('/api/v1/auth/enrol', {
    inviteToken,
    publicKey: key.publicKey,
    signature,
    label: Device.modelName ?? 'Phone',
  });
  await saveDeviceKey(key.seed, deviceKeyId);
  await signIn();
}

export async function signIn(): Promise<void> {
  const deviceKeyId = await getDeviceKeyId();
  if (!deviceKeyId) throw new Error('This phone is not enrolled.');
  const challenge = await post<{ challengeId: string; nonce: string }>('/api/v1/auth/challenge', { deviceKeyId });
  const signature = await signWithDeviceKey(
    loginMessage(challenge.challengeId, challenge.nonce),
    'Sign in to BharatPoint'
  );
  const { token } = await post<{ token: string }>('/api/v1/auth/login', {
    challengeId: challenge.challengeId,
    signature,
  });
  await setSessionToken(token);
}

export async function signOut(): Promise<void> {
  try {
    await post('/api/v1/auth/logout', {});
  } finally {
    await clearSessionToken();
  }
}

/** The signed-in staff member, or null (and the stale token dropped) if the session is gone. */
export async function loadMe(): Promise<Me | null> {
  if (!(await getSessionToken())) return null;
  try {
    return await api<Me>('/api/v1/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await clearSessionToken();
      return null;
    }
    throw e;
  }
}

export const isEnrolled = async () => (await getDeviceKeyId()) !== null;
