import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOutcome, voiceLanguage } from './asterisk';

test('asterisk reply maps to a BharatPoint record', () => {
  const ok = (t: object) => (toOutcome('c', { status: 'COMPLETED', ...t }) as any).record;
  assert.equal(ok({ decision: 'ACCEPTED' }).decision, 'ACCEPTED');
  assert.equal(ok({ decision: 'TIMEOUT' }).decision, 'NONE');
  assert.equal((toOutcome('c', { status: 'TIMEOUT' }) as any).record.status, 'NO_ANSWER');
  assert.equal((toOutcome('c', { status: 'INITIATED', decision: 'ACCEPTED' }) as any).record.decision, 'NONE');
  assert.equal(ok({ decision: 'ACCEPTED', keyed_pin: '4821' }).keyedPin, '4821');
  assert.equal(ok({ decision: 'ACCEPTED' }).keyedPin, null);
  assert.equal(toOutcome('c', { status: 'WAT' }).kind, 'UNKNOWN');
  assert.equal(voiceLanguage('ml'), 'en');
  assert.equal(voiceLanguage('ta'), 'ta');
});
