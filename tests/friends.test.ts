import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as friendsRoute from '@/app/api/v1/friends/route';
import * as friendRoute from '@/app/api/v1/friends/[userId]/route';
import * as requestsRoute from '@/app/api/v1/friends/requests/route';
import * as requestRoute from '@/app/api/v1/friends/requests/[id]/route';
import * as acceptRoute from '@/app/api/v1/friends/requests/[id]/accept/route';
import * as rejectRoute from '@/app/api/v1/friends/requests/[id]/reject/route';
import * as lookupRoute from '@/app/api/v1/users/lookup/route';
import * as searchRoute from '@/app/api/v1/users/search/route';
import * as meRoute from '@/app/api/v1/me/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { directoryEntries } from '@/server/finance/snapshot';
import { normalizeFinnId } from '@/server/modules/friends/service';
import { sql } from 'kysely';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});

afterAll(async () => t.close());

const finnIdOf = async (u: AuthUser): Promise<string> => (await call(meRoute.GET, 'GET', '/api/v1/me', { user: u })).body.data.user.finnId;
const friendsOf = async (u: AuthUser) => (await call(friendsRoute.GET, 'GET', '/api/v1/friends', { user: u })).body.data;
const send = (u: AuthUser, finnId: string) => call(requestsRoute.POST, 'POST', '/api/v1/friends/requests', { user: u, body: { finnId } });
const lookup = (u: AuthUser, finnId: string) => call(lookupRoute.GET, 'GET', '/api/v1/users/lookup', { user: u, query: { finnId } });
const accept = (u: AuthUser, id: string) => call(acceptRoute.POST, 'POST', `/api/v1/friends/requests/${id}/accept`, { user: u, params: { id } });
const reject = (u: AuthUser, id: string) => call(rejectRoute.POST, 'POST', `/api/v1/friends/requests/${id}/reject`, { user: u, params: { id } });
const cancel = (u: AuthUser, id: string) => call(requestRoute.DELETE, 'DELETE', `/api/v1/friends/requests/${id}`, { user: u, params: { id } });
const unfriend = (u: AuthUser, userId: string) => call(friendRoute.DELETE, 'DELETE', `/api/v1/friends/${userId}`, { user: u, params: { userId } });
const search = (u: AuthUser, q: string) => call(searchRoute.GET, 'GET', '/api/v1/users/search', { user: u, query: { q } });

const pendingItem = (linkedUserId: string) => ({
  counterparty: 'x',
  direction: 'owedToMe',
  kind: 'lent',
  amount: '40000',
  purpose: 'Loan',
  createdDate: '2026-10-01',
  linkedUserId,
});

