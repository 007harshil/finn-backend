import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as efRoute from '@/app/api/v1/emergency-fund/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';
import { emergencyStatus, suggestionFromTotal } from '@/server/modules/emergency-fund/calculator';
import { loadEmergencyStatus } from '@/server/modules/emergency-fund/service';
import { insertTransaction } from '@/server/modules/transactions/repo';
import type { EmergencyPlan, SavingsMovement } from '@/server/finance/models';

const TODAY = '2026-10-10';
const rs = (v: number) => v * 100;

let n = 0;
function efMv(rupees: number, date: string, withdraw = false, type: 'goal' | 'emergencyFund' = 'emergencyFund'): SavingsMovement {
  return {
    id: `sv_${n++}`,
    bucketType: type,
    bucketId: type === 'goal' ? 'g1' : 'emergency_fund',
    kind: withdraw ? 'withdrawal' : 'contribution',
    amountPaise: rs(rupees),
    date,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const plan: EmergencyPlan = { essentialMonthlyPaise: rs(40000), targetMonths: 6, targetOverridePaise: null, updatedAt: '2026-01-01T00:00:00.000Z' };
const status = (movements: SavingsMovement[], p: EmergencyPlan | null = plan) => emergencyStatus({ plan: p, movements, suggestion: null, today: TODAY });

describe('EmergencyFundCalculator', () => {
  it('coverage in tenths of a month, truncated', () => {
    const s = status([efMv(100000, '2026-07-01')]);
    expect(s.target).toBe(rs(240000));
    expect(s.saved).toBe(rs(100000));
    expect(s.coverageTenths).toBe(25);
    expect(s.progressBps).toBe(4167);
    expect(s.remaining).toBe(rs(140000));
    expect(status([efMv(39999, '2026-07-01')]).coverageTenths).toBe(9);
  });

  it('levels', () => {
    expect(status([efMv(79999, '2026-07-01')]).level).toBe('critical');
    expect(status([efMv(80000, '2026-07-01')]).level).toBe('building');
    expect(status([efMv(239999, '2026-07-01')]).level).toBe('building');
    expect(status([efMv(240000, '2026-07-01')]).level).toBe('funded');
    expect(status([efMv(300000, '2026-07-01')]).level).toBe('funded');
    expect(status([]).level).toBe('critical');
    const none = status([efMv(1000, '2026-07-01')], null);
    expect(none.level).toBe('notConfigured');
    expect(none.coverageTenths).toBeNull();
    expect(none.target).toBe(0);
    expect(status([], { ...plan, essentialMonthlyPaise: 0 }).level).toBe('notConfigured');
  });

  it('a target override replaces the computed target', () => {
    const p = { ...plan, targetOverridePaise: rs(100000) };
    expect(status([efMv(100000, '2026-07-01')], p).level).toBe('funded');
    const unknown = { ...plan, essentialMonthlyPaise: 0, targetOverridePaise: rs(50000) };
    const s = status([efMv(10000, '2026-07-01')], unknown);
    expect(s.coverageTenths).toBeNull();
    expect(s.level).toBe('building');
  });

  it('counts only emergency-fund movements up to today; withdrawals subtract', () => {
    const s = status([
      efMv(100000, '2026-07-01'),
      efMv(20000, '2026-09-01', true),
      efMv(50000, '2026-10-11'),
      efMv(70000, '2026-08-01', false, 'goal'),
    ]);
    expect(s.saved).toBe(rs(80000));
    expect(s.movements).toHaveLength(2);
  });

  it('suggestion rounds half-up to the paisa then to the rupee', () => {
    // (84,000 + 6,000 + 12,602) / 3 = 34,200.67 -> 34,201
    expect(suggestionFromTotal(rs(102602))).toBe(rs(34201));
    expect(suggestionFromTotal(null)).toBeNull();
  });
});

describe('emergency fund actions', () => {
  let t: TestDb;
  let call: ReturnType<typeof makeClient>;
  let alice: AuthUser;
  let bob: AuthUser;
  const bal = () => read(alice, (s) => s.balance());
  const move = (amount: number | string, over: Record<string, unknown> = {}) => ({ amount, date: TODAY, ...over });

  beforeAll(async () => {
    t = await createTestDb();
    call = makeClient(t);
    fixClock();
    alice = await t.createUser('alice@example.com');
    bob = await t.createUser('bob@example.com');
    for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
    await act(alice, 'transactions.create', { type: 'income', amount: '100000', categoryId: 'cat_salary', date: '2026-10-01' });
  });
  afterAll(async () => t.close());

  it('configures (upsert) without moving money; low risk needs no review', async () => {
    const before = await bal();
    const p = await act(alice, 'emergencyFund.configure', { essentialMonthlyExpenses: '40000', targetMonths: 6 }, { confirm: false });
    expect(p).toMatchObject({ configured: true, essentialMonthlyPaise: rs(40000), targetMonths: 6, targetOverridePaise: null });
    const again = await act(alice, 'emergencyFund.configure', { essentialMonthlyExpenses: '10000', targetMonths: 6, targetOverride: '100000' });
    expect(again).toMatchObject({ essentialMonthlyPaise: rs(10000), targetOverridePaise: rs(100000) });
    const rows = await withUserTx(alice, (tx) => tx.selectFrom('emergency_plans').selectAll().execute());
    expect(rows).toHaveLength(1);
    expect((await bal()).availablePaise).toBe(before.availablePaise);
  });

  it('validates the plan', async () => {
    const fields = (input: Record<string, unknown>) =>
      act(alice, 'emergencyFund.configure', input).then(
        () => [],
        (e) => Object.keys(e.fieldErrors ?? {}),
      );
    expect(await fields({ essentialMonthlyExpenses: 0, targetMonths: 6 })).toEqual(['essentialMonthlyExpenses']);
    expect(await fields({ essentialMonthlyExpenses: '1000000001', targetMonths: 6 })).toEqual(['essentialMonthlyExpenses']);
    expect(await fields({ essentialMonthlyExpenses: 40000, targetMonths: 0 })).toEqual(['targetMonths']);
    expect(await fields({ essentialMonthlyExpenses: 40000, targetMonths: 25 })).toEqual(['targetMonths']);
    expect(await fields({ essentialMonthlyExpenses: 40000, targetMonths: 6, targetOverride: 0 })).toEqual(['targetOverride']);
    await act(alice, 'emergencyFund.configure', { essentialMonthlyExpenses: 40000, targetMonths: 24 });
    await act(alice, 'emergencyFund.configure', { essentialMonthlyExpenses: 10000, targetMonths: 6 });
  });

  it('contribute / withdraw earmark and release cash, exactly one movement each, no transactions', async () => {
    const before = await bal();
    await expect(act(alice, 'emergencyFund.contribute', move(30000), { confirm: false })).rejects.toThrow(/Set aside ₹30,000 for emergencies/);
    const m = await act(alice, 'emergencyFund.contribute', move(30000));
    expect(m).toMatchObject({ bucketType: 'emergencyFund', bucketId: 'emergency_fund', kind: 'contribution', amountPaise: rs(30000) });
    await act(alice, 'emergencyFund.withdraw', move(10000));
    const after = await bal();
    expect(after.cashPaise).toBe(before.cashPaise);
    expect(after.earmarkedEmergencyPaise).toBe(rs(20000));
    expect(after.availablePaise).toBe(before.availablePaise - rs(20000));
    const s = await read(alice, (sn) => loadEmergencyStatus(sn));
    expect(s.saved).toBe(rs(20000));
    expect(s.coverageTenths).toBe(20);
    expect(s.level).toBe('building');
    const count = await withUserTx(alice, async (tx) =>
      Number((await tx.selectFrom('transactions').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    );
    expect(count).toBe(1); // just the salary
  });

  it('limits: available cash, saved amount, dates, note length', async () => {
    const b = await bal();
    const tooMuch = await act(alice, 'emergencyFund.contribute', move((b.availablePaise + 100) / 100)).catch((e) => e);
    expect(tooMuch.fieldErrors.amount).toMatch(/^Only ₹.* is available to set aside\.$/);
    const over = await act(alice, 'emergencyFund.withdraw', move(20001)).catch((e) => e);
    expect(over.fieldErrors.amount).toBe('Only ₹20,000 is in your emergency fund.');
    expect((await act(alice, 'emergencyFund.contribute', move(1, { date: '2026-10-11' })).catch((e) => e)).fieldErrors.date).toBeDefined();
    expect((await act(alice, 'emergencyFund.contribute', move(0)).catch((e) => e)).fieldErrors.amount).toBeDefined();
    expect((await act(alice, 'emergencyFund.contribute', move(1, { note: 'n'.repeat(201) })).catch((e) => e)).fieldErrors.note).toBeDefined();
  });

  it('reaching the target warns; withdrawals are reassured', async () => {
    const { dispatch } = await import('@/server/actions/dispatcher');
    // target override is 0 here (10000 x 6 = 60000); saved 20000, so 40000 more funds it.
    const full = await dispatch(alice, 'emergencyFund.contribute', move(40000), { idempotencyKey: 'ef-fund-key-001' });
    expect(full.status === 'needsConfirmation' && full.preview.warnings).toEqual(['This fully funds your emergency target!']);
    const out = await dispatch(alice, 'emergencyFund.withdraw', move(1000), { idempotencyKey: 'ef-wd-key-0001' });
    expect(out.status === 'needsConfirmation' && out.preview.warnings[0]).toMatch(/^Using your safety net is okay/);
  });

  it('suggestion averages essential categories plus EMIs over the last 3 full months (SQL)', async () => {
    const stamp = '2026-01-01T00:00:00.000Z';
    let i = 0;
    const tx = (categoryId: string, rupees: number, date: string, type: 'income' | 'expense' = 'expense') => ({
      id: `tx_ef_${i++}`,
      type,
      amountPaise: rs(rupees),
      categoryId,
      date,
      paymentMethod: null,
      counterparty: null,
      note: null,
      origin: 'manual' as const,
      originRefId: null,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    });
    const rows = [
      tx('cat_rent', 28000, '2026-07-03'),
      tx('cat_rent', 28000, '2026-08-03'),
      tx('cat_rent', 28000, '2026-09-03'),
      tx('cat_groceries', 6000, '2026-08-20'),
      tx('cat_sys_emi', 12602, '2026-09-05'),
      tx('cat_food', 5000, '2026-08-01'), // not essential
      tx('cat_salary', 125000, '2026-08-01', 'income'),
      tx('cat_rent', 28000, '2026-10-03'), // current month
      tx('cat_rent', 28000, '2026-06-30'), // before the window
    ];
    await withUserTx(bob, async (db) => {
      for (const r of rows) await insertTransaction(db, bob.userId, r as never);
    }, { write: true });
    const s = await read(bob, (sn) => loadEmergencyStatus(sn));
    expect(s.suggestedEssentialMonthly).toBe(rs(34201));
    expect(s.plan).toBeNull();
    // Alice's transactions do not leak into Bob's suggestion and vice versa.
    const a = await read(alice, (sn) => loadEmergencyStatus(sn));
    expect(a.suggestedEssentialMonthly).toBeNull();
  });

  it('GET /emergency-fund returns plan, status and movements; requires auth; isolates users', async () => {
    const res = await call(efRoute.GET, 'GET', '/api/v1/emergency-fund', { user: alice });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: { configured: true, essentialMonthlyPaise: rs(10000), targetMonths: 6 },
      saved: rs(20000),
      target: rs(60000),
      coverageTenths: 20,
      level: 'building',
      suggestedEssentialMonthly: null,
    });
    expect(res.body.data.movements).toHaveLength(2);
    const other = await call(efRoute.GET, 'GET', '/api/v1/emergency-fund', { user: bob });
    expect(other.body.data).toMatchObject({ plan: { configured: false }, saved: 0, level: 'notConfigured', suggestedEssentialMonthly: rs(34201) });
    expect((await call(efRoute.GET, 'GET', '/api/v1/emergency-fund', {})).status).toBe(401);
  });

  it('replays a duplicate contribution instead of recording twice', async () => {
    const key = 'ef-replay-key-01';
    const before = (await read(alice, (s) => s.movements())).length;
    await act(alice, 'emergencyFund.contribute', move(100), { key });
    await act(alice, 'emergencyFund.contribute', move(100), { key });
    expect((await read(alice, (s) => s.movements())).length).toBe(before + 1);
  });
});
