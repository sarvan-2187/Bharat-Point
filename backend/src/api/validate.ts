/**
 * Input checks at the API boundary. Bad input is a 400 with the field name,
 * never a 500 from Postgres. Deliberately tiny: add a check here when a route
 * needs one, not before.
 */
import { fail } from './errors';

type Body = Record<string, unknown> | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(body: Body, field: string, opts: { max?: number; pattern?: RegExp } = {}): string {
  const raw = body?.[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > (opts.max ?? 200) || (opts.pattern && !opts.pattern.test(value))) {
    fail('VALIDATION_FAILED', { field });
  }
  return value;
}

export function optionalStr(body: Body, field: string, opts: { max?: number; pattern?: RegExp } = {}): string | null {
  return body?.[field] === undefined || body?.[field] === null || body?.[field] === '' ? null : str(body, field, opts);
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('VALIDATION_FAILED', { field });
  return value;
}
