/**
 * Fraud review. A fake scorer stands in for the Python service so every failure
 * mode can be forced; the real model is tested in services/fraud-scorer/test_server.py.
 *
 * The rules under test: nothing is guessed (a missing feature means the model is
 * not asked), "no score" is never shown as "low risk", thresholds are validated,
 * and an assessment never changes the payment it describes.
 *
 * Only pure modules are imported at the top of this file: importing anything that
 * loads config/env here would point the whole suite at the real database.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dbSkip, startHarness, type Harness } from '../testing/harness';
import { intentMessage } from '../auth/crypto';
import { classify, fraudSettings } from './config';
import { ageAt, buildFeatures, parseFeatureMap, type FeatureMap } from './features';

const MAP: FeatureMap = { source: 'test fixture', gender: { F: 0, M: 1, T: 2 }, location: { MUMBAI: 4000 } };

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try {
    fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
};

describe('feature building (no guessing)', () => {
  const base = { amountMinor: 30_000, balanceMinor: 1_000_000, dateOfBirth: '1990-05-15', gender: 'f', location: ' mumbai ', map: MAP };

  test('every feature comes from real data; time is Asia/Kolkata with Monday=0', () => {
    // 20:30 UTC on Saturday 17 Oct 2026 is 02:00 IST on Sunday 18 Oct.
    const { features, missing } = buildFeatures({ ...base, at: new Date('2026-10-17T20:30:00Z') });
    assert.deepEqual(missing, []);
    assert.deepEqual(features, {
      age: 36,
      gender_num: 0,
      location_code: 4000,
      CustAccountBalance: 10_000,
      'TransactionAmount (INR)': 300,
      hour: 2,
      day_of_week: 6,
      month: 10,
      is_weekend: 1,
    });
  });

  test('a weekday is not a weekend', () => {
    const f = buildFeatures({ ...base, at: new Date('2026-10-14T06:30:00Z') }).features!; // Wednesday 12:00 IST
    assert.equal(f.day_of_week, 2);
    assert.equal(f.is_weekend, 0);
    assert.equal(f.hour, 12);
  });

  test('age counts whole years and refuses unusable dates', () => {
    assert.equal(ageAt('1990-10-18', new Date('2026-10-18T05:00:00Z')), 36);
    assert.equal(ageAt('1990-10-19', new Date('2026-10-18T05:00:00Z')), 35);
    assert.equal(ageAt('2999-01-01', new Date('2026-10-18T05:00:00Z')), null);
    assert.equal(ageAt('not a date', new Date()), null);
  });

  test('anything that cannot be sourced is reported, and no feature vector is built', () => {
    const at = new Date('2026-10-14T06:30:00Z');
    const none = buildFeatures({ amountMinor: 100, balanceMinor: null, dateOfBirth: null, gender: null, location: null, at, map: MAP });
    assert.equal(none.features, null);
    assert.deepEqual(none.missing.map((m) => m.feature).sort(), ['CustAccountBalance', 'age', 'gender_num', 'location_code']);

    const unmapped = buildFeatures({ ...base, gender: 'X', location: 'PUNE', at });
    assert.equal(unmapped.features, null);
    assert.match(unmapped.missing.find((m) => m.feature === 'gender_num')!.reason, /no encoding for "X"/);
    assert.match(unmapped.missing.find((m) => m.feature === 'location_code')!.reason, /no encoding for "PUNE"/);

    // The shipped, empty map can never produce a score.
    const empty = parseFeatureMap({ source: 'x', gender: {}, location: {} });
    assert.equal(buildFeatures({ ...base, map: empty, at }).features, null);
  });

  test('a malformed feature map is rejected with the exact problem', () => {
    assert.throws(() => parseFeatureMap({ gender: {}, location: {} }), /source/);
    assert.throws(() => parseFeatureMap({ source: 's', gender: { F: -1 }, location: {} }), /non-negative/);
    assert.throws(() => parseFeatureMap({ source: 's', gender: { F: 1.5 }, location: {} }), /whole number/);
    assert.throws(() => parseFeatureMap({ source: 's', gender: [], location: {} }), /object/);
  });
});

describe('thresholds are validated, not trusted', () => {
  test('defaults, and classification at the boundaries', () => {
    withEnv({ FRAUD_THRESHOLD_MEDIUM: undefined, FRAUD_THRESHOLD_HIGH: undefined, FRAUD_SCORER_URL: undefined }, () => {
      const s = fraudSettings();
      assert.deepEqual([s.medium, s.high, s.scorer], [0.5, 0.8, null]);
      assert.equal(classify(0.4999, s), 'LOW');
      assert.equal(classify(0.5, s), 'MEDIUM');
      assert.equal(classify(0.7999, s), 'MEDIUM');
      assert.equal(classify(0.8, s), 'HIGH');
      assert.equal(classify(1, s), 'HIGH');
    });
  });

  test('bad settings stop the server rather than change behaviour', () => {
    const bad = (vars: Record<string, string>, why: RegExp) =>
      withEnv({ FRAUD_THRESHOLD_MEDIUM: undefined, FRAUD_THRESHOLD_HIGH: undefined, FRAUD_SCORER_URL: undefined, FRAUD_SCORER_TOKEN: undefined, ...vars }, () => assert.throws(() => fraudSettings(), why));
    bad({ FRAUD_THRESHOLD_MEDIUM: '0.9', FRAUD_THRESHOLD_HIGH: '0.5' }, /must be lower/);
    bad({ FRAUD_THRESHOLD_MEDIUM: '0.8', FRAUD_THRESHOLD_HIGH: '0.8' }, /must be lower/);
    bad({ FRAUD_THRESHOLD_MEDIUM: '0' }, /greater than 0/);
    bad({ FRAUD_THRESHOLD_MEDIUM: '1' }, /less than 1/);
    bad({ FRAUD_THRESHOLD_HIGH: '1.5' }, /at most 1/);
    bad({ FRAUD_THRESHOLD_HIGH: 'high' }, /invalid/);
    bad({ FRAUD_SCORER_URL: 'http://127.0.0.1:1', FRAUD_SCORER_TOKEN: 'short' }, /16 characters/);
    bad({ FRAUD_SCORER_URL: 'http://127.0.0.1:1', FRAUD_SCORER_TOKEN: 'x'.repeat(16), FRAUD_SCORER_TIMEOUT_MS: '5' }, /100 to 30000/);
  });
});

describe('fraud review in the admin workflow', { skip: dbSkip }, () => {
  type Mode = { kind: 'ok'; p: number } | { kind: 'status'; code: number; body?: unknown } | { kind: 'raw'; body: unknown } | { kind: 'hang' };
  const TOKEN = 'fraud-test-token-0123456789';

  let h: Harness;
  let scorer: http.Server;
  let mode: Mode;
  let received: { auth: string | undefined; features: Record<string, number> }[];
  let admin: Awaited<ReturnType<Harness['signedIn']>>;
  let agent: Awaited<ReturnType<Harness['signedIn']>>;
  let cust: Awaited<ReturnType<Harness['customer']>>;
  let bare: Awaited<ReturnType<Harness['customer']>>; // no date of birth / gender / location
  let mapFile: string;

  before(async () => {
    h = await startHarness();
    mapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-fraud-')), 'map.json');
    fs.writeFileSync(mapFile, JSON.stringify(MAP));

    scorer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, features: JSON.parse(body).features });
        if (mode.kind === 'hang') return; // never answers
        const send = (code: number, payload: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (mode.kind === 'ok') return send(200, { probability: mode.p, modelSha256: 'f'.repeat(64) });
        if (mode.kind === 'status') return send(mode.code, mode.body ?? {});
        send(200, mode.body);
      });
    });
    await new Promise<void>((r) => scorer.listen(0, '127.0.0.1', r));

    admin = await h.signedIn('ADMIN');
    agent = await h.signedIn('AGENT');
    cust = await h.customer('Asha');
    bare = await h.customer('Bare');
    await h.pool.query(`UPDATE customers SET date_of_birth = '1990-05-15', gender = 'F', location = 'MUMBAI' WHERE id = $1`, [cust.customerId]);
  });
  after(async () => {
    scorer.closeAllConnections();
    await new Promise((r) => scorer.close(r));
    await h?.close();
  });
  beforeEach(() => {
    received = [];
    mode = { kind: 'ok', p: 0.93 };
    process.env.FRAUD_SCORER_URL = `http://127.0.0.1:${(scorer.address() as { port: number }).port}`;
    process.env.FRAUD_SCORER_TOKEN = TOKEN;
    process.env.FRAUD_FEATURE_MAP = mapFile;
    process.env.FRAUD_SCORER_TIMEOUT_MS = '400';
    delete process.env.FRAUD_THRESHOLD_MEDIUM;
    delete process.env.FRAUD_THRESHOLD_HIGH;
  });

  async function newPayment(customer = cust, amountMinor = 30_000) {
    const res = await h.call('POST', '/transactions', { txnType: 'CASH_OUT', amountMinor, customerId: customer.customerId, accountLinkId: customer.accountLinkId }, agent.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as { id: string; intentHash: string };
  }

  /** The assessment runs in the background after the payment is created; wait for its row. */
  async function assessment(txId: string, until: (row: Record<string, unknown>) => boolean = () => true) {
    for (let i = 0; i < 60; i++) {
      const row = (await h.pool.query(`SELECT * FROM fraud_assessments WHERE transaction_id = $1`, [txId])).rows[0];
      if (row && until(row)) return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no assessment for ${txId}`);
  }

  test('a scored payment: the model gets exactly the nine real features, and the admin sees who, how much and how risky', async () => {
    const tx = await newPayment();
    const a = await assessment(tx.id);

    assert.equal(a.status, 'SCORED');
    assert.equal(a.category, 'HIGH');
    assert.equal(Number(a.probability), 0.93);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.auth, `Bearer ${TOKEN}`);
    const sent = received[0]!.features;
    assert.deepEqual(Object.keys(sent).sort(), ['CustAccountBalance', 'TransactionAmount (INR)', 'age', 'day_of_week', 'gender_num', 'hour', 'is_weekend', 'location_code', 'month']);
    assert.equal(sent.gender_num, 0);
    assert.equal(sent.location_code, 4000);
    assert.equal(sent['TransactionAmount (INR)'], 300);
    assert.equal(sent.CustAccountBalance, 10_000); // the mock bank's balance for this customer

    const created = (await h.pool.query(`SELECT created_at FROM transactions WHERE id = $1`, [tx.id])).rows[0].created_at as Date;
    const expected = buildFeatures({ amountMinor: 30_000, balanceMinor: 1_000_000, dateOfBirth: '1990-05-15', gender: 'F', location: 'MUMBAI', at: created, map: MAP }).features!;
    assert.deepEqual(sent, expected);

    const list = (await h.call('GET', '/admin/fraud', undefined, admin.token)).body;
    const row = list.assessments.find((x: { transactionId: string }) => x.transactionId === tx.id);
    assert.equal(row.amountMinor, 30_000);
    assert.equal(row.agentCode, agent.auth.staffCode);
    assert.match(row.customerRef, /^CUS-[0-9A-F]{8}$/);
    assert.match(row.accountLabel, /DEMO-SBI/);
    assert.equal(row.category, 'HIGH');
    assert.equal(row.reviewStatus, 'PENDING');
    assert.deepEqual(list.settings.thresholds, { medium: 0.5, high: 0.8 });

    const alerts = (await h.call('GET', '/admin/alerts', undefined, admin.token)).body.alerts;
    assert.ok(alerts.some((x: { kind: string; transactionId: string }) => x.kind === 'FRAUD_FLAGGED' && x.transactionId === tx.id));
    const live = (await h.call('GET', '/admin/live', undefined, admin.token)).body;
    assert.equal(live.transactions.find((t: { id: string }) => t.id === tx.id).riskCategory, 'HIGH');
    assert.ok(live.summary.fraudFlagged >= 1);
  });

  test('the configured thresholds decide the category', async () => {
    process.env.FRAUD_THRESHOLD_MEDIUM = '0.3';
    process.env.FRAUD_THRESHOLD_HIGH = '0.6';
    mode = { kind: 'ok', p: 0.45 };
    assert.equal((await assessment((await newPayment()).id)).category, 'MEDIUM');
    mode = { kind: 'ok', p: 0.2 };
    assert.equal((await assessment((await newPayment()).id)).category, 'LOW');
  });

  test('a missing feature means the model is not asked, and the payment is NOT shown as low risk', async () => {
    const tx = await newPayment(bare);
    const a = await assessment(tx.id);
    assert.equal(a.status, 'INCOMPLETE');
    assert.equal(a.category, null);
    assert.equal(a.probability, null);
    assert.equal(received.length, 0, 'the scorer must not be called with guessed values');
    assert.deepEqual((a.missing as { feature: string }[]).map((m) => m.feature).sort(), ['age', 'gender_num', 'location_code']);
  });

  test('every way the scorer can fail gives "no score", never a category', async () => {
    const cases: [Mode | null, RegExp][] = [
      [{ kind: 'status', code: 500 }, /^SCORER_HTTP_500$/],
      [{ kind: 'status', code: 422, body: { fields: { age: 'missing' } } }, /^SCORER_REJECTED_FEATURES/],
      [{ kind: 'raw', body: { probability: 7, modelSha256: 'a' } }, /^SCORER_BAD_REPLY$/],
      [{ kind: 'raw', body: { probability: -0.1, modelSha256: 'a' } }, /^SCORER_BAD_REPLY$/],
      [{ kind: 'raw', body: { probability: '0.9', modelSha256: 'a' } }, /^SCORER_BAD_REPLY$/],
      [{ kind: 'raw', body: { probability: null, modelSha256: 'a' } }, /^SCORER_BAD_REPLY$/],
      [{ kind: 'raw', body: { modelSha256: 'a' } }, /^SCORER_BAD_REPLY$/],
      [{ kind: 'hang' }, /^SCORER_TIMEOUT$/],
    ];
    for (const [m, reason] of cases) {
      mode = m!;
      const a = await assessment((await newPayment()).id);
      assert.equal(a.status, 'UNAVAILABLE', JSON.stringify(m));
      assert.match(String(a.reason), reason, JSON.stringify(m));
      assert.equal(a.category, null, JSON.stringify(m));
      assert.equal(a.probability, null, JSON.stringify(m));
    }
    process.env.FRAUD_SCORER_URL = 'http://127.0.0.1:9'; // nothing listens
    assert.equal((await assessment((await newPayment()).id)).reason, 'SCORER_UNREACHABLE');
    delete process.env.FRAUD_SCORER_URL;
    assert.equal((await assessment((await newPayment()).id)).reason, 'SCORER_NOT_CONFIGURED');
  });

  test('an invalid setting is recorded as unavailable, not silently defaulted', async () => {
    process.env.FRAUD_THRESHOLD_MEDIUM = '0.9';
    process.env.FRAUD_THRESHOLD_HIGH = '0.5';
    const a = await assessment((await newPayment()).id);
    assert.equal(a.status, 'UNAVAILABLE');
    assert.match(String(a.reason), /^CONFIG_INVALID: .*must be lower/);
    assert.equal(a.category, null);
    assert.equal(received.length, 0);
  });

  test('an assessment never changes or blocks the payment', async () => {
    mode = { kind: 'status', code: 500 };
    const tx = await newPayment();
    await assessment(tx.id);
    const before = (await h.pool.query(`SELECT state, amount_minor, intent_hash FROM transactions WHERE id = $1`, [tx.id])).rows[0];
    assert.equal(before.state, 'CREATED');
    // The agent can still sign: the unavailable score did not block, and did not approve, anything.
    const signed = await h.call('POST', `/transactions/${tx.id}/sign`, { signature: agent.device.sign(intentMessage(tx.intentHash)) }, agent.token);
    assert.equal(signed.status, 200);
    const after = (await h.pool.query(`SELECT state, amount_minor, intent_hash FROM transactions WHERE id = $1`, [tx.id])).rows[0];
    assert.deepEqual(after, before);
  });

  test('review: clear or escalate with a note, once; only admins; escalation opens a ticket', async () => {
    const cleared = await newPayment();
    await assessment(cleared.id);
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/review`, { decision: 'CLEARED', note: 'x' }, agent.token)).status, 403);
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/review`, { decision: 'CLEARED' }, admin.token)).status, 400); // note required
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/review`, { decision: 'MAYBE', note: 'x' }, admin.token)).status, 400);
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/review`, { decision: 'CLEARED', note: 'Known customer, usual amount.' }, admin.token)).status, 204);
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/review`, { decision: 'ESCALATED', note: 'again' }, admin.token)).status, 409);
    assert.equal((await h.call('POST', `/admin/fraud/${cleared.id}/rerun`, {}, admin.token)).status, 409); // reviewed: frozen
    const alerts = (await h.call('GET', '/admin/alerts', undefined, admin.token)).body.alerts;
    assert.ok(!alerts.some((x: { kind: string; transactionId: string }) => x.kind === 'FRAUD_FLAGGED' && x.transactionId === cleared.id), 'a reviewed payment leaves the alert board');

    const escalated = await newPayment();
    await assessment(escalated.id);
    assert.equal((await h.call('POST', `/admin/fraud/${escalated.id}/review`, { decision: 'ESCALATED', note: 'Agent has three in a row.' }, admin.token)).status, 204);
    const tickets = (await h.call('GET', '/admin/tickets', undefined, admin.token)).body.tickets;
    const t = tickets.find((x: { transactionId: string; kind: string }) => x.transactionId === escalated.id);
    assert.equal(t.kind, 'FRAUD_REVIEW');
    assert.equal(t.status, 'OPEN');
  });

  test('"try scoring again" recovers a payment once the scorer is back, and reviewing a payment with no score is allowed but explicit', async () => {
    mode = { kind: 'status', code: 500 };
    const tx = await newPayment();
    assert.equal((await assessment(tx.id)).status, 'UNAVAILABLE');
    mode = { kind: 'ok', p: 0.12 };
    assert.equal((await h.call('POST', `/admin/fraud/${tx.id}/rerun`, {}, admin.token)).status, 204);
    const a = await assessment(tx.id, (r) => r.status === 'SCORED');
    assert.equal(a.category, 'LOW');

    mode = { kind: 'status', code: 500 };
    const noScore = await newPayment();
    await assessment(noScore.id);
    assert.equal((await h.call('POST', `/admin/fraud/${noScore.id}/review`, { decision: 'CLEARED', note: 'Checked by phone; no model score.' }, admin.token)).status, 204);
    const row = (await h.pool.query(`SELECT status, category, review_status FROM fraud_assessments WHERE transaction_id = $1`, [noScore.id])).rows[0];
    assert.deepEqual(row, { status: 'UNAVAILABLE', category: null, review_status: 'CLEARED' }); // human decision; the missing score stays missing
  });

  test('payments created before this feature are picked up when the admin opens the review', async () => {
    const tx = await newPayment();
    await assessment(tx.id);
    await h.pool.query(`DELETE FROM fraud_assessments WHERE transaction_id = $1`, [tx.id]); // as if it had never been assessed
    await h.call('GET', '/admin/fraud', undefined, admin.token);
    assert.equal((await assessment(tx.id)).status, 'SCORED');
  });
});
