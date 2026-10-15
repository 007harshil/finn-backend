import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pendingRoute from '@/app/api/v1/pending/route';
import * as pendingItemRoute from '@/app/api/v1/pending/[id]/route';
import * as resolveRoute from '@/app/api/v1/pending/resolve/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';
import { dispatch } from '@/server/actions/dispatcher';
import { AppFailure } from '@/server/core/failure';
import type { PendingPayment, PendingSettlement } from '@/server/finance/models';
import {
  collectSplits,
  computeSplit,
  formatSplitPercent,
  pendingTotals,
  pendingView,
  resolvePending,
  splitPartLabel,
  type PendingState,
} from '@/server/modules/pending/calculator';
import { loadPendingViews, type PendingViewDto } from '@/server/modules/pending/service';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});

afterAll(async () => t.close());

async function newUser(email: string): Promise<AuthUser> {
  const u = await t.createUser(email);
  await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
  return u;
}

const views = (u: AuthUser) => read(u, (s) => loadPendingViews(s));
const viewOf = async (u: AuthUser, id: string) => (await views(u)).find((v) => v.id === id);
const settleTxCount = (u: AuthUser) =>
  withUserTx(u, async (tx) =>
    Number(
      (
        await tx
          .selectFrom('transactions')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('origin', '=', 'pendingSettlement')
          .executeTakeFirstOrThrow()
      ).n,
    ),
  );

const item = (extra: Record<string, unknown> = {}) => ({
  counterparty: 'Rahul Verma',
  direction: 'owedToMe',
  kind: 'lent',
  amount: '6500',
  purpose: 'Goa trip hotel share',
  createdDate: '2026-10-01',
  ...extra,
});

// ---------------------------------------------------------------------------
// Calculator (pending_payment.dart, pending_split.dart)
// ---------------------------------------------------------------------------

const payment = (extra: Partial<PendingPayment> = {}): PendingPayment => ({
  id: 'p1',
  counterparty: 'Rahul',
  direction: 'owedToMe',
  kind: 'lent',
  originalPaise: 320000,
  purpose: 'Concert tickets',
  createdDate: '2026-09-16',
  notes: null,
  isCancelled: false,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  version: 1,
  link: null,
  split: null,
  ...extra,
});
const settlement = (amountPaise: number, date: string, pendingId = 'p1'): PendingSettlement => ({
  id: `s_${date}_${amountPaise}`,
  pendingId,
  amountPaise,
  date,
  accountId: null,
  channel: null,
  transactionId: null,
  note: null,
  createdAt: `${date}T00:00:00.000Z`,
});

