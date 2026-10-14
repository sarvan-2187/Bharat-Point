/**
 * Customers at the counter (Phase 7).
 *
 * A customer is found by their mobile number, exactly; there is no name or
 * partial search, so an agent cannot browse the customer list. The number is
 * never stored in the clear:
 *   phone_lookup  HMAC-SHA256 of the normalised number, for the exact-match search;
 *   phone_enc     AES-256-GCM of the number (iv | tag | ciphertext), for staff
 *                 screens that will need to show it.
 * Both keys are derived from ATTESTATION_SECRET, so a database dump alone
 * reveals neither the numbers nor a way to test guesses against them.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { fail } from '../api/errors';
import { config } from '../config/env';

const derive = (info: string) =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(config.attestationSecret, 'utf8'), 'bharatpoint/customers/v1', info, 32));
const LOOKUP_KEY = derive('bharatpoint/phone-lookup/v1');
const ENC_KEY = derive('bharatpoint/phone-enc/v1');

/** An Indian mobile number as its 10 digits; accepts +91 / 91 / 0 prefixes, spaces and hyphens. */
export function normalizePhone(raw: unknown): string {
  const digits = typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : '';
  const match = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  if (!match) fail('VALIDATION_FAILED', { field: 'phone' });
  return match[1]!;
}

export const phoneLookup = (phone: string) => crypto.createHmac('sha256', LOOKUP_KEY).update(phone, 'utf8').digest('hex');

export function encryptPhone(phone: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export interface NewCustomer {
  displayName: string;
  phone: string; // already normalised
  sipExtension: string | null; // the softphone the IVR rings in the demo
  mode: 'BLIND_ENTRY' | 'READBACK';
  bankId: string;
  providerToken: string; // the account as the bank knows it
  maskedLabel: string;
  /** Optional profile attributes the fraud model needs; without them its assessment is INCOMPLETE. */
  dateOfBirth?: string | null; // YYYY-MM-DD
  gender?: string | null;
  location?: string | null;
}

export async function createCustomer(c: PoolClient, input: NewCustomer) {
  const customer = (
    await c.query<{ id: string }>(
      `INSERT INTO customers (display_name, phone_enc, phone_lookup, sip_extension, confirmation_mode, date_of_birth, gender, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.displayName,
        encryptPhone(input.phone),
        phoneLookup(input.phone),
        input.sipExtension,
        input.mode,
        input.dateOfBirth ?? null,
        input.gender ?? null,
        input.location ?? null,
      ]
    )
  ).rows[0]!;
  const link = (
    await c.query<{ id: string }>(
      `INSERT INTO customer_account_links (customer_id, bank_id, provider_token, masked_label)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [customer.id, input.bankId, input.providerToken, input.maskedLabel]
    )
  ).rows[0]!;
  return { customerId: customer.id, accountLinkId: link.id };
}

export interface CustomerMatch {
  customerId: string;
  displayName: string;
  /** False when the IVR has no number to ring: such a customer cannot confirm a transaction. */
  reachable: boolean;
  accounts: { accountLinkId: string; bankCode: string; bankName: string; maskedLabel: string }[];
}

/** Every customer on this number (families share phones), with their accounts. */
export async function findByPhone(q: Pick<PoolClient, 'query'>, phone: string): Promise<CustomerMatch[]> {
  const { rows } = await q.query<CustomerMatch>(
    `SELECT c.id AS "customerId", c.display_name AS "displayName", c.sip_extension IS NOT NULL AS reachable,
            json_agg(json_build_object('accountLinkId', l.id, 'bankCode', b.code, 'bankName', b.display_name,
                                       'maskedLabel', l.masked_label) ORDER BY l.created_at) AS accounts
       FROM customers c
       JOIN customer_account_links l ON l.customer_id = c.id
       JOIN banks b                  ON b.id = l.bank_id
      WHERE c.phone_lookup = $1
      GROUP BY c.id
      ORDER BY c.created_at`,
    [phoneLookup(phone)]
  );
  return rows;
}
