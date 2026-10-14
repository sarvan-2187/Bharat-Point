/**
 * PostgreSQL connection pool. Adapted from PRISM@680037b (backend/src/db/pool.ts).
 *
 * One shared pool for the whole backend; never create another Pool.
 * Use getClient() for any multi-statement transaction, and always release it.
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

// An idle-client error is usually transient; log it rather than crash.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> => pool.query<T>(text, params);

export const getClient = (): Promise<PoolClient> => pool.connect();

/** Run fn inside BEGIN/COMMIT on one client; ROLLBACK and rethrow on any error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