describe('pending calculator', () => {
  it('outstanding = original − settled; partial never marks settled', () => {
    const v = pendingView(payment(), [settlement(120000, '2026-09-20'), settlement(5, '2026-09-21', 'other')], '2026-10-10');
    expect(v.settledPaise).toBe(120000);
    expect(v.outstandingPaise).toBe(200000);
    expect(v.status).toBe('partiallySettled');
    expect(v.daysOpen).toBe(24);
    expect(v.isLongPending).toBe(true);
    expect(v.settledBps).toBe(3750);
    expect(v.settledOn).toBeNull();

    const almost = pendingView(payment(), [settlement(319999, '2026-09-20')], '2026-10-10');
    expect(almost.status).toBe('partiallySettled');
    expect(almost.outstandingPaise).toBe(1);
  });

  it('settled, cancelled and open states; settlements newest first', () => {
    const s = [settlement(20000, '2026-09-20'), settlement(300000, '2026-10-02')];
    const done = pendingView(payment(), s, '2026-10-10');
    expect(done.status).toBe('settled');
    expect(done.outstandingPaise).toBe(0);
    expect(done.settlements.map((x) => x.date)).toEqual(['2026-10-02', '2026-09-20']);
    expect(done.settledOn).toBe('2026-10-02');
    expect(done.isLongPending).toBe(false);
    expect(done.daysSinceLastPayment).toBe(8);

    const off = pendingView(payment({ isCancelled: true }), [settlement(20000, '2026-09-20')], '2026-10-10');
    expect(off.status).toBe('cancelled');
    expect(off.outstandingPaise).toBe(0);

    const fresh = pendingView(payment({ createdDate: '2026-09-19' }), [], '2026-10-10');
    expect(fresh.status).toBe('open');
    expect(fresh.daysOpen).toBe(21);
    expect(fresh.isLongPending).toBe(false); // > 21 days only
  });

  it('totals count only active outstanding amounts', () => {
    const vs: PendingState[] = [
      pendingView(payment({ id: 'a', direction: 'iOwe', originalPaise: 1000 }), [], '2026-10-10'),
      pendingView(payment({ id: 'b', originalPaise: 5000, createdDate: '2026-10-05' }), [settlement(2000, '2026-10-06', 'b')], '2026-10-10'),
      pendingView(payment({ id: 'c', originalPaise: 7000, isCancelled: true }), [], '2026-10-10'),
    ];
    const tot = pendingTotals(vs);
    expect(tot).toMatchObject({ toPayPaise: 1000, toCollectPaise: 3000, payCount: 1, collectCount: 1, longCount: 1, longToPayPaise: 1000 });
    expect(tot.counts).toEqual({ active: 2, settled: 0, writtenOff: 1 });
  });

  it('equal split adds up exactly; the first person (me) absorbs the leftover paisa', () => {
    expect(computeSplit(10000, 'equally', [0, 0, 0]).shares).toEqual([3334, 3333, 3333]);
  });

  it('exact amounts must add up to the total', () => {
    expect(computeSplit(10000, 'exact', [6000, 4000]).valid).toBe(true);
    expect(computeSplit(10000, 'exact', [6000, 3000]).error).toContain('₹10 of the total is not given');
    expect(computeSplit(10000, 'exact', [6000, 5000]).error).toContain('₹10 more than the total');
  });

  it('percentages must add up to 100%', () => {
    expect(computeSplit(100000, 'percent', [5000, 3000, 2000]).shares).toEqual([50000, 30000, 20000]);
    expect(computeSplit(100000, 'percent', [5000, 3000]).error).toBe('Percentages add up to 80%, not 100%.');
  });

  it('shares divide by parts; adjustments add or take off an equal part', () => {
    expect(computeSplit(100000, 'shares', [2, 1, 1]).shares).toEqual([50000, 25000, 25000]);
    expect(computeSplit(100000, 'shares', [0, 0]).valid).toBe(false);
    expect(computeSplit(100000, 'adjustment', [0, 10000, 0]).shares).toEqual([30000, 40000, 30000]);
    expect(computeSplit(10000, 'adjustment', [-12000, 0]).valid).toBe(false);
  });

  it('every allocation sums exactly to the total', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let k = 0; k < 300; k++) {
      const total = 1 + rnd(10_000_000);
      const n = 2 + rnd(8);
      const weights: number[] = Array.from({ length: n }, () => rnd(7));
      if (!weights.some((w) => w !== 0)) weights[0] = 1;
      for (const [method, values] of [
        ['equally', weights],
        ['shares', weights],
      ] as const) {
        const out = computeSplit(total, method, values);
        expect(out.shares.reduce((a, b) => a + b, 0)).toBe(total);
        expect(out.shares.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
      }
    }
  });

  it('part labels describe each method', () => {
    expect(splitPartLabel({ method: 'percent', part: 3333 })).toBe('33.33%');
    expect(splitPartLabel({ method: 'percent', part: 4000 })).toBe('40%');
    expect(formatSplitPercent(3350)).toBe('33.5%');
    expect(splitPartLabel({ method: 'shares', part: 2 })).toBe('2 shares');
    expect(splitPartLabel({ method: 'adjustment', part: -500 })).toBe('−₹5 adjusted');
  });

  it('resolver refuses to guess', () => {
    const vs = [
      pendingView(payment({ id: 'r1', counterparty: 'Rahul Verma', originalPaise: 50000, purpose: 'Lunch' }), [], '2026-10-10'),
      pendingView(payment({ id: 'r2', counterparty: 'Rahul Verma', originalPaise: 200000, purpose: 'Tickets' }), [], '2026-10-10'),
      pendingView(payment({ id: 'r3', counterparty: 'Priya', direction: 'iOwe', originalPaise: 9900 }), [], '2026-10-10'),
    ];
    let failure: AppFailure | undefined;
    try {
      resolvePending(vs, 'rahul');
    } catch (e) {
      failure = e as AppFailure;
    }
    expect(failure?.code).toBe('ambiguous');
    expect(failure?.message).toBe('2 open items match "rahul": Lunch (₹500), Tickets (₹2,000). Please choose one.');
    expect(failure?.details).toEqual({ candidates: ['r1', 'r2'] });
    expect(resolvePending(vs, 'Rahul', { amountPaise: 50000 }).payment.id).toBe('r1');
    expect(resolvePending(vs, 'priya').payment.id).toBe('r3');
    expect(() => resolvePending(vs, 'priya', { direction: 'owedToMe' })).toThrow('No open item found for "priya".');
  });

  it('split view: total = my share + items; methodLabel Custom after an edit', () => {
    const split = { id: 'spl', method: 'equally' as const, includesMe: true, mySharePaise: 1000, part: null };
    const vs = [
      pendingView(payment({ id: 'x1', originalPaise: 1000, split, createdAt: '2026-10-01T00:00:00.001Z' }), [], '2026-10-10'),
      pendingView(payment({ id: 'x2', originalPaise: 1500, split: { ...split, method: 'exact', part: 1500 } }), [], '2026-10-10'),
    ];
    const s = collectSplits(vs).get('spl')!;
    expect(s.totalPaise).toBe(3500);
    expect(s.people).toBe(3);
    expect(s.methodLabel).toBe('Custom');
    expect(s.members.map((m) => m.payment.id)).toEqual(['x2', 'x1']);
  });
});

