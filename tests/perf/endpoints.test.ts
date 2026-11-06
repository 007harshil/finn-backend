// Local endpoint baseline: per-request database query count and in-process
// latency for the endpoints the mobile app calls most, against a realistic
// user (one year of history). Runs only with FINN_PERF=1 and writes
// docs/perf/<FINN_PERF_LABEL>.json so before/after runs can be compared.
//
// PGlite runs in-process, so absolute times exclude network round trips.
// In production every query also costs one round trip between the function
// (Vercel sin1) and the database (Supabase ap-southeast-1), so the query
// count is the number to watch.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import * as analyticsRoute from '@/app/api/v1/analytics/route';
import * as budgetsRoute from '@/app/api/v1/budgets/route';
import * as dashboardRoute from '@/app/api/v1/dashboard/route';
import * as meRoute from '@/app/api/v1/me/route';
import * as netWorthRoute from '@/app/api/v1/net-worth/route';
import * as previewRoute from '@/app/api/v1/plans/preview/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import * as timelineRoute from '@/app/api/v1/timeline/route';
import * as transactionsRoute from '@/app/api/v1/transactions/route';
import * as upcomingRoute from '@/app/api/v1/upcoming/route';
import type { KyselyPlugin } from 'kysely';
import type { AuthUser } from '@/server/auth/verify';
import { setDb } from '@/server/db/client';
import { act, fixClock } from '../support/actions';
import { createTestDb, type TestDb } from '../support/db';
import { makeClient, newKey } from '../support/http';

const enabled = process.env.FINN_PERF === '1';
const ITERATIONS = Number(process.env.FINN_PERF_ITERATIONS ?? 30);
const TRANSACTIONS = Number(process.env.FINN_PERF_TRANSACTIONS ?? 3000);

interface Sample {
  ms: number;
  queries: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

describe.skipIf(!enabled)('endpoint baseline (FINN_PERF=1)', () => {
  let t: TestDb;
  let call: ReturnType<typeof makeClient>;
  let user: AuthUser;
  let queryCount = 0;
  let tracing = false;
  const traced: string[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    call = makeClient(t);
    fixClock();
    user = await t.createUser('perf@example.com');
    await t.fund(user, 1_000_000);

    await act(user, 'budgets.create', { categoryId: 'cat_food', limit: '12000' });
    await act(user, 'budgets.create', { categoryId: 'cat_transport', limit: '4000' });
    await act(user, 'budgets.create', { categoryId: 'cat_shopping', limit: '8000' });

    // One year of history, written directly (bypassing the API) for speed.
    await t.pglite.query(
      `insert into public.transactions (user_id, id, type, amount_paise, category_id, date, account_id, note, created_at, updated_at)
       select $1, 'tx_perf_' || g, case when g % 25 = 0 then 'income' else 'expense' end,
              case when g % 25 = 0 then 5000000 else 5000 + (g * 7919) % 250000 end,
              case when g % 25 = 0 then 'cat_salary'
                   else (array['cat_food','cat_transport','cat_shopping','cat_groceries','cat_utilities','cat_entertainment'])[1 + g % 6] end,
              (date '2026-10-10' - (g % 365))::date, 'acc_cash', null, now(), now()
       from generate_series(1, $2::int) g`,
      [user.userId, TRANSACTIONS],
    );

    // Count every statement the API sends (each one is a round trip in production).
    const counter: KyselyPlugin = {
      transformQuery(args) {
        queryCount++;
        if (tracing) traced.push(args.node.kind === 'RawNode' ? args.node.sqlFragments.join('?').replace(/\s+/g, ' ').trim().slice(0, 100) : `${args.node.kind} ${[...JSON.stringify(args.node).matchAll(/"TableNode","table":\{[^}]*?"identifier":\{"kind":"IdentifierNode","name":"(\w+)"/g)].map((m) => m[1]).join(',')}`);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    };
    setDb(t.db.withPlugin(counter));
  }, 300_000);

  afterAll(async () => t?.close());

  it('measures the main endpoints', async () => {
    const endpoints: Record<string, () => Promise<{ status: number }>> = {
      'GET /dashboard': () => call(dashboardRoute.GET, 'GET', '/api/v1/dashboard', { user }),
      'GET /transactions': () => call(transactionsRoute.GET, 'GET', '/api/v1/transactions', { user }),
      'GET /timeline': () => call(timelineRoute.GET, 'GET', '/api/v1/timeline', { user }),
      'GET /budgets': () => call(budgetsRoute.GET, 'GET', '/api/v1/budgets', { user }),
      'GET /analytics?period=month': () => call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user, query: { period: 'month' } }),
      'GET /net-worth': () => call(netWorthRoute.GET, 'GET', '/api/v1/net-worth', { user }),
      'GET /upcoming': () => call(upcomingRoute.GET, 'GET', '/api/v1/upcoming', { user }),
      'GET /me': () => call(meRoute.GET, 'GET', '/api/v1/me', { user }),
      'GET /sync (first page)': () => call(syncRoute.GET, 'GET', '/api/v1/sync', { user }),
      'POST /actions/transactions.create': () =>
        call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
          user,
          params: { actionId: 'transactions.create' },
          headers: { 'idempotency-key': newKey() },
          body: { input: { type: 'expense', amount: '120', categoryId: 'cat_food', date: '2026-10-09' } },
        }),
      'POST /plans/preview (1 step)': () =>
        call(previewRoute.POST, 'POST', '/api/v1/plans/preview', {
          user,
          body: {
            planId: `perf-plan-${newKey()}`.slice(0, 60),
            steps: [{ stepId: 's1', actionId: 'transactions.create', input: { type: 'expense', amount: '250', categoryId: 'cat_food', date: '2026-10-09' } }],
          },
        }),
    };

    const report: Record<string, { status: number; queries: number; p50Ms: number; p95Ms: number; maxMs: number }> = {};
    for (const [name, run] of Object.entries(endpoints)) {
      await run(); // warm-up (module init, first plan)
      const samples: Sample[] = [];
      let status = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        queryCount = 0;
        const started = performance.now();
        const res = await run();
        samples.push({ ms: performance.now() - started, queries: queryCount });
        status = res.status;
      }
      expect(status, name).toBe(200);
      if (process.env.FINN_PERF_TRACE && name.includes(process.env.FINN_PERF_TRACE)) {
        traced.length = 0;
        tracing = true;
        await run();
        tracing = false;
        writeFileSync(join(process.env.FINN_PERF_TRACE_DIR ?? '.', 'perf-trace.txt'), `--- ${name}\n${traced.join('\n')}\n`);
      }
      const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
      const queries = samples.map((s) => s.queries).sort((a, b) => a - b);
      report[name] = {
        status,
        queries: percentile(queries, 50),
        p50Ms: Number(percentile(ms, 50).toFixed(2)),
        p95Ms: Number(percentile(ms, 95).toFixed(2)),
        maxMs: Number(ms[ms.length - 1].toFixed(2)),
      };
    }

    const label = process.env.FINN_PERF_LABEL ?? 'latest';
    const dir = join(__dirname, '..', '..', 'docs', 'perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${label}.json`),
      JSON.stringify({ label, transactions: TRANSACTIONS, iterations: ITERATIONS, note: 'PGlite in-process; excludes network RTT', endpoints: report }, null, 2) + '\n',
    );
    console.table(report);
  }, 600_000);
});
