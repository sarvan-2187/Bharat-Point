/**
 * This phone's staff signing key.
 *
 * An Ed25519 key generated on the phone, stored in expo-secure-store (this
 * device only, never backed up), and used only after the phone's own
 * biometric / screen-lock prompt succeeds. The server stores only the public
 * key, so a server breach cannot forge a staff signature.
 *
 * The message strings below must match backend/src/auth/crypto.ts exactly.
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { getRandomBytes } from 'expo-crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

export const enrolMessage = (inviteToken: string) => `bharatpoint/enrol/v1\n${inviteToken}`;
export const loginMessage = (challengeId: string, nonce: string) => `bharatpoint/login/v1\n${challengeId}\n${nonce}`;

const SEED = 'bp.deviceKey.seed';
const KEY_ID = 'bp.deviceKey.id';
const STORE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Ask the phone's owner to prove presence. Throws with a readable reason if they cannot. */
async function confirmPresence(reason: string): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
  if (result.success) return;
  if (result.error === 'not_enrolled' || result.error === 'passcode_not_set') {
    throw new Error('Set a screen lock (fingerprint or PIN) on this phone to use BharatPoint.');
  }
  throw new Error('Verification was cancelled.');
}

/** A fresh key pair. Nothing is stored until the server has accepted it (see saveDeviceKey). */
export function newDeviceKey() {
  const seed = getRandomBytes(32);
  return { seed, publicKey: toBase64url(ed25519.getPublicKey(seed)) };
}

export async function saveDeviceKey(seed: Uint8Array, deviceKeyId: string): Promise<void> {
  await SecureStore.setItemAsync(SEED, toBase64url(seed), STORE);
  await SecureStore.setItemAsync(KEY_ID, deviceKeyId, STORE);
}

export const getDeviceKeyId = () => SecureStore.getItemAsync(KEY_ID, STORE);

/** Sign with a key held in memory (enrolment, before it is saved). */
export async function signWithSeed(seed: Uint8Array, message: string, reason: string): Promise<string> {
  await confirmPresence(reason);
  return toBase64url(ed25519.sign(new TextEncoder().encode(message), seed));
}

/** Sign with this phone's saved key. */
export async function signWithDeviceKey(message: string, reason: string): Promise<string> {
  const stored = await SecureStore.getItemAsync(SEED, STORE);
  if (!stored) throw new Error('This phone is not enrolled.');
  return signWithSeed(fromBase64url(stored), message, reason);
}
