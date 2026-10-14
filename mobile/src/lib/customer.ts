/**
 * Customer sign-up and preferences. See backend/src/customers/{signup,routes}.ts.
 * Sign-up makes this phone's key (the customer's passkey), proves it to the
 * server by signing "signup:<phone>", then signs in exactly like staff do.
 */
import * as Device from 'expo-device';
import { api } from './api';
import { enrolMessage, newDeviceKey, saveDeviceKey, signWithSeed } from './device-key';
import type { Lang } from './i18n';
import { signIn } from './session';

export interface Bank {
  code: string;
  displayName: string;
}

export const listBanks = async () => (await api<{ banks: Bank[] }>('/api/v1/banks')).banks;

/** An Indian mobile as its 10 digits (the server normalises the same way), or null. */
export function tenDigits(raw: string): string | null {
  return /^(?:\+?91|0)?([6-9]\d{9})$/.exec(raw.replace(/[\s-]/g, ''))?.[1] ?? null;
}

/** The same easy-PIN rule as the server (all one digit, or counting up or down). */
export function isWeakPin(pin: string): boolean {
  const d = [...pin].map(Number);
  return d.every((x) => x === d[0]) || d.every((x, i) => i === 0 || x - d[i - 1]! === 1) || d.every((x, i) => i === 0 || d[i - 1]! - x === 1);
}

export async function signUpCustomer(input: {
  displayName: string;
  pin: string;
  phone: string;
  bankCode: string;
  language: Lang;
  sipExtension: string;
}): Promise<void> {
  const phone = tenDigits(input.phone);
  if (!phone) throw new Error('Enter a 10-digit mobile number.');
  const key = newDeviceKey();
  const signature = await signWithSeed(key.seed, enrolMessage(`signup:${phone}`), 'Create your BharatPoint account');
  const { deviceKeyId } = await api<{ deviceKeyId: string }>('/api/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      displayName: input.displayName.trim(),
      phone,
      bankCode: input.bankCode,
      language: input.language,
      pin: input.pin,
      sipExtension: input.sipExtension.trim() || undefined,
      publicKey: key.publicKey,
      signature,
      label: Device.modelName ?? 'Phone',
    }),
  });
  await saveDeviceKey(key.seed, deviceKeyId);
  await signIn();
}

/** "This wasn't me": tell the admin a transaction on my account was not mine. */
export const reportTransaction = (id: string) =>
  api(`/api/v1/transactions/${id}/report`, { method: 'POST', body: JSON.stringify({}) });

export const raiseSupportTicket = (message: string) =>
  api('/api/v1/me/support', { method: 'POST', body: JSON.stringify({ message }) });

/** Save the signed-in customer's language on the server (the IVR call speaks it). */
export const saveLanguage = (language: Lang) =>
  api('/api/v1/me/preferences', { method: 'PUT', body: JSON.stringify({ language }) });
export const loadLanguage = async () => (await api<{ language: Lang }>('/api/v1/me/preferences')).language;
