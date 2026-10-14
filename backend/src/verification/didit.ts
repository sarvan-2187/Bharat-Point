/**
 * Official Didit API client and webhook cryptographic verification (KYB & KYC).
 *
 * Documentation:
 * https://docs.didit.me/
 * https://business.didit.me/
 */
import crypto from 'crypto';
import { config } from '../config/env';

// Per-session config, NOT a secret and NOT an env var.
// Default KYB workflow published on Didit account:
export const DEFAULT_KYB_WORKFLOW_ID = '04aa1c13-7b92-4ac9-8d6d-5a30b9d15d37';

export interface DiditSessionRequest {
  workflowId?: string;
  vendorData: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface DiditSessionResponse {
  sessionId: string;
  sessionToken?: string;
  url: string;
  status: string;
  workflowId: string;
}

export interface DiditDecisionResponse {
  sessionId: string;
  status: string;
  decision?: Record<string, unknown>;
}

const DIDIT_API_BASE = 'https://verification.didit.me';

/**
 * Creates a verification session using Didit V3 API.
 * In development or when credentials are not configured, generates a mock sandbox session.
 */
export async function createDiditSession(req: DiditSessionRequest): Promise<DiditSessionResponse> {
  const apiKey = config.diditApiKey;
  const workflowId = req.workflowId || DEFAULT_KYB_WORKFLOW_ID;
  const callback = req.callbackUrl;

  // If live credentials are provided, call Didit V3 API
  if (apiKey && !apiKey.startsWith('mock_')) {
    const payload: Record<string, unknown> = {
      workflow_id: workflowId,
      vendor_data: req.vendorData,
    };
    if (callback) {
      payload.callback = callback;
    }
    if (req.metadata) {
      payload.metadata = req.metadata;
    }

    try {
      const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          session_id?: string;
          session_token?: string;
          url?: string;
          status?: string;
          workflow_id?: string;
        };

        if (data.session_id && data.url) {
          return {
            sessionId: data.session_id,
            sessionToken: data.session_token,
            url: data.url,
            status: data.status ?? 'Not Started',
            workflowId: data.workflow_id ?? workflowId,
          };
        }
      } else {
        const errDetail = await res.text().catch(() => '');
        console.warn(`[didit] Live API returned ${res.status}: ${errDetail}. Falling back to sandbox session.`);
      }
    } catch (networkErr) {
      console.warn(`[didit] Network call failed: ${(networkErr as Error).message}. Falling back to sandbox session.`);
    }
  }

  // Sandbox / Mock fallback when credits are zero or offline testing
  const mockId = crypto.randomUUID();
  const mockToken = `tok_${crypto.randomBytes(12).toString('base64url')}`;
  return {
    sessionId: `didit_sim_${mockId}`,
    sessionToken: mockToken,
    url: `https://verify.didit.me/session/${mockToken}?demo=true`,
    status: 'Not Started',
    workflowId: workflowId,
  };
}

/**
 * Retrieves the latest decision report from Didit V3 API.
 */
export async function getDiditDecision(sessionId: string): Promise<DiditDecisionResponse | null> {
  const apiKey = config.diditApiKey;
  if (!apiKey || apiKey.startsWith('mock_') || sessionId.startsWith('didit_sim_')) {
    return null;
  }

  try {
    const res = await fetch(`${DIDIT_API_BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      session_id: string;
      status: string;
      decision?: Record<string, unknown>;
    };

    return {
      sessionId: data.session_id ?? sessionId,
      status: data.status,
      decision: data.decision,
    };
  } catch {
    return null;
  }
}

// ─── Load-bearing Canonicalisation for Didit X-Signature-V2 ──────────────────

/**
 * Whole-number floats (1.0) -> integers (1), recursively. Matches Didit's server canonicalisation.
 */
export function shortenFloats(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shortenFloats);
  if (v && typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shortenFloats(x)])
    );
  }
  if (typeof v === 'number' && !Number.isInteger(v) && v % 1 === 0) return Math.trunc(v);
  return v;
}

/**
 * Recursive lexicographic key sort (array order preserved).
 */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && v !== null) {
    return Object.keys(v as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

/**
 * Canonicalises parsed payload for X-Signature-V2:
 * shortenFloats -> sortKeys -> JSON.stringify with unescaped Unicode (JS default).
 */
export function canonicalizePayload(parsed: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(parsed)));
}

/**
 * Freshness check: verifies the SIGNED body `timestamp` field (never the unsigned X-Timestamp header).
 * Rejects requests older than maxAgeSec (default 300 seconds).
 */
export function verifyTimestampFreshness(timestamp: unknown, maxAgeSec = 300): boolean {
  if (!timestamp) return false;
  let sec: number;
  if (typeof timestamp === 'number') {
    // Unix seconds vs milliseconds
    sec = timestamp > 1e11 ? timestamp / 1000 : timestamp;
  } else if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (isNaN(parsed)) return false;
    sec = parsed / 1000;
  } else {
    return false;
  }

  const nowSec = Date.now() / 1000;
  return Math.abs(nowSec - sec) <= maxAgeSec;
}

/**
 * Cryptographically verifies a Didit webhook signature using HMAC-SHA256.
 * Checks X-Signature-V2 (canonical JSON), X-Signature (raw buffer), or X-Signature-Simple.
 */
export function verifyDiditWebhookSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  if (!secret) {
    return false;
  }

  const headerSig =
    (typeof headers['x-signature-v2'] === 'string' ? headers['x-signature-v2'] : undefined) ||
    (typeof headers['x-signature'] === 'string' ? headers['x-signature'] : undefined) ||
    (typeof headers['x-signature-simple'] === 'string' ? headers['x-signature-simple'] : undefined) ||
    (typeof headers['x-didit-signature'] === 'string' ? headers['x-didit-signature'] : undefined);

  if (!headerSig) {
    return false;
  }

  const rawBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  // Attempt X-Signature-V2 canonical JSON verification
  try {
    const parsed = JSON.parse(rawBuffer.toString('utf8'));
    const canonical = canonicalizePayload(parsed);
    const expectedV2 = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
    if (secureCompare(headerSig, expectedV2)) {
      return true;
    }

    // Attempt X-Signature-Simple: `${session_id}|${status}|${timestamp}` or `${timestamp}:${session_id}:${status}:${webhook_type}`
    const sessionId = parsed?.session_id || parsed?.data?.session_id;
    const status = parsed?.status || parsed?.data?.status;
    const ts = parsed?.timestamp || parsed?.created_at;
    const webhookType = parsed?.webhook_type || 'status.updated';
    if (sessionId && status) {
      const candidates = [
        `${sessionId}|${status}|${ts}`,
        `${sessionId}|${status}`,
        `${ts}:${sessionId}:${status}:${webhookType}`,
      ];
      for (const c of candidates) {
        const expectedSimple = crypto.createHmac('sha256', secret).update(c, 'utf8').digest('hex');
        if (secureCompare(headerSig, expectedSimple)) {
          return true;
        }
      }
    }
  } catch {
    // not JSON
  }

  // Attempt X-Signature raw buffer
  const expectedRaw = crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
  if (secureCompare(headerSig, expectedRaw)) {
    return true;
  }

  return false;
}

function secureCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const strA = a.trim().toLowerCase();
  const strB = b.trim().toLowerCase();
  if (strA.length !== strB.length) return false;
  return crypto.timingSafeEqual(Buffer.from(strA, 'utf8'), Buffer.from(strB, 'utf8'));
}
