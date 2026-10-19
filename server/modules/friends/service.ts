// Friends and FiNN IDs (finn/docs/FRIENDS.md). Other users are found only by
// their exact FiNN ID, and a pending item can be shared only with a friend.
// Requests are pending rows in friend_requests; accepting moves the pair to
// friendships, rejecting or cancelling deletes the row (it can be sent again).
// Writes lock both users in sorted order, so crossing requests (A asks B
// while B asks A) cannot both be inserted.

import { sql } from 'kysely';
import { z } from 'zod';
import { lockUsers, type Tx } from '../../db/tx';
import { AppFailure } from '../../core/failure';

export const FINN_ID_RE = /^[2-9A-HJ-NP-Z]{8}$/;
export const MAX_OUTGOING_REQUESTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID_ID = 'Enter a valid FiNN ID, like K7Q2-M9XD.';
const REQUEST_GONE = 'This request no longer exists.';

/** `k7q2-m9xd` / `K7Q2 M9XD` → `K7Q2M9XD`; null when it is not a FiNN ID. */
export function normalizeFinnId(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return FINN_ID_RE.test(code) ? code : null;
}

export const finnIdSchema = z.object({ finnId: z.string().max(40) });

export interface FriendUser {
  id: string;
  name: string;
  finnId: string;
}
export interface Friend {
  user: FriendUser;
  since: string;
}
export interface FriendRequest {
  id: string;
  user: FriendUser;
  createdAt: string;
}
export type Relation = 'self' | 'friend' | 'outgoing' | 'incoming' | 'blocked' | 'none';

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const pair = (a: string, b: string) => (a < b ? { user_low: a, user_high: b } : { user_low: b, user_high: a });

function requireFinnId(raw: string): string {
  const code = normalizeFinnId(raw);
  if (!code) throw AppFailure.validation(INVALID_ID, { finnId: INVALID_ID });
  return code;
}

async function findByFinnId(tx: Tx, code: string): Promise<FriendUser | null> {
  const rows = await sql<{ user_id: string; display_name: string; finn_id: string }>`
    select * from private.find_user_by_finn_id(${code})`.execute(tx);
  const r = rows.rows[0];
  return r ? { id: r.user_id, name: r.display_name, finnId: r.finn_id } : null;
}

async function requestBetween(tx: Tx, a: string, b: string) {
  return tx
    .selectFrom('friend_requests')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb.and([eb('requester_id', '=', a), eb('addressee_id', '=', b)]),
        eb.and([eb('requester_id', '=', b), eb('addressee_id', '=', a)]),
      ]),
    )
    .executeTakeFirst();
}

/** Whether the caller blocked [other] (the caller's own rows only). */
async function iBlocked(tx: Tx, userId: string, other: string): Promise<boolean> {
  const row = await tx
    .selectFrom('user_blocks')
    .select('blocked_id')
    .where('blocker_id', '=', userId)
    .where('blocked_id', '=', other)
    .executeTakeFirst();
  return !!row;
}

/** Whether either side blocked the other (security definer: sees the other side's row too). */
async function blockedBetween(tx: Tx, other: string): Promise<boolean> {
  const rows = await sql<{ blocked: boolean }>`select private.blocked_between(${other}::uuid) as blocked`.execute(tx);
  return rows.rows[0]?.blocked === true;
}

async function areFriends(tx: Tx, a: string, b: string): Promise<boolean> {
  const p = pair(a, b);
  const row = await tx
    .selectFrom('friendships')
    .select('created_at')
    .where('user_low', '=', p.user_low)
    .where('user_high', '=', p.user_high)
    .executeTakeFirst();
  return !!row;
}

/** Ids among [ids] that are the caller's friends. */
export async function friendIdsAmong(tx: Tx, userId: string, ids: string[]): Promise<Set<string>> {
  const candidates = [...new Set(ids.filter((id) => id !== userId && UUID_RE.test(id)))];
  if (candidates.length === 0) return new Set();
  const rows = await tx
    .selectFrom('friendships')
    .select(['user_low', 'user_high'])
    .where((eb) =>
      eb.or([
        eb.and([eb('user_low', '=', userId), eb('user_high', 'in', candidates)]),
        eb.and([eb('user_high', '=', userId), eb('user_low', 'in', candidates)]),
      ]),
    )
    .execute();
  return new Set(rows.map((r) => (r.user_low === userId ? r.user_high : r.user_low)));
}

async function me(tx: Tx, userId: string): Promise<FriendUser> {
  const row = await tx.selectFrom('profiles').select(['display_name', 'finn_id']).where('user_id', '=', userId).executeTakeFirst();
  if (!row) throw AppFailure.notFound('Profile not found.');
  return { id: userId, name: row.display_name, finnId: row.finn_id };
}

export interface FriendEntry extends FriendUser {
  handle: string;
  phoneHint: string | null;
  since: string;
}

