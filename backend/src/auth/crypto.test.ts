/**
 * The phone signs with @noble/curves; the server verifies with Node's crypto.
 * This pins that the two agree, and that signatures are bound to their purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { enrolMessage, loginMessage, verifyEd25519 } from './crypto';

test('a signature made by @noble/curves (the phone) verifies on the server', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const secret = crypto.randomBytes(32);
  const publicKey = Buffer.from(ed25519.getPublicKey(secret));
  const message = loginMessage(crypto.randomUUID(), 'nonce-123');
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret));

  assert.equal(verifyEd25519(publicKey, message, signature), true);

  // Bound to its purpose: the same signature is not a valid enrolment.
  assert.equal(verifyEd25519(publicKey, enrolMessage('nonce-123'), signature), false);

  const tampered = Buffer.from(signature);
  tampered[0] = tampered[0]! ^ 1;
  assert.equal(verifyEd25519(publicKey, message, tampered), false);
});

test('wrong-length keys and signatures are rejected without throwing', () => {
  assert.equal(verifyEd25519(Buffer.alloc(31), 'x', Buffer.alloc(64)), false);
  assert.equal(verifyEd25519(crypto.randomBytes(32), 'x', Buffer.alloc(10)), false);
});
