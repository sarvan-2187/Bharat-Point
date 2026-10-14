/**
 * Mock bank entrypoint (DEMO ONLY). Reads the repo-root .env.
 *   MOCK_BANK_TOKEN      shared secret the BharatPoint backend sends (required)
 *   MOCK_BANK_PORT       default 4100
 *   MOCK_BANK_HOST       default 127.0.0.1 (the backend calls it locally; never expose it)
 *   MOCK_BANK_DATA_FILE  default services/mock-bank/data/mock-bank.json
 */
import path from 'node:path';
import { createMockBank } from './bank';

const token = process.env.MOCK_BANK_TOKEN;
if (!token || token.length < 16) {
  console.error('[mock-bank] MOCK_BANK_TOKEN (16+ characters) must be set in the repo-root .env');
  process.exit(1);
}

const port = Number(process.env.MOCK_BANK_PORT ?? 4100);
const host = process.env.MOCK_BANK_HOST ?? '127.0.0.1';
const dataFile = process.env.MOCK_BANK_DATA_FILE ?? path.join(__dirname, '..', 'data', 'mock-bank.json');

createMockBank({ token, dataFile }).listen(port, host, () => {
  console.log(`[mock-bank] DEMO bank listening on http://${host}:${port} (data: ${dataFile})`);
});
