/**
 * The mock bank keeps the promises BharatPoint relies on from a real provider:
 * one request id moves money at most once, inquiries tell the truth, and the
 * injected faults behave exactly as named.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { createMockBank } from './bank';

const TOKEN = 'test-token-0123456789';

async function start(dataFile: string | null = null) {
  const server = createMockBank({ token: TOKEN, dataFile });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, p: string, body?: unknown, opts: { token?: string; timeoutMs?: number } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token ?? TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { server: server as http.Server, call, close };
}

describe('mock bank', () => {
  let bank: Awaited<ReturnType<typeof start>>;
  let token: string;

  const balance = async () => (await bank.call('GET', `/v1/accounts/${token}`)).body.balanceMinor as number;
  const debit = (requestId: string, amountMinor = 20000, opts = {}) =>
    bank.call('POST', '/v1/debit', { requestId, accountToken: token, amountMinor }, opts);

  before(async () => {
    bank = await start();
  });
  after(() => bank.close());

  beforeEach(async () => {
    token = crypto.randomUUID();
    await bank.call('POST', '/sim/accounts', {
      token,
      bankCode: 'DEMO-SBI',
      holderName: 'Lakshmi',
      maskedLabel: 'Demo SBI ••••4321',
      balanceMinor: 100000,
    });
    await bank.call('POST', '/sim/faults', { mode: null });
  });

  test('the same request id twice debits exactly once', async () => {
    const first = await debit('debit:a');
    const second = await debit('debit:a');
    assert.equal(first.body.status, 'APPROVED');
    assert.deepEqual(second.body, first.body);
    assert.equal(await balance(), 80000);
  });

  test('reusing a request id with different details is refused', async () => {
    await debit('debit:b', 20000);
    assert.equal((await debit('debit:b', 50000)).status, 409);
    assert.equal(await balance(), 80000);
  });

  test('insufficient funds is a stored decline, and a replay returns the same decline', async () => {
    const res = await debit('debit:c', 500000);
    assert.equal(res.body.status, 'DECLINED');
    assert.equal(res.body.reason, 'INSUFFICIENT_FUNDS');
    assert.deepEqual((await debit('debit:c', 500000)).body, res.body);
    assert.equal(await balance(), 100000);
  });

  test('an inquiry reports what happened, or 404 if the request never arrived', async () => {
    await debit('debit:d');
    assert.equal((await bank.call('GET', '/v1/requests/debit:d')).body.status, 'APPROVED');
    assert.equal((await bank.call('GET', '/v1/requests/never-sent')).status, 404);
  });

  test('fault DECLINE: the next request is declined and recorded', async () => {
    await bank.call('POST', '/sim/faults', { mode: 'DECLINE' });
    assert.equal((await debit('debit:e')).body.reason, 'SIMULATED_DECLINE');
    assert.equal((await debit('debit:f')).body.status, 'APPROVED'); // one-shot
    assert.equal(await balance(), 80000);
  });

  test('fault ERROR_BEFORE_COMMIT: nothing is saved, so a retry of the same id debits once', async () => {
    await bank.call('POST', '/sim/faults', { mode: 'ERROR_BEFORE_COMMIT' });
    assert.equal((await debit('debit:g')).status, 500);
    assert.equal((await bank.call('GET', '/v1/requests/debit:g')).status, 404);
    assert.equal(await balance(), 100000);
    assert.equal((await debit('debit:g')).body.status, 'APPROVED');
    assert.equal(await balance(), 80000);
  });

  test('fault TIMEOUT_AFTER_COMMIT: the money moves even though the caller gave up', async () => {
    await bank.call('POST', '/sim/faults', { mode: 'TIMEOUT_AFTER_COMMIT', delayMs: 1000 });
    await assert.rejects(debit('debit:h', 20000, { timeoutMs: 200 }));
    assert.equal((await bank.call('GET', '/v1/requests/debit:h')).body.status, 'APPROVED');
    assert.equal(await balance(), 80000);
    assert.equal((await debit('debit:h')).body.status, 'APPROVED'); // replay: no second debit
    assert.equal(await balance(), 80000);
  });

  test('a reversal restores the money once', async () => {
    await debit('debit:i');
    const rev = await bank.call('POST', '/v1/reverse', { requestId: 'reversal:i', originalRequestId: 'debit:i' });
    assert.equal(rev.body.status, 'APPROVED');
    assert.equal(await balance(), 100000);
    const again = await bank.call('POST', '/v1/reverse', { requestId: 'reversal:i2', originalRequestId: 'debit:i' });
    assert.equal(again.body.reason, 'ALREADY_REVERSED');
    assert.equal(await balance(), 100000);
  });

  test('requests without the shared token are refused', async () => {
    assert.equal((await debit('debit:j', 20000, { token: 'wrong-token-0123456' })).status, 401);
  });

  test('state survives a restart when a data file is set', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mockbank-')), 'state.json');
    const one = await start(file);
    await one.call('POST', '/sim/accounts', { token: 'p', bankCode: 'X', holderName: 'Y', maskedLabel: 'Z', balanceMinor: 5000 });
    await one.call('POST', '/v1/debit', { requestId: 'persist:1', accountToken: 'p', amountMinor: 1000 });
    await one.close();
    const two = await start(file);
    assert.equal((await two.call('GET', '/v1/accounts/p')).body.balanceMinor, 4000);
    assert.equal((await two.call('GET', '/v1/requests/persist:1')).body.status, 'APPROVED');
    await two.close();
  });
});
