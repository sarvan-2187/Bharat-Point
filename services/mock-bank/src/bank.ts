/**
 * Mock bank / payment provider. DEMO ONLY: every account and balance is synthetic.
 *
 * It behaves the way BharatPoint needs a real provider to behave, so the
 * backend can be built and tested against those guarantees:
 *   * debit, credit and reversal are idempotent on requestId: the same id
 *     twice returns the first result and never moves money twice; the same id
 *     with different details is refused (409);
 *   * a status inquiry (GET /v1/requests/:id) says what happened, or 404 if
 *     the request never arrived;
 *   * fault injection rehearses the failures that matter: a decline, an error
 *     before anything is saved, and a timeout after the money has moved.
 *
 * No runtime dependencies (Node's http only). State is written to a JSON file
 * after every change so a restart mid-demo keeps balances.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Kind = 'DEBIT' | 'CREDIT' | 'REVERSAL';
export type FaultMode = 'DECLINE' | 'ERROR_BEFORE_COMMIT' | 'TIMEOUT_AFTER_COMMIT';

interface Account {
  token: string;
  bankCode: string;
  holderName: string;
  maskedLabel: string;
  balanceMinor: number;
}

interface BankRequest {
  requestId: string;
  kind: Kind;
  accountToken: string;
  amountMinor: number;
  originalRequestId: string | null; // REVERSAL only
  status: 'APPROVED' | 'DECLINED';
  reason: string | null;
  reversed: boolean;
  bankRef: string;
  createdAt: string;
}

interface State {
  accounts: Record<string, Account>;
  requests: Record<string, BankRequest>;
}

interface Fault {
  mode: FaultMode;
  remaining: number;
  delayMs: number;
}

export interface MockBankOptions {
  token: string;
  dataFile?: string | null; // null = in memory only (tests)
}

const MAX_BODY = 16 * 1024;

export function createMockBank(opts: MockBankOptions): http.Server {
  let state: State = { accounts: {}, requests: {} };
  if (opts.dataFile && fs.existsSync(opts.dataFile)) state = JSON.parse(fs.readFileSync(opts.dataFile, 'utf8'));
  let fault: Fault | null = null;

  function save() {
    if (!opts.dataFile) return;
    fs.mkdirSync(path.dirname(opts.dataFile), { recursive: true });
    const tmp = `${opts.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, opts.dataFile); // atomic replace: never a half-written file
  }

  /** Faults apply only to new money requests, one at a time, never to replays or inquiries. */
  function takeFault(): Fault | null {
    if (!fault) return null;
    const f = { ...fault };
    fault.remaining -= 1;
    if (fault.remaining <= 0) fault = null;
    return f;
  }

  const authorized = (req: http.IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${opts.token}`);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) reject(new Error('body too large'));
        else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const isText = (v: unknown, max = 100): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

  const view = (r: BankRequest) => ({
    requestId: r.requestId,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    amountMinor: r.amountMinor,
    bankRef: r.bankRef,
    createdAt: r.createdAt,
  });

  function record(r: Omit<BankRequest, 'bankRef' | 'createdAt' | 'reversed'>): BankRequest {
    const stored: BankRequest = {
      ...r,
      reversed: false,
      bankRef: `MB${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      createdAt: new Date().toISOString(),
    };
    state.requests[r.requestId] = stored;
    save();
    return stored;
  }

  /** Apply a new DEBIT or CREDIT. Synchronous between check and commit, so it is atomic. */
  function applyMovement(kind: 'DEBIT' | 'CREDIT', requestId: string, accountToken: string, amountMinor: number, f: Fault | null) {
    const base = { requestId, kind, accountToken, amountMinor, originalRequestId: null };
    if (f?.mode === 'DECLINE') return record({ ...base, status: 'DECLINED', reason: 'SIMULATED_DECLINE' });
    const account = state.accounts[accountToken];
    if (!account) return record({ ...base, status: 'DECLINED', reason: 'ACCOUNT_NOT_FOUND' });
    if (kind === 'DEBIT' && account.balanceMinor < amountMinor) {
      return record({ ...base, status: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' });
    }
    account.balanceMinor += kind === 'DEBIT' ? -amountMinor : amountMinor;
    return record({ ...base, status: 'APPROVED', reason: null });
  }

  function applyReversal(requestId: string, originalRequestId: string, f: Fault | null) {
    const original = state.requests[originalRequestId];
    const base = {
      requestId,
      kind: 'REVERSAL' as const,
      accountToken: original?.accountToken ?? '',
      amountMinor: original?.amountMinor ?? 0,
      originalRequestId,
    };
    if (f?.mode === 'DECLINE') return record({ ...base, status: 'DECLINED', reason: 'SIMULATED_DECLINE' });
    if (!original || original.kind === 'REVERSAL' || original.status !== 'APPROVED') {
      return record({ ...base, status: 'DECLINED', reason: 'ORIGINAL_NOT_REVERSIBLE' });
    }
    if (original.reversed) return record({ ...base, status: 'DECLINED', reason: 'ALREADY_REVERSED' });
    const account = state.accounts[original.accountToken]!;
    account.balanceMinor += original.kind === 'DEBIT' ? original.amountMinor : -original.amountMinor;
    original.reversed = true;
    return record({ ...base, status: 'APPROVED', reason: null });
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://bank');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED' });

    const movement = /^\/v1\/(debit|credit|reverse)$/.exec(url.pathname);
    if (method === 'POST' && movement) {
      const body = await readJson(req);
      const kind: Kind = movement[1] === 'debit' ? 'DEBIT' : movement[1] === 'credit' ? 'CREDIT' : 'REVERSAL';
      const requestId = body.requestId;
      if (!isText(requestId)) return send(res, 400, { error: 'INVALID_REQUEST', field: 'requestId' });
      if (kind === 'REVERSAL' ? !isText(body.originalRequestId) : !isText(body.accountToken) || !isAmount(body.amountMinor)) {
        return send(res, 400, { error: 'INVALID_REQUEST' });
      }

      // Idempotency: a known id returns its first result, whatever happens now.
      const existing = state.requests[requestId];
      if (existing) {
        const same =
          existing.kind === kind &&
          (kind === 'REVERSAL'
            ? existing.originalRequestId === body.originalRequestId
            : existing.accountToken === body.accountToken && existing.amountMinor === body.amountMinor);
        return same ? send(res, 200, view(existing)) : send(res, 409, { error: 'IDEMPOTENCY_MISMATCH' });
      }

      const f = takeFault();
      if (f?.mode === 'ERROR_BEFORE_COMMIT') return send(res, 500, { error: 'SIMULATED_ERROR' });
      const result =
        kind === 'REVERSAL'
          ? applyReversal(requestId, body.originalRequestId as string, f)
          : applyMovement(kind, requestId, body.accountToken as string, body.amountMinor as number, f);
      if (f?.mode === 'TIMEOUT_AFTER_COMMIT') await new Promise((r) => setTimeout(r, f.delayMs)); // money moved; answer is late
      return send(res, 200, view(result));
    }

    const inquiry = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && inquiry) {
      const r = state.requests[decodeURIComponent(inquiry[1]!)];
      return r ? send(res, 200, view(r)) : send(res, 404, { error: 'NOT_FOUND' });
    }

    const account = /^\/v1\/accounts\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && account) {
      const a = state.accounts[decodeURIComponent(account[1]!)];
      return a ? send(res, 200, a) : send(res, 404, { error: 'NOT_FOUND' });
    }

    // ── Demo controls ────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/sim/accounts') {
      const b = await readJson(req);
      if (!isText(b.token) || !isText(b.bankCode) || !isText(b.holderName) || !isText(b.maskedLabel)) {
        return send(res, 400, { error: 'INVALID_REQUEST' });
      }
      if (typeof b.balanceMinor !== 'number' || !Number.isSafeInteger(b.balanceMinor) || b.balanceMinor < 0) {
        return send(res, 400, { error: 'INVALID_REQUEST', field: 'balanceMinor' });
      }
      state.accounts[b.token] = {
        token: b.token,
        bankCode: b.bankCode,
        holderName: b.holderName,
        maskedLabel: b.maskedLabel,
        balanceMinor: b.balanceMinor,
      };
      save();
      return send(res, 201, state.accounts[b.token]);
    }

    if (url.pathname === '/sim/faults') {
      if (method === 'GET') return send(res, 200, { fault });
      if (method === 'POST') {
        const b = await readJson(req);
        if (b.mode === null || b.mode === undefined) {
          fault = null;
          return send(res, 200, { fault });
        }
        const modes: FaultMode[] = ['DECLINE', 'ERROR_BEFORE_COMMIT', 'TIMEOUT_AFTER_COMMIT'];
        if (!modes.includes(b.mode as FaultMode)) return send(res, 400, { error: 'INVALID_REQUEST', field: 'mode' });
        const count = b.count ?? 1;
        const delayMs = b.delayMs ?? 10_000;
        if (!isAmount(count) || count > 100 || typeof delayMs !== 'number' || delayMs < 0 || delayMs > 60_000) {
          return send(res, 400, { error: 'INVALID_REQUEST' });
        }
        fault = { mode: b.mode as FaultMode, remaining: count, delayMs };
        return send(res, 200, { fault });
      }
    }

    return send(res, 404, { error: 'NOT_FOUND' });
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err: Error) => send(res, 400, { error: 'INVALID_REQUEST', detail: err.message }));
  });
}
