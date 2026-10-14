/**
 * Customer self-registration (demo only).
 *
 * Opens a simulated account at the mock bank, then creates the customer, a
 * CUSTOMER user and its device key in one DB transaction. Sign-in afterwards
 * is the same challenge-response as staff. Proof of key possession is a
 * signature over "signup:<phone>", checked before anything is written.
 *
 * ponytail: the phone number is not verified (no OTP), so anyone can claim a
 * number in the demo. A real deployment needs OTP or bank-side KYC here.
 */
import crypto from 'crypto';
import { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail, isUniqueViolation } from '../api/errors';
import { optionalStr, str } from '../api/validate';
import { config, isDemoMode } from '../config/env';
import { enrolMessage, fromBase64url, verifyEd25519 } from '../auth/crypto';
import { createCustomer, normalizePhone } from './customers';
import { hashPin, parsePin } from './pin';

export const LANGUAGES = ['en', 'hi', 'te', 'ta', 'ml'] as const;
export type Language = (typeof LANGUAGES)[number];

export function parseLanguage(value: unknown): Language {
  if (!LANGUAGES.includes(value as Language)) fail('VALIDATION_FAILED', { field: 'language' });
  return value as Language;
}

const STARTING_BALANCE_RUPEES = 10000;

export async function signUp(body: Record<string, unknown> | undefined): Promise<{ deviceKeyId: string }> {
  if (!isDemoMode()) fail('NOT_FOUND');
  const displayName = str(body, 'displayName', { max: 80 });
  const phone = normalizePhone(body?.phone);
  const bankCode = str(body, 'bankCode', { max: 20, pattern: /^[A-Z0-9-]+$/ });
  const language = parseLanguage(body?.language ?? 'en');
  const pinHash = hashPin(parsePin(body?.pin));
  const sipExtension = optionalStr(body, 'sipExtension', { max: 6, pattern: /^[0-9]{3,6}$/ });
  const label = optionalStr(body, 'label', { max: 60 });
  // Optional profile attributes for the fraud review; the app does not collect them yet.
  const dateOfBirth = optionalStr(body, 'dateOfBirth', { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  if (dateOfBirth && (Number.isNaN(Date.parse(dateOfBirth)) || new Date(dateOfBirth).toISOString().slice(0, 10) !== dateOfBirth)) {
    fail('VALIDATION_FAILED', { field: 'dateOfBirth' });
  }
  const gender = optionalStr(body, 'gender', { max: 20 });
  const location = optionalStr(body, 'location', { max: 80 });
  const publicKey = fromBase64url(body?.publicKey);
  const signature = fromBase64url(body?.signature);
  if (!publicKey || publicKey.length !== 32) fail('VALIDATION_FAILED', { field: 'publicKey' });
  if (!signature || !verifyEd25519(publicKey, enrolMessage(`signup:${phone}`), signature)) fail('AUTH_FAILED');

  try {
    return await withTransaction(async (c) => {
      const bank = (await c.query<{ id: string }>(`SELECT id FROM banks WHERE code = $1`, [bankCode])).rows[0];
      if (!bank) fail('VALIDATION_FAILED', { field: 'bankCode' });

      // Open the simulated account at the bank first; a failure leaves nothing in our database.
      const providerToken = crypto.randomUUID();
      const maskedLabel = `${bankCode} ••••${crypto.randomInt(1000, 10000)}`;
      let status: number;
      try {
        status = (
          await fetch(`${config.providerUrl}/sim/accounts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.providerToken}` },
            body: JSON.stringify({ token: providerToken, bankCode, holderName: displayName, maskedLabel, balanceMinor: STARTING_BALANCE_RUPEES * 100 }),
            signal: AbortSignal.timeout(config.providerTimeoutMs),
          })
        ).status;
      } catch {
        status = 0;
      }
      if (status !== 201) fail('PROVIDER_UNAVAILABLE', { reason: 'the bank could not open the account' });

      const user = (
        await c.query<{ id: string }>(
          `INSERT INTO users (staff_code, display_name, role) VALUES ($1, $2, 'CUSTOMER') RETURNING id`,
          [`CU-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, displayName]
        )
      ).rows[0]!;
      const { customerId } = await createCustomer(c, { displayName, phone, sipExtension, mode: 'BLIND_ENTRY', bankId: bank.id, providerToken, maskedLabel, dateOfBirth, gender, location });
      await c.query(`UPDATE customers SET user_id = $2, preferred_language = $3, pin_hash = $4 WHERE id = $1`, [customerId, user.id, language, pinHash]);
      const key = (
        await c.query<{ id: string }>(`INSERT INTO device_keys (user_id, public_key, label) VALUES ($1, $2, $3) RETURNING id`, [user.id, publicKey, label])
      ).rows[0]!;
      await audit(c, 'CUSTOMER_REGISTERED', { actorUserId: user.id, data: { customerId, deviceKeyId: key.id } });
      return { deviceKeyId: key.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'publicKey' });
    throw err;
  }
}