describe('FiNN IDs', () => {
  it('every user gets a unique 8-character FiNN ID', async () => {
    const a = await t.createUser('id-a@example.com');
    const b = await t.createUser('id-b@example.com');
    const [ia, ib] = [await finnIdOf(a), await finnIdOf(b)];
    expect(ia).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(ib).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    expect(ia).not.toBe(ib);
  });

  it('normalises dashes, spaces and case', () => {
    expect(normalizeFinnId('k7q2-m9xd')).toBe('K7Q2M9XD');
    expect(normalizeFinnId(' K7Q2 M9XD ')).toBe('K7Q2M9XD');
    expect(normalizeFinnId('K7Q2M9X0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeFinnId('K7Q2M9X')).toBeNull();
    expect(normalizeFinnId('ramesh')).toBeNull();
  });

  it('the API role cannot change a FiNN ID', async () => {
    const u = await t.createUser('id-fixed@example.com');
    await expect(
      withUserTx(u, (tx) => sql`update public.profiles set finn_id = 'ABCDEFGH' where user_id = ${u.userId}`.execute(tx)),
    ).rejects.toThrow(/finn_id cannot change/);
  });
});

describe('lookup', () => {
  let me: AuthUser;
  let ramesh: AuthUser;

  beforeAll(async () => {
    me = await t.createUser('look-me@example.com');
    ramesh = await t.createUser('look-ramesh@example.com');
  });

  it('finds a user only by exact FiNN ID and shows only name and ID', async () => {
    const id = await finnIdOf(ramesh);
    const res = await lookup(me, `${id.slice(0, 4).toLowerCase()}-${id.slice(4)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual({ id: ramesh.userId, name: expect.any(String), finnId: id, relation: 'none' });
  });

  it('returns null for an unknown ID and 422 for a malformed one', async () => {
    expect((await lookup(me, '22222222')).body.data).toEqual({ user: null });
    const bad = await lookup(me, 'look-ramesh');
    expect(bad.status).toBe(422);
    expect(bad.body.error!.fieldErrors!.finnId).toBe('Enter a valid FiNN ID, like K7Q2-M9XD.');
  });

  it('reports self', async () => {
    expect((await lookup(me, await finnIdOf(me))).body.data.user.relation).toBe('self');
  });

  it('search never reaches strangers, by name, handle or partial ID', async () => {
    const id = await finnIdOf(ramesh);
    for (const q of ['look', 'look-ramesh', '@look', id.slice(0, 4), id]) {
      expect((await search(me, q)).body.data.items).toEqual([]);
    }
  });

  it('stranger profiles are not readable through the directory', async () => {
    const entries = await withUserTx(me, (tx) => directoryEntries(tx, [ramesh.userId]));
    expect(entries.size).toBe(0);
  });
});

describe('friend requests', () => {
  let me: AuthUser;
  let ramesh: AuthUser;
  let rameshId: string;
  let myId: string;

  beforeAll(async () => {
    me = await t.createUser('fr-me@example.com');
    ramesh = await t.createUser('fr-ramesh@example.com');
    [myId, rameshId] = [await finnIdOf(me), await finnIdOf(ramesh)];
  });

  it('send → shows as outgoing for me and incoming for them', async () => {
    const res = await send(me, rameshId);
    expect(res.status).toBe(200);
    expect(res.body.data.request).toMatchObject({ user: { id: ramesh.userId, finnId: rameshId } });
    expect((await friendsOf(me)).outgoing).toHaveLength(1);
    const theirs = await friendsOf(ramesh);
    expect(theirs.incoming).toEqual([{ id: res.body.data.request.id, user: { id: me.userId, name: expect.any(String), finnId: myId }, createdAt: expect.any(String) }]);
    expect((await lookup(me, rameshId)).body.data.user).toMatchObject({ relation: 'outgoing', requestId: res.body.data.request.id });
    expect((await lookup(ramesh, myId)).body.data.user).toMatchObject({ relation: 'incoming', requestId: res.body.data.request.id });
    // Request parties can see each other's name.
    expect((await withUserTx(ramesh, (tx) => directoryEntries(tx, [me.userId]))).size).toBe(1);
  });

  it('refuses duplicates, own ID and unknown IDs', async () => {
    expect((await send(me, rameshId)).status).toBe(409);
    const own = await send(me, myId);
    expect(own.status).toBe(422);
    expect(own.body.error!.fieldErrors!.finnId).toBe('That is your own FiNN ID.');
    expect((await send(me, '22222222')).status).toBe(404);
  });

  it('only the addressee can accept or reject; only the requester can cancel', async () => {
    const id = (await friendsOf(me)).outgoing[0].id;
    expect((await accept(me, id)).status).toBe(404);
    expect((await reject(me, id)).status).toBe(404);
    expect((await cancel(ramesh, id)).status).toBe(404);
    const stranger = await t.createUser('fr-stranger@example.com');
    expect((await accept(stranger, id)).status).toBe(404);
  });

  it('reject deletes the request; a new one can be sent', async () => {
    const id = (await friendsOf(ramesh)).incoming[0].id;
    expect((await reject(ramesh, id)).body.data).toEqual({ ok: true });
    expect((await friendsOf(me)).outgoing).toEqual([]);
    expect((await lookup(me, rameshId)).body.data.user.relation).toBe('none');
    expect((await send(me, rameshId)).status).toBe(200);
  });

  it('accept makes both friends', async () => {
    const id = (await friendsOf(ramesh)).incoming[0].id;
    const res = await accept(ramesh, id);
    expect(res.body.data.friend).toMatchObject({ user: { id: me.userId, finnId: myId }, since: expect.any(String) });
    expect((await friendsOf(me)).friends.map((f: { user: { id: string } }) => f.user.id)).toEqual([ramesh.userId]);
    expect((await friendsOf(ramesh)).friends.map((f: { user: { id: string } }) => f.user.id)).toEqual([me.userId]);
    expect((await friendsOf(me)).outgoing).toEqual([]);
    expect((await lookup(me, rameshId)).body.data.user.relation).toBe('friend');
    expect((await send(me, rameshId)).status).toBe(409);
  });

  it('search lists friends (empty query = all) by name, handle or ID', async () => {
    const all = (await search(me, '')).body.data.items;
    expect(all).toEqual([{ id: ramesh.userId, name: expect.any(String), handle: expect.any(String), phoneHint: null, finnId: rameshId }]);
    expect((await search(me, rameshId)).body.data.items).toHaveLength(1);
    expect((await search(me, all[0].name.slice(0, 3))).body.data.items).toHaveLength(1);
  });

  it('crossing requests: sending to someone who asked you accepts at once', async () => {
    const priya = await t.createUser('fr-priya@example.com');
    await send(priya, myId);
    const res = await send(me, await finnIdOf(priya));
    expect(res.body.data.friend).toMatchObject({ user: { id: priya.userId } });
    expect((await friendsOf(me)).incoming).toEqual([]);
    expect((await friendsOf(priya)).friends).toHaveLength(1);
  });

  it('cancel withdraws a request', async () => {
    const karan = await t.createUser('fr-karan@example.com');
    const sent = await send(me, await finnIdOf(karan));
    expect((await cancel(me, sent.body.data.request.id)).body.data).toEqual({ ok: true });
    expect((await friendsOf(karan)).incoming).toEqual([]);
  });

  it('caps outgoing pending requests at 50', async () => {
    const spammer = await t.createUser('fr-spammer@example.com');
    const targets: AuthUser[] = [];
    for (let i = 0; i < 51; i++) targets.push(await t.createUser(`fr-target${i}@example.com`));
    for (let i = 0; i < 50; i++) expect((await send(spammer, await finnIdOf(targets[i]))).status).toBe(200);
    const res = await send(spammer, await finnIdOf(targets[50]));
    expect(res.status).toBe(422);
    expect(res.body.error!.fieldErrors!.finnId).toBe('You have too many pending requests. Cancel some first.');
  }, 60_000);
});

describe('sharing pending items needs a friendship', () => {
  let me: AuthUser;
  let stranger: AuthUser;
  let friend: AuthUser;

  beforeAll(async () => {
    me = await t.createUser('share-me@example.com');
    stranger = await t.createUser('share-stranger@example.com');
    friend = await t.createUser('share-friend@example.com');
    await send(me, await finnIdOf(friend));
    await accept(friend, (await friendsOf(friend)).incoming[0].id);
  });

  it('refuses a stranger and nothing reaches their account', async () => {
    await expect(act(me, 'pending.create', pendingItem(stranger.userId))).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { linkedUserId: 'You can share only with friends. Send them a friend request first.' },
    });
    const rows = await t.pglite.query('select 1 from public.pending_payments where shared_with_user_id = $1', [stranger.userId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses a stranger in a split', async () => {
    await expect(
      act(me, 'pending.split', {
        direction: 'owedToMe',
        kind: 'sharedExpense',
        total: '900',
        purpose: 'Dinner',
        createdDate: '2026-10-01',
        method: 'equally',
        includeMe: true,
        people: [{ counterparty: 'Friend', linkedUserId: friend.userId }, { counterparty: 'Stranger', linkedUserId: stranger.userId }],
      }),
    ).rejects.toMatchObject({ fieldErrors: { 'people.1.linkedUserId': 'You can share only with friends. Send them a friend request first.' } });
  });

  it('shares with a friend; the item keeps its person after unfriending', async () => {
    const p = await act<{ id: string; version: number }>(me, 'pending.create', pendingItem(friend.userId));
    expect((await unfriend(me, friend.userId)).body.data).toEqual({ ok: true });
    expect((await friendsOf(friend)).friends).toEqual([]);
    // Still editable with its link; new shares are refused.
    await act(me, 'pending.update', { id: p.id, expectedVersion: p.version, ...pendingItem(friend.userId), amount: '35000' });
    await expect(act(me, 'pending.create', pendingItem(friend.userId))).rejects.toMatchObject({ code: 'validation' });
    expect((await unfriend(me, friend.userId)).status).toBe(404);
  });
});
