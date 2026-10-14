/**
 * Adapter for the Asterisk voice-approval API (IVR_KIND=asterisk), which reads
 * the amount out and takes 1 (accept) or 2 (decline). It speaks no signatures,
 * keyed amounts, and PIN entry only when it says so (IVR_PIN_ENTRY=true: the
 * IVR then takes `require_pin` and returns `keyed_pin`). So it serves READBACK
 * confirmations only, and PIN customers only with PIN entry; anything else is refused (audited by the caller) and
 * never quietly weakened. The reply is plain TLS-protected JSON, not signed.
 */
import pool from '../db/pool';
import { config } from '../config/env';
import type { IvrOutcome, IvrRecord, IvrSettings, StartCallPayload } from './client';

// The voices the API has; other customer languages (e.g. Malayalam) hear English.
const VOICE_LANGS = ['ta', 'hi', 'te', 'kn', 'en'];
export const voiceLanguage = (lang: string) => (VOICE_LANGS.includes(lang) ? lang : 'en');

const STATUS: Record<string, IvrRecord['status']> = { COMPLETED: 'COMPLETED', INITIATED: 'IN_PROGRESS', TIMEOUT: 'NO_ANSWER', FAILED: 'FAILED' };

/** One API transaction record → the record BharatPoint understands. */
export function toOutcome(callId: string, t: { status: string; decision?: string | null; updated_at?: string; keyed_pin?: string | null }): IvrOutcome {
  const status = STATUS[t.status];
  if (!status) return { kind: 'UNKNOWN', reason: `STATUS_${t.status}` };
  const decision = status === 'COMPLETED' && (t.decision === 'ACCEPTED' || t.decision === 'DECLINED') ? t.decision : 'NONE';
  const done = status === 'COMPLETED' || status === 'NO_ANSWER' || status === 'FAILED';
  const record: IvrRecord = { callId, status, decision, keyedRupees: null, keyedPin: typeof t.keyed_pin === 'string' ? t.keyed_pin : null, completedAt: done ? t.updated_at ?? null : null };
  return { kind: 'ANSWERED', record, signature: 'unsigned' };
}

async function http(s: IvrSettings, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.ivrTimeoutMs),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const unknown = (err: unknown): IvrOutcome => ({ kind: 'UNKNOWN', reason: (err as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK' });

export async function startCall(s: IvrSettings, p: StartCallPayload): Promise<IvrOutcome> {
  if (p.mode !== 'READBACK' || (p.pinRequired && process.env.IVR_PIN_ENTRY !== 'true')) return { kind: 'REJECTED', reason: 'IVR_CANNOT_DO_BLIND_ENTRY_OR_PIN' };
  // Same callId again never places a second call: if we already dialled it, just report it.
  if (await ivrCallId(p.callId)) return getDecision(s, p.callId);
  try {
    const { status, json } = await http(s, 'POST', '/api/call', {
      extension: p.extension,
      amount: p.amountRupees,
      language: voiceLanguage(p.language),
      require_pin: p.pinRequired,
      wait: false,
      timeout: Math.min(120, Math.max(5, p.ringTimeoutSeconds)),
    });
    if (status !== 200 || !json?.success || !json.call_id) return { kind: 'UNKNOWN', reason: `HTTP_${status}` };
    // ponytail: a crash between the dial and this insert could ring twice; fine for a demo IVR.
    await pool.query(`INSERT INTO ivr_calls (call_id, ivr_call_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [p.callId, json.call_id]);
    return toOutcome(p.callId, json);
  } catch (err) {
    return unknown(err);
  }
}

export async function getDecision(s: IvrSettings, callId: string): Promise<IvrOutcome> {
  const id = await ivrCallId(callId);
  if (!id) return { kind: 'NOT_FOUND' };
  try {
    const { status, json } = await http(s, 'GET', `/api/decision/${encodeURIComponent(id)}`);
    if (status !== 200) return { kind: 'UNKNOWN', reason: `HTTP_${status}` };
    return json?.found && json.transaction ? toOutcome(callId, json.transaction) : { kind: 'NOT_FOUND' };
  } catch (err) {
    return unknown(err);
  }
}

const ivrCallId = async (callId: string) =>
  (await pool.query<{ ivr_call_id: string }>(`SELECT ivr_call_id FROM ivr_calls WHERE call_id = $1`, [callId])).rows[0]?.ivr_call_id;
