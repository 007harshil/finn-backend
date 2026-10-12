import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as assetsRoute from '@/app/api/v1/assets/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import { dispatch, previewAction } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';
import { computeNetWorth } from '@/server/modules/assets/net-worth';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  bob = await t.createUser('bob@example.com');
  for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
});

afterAll(async () => t.close());

const gold = (rupees: number | string, extra: Record<string, unknown> = {}) => ({
  name: 'Gold coins',
  type: 'gold',
  value: rupees,
  valuedOn: '2026-10-01',
  ...extra,
});

describe('assets actions', () => {
  it('creates without touching cash; blank note dropped', async () => {
    const before = await read(alice, (s) => s.balance());
    const a = await act(alice, 'assets.create', gold(80000, { note: '  ' }));
    expect(a.valuePaise).toBe(8_000_000);
    expect(a.note).toBeNull();
    expect(a.version).toBe(1);
    expect(a.valuedOn).toBe('2026-10-01');
    expect(a.id).toMatch(/^asset_/);
    expect((await read(alice, (s) => s.balance())).cashPaise).toBe(before.cashPaise);
  });

  it('allows zero; duplicate name only warns', async () => {
    await act(alice, 'assets.create', gold(0, { name: 'Zero asset' }));
    const p = await previewAction(alice, 'assets.create', gold(1000, { name: 'gold COINS' }));
    expect(p.warnings).toEqual(['You already have an asset called "gold COINS".']);
    expect(p.summary).toBe('Added gold COINS at ₹1,000');
  });

  it('validates fields', async () => {
    const fields = async (input: Record<string, unknown>) => {
      try {
        await dispatch(alice, 'assets.create', input, { idempotencyKey: newKey() });
        return [];
      } catch (e: any) {
        return Object.keys(e.fieldErrors ?? {});
      }
    };
    expect(await fields(gold(1, { name: 'G' }))).toEqual(['name']);
    expect(await fields(gold(1, { name: 'x'.repeat(41) }))).toEqual(['name']);
    expect(await fields(gold(-1))).toEqual(['value']);
    expect(await fields(gold('10000000001'))).toEqual(['value']);
    expect(await fields(gold(1, { valuedOn: '2026-10-11' }))).toEqual(['valuedOn']);
    expect(await fields(gold(1, { note: 'n'.repeat(501) }))).toEqual(['note']);
  });

  it('revalues with net-worth effect, bumps version, rejects stale/missing', async () => {
    const a = await act(alice, 'assets.create', gold(80000, { name: 'Update me' }));
    const p = await previewAction(alice, 'assets.update', { id: a.id, expectedVersion: 1, ...gold(95000, { name: 'Update me' }) });
    expect(p.lines.at(-1)).toEqual({ label: 'Net worth effect', value: '+₹15,000' });
    const u = await act(alice, 'assets.update', { id: a.id, expectedVersion: 1, ...gold(95000, { name: 'Update me' }) });
    expect(u.version).toBe(2);
    expect(u.valuePaise).toBe(9_500_000);
    await expect(act(alice, 'assets.update', { id: a.id, expectedVersion: 1, ...gold(1) })).rejects.toMatchObject({ code: 'staleData' });
    await expect(act(alice, 'assets.update', { id: 'nope', expectedVersion: 1, ...gold(1) })).rejects.toMatchObject({ code: 'notFound' });
  });

  it('delete needs review and only lowers net worth', async () => {
    const a = await act(alice, 'assets.create', gold(500, { name: 'Delete me' }));
    const key = newKey();
    const asked = await dispatch(alice, 'assets.delete', { id: a.id }, { idempotencyKey: key });
    expect(asked.status).toBe('needsConfirmation');
    await act(alice, 'assets.delete', { id: a.id });
    expect((await read(alice, (s) => s.assets())).find((x) => x.id === a.id)).toBeUndefined();
  });

  it('replays an idempotent create once', async () => {
    const key = newKey();
    const input = gold(10, { name: 'Replay asset' });
    await dispatch(alice, 'assets.create', input, { idempotencyKey: key });
    await dispatch(alice, 'assets.create', input, { idempotencyKey: key });
    const n = (await read(alice, (s) => s.assets())).filter((x) => x.name === 'Replay asset').length;
    expect(n).toBe(1);
  });

  it('isolates users', async () => {
    const a = await act(alice, 'assets.create', gold(100, { name: 'Alice only' }));
    expect((await read(bob, (s) => s.assets())).length).toBe(0);
    await expect(act(bob, 'assets.delete', { id: a.id })).rejects.toMatchObject({ code: 'notFound' });
    const res = await call(assetsRoute.GET, 'GET', '/api/v1/assets', { user: bob });
    expect(res.body.data).toEqual({ assets: [], totalPaise: 0 });
  });

  it('GET /assets lists assets with a total', async () => {
    const res = await call(assetsRoute.GET, 'GET', '/api/v1/assets', { user: alice });
    expect(res.status).toBe(200);
    expect(res.body.data.assets.length).toBeGreaterThan(3);
    expect(res.body.data.totalPaise).toBe(res.body.data.assets.reduce((s: number, a: any) => s + a.valuePaise, 0));
  });
});

