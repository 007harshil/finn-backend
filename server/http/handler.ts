// Thin route-handler wrapper: authentication, account bootstrap, error
// mapping, CORS and request ids. Business logic lives in services; handlers
// only parse input and shape output.
//
// Response envelope: `{ "data": ... }` on success, `{ "error": FailureBody }`
// on failure. Internal details (SQL, stack traces) never reach the client.

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { authenticate, type AuthUser } from '../auth/verify';
import { AppFailure, FAILURE_STATUS } from '../core/failure';
import { fromZod, toFailure } from '../core/errors';

export { fromZod, toFailure };
import { ensureAccount } from '../modules/account/bootstrap';
import { withUserTx } from '../db/tx';
import { logger } from './logger';

export interface RequestContext {
  request: Request;
  user: AuthUser;
  requestId: string;
  params: Record<string, string | string[]>;
  url: URL;
}

type Handler = (ctx: RequestContext) => Promise<Response | unknown>;

type RouteParams = { params: Promise<Record<string, string | string[]>> };

const bootstrapped = new Set<string>();

function corsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin');
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-confirmation-fingerprint, x-channel',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function failureResponse(failure: AppFailure, headers: Record<string, string> = {}): Response {
  return json({ error: failure.toJSON() }, FAILURE_STATUS[failure.code], headers);
}

async function run(request: Request, routeCtx: RouteParams | undefined, handler: Handler, authRequired: boolean): Promise<Response> {
  const requestId = request.headers.get('x-request-id')?.slice(0, 64) || randomUUID();
  const cors = corsHeaders(request);
  const started = Date.now();
  const url = new URL(request.url);
  try {
    const params = routeCtx ? await routeCtx.params : {};
    let user: AuthUser = { userId: '', email: null, claims: { sub: '', role: 'authenticated' } };
    if (authRequired) {
      user = await authenticate(request);
      if (!bootstrapped.has(user.userId)) {
        await withUserTx(user, (tx) => ensureAccount(tx, user), { write: true });
        bootstrapped.add(user.userId);
        if (bootstrapped.size > 50_000) bootstrapped.clear();
      }
    }
    const result = await handler({ request, user, requestId, params, url });
    const response = result instanceof Response ? result : json({ data: result });
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    response.headers.set('x-request-id', requestId);
    logger.info('http', { requestId, method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started });
    return response;
  } catch (err) {
    const failure = toFailure(err);
    if (failure.code === 'unknown' || failure.code === 'storage') {
      logger.error('http.unhandled', {
        requestId,
        path: url.pathname,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        pgCode: (err as { code?: string })?.code,
      });
    }
    logger.info('http', { requestId, method: request.method, path: url.pathname, status: FAILURE_STATUS[failure.code], code: failure.code, ms: Date.now() - started });
    return failureResponse(failure, { ...cors, 'x-request-id': requestId });
  }
}

/** Authenticated route handler. */
export function route(handler: Handler) {
  return (request: Request, ctx?: RouteParams) => run(request, ctx, handler, true);
}

/** Unauthenticated route handler (health checks). */
export function publicRoute(handler: Handler) {
  return (request: Request, ctx?: RouteParams) => run(request, ctx, handler, false);
}

/** CORS preflight. */
export function preflight() {
  return (request: Request) => new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function readJson(request: Request, maxBytes = 1_000_000): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw AppFailure.validation('The request is too large.');
  // Count bytes while streaming: a missing or false content-length must not
  // let an oversized body be buffered.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw AppFailure.validation('The request is too large.');
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw AppFailure.validation('The request body is not valid JSON.');
  }
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw fromZod(parsed.error);
  return parsed.data;
}

export function query(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

export function param(ctx: RequestContext, name: string): string {
  const v = ctx.params[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) throw AppFailure.notFound('Not found.');
  return v;
}

export function resetBootstrapCache(): void {
  bootstrapped.clear();
}
