// Blocking people (Play user-generated content policy) and reporting
// assistant replies (Play AI-generated content policy).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as friendsRoute from '@/app/api/v1/friends/route';
import * as requestsRoute from '@/app/api/v1/friends/requests/route';
import * as blocksRoute from '@/app/api/v1/friends/blocks/route';
import * as blockRoute from '@/app/api/v1/friends/blocks/[userId]/route';
import * as lookupRoute from '@/app/api/v1/users/lookup/route';
import * as reportsRoute from '@/app/api/v1/agent/reports/route';
import * as meRoute from '@/app/api/v1/me/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import type { AuthUser } from '@/server/auth/verify';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
});
afterAll(async () => t.close());

const finnIdOf = async (u: AuthUser): Promise<string> => (await call(meRoute.GET, 'GET', '/api/v1/me', { user: u })).body.data.user.finnId;
const friendsOf = async (u: AuthUser) => (await call(friendsRoute.GET, 'GET', '/api/v1/friends', { user: u })).body.data;
const send = (u: AuthUser, finnId: string) => call(requestsRoute.POST, 'POST', '/api/v1/friends/requests', { user: u, body: { finnId } });
const lookup = (u: AuthUser, finnId: string) => call(lookupRoute.GET, 'GET', '/api/v1/users/lookup', { user: u, query: { finnId } });
const block = (u: AuthUser, userId: string) => call(blocksRoute.POST, 'POST', '/api/v1/friends/blocks', { user: u, body: { userId } });
const unblock = (u: AuthUser, userId: string) =>
  call(blockRoute.DELETE, 'DELETE', `/api/v1/friends/blocks/${userId}`, { user: u, params: { userId } });
const report = (u: AuthUser, body: unknown) => call(reportsRoute.POST, 'POST', '/api/v1/agent/reports', { user: u, body });

describe('blocking', () => {
  it('blocking a requester removes the request and hides the blocker from them', async () => {
    const a = await t.createUser('blk-a@example.com');
    const b = await t.createUser('blk-b@example.com');
    const [ia, ib] = [await finnIdOf(a), await finnIdOf(b)];
    expect((await send(b, ia)).status).toBe(200);

    expect((await block(a, b.userId)).status).toBe(200);
    const mine = await friendsOf(a);
    expect(mine.incoming).toEqual([]);
    expect(mine.blocked.map((x: { user: { id: string } }) => x.user.id)).toEqual([b.userId]);
    expect((await friendsOf(b)).outgoing).toEqual([]);

    // B cannot find or ask A again; A sees B as blocked.
    expect((await lookup(b, ia)).body.data.user).toBeNull();
    expect((await send(b, ia)).status).toBe(404);
    expect((await lookup(a, ib)).body.data.user.relation).toBe('blocked');
    expect((await send(a, ib)).status).toBe(409);

    // Unblock: B can send a request again.
    expect((await unblock(a, b.userId)).status).toBe(200);
    expect((await friendsOf(a)).blocked).toEqual([]);
    expect((await send(b, ia)).status).toBe(200);
  });

  it('blocking a friend ends the friendship', async () => {
    const a = await t.createUser('blk-c@example.com');
    const b = await t.createUser('blk-d@example.com');
    await t.befriend(a, b);
    expect((await block(a, b.userId)).status).toBe(200);
    expect((await friendsOf(a)).friends).toEqual([]);
    expect((await friendsOf(b)).friends).toEqual([]);
  });

  it('cannot block a stranger or yourself', async () => {
    const a = await t.createUser('blk-e@example.com');
    const stranger = await t.createUser('blk-f@example.com');
    expect((await block(a, stranger.userId)).status).toBe(404);
    expect((await block(a, a.userId)).status).toBe(404);
    expect((await block(a, 'not-a-uuid')).status).toBe(404);
    expect((await unblock(a, stranger.userId)).status).toBe(404);
  });
});

describe('POST /api/v1/agent/reports', () => {
  it('stores a report owned by the reporter', async () => {
    const u = await t.createUser('rep-a@example.com');
    const res = await report(u, { reason: 'offensive', reply: 'Some reply', request: 'add 500 for food', note: 'rude' });
    expect(res.status).toBe(200);
    const rows = await t.db.selectFrom('agent_reports').selectAll().where('user_id', '=', u.userId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'offensive', reply: 'Some reply', request: 'add 500 for food', note: 'rude', status: 'open' });
  });

  it('rejects an unknown reason or an empty reply', async () => {
    const u = await t.createUser('rep-b@example.com');
    expect((await report(u, { reason: 'spam', reply: 'x' })).status).toBe(422);
    expect((await report(u, { reason: 'other', reply: '  ' })).status).toBe(422);
  });
});