describe('net worth calculator', () => {
  const rs = (n: number) => n * 100;
  const base = { cashPaise: rs(200000), earmarkedPaise: 0, assets: [], loans: [], pending: [] };

  it('counts cash once: earmarked savings are a split, not added', () => {
    const plain = computeNetWorth(base);
    const earmarked = computeNetWorth({ ...base, earmarkedPaise: rs(80000) });
    expect(plain.netWorthPaise).toBe(rs(200000));
    expect(earmarked.netWorthPaise).toBe(rs(200000));
    expect(earmarked.lines[0]!.detail).toBe('Includes earmarked savings');
    expect(plain.lines[0]!.detail).toBeNull();
  });

  it('assets add; borrowed loans are liabilities; lent loans receivables', () => {
    const nw = computeNetWorth({
      ...base,
      assets: [
        { id: 'a1', name: 'Mutual funds', type: 'investment', valuePaise: rs(150000) },
        { id: 'a2', name: 'Gold', type: 'gold', valuePaise: rs(50000) },
      ],
      loans: [
        { id: 'b', name: 'Car loan', counterparty: 'HDFC Bank', direction: 'borrowed', outstandingPaise: rs(300000) },
        { id: 'l', name: 'Friend', direction: 'lent', outstandingPaise: rs(40000) },
      ],
      pending: [],
    });
    expect(nw.assetsPaise).toBe(rs(200000));
    expect(nw.liabilitiesPaise).toBe(rs(300000));
    expect(nw.receivablesPaise).toBe(rs(40000));
    expect(nw.totalAssetsPaise).toBe(rs(440000));
    expect(nw.netWorthPaise).toBe(rs(140000));
    const liability = nw.lines.find((l) => l.group === 'liabilities')!;
    expect(liability.recordId).toBe('b');
    expect(liability.label).toBe('Car loan · HDFC Bank');
    expect(nw.lines.find((l) => l.recordId === 'a2')!.detail).toBe('Gold & jewellery');
  });

  it('omits loans with nothing outstanding', () => {
    const nw = computeNetWorth({
      ...base,
      cashPaise: 0,
      loans: [
        { id: 'p', name: 'Partly', direction: 'borrowed', outstandingPaise: rs(75000) },
        { id: 'r', name: 'Repaid', direction: 'borrowed', outstandingPaise: 0 },
      ],
    });
    expect(nw.liabilitiesPaise).toBe(rs(75000));
    expect(nw.lines.some((l) => l.recordId === 'r')).toBe(false);
  });

  it('summarises pending per direction; no lines when nothing is outstanding', () => {
    const nw = computeNetWorth({
      ...base,
      cashPaise: rs(10000),
      pending: [
        { id: 'o', direction: 'iOwe', outstandingPaise: rs(5000) },
        { id: 'op', direction: 'iOwe', outstandingPaise: rs(2000) },
        { id: 'c', direction: 'owedToMe', outstandingPaise: rs(8000) },
      ],
    });
    expect(nw.liabilitiesPaise).toBe(rs(7000));
    expect(nw.receivablesPaise).toBe(rs(8000));
    expect(nw.lines.find((l) => l.label === 'Pending to pay')!.amountPaise).toBe(rs(7000));
    expect(nw.lines.find((l) => l.label === 'Pending to collect')!.amountPaise).toBe(rs(8000));
    expect(nw.netWorthPaise).toBe(rs(11000));
    const none = computeNetWorth({ ...base, pending: [{ id: 's', direction: 'iOwe', outstandingPaise: 0 }] });
    expect(none.lines).toHaveLength(1);
  });

  it('goes negative when debt exceeds everything else', () => {
    const nw = computeNetWorth({
      ...base,
      cashPaise: rs(10000),
      loans: [{ id: 'b', name: 'Loan', direction: 'borrowed', outstandingPaise: rs(600000) }],
    });
    expect(nw.netWorthPaise).toBe(-rs(590000));
  });
});