// ---------------------------------------------------------------------------
// Actions (one user)
// ---------------------------------------------------------------------------

describe('pending actions', () => {
  let me: AuthUser;
  beforeAll(async () => {
    me = await newUser('priya@example.com');
  });

  it('creates an item without touching cash, with Dart preview text', async () => {
    const before = await read(me, (s) => s.balance());
    const outcome = await dispatch(me, 'pending.create', item(), { idempotencyKey: newKey() });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.preview.title).toBe('Rahul Verma owes you');
    expect(outcome.preview.summary).toBe('Collect ₹6,500 · Goa trip hotel share');
    const p = outcome.result as PendingPayment;
    expect(p).toMatchObject({ originalPaise: 650000, direction: 'owedToMe', link: null, version: 1 });
    expect((await read(me, (s) => s.balance())).cashPaise).toBe(before.cashPaise);
  });

  it('validates input with Dart messages', async () => {
    await expect(act(me, 'pending.create', item({ amount: '0' }))).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { amount: 'Enter an amount greater than zero.' },
    });
    await expect(act(me, 'pending.create', item({ createdDate: '2026-10-11' }))).rejects.toMatchObject({
      fieldErrors: { createdDate: 'The date cannot be in the future.' },
    });
    await expect(act(me, 'pending.create', item({ linkedUserId: me.userId }))).rejects.toMatchObject({
      fieldErrors: { linkedUserId: 'You cannot share an item with yourself.' },
    });
    for (const bad of ['not-a-user', '00000000-0000-4000-8000-000000000000']) {
      await expect(act(me, 'pending.create', item({ linkedUserId: bad }))).rejects.toMatchObject({
        fieldErrors: { linkedUserId: 'That FiNN user could not be found. Search again.' },
      });
    }
  });

  it('a partial settlement keeps the item partially settled and records cash once', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item());
    const balance0 = await read(me, (s) => s.balance());
    const s = await act<PendingSettlement>(me, 'pending.settle', { pendingId: p.id, amount: '2500', date: '2026-10-10', method: 'upi' });
    const v = (await viewOf(me, p.id))!;
    expect(v.status).toBe('partiallySettled');
    expect(v.outstandingPaise).toBe(400000);
    const linked = await read(me, (snap) => snap.linkedTransactions(p.id));
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ type: 'income', origin: 'pendingSettlement', categoryId: 'cat_sys_settle_in', amountPaise: 250000 });
    expect(linked[0]!.note).toBe('Settlement · Goa trip hotel share');
    expect(s.transactionId).toBe(linked[0]!.id);
    expect((await read(me, (snap) => snap.balance())).cashPaise - balance0.cashPaise).toBe(250000);
  });

  it('settling more than the outstanding amount is rejected and records nothing', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '3200', purpose: 'Concert tickets', direction: 'iOwe' }));
    await act(me, 'pending.settle', { pendingId: p.id, amount: '1200', date: '2026-10-05' });
    const txBefore = await settleTxCount(me);
    await expect(act(me, 'pending.settle', { pendingId: p.id, amount: '2500', date: '2026-10-10' })).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { amount: 'Only ₹2,000 is outstanding.' },
    });
    expect(await settleTxCount(me)).toBe(txBefore);
    expect((await viewOf(me, p.id))!.outstandingPaise).toBe(200000);
    await expect(act(me, 'pending.settle', { pendingId: p.id, amount: '10', date: '2026-09-30' })).rejects.toMatchObject({
      fieldErrors: { date: 'The date is before this item was created.' },
    });
  });

  it('settle preview: expense line with minus sign, basis changes with state', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ direction: 'iOwe', amount: '900', purpose: 'Cab' }));
    const input = { pendingId: p.id, amount: '400', date: '2026-10-10' };
    const first = await dispatch(me, 'pending.settle', input, { idempotencyKey: newKey() });
    expect(first.status).toBe('needsConfirmation');
    expect(first.preview.title).toBe('Record partial settlement');
    expect(first.preview.summary).toBe('Pay Rahul Verma ₹400');
    expect(first.preview.lines.find((l) => l.label === 'Cash balance')?.value).toBe('−₹400');
    await act(me, 'pending.settle', { ...input, amount: '100' });
    // The old approval no longer matches the item.
    const stale = await dispatch(me, 'pending.settle', input, {
      idempotencyKey: newKey(),
      confirmation: { fingerprint: first.preview.fingerprint },
    });
    expect(stale.status).toBe('needsConfirmation');
  });

  it('recordCashMovement false settles without a transaction', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '300', purpose: 'Office lunch' }));
    const txBefore = await settleTxCount(me);
    const s = await act<PendingSettlement>(me, 'pending.settle', { pendingId: p.id, amount: '300', date: '2026-10-10', recordCashMovement: false });
    expect(s.transactionId).toBeNull();
    expect(await settleTxCount(me)).toBe(txBefore);
    expect((await viewOf(me, p.id))!.status).toBe('settled');
    await expect(act(me, 'pending.settle', { pendingId: p.id, amount: '1', date: '2026-10-10' })).rejects.toMatchObject({
      message: 'This item is already settled.',
    });
  });

  it('a replayed settle does not double-record', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '1000', purpose: 'Replay' }));
    const key = newKey();
    const a = await act<PendingSettlement>(me, 'pending.settle', { pendingId: p.id, amount: '500', date: '2026-10-10' }, { key });
    const b = await act<PendingSettlement>(me, 'pending.settle', { pendingId: p.id, amount: '500', date: '2026-10-10' }, { key });
    expect(b.id).toBe(a.id);
    const v = (await viewOf(me, p.id))!;
    expect(v.settlements).toHaveLength(1);
    expect(v.outstandingPaise).toBe(50000);
    expect(await read(me, (s) => s.linkedTransactions(p.id))).toHaveLength(1);
  });

  it('write-off keeps settlements, zeroes outstanding, and cannot repeat', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '800', purpose: 'Write off' }));
    await act(me, 'pending.settle', { pendingId: p.id, amount: '300', date: '2026-10-10' });
    const off = await act<PendingPayment>(me, 'pending.cancel', { id: p.id });
    expect(off).toMatchObject({ isCancelled: true, version: 2 });
    const v = (await viewOf(me, p.id))!;
    expect(v).toMatchObject({ status: 'cancelled', outstandingPaise: 0, settledPaise: 30000 });
    await expect(act(me, 'pending.cancel', { id: p.id })).rejects.toMatchObject({ message: 'This item is already closed.' });
  });

  it('delete: refused with settlements, otherwise removes the item', async () => {
    const withSettlement = await act<PendingPayment>(me, 'pending.create', item({ amount: '50', purpose: 'Has settlement' }));
    await act(me, 'pending.settle', { pendingId: withSettlement.id, amount: '10', date: '2026-10-10' });
    await expect(act(me, 'pending.delete', { id: withSettlement.id })).rejects.toMatchObject({
      code: 'notPermitted',
      message: 'This item has settlements recorded. Write it off instead so your history stays accurate.',
    });
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '50', purpose: 'Mistake' }));
    await act(me, 'pending.delete', { id: p.id });
    expect(await viewOf(me, p.id)).toBeUndefined();
  });

  it('update: version check, amount not below settled', async () => {
    const p = await act<PendingPayment>(me, 'pending.create', item({ amount: '1000', purpose: 'Edit me' }));
    await act(me, 'pending.settle', { pendingId: p.id, amount: '400', date: '2026-10-10' });
    await expect(act(me, 'pending.update', { id: p.id, expectedVersion: 1, ...item({ amount: '300', purpose: 'Edit me' }) })).rejects.toMatchObject({
      fieldErrors: { amount: '₹400 has already been settled, so the amount cannot be lower.' },
    });
    const u = await act<PendingPayment>(me, 'pending.update', { id: p.id, expectedVersion: 1, ...item({ amount: '1200', purpose: 'Edited' }) });
    expect(u).toMatchObject({ version: 2, originalPaise: 120000, purpose: 'Edited' });
    await expect(act(me, 'pending.update', { id: p.id, expectedVersion: 1, ...item() })).rejects.toMatchObject({ code: 'staleData' });
  });

  it('split: one item per person, all tied to the same bill', async () => {
    const items = await act<PendingPayment[]>(me, 'pending.split', {
      direction: 'owedToMe',
      total: '3000',
      purpose: 'Weekend cabin',
      createdDate: '2026-10-10',
      method: 'equally',
      includeMe: true,
      people: [{ counterparty: 'Asha' }, { counterparty: 'Bina' }],
    });
    expect(items.map((p) => [p.counterparty, p.originalPaise])).toEqual([
      ['Asha', 100000],
      ['Bina', 100000],
    ]);
    expect(new Set(items.map((p) => p.split!.id)).size).toBe(1);
    expect(items[0]!.split).toMatchObject({ mySharePaise: 100000, includesMe: true, method: 'equally' });

    // Editing one person changes the bill total and marks their part exact.
    await act(me, 'pending.update', {
      id: items[0]!.id,
      expectedVersion: 1,
      counterparty: 'Asha',
      direction: 'owedToMe',
      kind: 'sharedExpense',
      amount: '1500',
      purpose: 'Weekend cabin',
      createdDate: '2026-10-10',
    });
    const states = await read(me, async (s) => {
      const { loadPendingStates } = await import('@/server/modules/pending/service');
      return loadPendingStates(s);
    });
    const split = collectSplits(states).get(items[0]!.split!.id)!;
    expect(split.totalPaise).toBe(350000);
    expect(splitPartLabel(split.members[0]!.payment.split!)).toBe('Exact amount');
    expect(split.methodLabel).toBe('Custom');
  });

  it('split decodes human units (percent strings) and rejects invalid splits', async () => {
    const items = await act<PendingPayment[]>(me, 'pending.split', {
      direction: 'owedToMe',
      total: '1000',
      purpose: 'Lunch',
      createdDate: '2026-10-10',
      method: 'percent',
      includeMe: true,
      myValue: 50,
      people: [
        { counterparty: 'Asha', value: '30%' },
        { counterparty: 'Bina', value: 20 },
      ],
    });
    expect(items.map((p) => p.originalPaise)).toEqual([30000, 20000]);
    expect(items[0]!.split).toMatchObject({ part: 3000, mySharePaise: 50000 });

    const base = { direction: 'owedToMe', total: '3000', purpose: 'Cabin', createdDate: '2026-10-10', method: 'equally', includeMe: true };
    const errors = async (extra: Record<string, unknown>) => {
      try {
        await act(me, 'pending.split', { ...base, people: [{ counterparty: 'Asha' }, { counterparty: 'Bina' }], ...extra });
      } catch (e) {
        return Object.keys((e as AppFailure).fieldErrors);
      }
      return [];
    };
    expect(await errors({ people: [{ counterparty: 'Asha' }] })).toContain('people');
    expect(await errors({ people: [{ counterparty: 'Asha' }, { counterparty: 'asha' }] })).toContain('people.1.counterparty');
    expect(await errors({ direction: 'iOwe' })).toContain('includeMe');
    expect(await errors({ method: 'percent', myValue: 50 })).toContain('split');
    expect(await errors({ method: 'shares', people: [{ counterparty: 'Asha', value: 'two' }, { counterparty: 'Bina', value: 1 }] })).toContain(
      'value',
    );
  });
});

