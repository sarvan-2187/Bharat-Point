/**
 * Migration runner. Adapted from PRISM@680037b (backend/src/db/migrate.ts).
 * Usage: npm run db:migrate
 *
 * Applies every NNNN_name.sql in migrations/ in order, each inside its own
 * transaction, and records it in schema_migrations so re-running is safe.
 * Migrations are append-only: never edit one that has been applied.
 * migrations.test.ts enforces unique, zero-padded numbers (audit F-18).
 */
import fs from 'fs';
import path from 'path';
import pool, { query } from './pool';

const DIR = path.join(__dirname, 'migrations');

async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename
    )
  );

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[db] migrations complete (${ran} applied, ${files.length - ran} already applied)`);
  await pool.end();
}

migrate().catch((err) => {
  console.error('[db]', (err as Error).message);
  process.exit(1);
});
