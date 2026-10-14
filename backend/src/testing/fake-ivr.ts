/**
 * In-process fake of the IVR contract (test-only; never imported by the app).
 *
 * Implements exactly what BharatPoint expects from the real IVR on the Mac:
 * signed requests required, signed replies, caller-chosen idempotent callId,
 * POST /api/call and GET /api/decision/:callId. Outcomes are scripted per
 * extension, so a test decides what the "customer" does.
 */
import http from 'node:http';
import { nowSeconds, replySignature, requestSignature, signatureValid } from '../confirmation/signing';

export type FakeOutcome =
  | { decision: 'ACCEPTED' | 'MISMATCH'; keyedRupees: number; keyedPin?: string; pendingPolls?: number; badSignature?: boolean }
  | { decision: 'DECLINED' | 'INVALID_INPUT'; pendingPolls?: number; badSignature?: boolean }
  | { status: 'NO_ANSWER' | 'FAILED'; pendingPolls?: number }
  | { unreachable: true }; // the next POST fails with 500 and nothing is recorded

interface CallRecord {
  callId: string;
  extension: string;
  outcome: Exclude<FakeOutcome, { unreachable: true }> | null; // null = rings forever
  pollsLeft: number;
}

export async function startFakeIvr(secret: string) {
  const scripts = new Map<string, FakeOutcome[]>();
  const records = new Map<string, CallRecord>();
  const posts: { callId: string; extension: string; created: boolean; pinRequired?: boolean; mode?: string }[] = [];

  const view = (rec: CallRecord) => {
    const base = { callId: rec.callId, keyedRupees: null as number | null, keyedPin: null as string | null, completedAt: null as string | null };
    if (!rec.outcome) return { ...base, status: 'RINGING', decision: 'NONE' };
    if (rec.pollsLeft > 0) {
      rec.pollsLeft -= 1;
      return { ...base, status: 'IN_PROGRESS', decision: 'NONE' };
    }
    const completedAt = new Date().toISOString();
    if ('status' in rec.outcome) return { ...base, status: rec.outcome.status, decision: 'NONE', completedAt };
    const keyed = 'keyedRupees' in rec.outcome ? rec.outcome.keyedRupees : null;
    const keyedPin = 'keyedPin' in rec.outcome ? (rec.outcome.keyedPin ?? null) : null;
    return { ...base, status: 'COMPLETED', decision: rec.outcome.decision, keyedRupees: keyed, keyedPin, completedAt };
  };

  const reply = (res: http.ServerResponse, status: number, body: unknown, rec?: CallRecord) => {
    const text = JSON.stringify(body);
    const ts = nowSeconds();
    const bad = rec?.outcome && 'badSignature' in rec.outcome && rec.outcome.badSignature;
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-bp-timestamp': ts,
      'x-bp-signature': replySignature(bad ? 'not-the-shared-secret-0000000000' : secret, ts, text),
    });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      const ts = (req.headers['x-bp-timestamp'] as string | undefined) ?? null;
      const sig = (req.headers['x-bp-signature'] as string | undefined) ?? null;
      if (!signatureValid(requestSignature(secret, ts ?? '', req.method ?? '', path, body), sig, ts)) {
        return reply(res, 401, { error: 'BAD_SIGNATURE' });
      }

      if (req.method === 'POST' && path === '/api/call') {
        const p = JSON.parse(body) as { callId: string; extension: string; pinRequired?: boolean; mode?: string };
        const existing = records.get(p.callId);
        if (existing) {
          posts.push({ callId: p.callId, extension: p.extension, created: false });
          return reply(res, 200, view(existing), existing);
        }
        const next = scripts.get(p.extension)?.shift() ?? null;
        if (next && 'unreachable' in next) {
          posts.push({ callId: p.callId, extension: p.extension, created: false });
          res.writeHead(500);
          return res.end('IVR down');
        }
        const rec: CallRecord = { callId: p.callId, extension: p.extension, outcome: next, pollsLeft: next?.pendingPolls ?? 0 };
        records.set(p.callId, rec);
        posts.push({ callId: p.callId, extension: p.extension, created: true, pinRequired: p.pinRequired, mode: p.mode });
        return reply(res, 202, { callId: p.callId, status: 'QUEUED', decision: 'NONE', keyedRupees: null, completedAt: null }, rec);
      }

      const decision = /^\/api\/decision\/(.+)$/.exec(path);
      if (req.method === 'GET' && decision) {
        const rec = records.get(decision[1]!);
        if (!rec) return reply(res, 404, { error: 'NOT_FOUND' });
        return reply(res, 200, view(rec), rec);
      }
      reply(res, 404, { error: 'NOT_FOUND' });
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    /** What the customer on this extension does on the next calls, in order. */
    script: (extension: string, ...outcomes: FakeOutcome[]) => scripts.set(extension, [...(scripts.get(extension) ?? []), ...outcomes]),
    posts,
    /** How many real calls were placed for this callId (an idempotent re-send is not a new call). */
    callsPlaced: (callId: string) => posts.filter((p) => p.callId === callId && p.created).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type FakeIvr = Awaited<ReturnType<typeof startFakeIvr>>;
