/**
 * HMAC signing between BharatPoint and the IVR (shared secret IVR_SHARED_SECRET).
 *
 *   request  X-BP-Signature = hex(HMAC-SHA256(secret, `${ts}\n${METHOD}\n${path}\n${body}`))
 *   reply    X-BP-Signature = hex(HMAC-SHA256(secret, `${ts}\n${body}`))
 *   both     X-BP-Timestamp = unix seconds; rejected if more than 60 s from now
 *
 * `path` is exactly as sent (e.g. /api/decision/confirm:<id>:1); `body` is the
 * exact raw body text ('' for GET). Replies must also name the callId that was
 * asked about, so a reply for one call can never be replayed as another's.
 * The Python IVR implements the same three lines with hmac.new(...).hexdigest().
 */
import crypto from 'crypto';

export const MAX_SKEW_SECONDS = 60;

const hmacHex = (secret: string, message: string) => crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');

export const requestSignature = (secret: string, ts: string, method: string, path: string, body: string) =>
  hmacHex(secret, `${ts}\n${method.toUpperCase()}\n${path}\n${body}`);

export const replySignature = (secret: string, ts: string, body: string) => hmacHex(secret, `${ts}\n${body}`);

export const nowSeconds = () => String(Math.floor(Date.now() / 1000));

/** Constant-time check of a signature and its freshness. */
export function signatureValid(expectedHex: string, givenHex: string | null, ts: string | null): boolean {
  if (!givenHex || !ts || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Number(nowSeconds()) - Number(ts)) > MAX_SKEW_SECONDS) return false;
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(givenHex, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
