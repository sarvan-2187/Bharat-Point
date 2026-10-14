/**
 * HTTP client for the bank / provider (the mock bank in this prototype).
 *
 * Every call ends in one of three outcomes:
 *   ANSWERED   the bank said APPROVED or DECLINED;
 *   NOT_FOUND  (inquiry only) the bank has no record of the request;
 *   UNKNOWN    no clear answer: timeout, dropped connection, 5xx. The money
 *              may or may not have moved, so this is resolved by inquiry,
 *              never by sending a new request.
 */
import { config } from '../config/env';

export type ProviderKind = 'DEBIT' | 'CREDIT' | 'REVERSAL';

export interface BankAnswer {
  requestId: string;
  kind: ProviderKind;
  status: 'APPROVED' | 'DECLINED';
  reason: string | null;
  amountMinor: number;
  bankRef: string;
  createdAt: string;
}

export type Outcome =
  | { kind: 'ANSWERED'; answer: BankAnswer }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNKNOWN'; reason: string };

const PATHS: Record<ProviderKind, string> = { DEBIT: '/v1/debit', CREDIT: '/v1/credit', REVERSAL: '/v1/reverse' };

async function bankFetch(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${config.providerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.providerToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.providerTimeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // a non-JSON error page: treated by the caller according to the status code
  }
  return { status: res.status, body: parsed };
}

const unknown = (err: unknown): Outcome => ({
  kind: 'UNKNOWN',
  reason: (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
});

export async function submit(
  kind: ProviderKind,
  payload: { requestId: string; accountToken?: string; amountMinor?: number; originalRequestId?: string }
): Promise<Outcome> {
  let res;
  try {
    res = await bankFetch('POST', PATHS[kind], payload);
  } catch (err) {
    return unknown(err);
  }
  if (res.status === 200) return { kind: 'ANSWERED', answer: res.body as BankAnswer };
  // Same id, different details: a bug on our side, never something to retry around.
  if (res.status === 409) throw new Error(`provider refused reuse of request id ${payload.requestId} with different details`);
  return { kind: 'UNKNOWN', reason: `HTTP_${res.status}` };
}

export async function inquire(requestId: string): Promise<Outcome> {
  let res;
  try {
    res = await bankFetch('GET', `/v1/requests/${encodeURIComponent(requestId)}`);
  } catch (err) {
    return unknown(err);
  }
  if (res.status === 200) return { kind: 'ANSWERED', answer: res.body as BankAnswer };
  if (res.status === 404) return { kind: 'NOT_FOUND' };
  return { kind: 'UNKNOWN', reason: `HTTP_${res.status}` };
}

// ── Demo fault injection (mock bank only) ─────────────────────────────────

export async function getFault(): Promise<unknown> {
  return (await bankFetch('GET', '/sim/faults')).body;
}

export async function setFault(body: { mode: string | null; count?: number; delayMs?: number }): Promise<unknown> {
  const res = await bankFetch('POST', '/sim/faults', body);
  if (res.status !== 200) throw new Error(`mock bank refused the fault setting (HTTP ${res.status})`);
  return res.body;
}
