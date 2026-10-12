// Expected failures shared by every layer (lib/core/result/result.dart).
// Services throw AppFailure; the HTTP layer maps the code to a status and a
// structured body. Messages are user-facing and never contain internals.

export const FAILURE_CODES = [
  'validation',
  'notFound',
  'conflict',
  'staleData',
  'insufficientFunds',
  'duplicate',
  'ambiguous',
  'confirmationRequired',
  'notPermitted',
  'unauthenticated',
  'unavailable',
  'storage',
  'unknown',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export class AppFailure extends Error {
  readonly code: FailureCode;
  readonly fieldErrors: Record<string, string>;
  readonly retryable: boolean;
  /** Extra machine-readable data (e.g. candidate ids for `ambiguous`). */
  readonly details?: Record<string, unknown>;

  constructor(
    code: FailureCode,
    message: string,
    opts: { fieldErrors?: Record<string, string>; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppFailure';
    this.code = code;
    this.fieldErrors = opts.fieldErrors ?? {};
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  static validation(message: string, fields: Record<string, string> = {}): AppFailure {
    return new AppFailure('validation', message, { fieldErrors: fields });
  }

  /** Validation failure built from field errors; message is the first error. */
  static fields(errors: Record<string, string>): AppFailure {
    const first = Object.values(errors)[0] ?? 'Please check the highlighted fields.';
    return new AppFailure('validation', first, { fieldErrors: errors });
  }

  static notFound(message: string): AppFailure {
    return new AppFailure('notFound', message);
  }

  static conflict(message: string): AppFailure {
    return new AppFailure('conflict', message);
  }

  static stale(message = 'This record changed since you last saw it. Review it and try again.'): AppFailure {
    return new AppFailure('staleData', message);
  }

  static notPermitted(message: string): AppFailure {
    return new AppFailure('notPermitted', message);
  }

  static unavailable(message = 'The service is temporarily unavailable. Nothing was changed.'): AppFailure {
    return new AppFailure('unavailable', message, { retryable: true });
  }

  toJSON(): FailureBody {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.fieldErrors).length > 0 ? { fieldErrors: this.fieldErrors } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export interface FailureBody {
  code: FailureCode;
  message: string;
  fieldErrors?: Record<string, string>;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** HTTP status per failure code (inverse of docs/BACKEND_INTEGRATION.md). */
export const FAILURE_STATUS: Record<FailureCode, number> = {
  validation: 422,
  notFound: 404,
  conflict: 409,
  staleData: 409,
  insufficientFunds: 422,
  duplicate: 409,
  ambiguous: 422,
  confirmationRequired: 428,
  notPermitted: 403,
  unauthenticated: 401,
  unavailable: 503,
  storage: 500,
  unknown: 500,
};

/** Ensures a field error map is non-empty before throwing. */
export function throwIfErrors(errors: Record<string, string>): void {
  if (Object.keys(errors).length > 0) throw AppFailure.fields(errors);
}