// ---------------------------------------------------------------------------
// Shared items between two FiNN users
// ---------------------------------------------------------------------------

describe('shared pending items', () => {
  let alice: AuthUser;
  let bob: AuthUser;
  let carol: AuthUser;
  let shared: PendingPayment;
  let mirId: string;

  beforeAll(async () => {
    alice = await newUser('alice@example.com');
    bob = await newUser('bob@example.com');
    carol = await newUser('carol@example.com');
    shared = await act<PendingPayment>(alice, 'pending.create', {
      counterparty: 'x',
      direction: 'iOwe',
      kind: 'borrowed',
      amount: '1000',
      purpose: 'Dinner',
      createdDate: '2026-10-01',
      linkedUserId: bob.userId,
    });
    mirId = `mir_${shared.link!.sharedId}`;
  });

  it('is stored once under the creator; the other person sees the mirrored view', async () => {
    expect(shared).toMatchObject({ counterparty: 'Bob', direction: 'iOwe', kind: 'borrowed' });
    expect(shared.link).toMatchObject({ userId: bob.userId, handle: '@bob', createdByMe: true });
    const bv = (await views(bob)).find((v) => v.id === mirId)!;
    expect(bv).toMatchObject({ direction: 'owedToMe', kind: 'lent', counterparty: 'Alice', originalPaise: 100000, outstandingPaise: 100000 });
    expect(bv.link).toMatchObject({ userId: alice.userId, createdByMe: false, sharedId: shared.link!.sharedId });
    const rows = await withUserTx(bob, (tx) => tx.selectFrom('pending_payments').selectAll().execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(alice.userId);
  });

  it('Bob records ₹400 received: only Bob gets a transaction; Alice sees ₹600 outstanding', async () => {
    const aliceTx0 = await settleTxCount(alice);
    const s = await act<PendingSettlement>(bob, 'pending.settle', { pendingId: mirId, amount: '400', date: '2026-10-10', method: 'upi' });
    expect(s.pendingId).toBe(mirId);
    expect(s.transactionId).not.toBeNull();
    const bobTx = await read(bob, (snap) => snap.transaction(s.transactionId!));
    expect(bobTx).toMatchObject({ type: 'income', amountPaise: 40000, categoryId: 'cat_sys_settle_in', counterparty: 'Alice', originRefId: mirId });
    expect(await settleTxCount(bob)).toBe(1);

    const av = (await viewOf(alice, shared.id))!;
    expect(av).toMatchObject({ outstandingPaise: 60000, status: 'partiallySettled', version: 2 });
    expect(av.settlements).toEqual([expect.objectContaining({ id: `mir_${s.id}`, pendingId: shared.id, transactionId: null, amountPaise: 40000 })]);
    expect(await settleTxCount(alice)).toBe(aliceTx0);
    // Alice cannot read Bob's transaction, even with raw SQL (RLS).
    const peek = await withUserTx(alice, (tx) => tx.selectFrom('transactions').select('id').where('id', '=', s.transactionId!).execute());
    expect(peek).toHaveLength(0);
    expect((await viewOf(bob, mirId))!.outstandingPaise).toBe(60000);
  });

  it('a third user sees nothing', async () => {
    expect(await views(carol)).toHaveLength(0);
    const counts = await withUserTx(carol, async (tx) => ({
      pending: (await tx.selectFrom('pending_payments').select('id').execute()).length,
      settlements: (await tx.selectFrom('pending_settlements').select('id').execute()).length,
    }));
    expect(counts).toEqual({ pending: 0, settlements: 0 });
    const res = await call(pendingItemRoute.GET, 'GET', `/api/v1/pending/${mirId}`, { user: carol, params: { id: mirId } });
    expect(res.status).toBe(404);
    await expect(act(carol, 'pending.settle', { pendingId: mirId, amount: '1', date: '2026-10-10' })).rejects.toMatchObject({ code: 'notFound' });
    await expect(act(carol, 'pending.settle', { pendingId: shared.id, amount: '1', date: '2026-10-10' })).rejects.toMatchObject({ code: 'notFound' });
  });

  it('enforces who may edit, write off and delete', async () => {
    await expect(
      act(bob, 'pending.update', {
        id: mirId,
        expectedVersion: 2,
        counterparty: 'Alice',
        direction: 'owedToMe',
        amount: '2000',
        purpose: 'Dinner',
        createdDate: '2026-10-01',
      }),
    ).rejects.toMatchObject({
      code: 'notPermitted',
      message: 'Only Alice can change the details of this shared item. You can still record a settlement.',
    });
    await expect(
      act(alice, 'pending.update', { id: shared.id, expectedVersion: 2, counterparty: 'Bob', direction: 'iOwe', amount: '1000', purpose: 'Dinner', createdDate: '2026-10-01', linkedUserId: carol.userId }),
    ).rejects.toMatchObject({ code: 'notPermitted', message: 'The person on a shared item cannot change.' });
    // Alice owes the money: only Bob may write it off.
    await expect(act(alice, 'pending.cancel', { id: shared.id })).rejects.toMatchObject({
      code: 'notPermitted',
      message: 'This is shared with Bob, who is owed the money. Only they can write it off.',
    });
    await expect(act(bob, 'pending.delete', { id: mirId })).rejects.toMatchObject({ code: 'notPermitted' });
    // Bob recorded a settlement with a transaction: Alice's delete would orphan it.
    await expect(act(alice, 'pending.delete', { id: shared.id })).rejects.toMatchObject({ code: 'notPermitted' });
    // A stale version (Bob's settlement bumped it) is refused.
    await expect(
      act(alice, 'pending.update', { id: shared.id, expectedVersion: 1, counterparty: 'Bob', direction: 'iOwe', amount: '1000', purpose: 'Dinner 2', createdDate: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'staleData' });
    const edited = await act<PendingPayment>(alice, 'pending.update', {
      id: shared.id,
      expectedVersion: 2,
      counterparty: 'ignored',
      direction: 'iOwe',
      amount: '1000',
      purpose: 'Dinner at Toit',
      createdDate: '2026-10-01',
    });
    expect(edited).toMatchObject({ counterparty: 'Bob', purpose: 'Dinner at Toit', version: 3 });
    expect((await viewOf(bob, mirId))!.purpose).toBe('Dinner at Toit');
  });

  it('Alice pays the rest: her own expense; settled for both; Bob can no longer settle', async () => {
    const s = await act<PendingSettlement>(alice, 'pending.settle', { pendingId: shared.id, amount: '600', date: '2026-10-10' });
    const t1 = await read(alice, (snap) => snap.transaction(s.transactionId!));
    expect(t1).toMatchObject({ type: 'expense', categoryId: 'cat_sys_settle_out', amountPaise: 60000, counterparty: 'Bob' });
    expect((await viewOf(alice, shared.id))!.status).toBe('settled');
    const bv = (await viewOf(bob, mirId))!;
    expect(bv.status).toBe('settled');
    // Bob sees his own settlement (with his transaction) and Alice's (mir_, no transaction).
    const byAmount = Object.fromEntries(bv.settlements.map((x) => [x.amountPaise, x]));
    expect(byAmount[60000]).toMatchObject({ id: `mir_${s.id}`, transactionId: null });
    expect(byAmount[40000]!.transactionId).not.toBeNull();
    await expect(act(bob, 'pending.settle', { pendingId: mirId, amount: '1', date: '2026-10-10' })).rejects.toMatchObject({
      message: 'This item is already settled.',
    });
    expect(await settleTxCount(bob)).toBe(1);
  });

  it('the owed person may write off; the creator may delete an unsettled shared item (tombstone for both)', async () => {
    const a = await act<PendingPayment>(alice, 'pending.create', {
      counterparty: 'Bob',
      direction: 'iOwe',
      amount: '250',
      purpose: 'Coffee',
      createdDate: '2026-10-10',
      linkedUserId: bob.userId,
    });
    const aMir = `mir_${a.link!.sharedId}`;
    const off = await act<PendingPayment>(bob, 'pending.cancel', { id: aMir });
    expect(off).toMatchObject({ id: aMir, isCancelled: true, direction: 'owedToMe', counterparty: 'Alice' });
    expect((await viewOf(alice, a.id))!.status).toBe('cancelled');

    const b = await act<PendingPayment>(alice, 'pending.create', {
      counterparty: 'Bob',
      direction: 'owedToMe',
      amount: '99',
      purpose: 'Mistake',
      createdDate: '2026-10-10',
      linkedUserId: bob.userId,
    });
    const sync0 = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: bob });
    await act(alice, 'pending.delete', { id: b.id });
    const sync1 = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: bob, query: { since: sync0.body.data.cursor } });
    expect(sync1.body.data.collections.pending.deleted).toContain(`mir_${b.link!.sharedId}`);
  });

  it('routes: list with totals, detail by mir_ id, resolver', async () => {
    const list = await call(pendingRoute.GET, 'GET', '/api/v1/pending', { user: bob });
    expect(list.status).toBe(200);
    const ids = list.body.data.items.map((x: PendingViewDto) => x.id);
    expect(ids).toContain(mirId);
    expect(list.body.data.totals).toMatchObject({ toPayPaise: 0, toCollectPaise: 0 });

    const detail = await call(pendingItemRoute.GET, 'GET', `/api/v1/pending/${mirId}`, { user: bob, params: { id: mirId } });
    expect(detail.status).toBe(200);
    expect(detail.body.data.item).toMatchObject({ id: mirId, status: 'settled', ageDays: 9 });
    expect(detail.body.data.item.settlements).toHaveLength(2);

    // Two open items with Rahul → ambiguous; the amount narrows it down.
    const dave = await newUser('dave@example.com');
    await act(dave, 'pending.create', item({ amount: '500', purpose: 'Lunch', createdDate: '2026-09-01' }));
    await act(dave, 'pending.create', item({ amount: '2000', purpose: 'Tickets' }));
    await act(dave, 'pending.create', item({ counterparty: 'Priya', direction: 'iOwe', amount: '120' }));
    const amb = await call(resolveRoute.GET, 'GET', '/api/v1/pending/resolve', { user: dave, query: { name: 'rahul' } });
    expect(amb.body.data.status).toBe('ambiguous');
    expect(amb.body.data.candidates).toHaveLength(2);
    const one = await call(resolveRoute.GET, 'GET', '/api/v1/pending/resolve', { user: dave, query: { name: 'Rahul Verma', amount: '500' } });
    expect(one.body.data).toMatchObject({ status: 'found', item: { purpose: 'Lunch', outstandingPaise: 50000 } });
    const none = await call(resolveRoute.GET, 'GET', '/api/v1/pending/resolve', { user: dave, query: { name: 'Priya', direction: 'owedToMe' } });
    expect(none.body.data).toMatchObject({ status: 'none', message: 'No open item found for "Priya".' });

    const dl = await call(pendingRoute.GET, 'GET', '/api/v1/pending', { user: dave });
    expect(dl.body.data.totals).toMatchObject({ toPayPaise: 12000, toCollectPaise: 250000, longCount: 1, people: 2 });
    expect(dl.body.data.longPending).toHaveLength(1);
    expect(dl.body.data.people.find((g: { name: string }) => g.name === 'Rahul Verma').itemIds).toHaveLength(2);
  });
});
