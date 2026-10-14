/**
 * Cash at the counter (Phase 6).
 *
 * Every cash event is signed on the agent's phone over the transaction's
 * intent hash, so the agent cannot later deny it:
 *   handover        cash-out: the cash was handed to the customer -> COMPLETED.
 *                   A fresh settlement capability is minted from the complete
 *                   chain and consumed with the ledger write: the last gate
 *                   before cash leaves the drawer.
 *   handover failed cash-out: the cash could not be paid -> CASH_NOT_DISBURSED ->
 *                   REVERSAL_PENDING, and the bank debit is reversed (exactly once).
 *   cash returned   cash-in the bank declined: the agent gave the cash back.
 *
 * Receipts are signed with an Ed25519 key derived from ATTESTATION_SECRET, so
 * anyone with the published public key can check one offline.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail } from '../api/errors';
import { config } from '../config/env';
import type { Auth } from '../auth/middleware';
import { cashReturnedMessage, fromBase64url, handoverFailedMessage, handoverMessage, verifyEd25519 } from '../auth/crypto';
import { appendStep, canonicalJson, consumeCapability, mintCapability } from '../transactions/chain';
import { transition, type TxRow } from '../transactions/service';
import { postHandover } from '../ledger/ledger';
import { sendReversal } from '../provider/service';

/** Lock the agent's own transaction, check its state, then the phone signature over `message(intentHash)`. */
async function signedEvent(
  c: PoolClient,
  auth: Auth,
  txId: string,
  signatureB64: unknown,
  expect: { txnType: 'CASH_IN' | 'CASH_OUT'; state: string },
  message: (intentHash: string) => string
): Promise<TxRow> {
  const signature = fromBase64url(signatureB64);
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });
  const tx = (await c.query<TxRow>(`SELECT * FROM transactions WHERE id = $1 FOR UPDATE`, [txId])).rows[0];
  if (!tx || tx.agent_id !== auth.agentId) fail('NOT_FOUND');
  if (tx.txn_type !== expect.txnType || tx.state !== expect.state) fail('STATE_CONFLICT', { state: tx.state });
  const key = (
    await c.query<{ public_key: Buffer }>(`SELECT public_key FROM device_keys WHERE id = $1 AND revoked_at IS NULL`, [auth.deviceKeyId])
  ).rows[0];
  if (!key || !verifyEd25519(key.public_key, message(tx.intent_hash), signature)) {
    fail('AUTH_FAILED', { reason: 'signature does not match this phone' });
  }
  return tx;
}

export async function confirmHandover(auth: Auth, txId: string, signature: unknown): Promise<void> {
  await withTransaction(async (c) => {
    const tx = await signedEvent(c, auth, txId, signature, { txnType: 'CASH_OUT', state: 'PROVIDER_APPROVED' }, handoverMessage);
    await appendStep(c, tx.id, 'CASH_HANDOVER_CONFIRMED', { deviceKeyId: auth.deviceKeyId, signature: signature as string });
    const cap = await mintCapability(
      c,
      tx.id,
      tx.intent_hash,
      ['INTENT_LOCKED', 'AGENT_SIGNED', 'CUSTOMER_CONFIRMED', 'PROVIDER_AUTHORIZED', 'CASH_HANDOVER_CONFIRMED'],
      60
    );
    await consumeCapability(c, cap.id, tx);
    await postHandover(c, tx);
    await transition(c, tx.id, ['PROVIDER_APPROVED'], 'COMPLETED', { kind: 'AGENT', userId: auth.userId });
    await audit(c, 'CASH_HANDED_OVER', { actorUserId: auth.userId, transactionId: tx.id, data: { amountMinor: Number(tx.amount_minor) } });
  });
}

