/**
 * Guards the migration filenames. PRISM shipped two 002_ and two 003_ files
 * (audit F-18): the order still happened to be deterministic, but only by
 * accident of alphabetical sorting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('migrations are NNNN_snake_case.sql with unique numbers', () => {
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'no migrations found');

  for (const f of files) {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `bad migration filename: ${f}`);
  }
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `duplicate migration number in: ${files.join(', ')}`);
});