/** The caller's friends, by name. */
export async function friendEntries(tx: Tx): Promise<FriendEntry[]> {
  const rows = await sql<{ user_id: string; display_name: string; handle: string; phone_hint: string | null; finn_id: string; since: Date | string }>`
    select * from private.friend_entries()`.execute(tx);
  return rows.rows
    .map((r) => ({ id: r.user_id, name: r.display_name, handle: r.handle, phoneHint: r.phone_hint, finnId: r.finn_id, since: iso(r.since) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.finnId.localeCompare(b.finnId));
}

/** GET /friends */
export async function listFriends(tx: Tx, userId: string) {
  const [self, friends, requests, people, blocks] = await Promise.all([
    me(tx, userId),
    friendEntries(tx),
    tx.selectFrom('friend_requests').selectAll().orderBy('created_at', 'desc').execute(),
    sql<{ user_id: string; display_name: string; finn_id: string }>`select * from private.request_entries()`.execute(tx),
    sql<{ user_id: string; display_name: string; finn_id: string; since: Date | string }>`select * from private.block_entries()`.execute(tx),
  ]);
  const byId = new Map(people.rows.map((r) => [r.user_id, { id: r.user_id, name: r.display_name, finnId: r.finn_id }]));
  const toRequest = (r: (typeof requests)[number], other: string): FriendRequest[] => {
    const user = byId.get(other);
    return user ? [{ id: r.id, user, createdAt: iso(r.created_at) }] : [];
  };
  return {
    me: self,
    friends: friends.map((f): Friend => ({ user: { id: f.id, name: f.name, finnId: f.finnId }, since: f.since })),
    incoming: requests.filter((r) => r.addressee_id === userId).flatMap((r) => toRequest(r, r.requester_id)),
    outgoing: requests.filter((r) => r.requester_id === userId).flatMap((r) => toRequest(r, r.addressee_id)),
    blocked: blocks.rows
      .map((r): Friend => ({ user: { id: r.user_id, name: r.display_name, finnId: r.finn_id }, since: iso(r.since) }))
      .sort((a, b) => a.user.name.localeCompare(b.user.name)),
  };
}

/** GET /users/lookup?finnId= — exact FiNN ID only. */
export async function lookupUser(tx: Tx, userId: string, raw: string) {
  const user = await findByFinnId(tx, requireFinnId(raw));
  if (!user) return { user: null };
  if (user.id === userId) return { user: { ...user, relation: 'self' as Relation } };
  if (await iBlocked(tx, userId, user.id)) return { user: { ...user, relation: 'blocked' as Relation } };
  // Someone who blocked the caller looks like an unknown ID.
  if (await blockedBetween(tx, user.id)) return { user: null };
  if (await areFriends(tx, userId, user.id)) return { user: { ...user, relation: 'friend' as Relation } };
  const request = await requestBetween(tx, userId, user.id);
  if (!request) return { user: { ...user, relation: 'none' as Relation } };
  const relation: Relation = request.requester_id === userId ? 'outgoing' : 'incoming';
  return { user: { ...user, relation, requestId: request.id } };
}

async function befriend(tx: Tx, userId: string, other: FriendUser, now: Date): Promise<Friend> {
  await tx
    .insertInto('friendships')
    .values({ ...pair(userId, other.id), created_at: now })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return { user: other, since: now.toISOString() };
}

/** POST /friends/requests { finnId } → a sent request, or a friendship when they had already asked. */
export async function sendRequest(tx: Tx, userId: string, raw: string, now: Date): Promise<{ request: FriendRequest } | { friend: Friend }> {
  const code = requireFinnId(raw);
  const other = await findByFinnId(tx, code);
  if (!other) throw AppFailure.notFound('No FiNN user has that ID.');
  if (other.id === userId) throw AppFailure.validation('That is your own FiNN ID.', { finnId: 'That is your own FiNN ID.' });
  if (await iBlocked(tx, userId, other.id)) throw AppFailure.conflict('You blocked this person. Unblock them first.');
  if (await blockedBetween(tx, other.id)) throw AppFailure.notFound('No FiNN user has that ID.');
  await lockUsers(tx, [userId, other.id]);
  if (await areFriends(tx, userId, other.id)) throw AppFailure.conflict('You are already friends.');
  const existing = await requestBetween(tx, userId, other.id);
  if (existing?.requester_id === userId) throw AppFailure.conflict('You already sent a request. Wait for them to accept it.');
  if (existing) {
    await tx.deleteFrom('friend_requests').where('id', '=', existing.id).execute();
    return { friend: await befriend(tx, userId, other, now) };
  }
  const { count } = await tx
    .selectFrom('friend_requests')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('requester_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (Number(count) >= MAX_OUTGOING_REQUESTS) {
    const msg = 'You have too many pending requests. Cancel some first.';
    throw AppFailure.validation(msg, { finnId: msg });
  }
  const row = await tx
    .insertInto('friend_requests')
    .values({ requester_id: userId, addressee_id: other.id, created_at: now })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { request: { id: row.id, user: other, createdAt: iso(row.created_at) } };
}

/** The request [id] where the caller plays [side]; locks both users. */
async function requireRequest(tx: Tx, userId: string, id: string, side: 'addressee' | 'requester') {
  if (!UUID_RE.test(id)) throw AppFailure.notFound(REQUEST_GONE);
  const peek = await tx.selectFrom('friend_requests').selectAll().where('id', '=', id).executeTakeFirst();
  const mine = side === 'addressee' ? peek?.addressee_id === userId : peek?.requester_id === userId;
  if (!peek || !mine) throw AppFailure.notFound(REQUEST_GONE);
  await lockUsers(tx, [peek.requester_id, peek.addressee_id]);
  // Re-read after the lock: the other person may have cancelled meanwhile.
  const row = await tx.selectFrom('friend_requests').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw AppFailure.notFound(REQUEST_GONE);
  return row;
}

/** POST /friends/requests/{id}/accept (addressee only). */
export async function acceptRequest(tx: Tx, userId: string, id: string, now: Date): Promise<{ friend: Friend }> {
  const row = await requireRequest(tx, userId, id, 'addressee');
  const people = await sql<{ user_id: string; display_name: string; finn_id: string }>`select * from private.request_entries()`.execute(tx);
  const p = people.rows.find((r) => r.user_id === row.requester_id);
  if (!p) throw AppFailure.notFound(REQUEST_GONE);
  await tx.deleteFrom('friend_requests').where('id', '=', id).execute();
  return { friend: await befriend(tx, userId, { id: p.user_id, name: p.display_name, finnId: p.finn_id }, now) };
}

/** POST /friends/requests/{id}/reject (addressee only). */
export async function rejectRequest(tx: Tx, userId: string, id: string): Promise<{ ok: true }> {
  await requireRequest(tx, userId, id, 'addressee');
  await tx.deleteFrom('friend_requests').where('id', '=', id).execute();
  return { ok: true };
}

/** DELETE /friends/requests/{id} (requester only). */
export async function cancelRequest(tx: Tx, userId: string, id: string): Promise<{ ok: true }> {
  await requireRequest(tx, userId, id, 'requester');
  await tx.deleteFrom('friend_requests').where('id', '=', id).execute();
  return { ok: true };
}

/** DELETE /friends/{userId}. Shared items stay; new shares need a new friendship. */
export async function removeFriend(tx: Tx, userId: string, otherId: string): Promise<{ ok: true }> {
  if (!UUID_RE.test(otherId) || otherId === userId) throw AppFailure.notFound('You are not friends with this person.');
  const p = pair(userId, otherId);
  // Only a friend's lock may be taken: an arbitrary id must not let a caller hold other people's locks.
  const friends = await tx
    .selectFrom('friendships')
    .select('user_low')
    .where('user_low', '=', p.user_low)
    .where('user_high', '=', p.user_high)
    .executeTakeFirst();
  if (!friends) throw AppFailure.notFound('You are not friends with this person.');
  await lockUsers(tx, [userId, otherId]);
  const gone = await tx
    .deleteFrom('friendships')
    .where('user_low', '=', p.user_low)
    .where('user_high', '=', p.user_high)
    .executeTakeFirst();
  if (Number(gone.numDeletedRows) === 0) throw AppFailure.notFound('You are not friends with this person.');
  return { ok: true };
}

/**
 * POST /friends/blocks { userId }. Only someone the caller is connected to (a
 * friend, an open request or a shared pending item) can be blocked. Removes
 * the friendship and any open request; existing shared items stay.
 */
export async function blockUser(tx: Tx, userId: string, otherId: string, now: Date): Promise<{ ok: true }> {
  const unknown = () => AppFailure.notFound('This person is not in your FiNN network.');
  if (!UUID_RE.test(otherId) || otherId === userId) throw unknown();
  if (await iBlocked(tx, userId, otherId)) return { ok: true };
  const connected = await sql<{ user_id: string }>`select user_id from private.directory_entries(array[${otherId}]::uuid[])`.execute(tx);
  if (connected.rows.length === 0) throw unknown();
  await lockUsers(tx, [userId, otherId]);
  const p = pair(userId, otherId);
  await tx.deleteFrom('friendships').where('user_low', '=', p.user_low).where('user_high', '=', p.user_high).execute();
  await tx
    .deleteFrom('friend_requests')
    .where((eb) =>
      eb.or([
        eb.and([eb('requester_id', '=', userId), eb('addressee_id', '=', otherId)]),
        eb.and([eb('requester_id', '=', otherId), eb('addressee_id', '=', userId)]),
      ]),
    )
    .execute();
  await tx
    .insertInto('user_blocks')
    .values({ blocker_id: userId, blocked_id: otherId, created_at: now })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return { ok: true };
}

/** DELETE /friends/blocks/{userId}. They can send requests again; the friendship is not restored. */
export async function unblockUser(tx: Tx, userId: string, otherId: string): Promise<{ ok: true }> {
  if (!UUID_RE.test(otherId)) throw AppFailure.notFound('You have not blocked this person.');
  const gone = await tx.deleteFrom('user_blocks').where('blocker_id', '=', userId).where('blocked_id', '=', otherId).executeTakeFirst();
  if (Number(gone.numDeletedRows) === 0) throw AppFailure.notFound('You have not blocked this person.');
  return { ok: true };
}

export const blockSchema = z.object({ userId: z.string().max(64) });
