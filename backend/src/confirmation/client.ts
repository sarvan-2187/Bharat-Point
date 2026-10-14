/**
 * HTTP client for the IVR that places customer confirmation calls.
 *
 * Shaped like provider/client.ts. Every call ends in one of:
 *   ANSWERED   a correctly signed reply about the call we asked about;
 *   NOT_FOUND  the IVR has no record of that callId;
 *   REJECTED   a reply that is unsigned, badly signed, stale, or about another call;
 *   UNKNOWN    no clear answer (timeout, network, 5xx, 429): ask again later.
 *
 * The IVR is evidence, never authority: BharatPoint re-checks the keyed amount
 * itself and the database refuses an approval whose amount differs.
 */
import { config } from '../config/env';
import { nowSeconds, replySignature, requestSignature, signatureValid } from './signing';

export interface IvrSettings {
  url: string;
  secret: string;
}

export interface IvrRecord {
  callId: string;
  status: 'QUEUED' | 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_ANSWER' | 'FAILED';
  decision: 'ACCEPTED' | 'DECLINED' | 'MISMATCH' | 'INVALID_INPUT' | 'NONE';
  keyedRupees: number | null;
  completedAt: string | null;
}

export interface StartCallPayload {
  callId: string;
  extension: string;
  mode: 'BLIND_ENTRY' | 'READBACK';
  txnType: 'CASH_IN' | 'CASH_OUT';
  amountRupees: number;
  agentLabel: string;
  language: string;
  ringTimeoutSeconds: number;
}

export type IvrOutcome =
  | { kind: 'ANSWERED'; record: IvrRecord; signature: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'UNKNOWN'; reason: string };

async function ivrFetch(s: IvrSettings, method: 'GET' | 'POST', path: string, body?: unknown) {
  const ts = nowSeconds();
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-bp-timestamp': ts,
      'x-bp-signature': requestSignature(s.secret, ts, method, path, bodyText),
    },
    body: body === undefined ? undefined : bodyText,
    signal: AbortSignal.timeout(config.ivrTimeoutMs),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function verified(s: IvrSettings, res: Awaited<ReturnType<typeof ivrFetch>>, callId: string): IvrOutcome {
  const ts = res.headers.get('x-bp-timestamp');
  const signature = res.headers.get('x-bp-signature');
  if (!signatureValid(replySignature(s.secret, ts ?? '', res.text), signature, ts)) {
    return { kind: 'REJECTED', reason: 'reply signature missing, invalid or stale' };
  }
  let record: IvrRecord;
  try {
    record = JSON.parse(res.text);
  } catch {
    return { kind: 'REJECTED', reason: 'reply is not JSON' };
  }
  if (record.callId !== callId) return { kind: 'REJECTED', reason: 'reply is about another call' };
  return { kind: 'ANSWERED', record, signature: signature! };
}

const unknown = (err: unknown): IvrOutcome => ({
  kind: 'UNKNOWN',
  reason: (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
});

/** Ask the IVR to place the call. The same callId again never places a second call (IVR contract). */
export async function startCall(s: IvrSettings, payload: StartCallPayload): Promise<IvrOutcome> {
  let res;
  try {
    res = await ivrFetch(s, 'POST', '/api/call', payload);
  } catch (err) {
    return unknown(err);
  }
  if (res.status === 200 || res.status === 202) return verified(s, res, payload.callId);
  return { kind: 'UNKNOWN', reason: `HTTP_${res.status}` };
}

export async function getDecision(s: IvrSettings, callId: string): Promise<IvrOutcome> {
  let res;
  try {
    res = await ivrFetch(s, 'GET', `/api/decision/${callId}`);
  } catch (err) {
    return unknown(err);
  }
  if (res.status === 200) return verified(s, res, callId);
  // An unsigned 404 is accepted: the worst it can cause is re-sending the same
  // callId, which the IVR treats as idempotent.
  if (res.status === 404) return { kind: 'NOT_FOUND' };
  return { kind: 'UNKNOWN', reason: `HTTP_${res.status}` };
}
