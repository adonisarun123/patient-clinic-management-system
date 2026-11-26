// API-006: stable machine codes, safe messages, HTTP status and retry guidance.
export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
  | 'VERSION_CONFLICT' | 'SLOT_TAKEN' | 'HOLD_EXPIRED' | 'IDEMPOTENCY_MISMATCH'
  | 'RULE_VIOLATION' | 'RATE_LIMITED' | 'TENANT_SUSPENDED' | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 422, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  VERSION_CONFLICT: 412, SLOT_TAKEN: 409, HOLD_EXPIRED: 409, IDEMPOTENCY_MISMATCH: 409,
  RULE_VIOLATION: 422, RATE_LIMITED: 429, TENANT_SUSPENDED: 403, INTERNAL: 500,
};

const RETRY: Partial<Record<ErrorCode, string>> = {
  SLOT_TAKEN: 'Refresh availability and choose another time.',
  HOLD_EXPIRED: 'The reservation expired. Choose a time again.',
  VERSION_CONFLICT: 'This record changed. Reload it before saving again.',
  RATE_LIMITED: 'Wait a moment and try again.',
  INTERNAL: 'Retry with the same request key; the original outcome will be returned if it was saved.',
};

export class AppError extends Error {
  readonly status: number;
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.status = STATUS[code];
  }
  toJSON(correlationId?: string) {
    return {
      error: { code: this.code, message: this.message, retry: RETRY[this.code], details: this.details, correlationId },
    };
  }
}

export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have permission for this action') => new AppError('FORBIDDEN', msg);
export const invalid = (msg: string, details?: unknown) => new AppError('VALIDATION', msg, details);
export const rule = (msg: string, details?: unknown) => new AppError('RULE_VIOLATION', msg, details);

/** Translate PostgreSQL errors raised by constraints into safe application errors. */
export function fromPg(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (!e || typeof e !== 'object' || !e.code) return err;
  switch (e.code) {
    case '23P01': return new AppError('SLOT_TAKEN', 'That time was just taken by another booking.');
    case '23505': return new AppError('CONFLICT', 'A record with the same unique value already exists.', { constraint: e.constraint });
    case '23514': return new AppError('VALIDATION', 'A value is outside the permitted range.', { constraint: e.constraint });
    case '23503': return new AppError('VALIDATION', 'A referenced record does not exist.', { constraint: e.constraint });
    case 'P0001': return new AppError('RULE_VIOLATION', e.message ?? 'Business rule violated');
    case '22P02': return new AppError('VALIDATION', 'Malformed identifier or value.');
    default: return err;
  }
}
