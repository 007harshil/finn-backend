// Calls Next.js route handlers in-process with a real Request, exactly as the
// framework would, and decodes the JSON envelope.

import type { AuthUser } from '@/server/auth/verify';
import type { TestDb } from './db';

type RouteHandler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

export interface CallOptions {
  user?: AuthUser | null;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

export interface CallResult<T = any> {
  status: number;
  body: { data?: T; error?: { code: string; message: string; fieldErrors?: Record<string, string>; retryable: boolean; details?: unknown } };
  headers: Headers;
}

export function makeClient(t: TestDb) {
  return async function call<T = any>(handler: RouteHandler, method: string, path: string, opts: CallOptions = {}): Promise<CallResult<T>> {
    const url = new URL(`http://localhost${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.user) headers.authorization = `Bearer ${t.tokenFor(opts.user)}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
  };
}

let keySeq = 0;
/** A fresh idempotency key. */
export const newKey = () => `test-key-${Date.now()}-${++keySeq}`;
