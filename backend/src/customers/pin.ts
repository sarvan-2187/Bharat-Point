/**
 * The customer's transaction PIN: the one thing an agent holding the
 * customer's phone cannot know. The customer keys it on the confirmation call;
 * the IVR forwards the digits; BharatPoint checks them here. The IVR is
 * evidence, not authority.
 *
 * Storage: scrypt over HMAC(server pepper, pin), per-customer salt. The pepper
 * comes from ATTESTATION_SECRET, so a copy of the database alone cannot be
 * used to guess the 10,000 possible PINs offline.
 */
import crypto from 'crypto';
import { fail } from '../api/errors';
import { config } from '../config/env';

const PEPPER = Buffer.from(
  crypto.hkdfSync('sha256', Buffer.from(config.attestationSecret, 'utf8'), 'bharatpoint/customers/v1', 'bharatpoint/pin/v1', 32)
);

export const MAX_PIN_FAILURES = 3;
export const PIN_LOCK_MINUTES = 30;

/** Exactly four digits, and not an obvious one (0000, 1234, 4321). */
export function parsePin(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}$/.test(value)) fail('VALIDATION_FAILED', { field: 'pin', reason: 'four digits' });
  const d = [...value].map(Number);
  const same = d.every((x) => x === d[0]);
  const run = d.every((x, i) => i === 0 || x - d[i - 1]! === 1) || d.every((x, i) => i === 0 || d[i - 1]! - x === 1);
  if (same || run) fail('VALIDATION_FAILED', { field: 'pin', reason: 'too easy to guess' });
  return value;
}

const stretch = (pin: string, salt: Buffer) =>
  crypto.scryptSync(crypto.createHmac('sha256', PEPPER).update(pin, 'utf8').digest(), salt, 32);

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${stretch(pin, salt).toString('hex')}`;
}

/** False for anything that is not the four digits that were set. */
export function pinMatches(pin: unknown, stored: string): boolean {
  if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(stretch(pin, Buffer.from(salt, 'hex')), Buffer.from(hash, 'hex'));
}
