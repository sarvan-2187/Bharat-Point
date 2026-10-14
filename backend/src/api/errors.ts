/**
 * Failure catalogue + global error handler. Adapted from PRISM@680037b
 * (backend/src/api/errors.ts, middleware/errorHandler.ts).
 *
 * Every refusal has a code. The web app switches on these, the security test
 * harness asserts on them, and the audit log records them. Add codes here as
 * the routes that raise them are built.
 */
import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly failureCode: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const FAILURES = {
  VALIDATION_FAILED: [400, 'The request is missing or has an invalid field.'],
  AUTH_FAILED: [401, 'Authentication failed.'],
  FORBIDDEN: [403, 'You do not have access to this.'],
  NOT_FOUND: [404, 'Not found.'],
  ALREADY_EXISTS: [409, 'That already exists.'],
  INTERNAL_ERROR: [500, 'Internal server error.'],
} as const;

/** Postgres unique_violation, for turning a duplicate into a 409 instead of a 500. */
export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

export type FailureCode = keyof typeof FAILURES;

export function fail(code: FailureCode, details?: Record<string, unknown>): never {
  const [status, message] = FAILURES[code];
  throw new AppError(status, code, message, details);
}

/** One response shape, { failureCode, message, details? }, for every error. */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      failureCode: err.failureCode,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  // Unexpected: log in full, tell the caller nothing useful to an attacker.
  console.error('[api]', err.stack ?? err.message);
  res.status(500).json({ failureCode: 'INTERNAL_ERROR', message: FAILURES.INTERNAL_ERROR[1] });
}
