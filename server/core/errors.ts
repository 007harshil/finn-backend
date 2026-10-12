// Maps thrown values to safe AppFailures (no SQL or stack details leak).

import { ZodError } from 'zod';
import { AppFailure } from './failure';

export function fromZod(err: ZodError): AppFailure {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : 'request';
    fields[key] ??= issue.message;
  }
  return AppFailure.fields(fields);
}

export function toFailure(err: unknown): AppFailure {
  if (err instanceof AppFailure) return err;
  if (err instanceof ZodError) return fromZod(err);
  const pg = err as { code?: string } | null;
  switch (pg?.code) {
    case '23505':
      return AppFailure.conflict('A record with these details already exists.');
    case '23503':
      return AppFailure.conflict('This refers to a record that does not exist or is still in use.');
    case '23514':
    case '22P02':
    case '22003':
    case '23502':
      return AppFailure.validation('Some values are not allowed. Please check and try again.');
    case '40P01':
    case '40001':
    case '55P03':
      return new AppFailure('unavailable', 'Another change was in progress. Please try again.', { retryable: true });
    case '42501':
      return AppFailure.notPermitted('You do not have access to this record.');
    case '57014':
      return AppFailure.unavailable('The request took too long. Nothing was changed.');
  }
  return new AppFailure('unknown', 'Something went wrong. Nothing was changed.', { retryable: true });
}
