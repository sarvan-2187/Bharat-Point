/**
 * Device-key cryptography for staff sign-in.
 *
 * The phone holds an Ed25519 private key (generated with @noble/curves, kept
 * in expo-secure-store, unlocked by the phone's biometric prompt). The server
 * only ever sees the 32-byte public key and verifies signatures with Node's
 * built-in Ed25519.
 *
 * Every signed message starts with a purpose string, so a signature made for
 * enrolment can never be replayed as a login, and vice versa. The phone builds
 * the exact same strings in mobile/src/lib/device-key.ts: keep them identical.
 */
import crypto from 'crypto';

// DER header that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const enrolMessage = (inviteToken: string) => `bharatpoint/enrol/v1\n${inviteToken}`;
export const loginMessage = (challengeId: string, nonce: string) => `bharatpoint/login/v1\n${challengeId}\n${nonce}`;
/** The agent signs the transaction's intent hash: "I entered exactly this transaction". */
export const intentMessage = (intentHash: string) => `bharatpoint/intent/v1\n${intentHash}`;
/** Cash events at the counter, each signed on the agent's phone over the intent hash. */
export const handoverMessage = (intentHash: string) => `bharatpoint/handover/v1\n${intentHash}`;
export const handoverFailedMessage = (intentHash: string) => `bharatpoint/handover-failed/v1\n${intentHash}`;
export const cashReturnedMessage = (intentHash: string) => `bharatpoint/cash-returned/v1\n${intentHash}`;

/** QR payload for an enrolment invite; the phone's scanner expects this prefix. */
export const inviteQrPayload = (token: string) => `bharatpoint-invite:${token}`;

export function verifyEd25519(publicKey: Buffer, message: string, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature);
}

/** 32 random bytes, base64url. Used for invite tokens, session tokens and nonces. */
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** Tokens are stored only as hashes, so a database leak does not leak live tokens. */
export const sha256Hex = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Decode base64url, returning null on anything malformed. */
export function fromBase64url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
}