export async function reportHandoverFailed(auth: Auth, txId: string, signature: unknown, reason: string | null): Promise<string> {
  await withTransaction(async (c) => {
    const tx = await signedEvent(c, auth, txId, signature, { txnType: 'CASH_OUT', state: 'PROVIDER_APPROVED' }, handoverFailedMessage);
    await transition(c, tx.id, ['PROVIDER_APPROVED'], 'CASH_NOT_DISBURSED', { kind: 'AGENT', userId: auth.userId }, {
      failureCode: 'CASH_NOT_DISBURSED',
      detail: { reason },
    });
    await transition(c, tx.id, ['CASH_NOT_DISBURSED'], 'REVERSAL_PENDING', { kind: 'SYSTEM', userId: null });
    await audit(c, 'CASH_HANDOVER_FAILED', { actorUserId: auth.userId, transactionId: tx.id, data: { reason } });
  });
  return sendReversal(txId); // if the bank does not answer, the sweeper retries with the same request id
}

export async function confirmCashReturned(auth: Auth, txId: string, signature: unknown): Promise<void> {
  await withTransaction(async (c) => {
    const tx = await signedEvent(c, auth, txId, signature, { txnType: 'CASH_IN', state: 'CASH_RETURN_REQUIRED' }, cashReturnedMessage);
    await transition(c, tx.id, ['CASH_RETURN_REQUIRED'], 'CASH_RETURNED', { kind: 'AGENT', userId: auth.userId });
    await audit(c, 'CASH_RETURNED', { actorUserId: auth.userId, transactionId: tx.id, data: { amountMinor: Number(tx.amount_minor) } });
  });
}

// ── Signed receipts ───────────────────────────────────────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const receiptKey = (() => {
  const seed = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(config.attestationSecret, 'utf8'), 'bharatpoint/attestation/v1', 'bharatpoint/receipt/v1', 32)
  );
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  const keyId = `rcpt-${crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 12)}`;
  return { privateKey, publicKeyPem, keyId };
})();

export const receiptPublicKey = () => ({ keyId: receiptKey.keyId, algorithm: 'Ed25519', publicKeyPem: receiptKey.publicKeyPem });

const RECEIPT_STATES = ['COMPLETED', 'REVERSED', 'CASH_RETURNED'];

/** A signed receipt for a finished transaction; verify canonicalJson(receipt) with the published key. */
export async function buildReceipt(q: Pick<PoolClient, 'query'>, txId: string) {
  const row = (
    await q.query(
      `SELECT t.id, t.txn_type, t.amount_minor, t.state, t.intent_hash, c.display_name AS customer_name,
              l.masked_label, ag.agent_code, ag.location_name, b.code AS bank_code,
              (SELECT response->>'bankRef' FROM provider_requests
                WHERE transaction_id = t.id AND kind IN ('DEBIT', 'CREDIT')) AS bank_ref,
              (SELECT row_hash FROM authorization_steps WHERE transaction_id = t.id ORDER BY seq DESC LIMIT 1) AS chain_tip
         FROM transactions t
         JOIN customers c              ON c.id = t.customer_id
         JOIN customer_account_links l ON l.id = t.account_link_id
         JOIN agents ag                ON ag.id = t.agent_id
         JOIN banks b                  ON b.id = t.bank_id
        WHERE t.id = $1`,
      [txId]
    )
  ).rows[0];
  if (!row) fail('NOT_FOUND');
  if (!RECEIPT_STATES.includes(row.state)) fail('STATE_CONFLICT', { state: row.state, reason: 'no receipt until the transaction is finished' });
  const receipt = {
    version: 1,
    simulated: true, // demo software: every bank and customer is synthetic
    transactionId: row.id,
    txnType: row.txn_type,
    amountMinor: Number(row.amount_minor),
    state: row.state,
    customerName: row.customer_name,
    accountLabel: row.masked_label,
    agentCode: row.agent_code,
    agentLocation: row.location_name,
    bankCode: row.bank_code,
    bankRef: row.bank_ref,
    intentHash: row.intent_hash,
    chainTipHash: row.chain_tip,
    issuedAt: new Date().toISOString(),
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), receiptKey.privateKey).toString('base64url');
  return { receipt, signature, keyId: receiptKey.keyId };
}
