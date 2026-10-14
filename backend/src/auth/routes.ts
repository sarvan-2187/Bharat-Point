/**
 * Staff enrolment and sign-in.
 *
 *   enrol:   invite token + new device public key + signature over the token
 *   login:   POST /auth/challenge -> sign the nonce on the phone -> POST /auth/login
 *   logout:  revokes the session server-side
 *
 * Every failure is the same AUTH_FAILED, so a caller cannot tell an unknown
 * invite from a spent or expired one, or a revoked key from a wrong signature.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/pool';
import { audit } from '../db/audit';
import { fail, isUniqueViolation } from '../api/errors';
import { optionalStr, str, uuid } from '../api/validate';
import { config } from '../config/env';
import { enrolMessage, fromBase64url, loginMessage, randomToken, sha256Hex, verifyEd25519 } from './crypto';
import { requireRole, type Auth } from './middleware';

const CHALLENGE_TTL_SECONDS = 60;

const router = Router();

router.post('/auth/enrol', async (req, res) => {
  const inviteToken = str(req.body, 'inviteToken', { max: 100 });
  const label = optionalStr(req.body, 'label', { max: 60 });
  const publicKey = fromBase64url(req.body?.publicKey);
  const signature = fromBase64url(req.body?.signature);
  if (!publicKey || publicKey.length !== 32) fail('VALIDATION_FAILED', { field: 'publicKey' });
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });

  // Proof the caller holds the private key, checked before the invite is
  // touched: a bad signature must not burn someone's invite.
  if (!verifyEd25519(publicKey, enrolMessage(inviteToken), signature)) fail('AUTH_FAILED');

  try {
    const result = await withTransaction(async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string }>(
        `SELECT i.id, i.user_id
           FROM enrolment_invites i JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > NOW() AND u.status = 'ACTIVE'
          FOR UPDATE OF i`,
        [sha256Hex(inviteToken)]
      );
      const invite = rows[0];
      if (!invite) fail('AUTH_FAILED');

      await c.query(`UPDATE enrolment_invites SET used_at = NOW() WHERE id = $1`, [invite.id]);
      const key = (
        await c.query<{ id: string }>(
          `INSERT INTO device_keys (user_id, public_key, label) VALUES ($1, $2, $3) RETURNING id`,
          [invite.user_id, publicKey, label]
        )
      ).rows[0]!;
      await audit(c, 'DEVICE_ENROLLED', { actorUserId: invite.user_id, data: { deviceKeyId: key.id, label } });
      return { deviceKeyId: key.id };
    });
    res.status(201).json(result);
  } catch (err) {
    if (isUniqueViolation(err)) fail('ALREADY_EXISTS', { field: 'publicKey' });
    throw err;
  }
});

router.post('/auth/challenge', async (req, res) => {
  const deviceKeyId = uuid(req.body?.deviceKeyId, 'deviceKeyId');
  const { rows } = await query(
    `SELECT 1 FROM device_keys d JOIN users u ON u.id = d.user_id
      WHERE d.id = $1 AND d.revoked_at IS NULL AND u.status = 'ACTIVE'`,
    [deviceKeyId]
  );
  if (!rows[0]) fail('AUTH_FAILED');

  const nonce = randomToken();
  const challenge = (
    await query<{ id: string; expires_at: Date }>(
      `INSERT INTO auth_challenges (device_key_id, nonce, expires_at)
       VALUES ($1, $2, NOW() + make_interval(secs => $3)) RETURNING id, expires_at`,
      [deviceKeyId, nonce, CHALLENGE_TTL_SECONDS]
    )
  ).rows[0]!;
  res.json({ challengeId: challenge.id, nonce, expiresAt: challenge.expires_at });
});

router.post('/auth/login', async (req, res) => {
  const challengeId = uuid(req.body?.challengeId, 'challengeId');
  const signature = fromBase64url(req.body?.signature);
  if (!signature) fail('VALIDATION_FAILED', { field: 'signature' });

  // Consume the challenge first, in its own statement: one attempt per
  // challenge whatever the outcome, so a signature can never be replayed.
  const { rows } = await query<{ nonce: string; device_key_id: string; public_key: Buffer; user_id: string }>(
    `UPDATE auth_challenges c SET used_at = NOW()
       FROM device_keys d JOIN users u ON u.id = d.user_id
      WHERE c.id = $1 AND c.used_at IS NULL AND c.expires_at > NOW()
        AND d.id = c.device_key_id AND d.revoked_at IS NULL AND u.status = 'ACTIVE'
      RETURNING c.nonce, d.id AS device_key_id, d.public_key, u.id AS user_id`,
    [challengeId]
  );
  const challenge = rows[0];
  if (!challenge) fail('AUTH_FAILED');

  const verified = verifyEd25519(challenge.public_key, loginMessage(challengeId, challenge.nonce), signature);
  const token = randomToken();

  const session = await withTransaction(async (c) => {
    if (!verified) {
      await audit(c, 'LOGIN_FAILED', { actorUserId: challenge.user_id, data: { deviceKeyId: challenge.device_key_id } });
      return null;
    }
    const s = (
      await c.query<{ id: string; expires_at: Date }>(
        `INSERT INTO sessions (token_hash, user_id, device_key_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(hours => $4)) RETURNING id, expires_at`,
        [sha256Hex(token), challenge.user_id, challenge.device_key_id, config.sessionTtlHours]
      )
    ).rows[0]!;
    await c.query(`UPDATE device_keys SET last_used_at = NOW() WHERE id = $1`, [challenge.device_key_id]);
    await audit(c, 'LOGIN_SUCCEEDED', {
      actorUserId: challenge.user_id,
      data: { deviceKeyId: challenge.device_key_id, sessionId: s.id },
    });
    return s;
  });
  if (!session) fail('AUTH_FAILED');

  res.json({ token, expiresAt: session.expires_at });
});

router.post('/auth/logout', requireRole(), async (req, res) => {
  const auth = req.auth!;
  await withTransaction(async (c) => {
    await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [auth.sessionId]);
    await audit(c, 'SESSION_REVOKED', { actorUserId: auth.userId, data: { sessionId: auth.sessionId, reason: 'logout' } });
  });
  res.status(204).end();
});

router.get('/me', requireRole(), (req, res) => {
  const { sessionId: _sessionId, ...me } = req.auth as Auth;
  res.json(me);
});

export default router;
