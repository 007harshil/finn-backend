// pending.create / split / update / settle / cancel / delete
// (lib/features/pending/application/pending_actions.dart).
//
// Shared items (counterparty is a FiNN user) are stored ONCE, under the
// creator, with shared_id / shared_with_user_id / shared_with_handle. The
// other person sees a derived view with id `mir_<sharedId>` (direction and
// borrowed/lent reversed). Actions accept either id form and resolve it to
// the underlying row. Rules (docs/BACKEND_INTEGRATION.md "Shared pending"):
// only the creator edits details or deletes; either person records
// settlements (a linked transaction belongs to the recorder only); only the
// person who is owed writes the rest off; the person never changes. Before
// touching a shared item the other user's write lock is taken, so both
// users' writes (and their sync ordering) stay serialised.

import type { Selectable } from 'kysely';
import { z } from 'zod';
import { zBool, zDate, zEnum, zEnumOpt, zId, zMoney, zText, zTextOpt, zVersion } from '../../actions/input';
import type { Tx } from '../../db/tx';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr, sumPaise, type Paise } from '../../core/money';
import type { PendingPaymentsTable } from '../../db/types';
import {
  MIRROR_PREFIX,
  PENDING_KINDS,
  SPLIT_METHODS,
  pendingFromRow,
  settlementFromRow,
  type PendingPayment,
  type PendingSettlement,
  type SplitMethod,
} from '../../finance/models';
import { directoryEntries, type DirectoryEntry } from '../../finance/snapshot';
import { SystemCategories } from '../account/standard-categories';
import { channelError, resolveAccountId } from '../accounts/resolve';
import { MAX_TRANSACTION_PAISE } from '../transactions/actions';
import { buildLinkedTransaction, insertTransaction } from '../transactions/repo';
import {
  collectSplits,
  computeSplit,
  isActiveStatus,
  PENDING_KIND_LABELS,
  PENDING_STATUS_LABELS,
  pendingView,
  pendingViews,
  SPLIT_METHOD_LABELS,
  splitTakesValues,
  type PendingState,
} from './calculator';

/** Most people one split takes. */
export const MAX_SPLIT_PEOPLE = 20;

const DIRECTIONS = ['iOwe', 'owedToMe'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'This item no longer exists.';
const STALE = 'This item changed since you opened it. Reload and try again.';

type PendingRow = Selectable<PendingPaymentsTable>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** FiNN users among [ids] (the caller and malformed ids are never "known"). */
async function knownUsers(ctx: ActionContext, ids: (string | null)[]): Promise<Map<string, DirectoryEntry>> {
  const valid = ids.filter((id): id is string => !!id && id !== ctx.userId && UUID_RE.test(id));
  return directoryEntries(ctx.tx, valid);
}

// ---------------------------------------------------------------------------
// Lock declarations: every user a pending action may write for, locked by the
// dispatcher together with the caller in one sorted order (no deadlocks).
// ---------------------------------------------------------------------------

type LockScope = { tx: Tx; userId: string };

/** Only users that exist are locked: arbitrary ids must not let a caller hold other people's locks. */
async function linkedIds(scope: LockScope, ids: (string | null | undefined)[]): Promise<string[]> {
  const candidates = [...new Set(ids.filter((id): id is string => !!id && id !== scope.userId && UUID_RE.test(id)))];
  if (candidates.length === 0 || candidates.length > MAX_SPLIT_PEOPLE) return [];
  return [...(await directoryEntries(scope.tx, candidates)).keys()];
}

async function otherPartyOf(scope: LockScope, id: string): Promise<string[]> {
  const q = scope.tx.selectFrom('pending_payments').select(['user_id', 'shared_with_user_id']);
  const row = id.startsWith(MIRROR_PREFIX)
    ? await q.where('shared_id', '=', id.slice(MIRROR_PREFIX.length)).where('shared_with_user_id', '=', scope.userId).executeTakeFirst()
    : await q.where('user_id', '=', scope.userId).where('id', '=', id).executeTakeFirst();
  if (!row) return [];
  const other = row.user_id === scope.userId ? row.shared_with_user_id : row.user_id;
  return other ? [other] : [];
}

interface Target {
  /** The stored row (owner = row.user_id). Read before locking: use only its immutable keys. */
  row: PendingRow;
  /** Id as the caller sees it (own id or `mir_<sharedId>`). */
  viewId: string;
  /** The other party of a shared item, if any. */
  otherUserId: string | null;
}

async function findTarget(ctx: ActionContext, id: string): Promise<Target | null> {
  const q = ctx.tx.selectFrom('pending_payments').selectAll();
  const row = id.startsWith(MIRROR_PREFIX)
    ? await q.where('shared_id', '=', id.slice(MIRROR_PREFIX.length)).where('shared_with_user_id', '=', ctx.userId).executeTakeFirst()
    : await q.where('user_id', '=', ctx.userId).where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  const otherUserId = row.user_id === ctx.userId ? row.shared_with_user_id : row.user_id;
  return { row, viewId: id, otherUserId };
}

interface Loaded {
  target: Target;
  view: PendingState;
  /** Every visible item's view (for split totals). */
  all: PendingState[];
}

/**
 * Resolves [id] to its stored row, takes the other party's write lock for a
 * shared item, then reads the item's current view (after the lock, so the
 * other person's latest settlements are included).
 */
async function loadItem(ctx: ActionContext, id: string): Promise<Loaded | null> {
  const target = await findTarget(ctx, id);
  if (!target) return null;
  if (target.otherUserId) await ctx.lockUsers([target.otherUserId]);
  const [items, settlements] = await Promise.all([ctx.snapshot.pending(), ctx.snapshot.settlements()]);
  const p = items.find((x) => x.id === id);
  if (!p) return null;
  return { target, view: pendingView(p, settlements, ctx.today), all: pendingViews(items, settlements, ctx.today) };
}

async function requireItem(ctx: ActionContext, id: string): Promise<Loaded> {
  const loaded = await loadItem(ctx, id);
  if (!loaded) throw AppFailure.notFound(NOT_FOUND);
  return loaded;
}

/** The stored row as the caller sees it. */
async function asViewer(ctx: ActionContext, row: PendingRow): Promise<PendingPayment> {
  if (row.user_id === ctx.userId) return pendingFromRow(row, ctx.userId);
  const owner = (await directoryEntries(ctx.tx, [row.user_id])).get(row.user_id);
  return pendingFromRow(row, ctx.userId, owner ? { name: owner.name, handle: owner.handle } : undefined);
}

/** Writes [values] to the item only if its version is still [expectedVersion]; bumps the version. */
async function updateItem(
  ctx: ActionContext,
  target: Target,
  expectedVersion: number,
  values: Partial<Omit<PendingRow, 'user_id' | 'id' | 'version' | 'created_at' | 'updated_at' | 'sync_seq'>>,
): Promise<PendingRow> {
  const row = await ctx.tx
    .updateTable('pending_payments')
    .set({ ...values, version: expectedVersion + 1, updated_at: ctx.now.toISOString() })
    .where('user_id', '=', target.row.user_id)
    .where('id', '=', target.row.id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale(STALE);
  return row;
}

/** −₹2,500 / +₹2,500 (Dart SignDisplay.always uses the minus sign U+2212). */
const signedInr = (paise: Paise) => (paise < 0 ? `−${formatInr(-paise)}` : paise > 0 ? `+${formatInr(paise)}` : formatInr(0));

// ---------------------------------------------------------------------------
// pending.create
// ---------------------------------------------------------------------------

const pendingShape = {
  counterparty: zText,
  direction: zEnum(DIRECTIONS),
  kind: zEnumOpt(PENDING_KINDS).transform((k) => k ?? 'other'),
  amount: zMoney,
  purpose: zText,
  createdDate: zDate,
  notes: zTextOpt,
  linkedUserId: zTextOpt,
};
const pendingInput = z.object(pendingShape);
type PendingInput = z.output<typeof pendingInput>;

const pendingFields: FieldSpec[] = [
  { name: 'counterparty', kind: 'string', description: 'Person or organisation', required: true },
  {
    name: 'direction',
    kind: 'enumeration',
    description: 'iOwe = I must pay; owedToMe = I will receive',
    required: true,
    allowedValues: DIRECTIONS,
  },
  { name: 'kind', kind: 'enumeration', description: 'Reason', required: false, allowedValues: PENDING_KINDS },
  { name: 'amount', kind: 'money', description: 'Original amount in rupees', required: true },
  { name: 'purpose', kind: 'string', description: 'Short description', required: true },
  { name: 'createdDate', kind: 'date', description: 'When the obligation arose', required: true },
  { name: 'notes', kind: 'string', description: 'Notes', required: false },
  {
    name: 'linkedUserId',
    kind: 'id',
    description: 'FiNN user to share with; the item then also appears in their account. Find ids with the user directory.',
    required: false,
  },
];

function validatePending(i: PendingInput, ctx: ActionContext, users: Map<string, DirectoryEntry>, minimum: Paise = 0): Record<string, string> {
  const e: Record<string, string> = {};
  const link = i.linkedUserId;
  if (link != null) {
    if (link === ctx.userId) e.linkedUserId = 'You cannot share an item with yourself.';
    else if (!users.has(link)) e.linkedUserId = 'That FiNN user could not be found. Search again.';
  }
  if (i.counterparty.trim() === '') e.counterparty = "Enter the person's name.";
  if (i.counterparty.length > 60) e.counterparty = 'Keep the name under 60 characters.';
  if (i.amount <= 0) e.amount = 'Enter an amount greater than zero.';
  if (i.amount > MAX_TRANSACTION_PAISE) e.amount = 'That amount looks too large. Please check it.';
  if (minimum > 0 && i.amount < minimum) e.amount = `${formatInr(minimum)} has already been settled, so the amount cannot be lower.`;
  if (i.purpose.trim() === '') e.purpose = 'Add a short description.';
  if (i.createdDate > ctx.today) e.createdDate = 'The date cannot be in the future.';
  return e;
}

export const createPending = defineAction({
  descriptor: {
    id: 'pending.create',
    module: 'pending',
    title: 'Track money owed',
    description: 'Records an obligation between you and someone else. Does not change your cash balance.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: pendingFields,
  },
  input: pendingInput,
  extraLocks: async (input, scope) => linkedIds(scope, [input.linkedUserId]),
  async prepare(input, ctx) {
    const users = await knownUsers(ctx, [input.linkedUserId]);
    throwIfErrors(validatePending(input, ctx, users));
    const owe = input.direction === 'iOwe';
    const lines: PreviewLine[] = [
      { label: 'Amount', value: formatInr(input.amount), emphasis: true },
      { label: 'Reason', value: PENDING_KIND_LABELS[input.kind] },
    ];
    if (input.linkedUserId != null) {
      lines.push({ label: 'Shared with', value: `${users.get(input.linkedUserId)!.handle} · also in their FiNN` });
    }
    lines.push({ label: 'Cash balance', value: 'Unchanged until settled' });
    return {
      title: owe ? `You owe ${input.counterparty}` : `${input.counterparty} owes you`,
      summary: `${owe ? 'Owe' : 'Collect'} ${formatInr(input.amount)} · ${input.purpose}`,
      lines,
    };
  },
  async execute(input, ctx): Promise<PendingPayment> {
    const user = input.linkedUserId == null ? null : ((await knownUsers(ctx, [input.linkedUserId])).get(input.linkedUserId) ?? null);
    if (user) await ctx.lockUsers([user.userId]);
    const now = ctx.now.toISOString();
    const id = ctx.ids.next('pend');
    const row = await ctx.tx
      .insertInto('pending_payments')
      .values({
        user_id: ctx.userId,
        id,
        counterparty: user?.name ?? input.counterparty.trim(),
        direction: input.direction,
        kind: input.kind,
        original_paise: input.amount,
        purpose: input.purpose.trim(),
        created_date: input.createdDate,
        notes: input.notes,
        is_cancelled: false,
        shared_id: user ? ctx.ids.next('shr') : null,
        shared_with_user_id: user?.userId ?? null,
        shared_with_handle: user?.handle ?? null,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.touched.push(row.id);
    return pendingFromRow(row, ctx.userId);
  },
});

// ---------------------------------------------------------------------------
// pending.split
// ---------------------------------------------------------------------------

/** Dart num.round(): half away from zero. */
const dartRound = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * JSON values are human units (rupees, percent, share count); inside they are
 * paise, basis points and counts. Null when the value is not a number.
 */
function splitValueIn(raw: unknown, method: SplitMethod): number | null {
  if (raw == null || !splitTakesValues(method)) return 0;
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    const s = String(raw).replace(/[₹,%\s]/g, '');
    if (s === '') return null;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return null;
  return method === 'shares' ? dartRound(n) : dartRound(n * 100);
}

const splitPerson = z.object({ counterparty: zText, linkedUserId: zTextOpt, value: z.unknown().optional() });

const splitInput = z
  .object({
    direction: zEnum(DIRECTIONS),
    kind: zEnumOpt(PENDING_KINDS).transform((k) => k ?? 'sharedExpense'),
    total: zMoney,
    purpose: zText,
    createdDate: zDate,
    method: zEnumOpt(SPLIT_METHODS).transform((m) => m ?? 'equally'),
    people: z
      .array(splitPerson, { error: 'Expected a list of people' })
      .max(MAX_SPLIT_PEOPLE, `A split can have up to ${MAX_SPLIT_PEOPLE} people.`),
    includeMe: zBool(false),
    myValue: z.unknown().optional(),
    notes: zTextOpt,
  })
  .transform((o, c) => {
    let bad = false;
    const value = (raw: unknown, field: string) => {
      const v = splitValueIn(raw, o.method);
      if (v === null) {
        c.addIssue({ code: 'custom', path: [field], message: 'Expected a number' });
        bad = true;
        return 0;
      }
      return v;
    };
    const people = o.people.map((p) => ({ counterparty: p.counterparty, linkedUserId: p.linkedUserId, value: value(p.value, 'value') }));
    const myValue = value(o.myValue, 'myValue');
    if (bad) return z.NEVER;
    return {
      direction: o.direction,
      kind: o.kind,
      total: o.total,
      purpose: o.purpose,
      createdDate: o.createdDate,
      method: o.method,
      people,
      includeMe: o.includeMe,
      myValue,
      notes: o.notes,
      /** Values in split order: the user first when included, then each person. */
      values: [...(o.includeMe ? [myValue] : []), ...people.map((p) => p.value)],
    };
  });
type SplitInput = z.output<typeof splitInput>;

/** Field errors for a split, keyed like the form: `people.<i>.counterparty`, `amount`, `includeMe`, `split`, … */
function validateSplit(i: SplitInput, ctx: ActionContext, users: Map<string, DirectoryEntry>): Record<string, string> {
  const e: Record<string, string> = {};
  if (i.people.length < 2) e.people = 'Add at least two people to split with.';
  if (i.people.length > MAX_SPLIT_PEOPLE) e.people = `A split can have up to ${MAX_SPLIT_PEOPLE} people.`;
  const seen = new Set<string>();
  i.people.forEach((p, n) => {
    const name = p.counterparty.trim();
    const link = p.linkedUserId;
    if (link != null) {
      if (link === ctx.userId) e[`people.${n}.linkedUserId`] = 'You are already in the split. Use "Include me" instead.';
      else if (!users.has(link)) e[`people.${n}.linkedUserId`] = 'That FiNN user could not be found. Search again.';
    }
    const key = link ?? name.toLowerCase();
    if (name === '' && link == null) {
      e[`people.${n}.counterparty`] = "Enter each person's name.";
    } else if (name.length > 60) {
      e[`people.${n}.counterparty`] = 'Keep the name under 60 characters.';
    } else if (seen.has(key)) {
      e[`people.${n}.counterparty`] = `${name === '' ? 'This person' : name} is in the split twice.`;
    } else {
      seen.add(key);
    }
  });
  if (i.includeMe && i.direction === 'iOwe') e.includeMe = 'Your own share only applies when you paid the bill.';
  if (i.total <= 0) e.amount = 'Enter an amount greater than zero.';
  if (i.total > MAX_TRANSACTION_PAISE) e.amount = 'That amount looks too large. Please check it.';
  if (i.purpose.trim() === '') e.purpose = 'Add a short description.';
  if (i.createdDate > ctx.today) e.createdDate = 'The date cannot be in the future.';
  if (i.total > 0 && i.people.length > 0 && !('people' in e)) {
    const out = computeSplit(i.total, i.method, i.values);
    if (!out.valid) e.split = out.error;
    else if ((i.includeMe ? out.shares.slice(1) : out.shares).some((x) => x <= 0)) {
      e.split = 'Everyone in the split needs a share above zero. Remove anyone who is not paying.';
    }
  }
  return e;
}

function splitShares(i: SplitInput): { mine: Paise; others: Paise[] } {
  const out = computeSplit(i.total, i.method, i.values);
  if (!out.valid) throw AppFailure.fields({ split: out.error });
  return i.includeMe ? { mine: out.shares[0]!, others: out.shares.slice(1) } : { mine: 0, others: out.shares };
}

export const splitPending = defineAction({
  descriptor: {
    id: 'pending.split',
    module: 'pending',
    title: 'Split money owed',
    description:
      'Splits one bill between several people: equally, by exact amounts, percentages, shares or ' +
      'adjustments. Creates one item per person. Does not change your cash balance.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      {
        name: 'direction',
        kind: 'enumeration',
        description: 'owedToMe = I paid and they owe me their shares; iOwe = I owe each person their share',
        required: true,
        allowedValues: DIRECTIONS,
      },
      { name: 'kind', kind: 'enumeration', description: 'Reason (default sharedExpense)', required: false, allowedValues: PENDING_KINDS },
      { name: 'total', kind: 'money', description: 'Whole bill in rupees, your own share included when includeMe', required: true },
      { name: 'purpose', kind: 'string', description: 'Short description', required: true },
      { name: 'createdDate', kind: 'date', description: 'When the bill was paid', required: true },
      {
        name: 'method',
        kind: 'enumeration',
        description:
          'equally; exact (value = rupees, must add up to total); percent (value = %, must add up to 100); ' +
          'shares (value = whole parts); adjustment (value = rupees added (+) or taken off (−) an equal share)',
        required: true,
        allowedValues: SPLIT_METHODS,
      },
      {
        name: 'includeMe',
        kind: 'boolean',
        description: 'You were part of the bill too; your share is not owed. Only with owedToMe',
        required: false,
      },
      { name: 'myValue', kind: 'string', description: 'Your own value when includeMe (same unit as people[].value)', required: false },
      {
        name: 'people',
        kind: 'string',
        description: `List of {counterparty, linkedUserId?, value?}, 2 to ${MAX_SPLIT_PEOPLE} people, you not included`,
        required: true,
      },
      { name: 'notes', kind: 'string', description: 'Notes', required: false },
    ],
  },
  input: splitInput,
  extraLocks: async (input, scope) => linkedIds(scope, input.people.map((p) => p.linkedUserId)),
  async prepare(input, ctx) {
    const users = await knownUsers(ctx, input.people.map((p) => p.linkedUserId));
    throwIfErrors(validateSplit(input, ctx, users));
    const { mine, others } = splitShares(input);
    const owe = input.direction === 'iOwe';
    const n = input.people.length;
    const lines: PreviewLine[] = [
      { label: 'Total', value: formatInr(input.total), emphasis: true },
      { label: 'Split', value: `${SPLIT_METHOD_LABELS[input.method]} · ${n + (input.includeMe ? 1 : 0)} people` },
    ];
    if (input.includeMe) lines.push({ label: 'Your share', value: formatInr(mine) });
    input.people.forEach((p, i) => {
      lines.push({
        label: p.linkedUserId == null ? p.counterparty.trim() : users.get(p.linkedUserId)!.name,
        value: formatInr(others[i]!),
      });
    });
    lines.push({ label: 'Cash balance', value: 'Unchanged until settled' });
    return {
      title: owe ? `You owe ${n} people` : `Split with ${n} people`,
      summary: `${owe ? 'Owe' : 'Collect'} ${formatInr(sumPaise(others))} ${owe ? 'to' : 'from'} ${n} people · ${input.purpose}`,
      lines,
    };
  },
  async execute(input, ctx): Promise<PendingPayment[]> {
    const { mine, others } = splitShares(input);
    const users = await knownUsers(ctx, input.people.map((p) => p.linkedUserId));
    if (users.size > 0) await ctx.lockUsers([...users.keys()]);
    const splitId = ctx.ids.next('spl');
    const created: PendingPayment[] = [];
    for (let i = 0; i < input.people.length; i++) {
      const person = input.people[i]!;
      const user = person.linkedUserId == null ? null : (users.get(person.linkedUserId) ?? null);
      // A millisecond apart, so the people keep the order they were added
      // (the Flutter app uses microseconds; JSON instants carry milliseconds).
      const at = new Date(ctx.now.getTime() + i).toISOString();
      const id = ctx.ids.next('pend');
      const row = await ctx.tx
        .insertInto('pending_payments')
        .values({
          user_id: ctx.userId,
          id,
          counterparty: user?.name ?? person.counterparty.trim(),
          direction: input.direction,
          kind: input.kind,
          original_paise: others[i]!,
          purpose: input.purpose.trim(),
          created_date: input.createdDate,
          notes: input.notes,
          is_cancelled: false,
          shared_id: user ? ctx.ids.next('shr') : null,
          shared_with_user_id: user?.userId ?? null,
          shared_with_handle: user?.handle ?? null,
          split_id: splitId,
          split_method: input.method,
          split_includes_me: input.includeMe,
          split_my_share_paise: input.includeMe ? mine : 0,
          split_part: splitTakesValues(input.method) ? person.value : null,
          version: 1,
          created_at: at,
          updated_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ctx.touched.push(row.id);
      created.push(pendingFromRow(row, ctx.userId));
    }
    return created;
  },
});

// ---------------------------------------------------------------------------
// pending.update
// ---------------------------------------------------------------------------

export const updatePending = defineAction({
  descriptor: {
    id: 'pending.update',
    module: 'pending',
    title: 'Edit money owed',
    description: 'Edits the details of a pending payment. The original amount cannot go below what was already settled.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Pending payment id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...pendingFields,
    ],
  },
  // Direction cannot change after creation; it is ignored here.
  input: z.object({ id: zId, expectedVersion: zVersion, ...pendingShape }),
  extraLocks: async (input, scope) => [...(await otherPartyOf(scope, input.id)), ...(await linkedIds(scope, [input.linkedUserId]))],
  async prepare(input, ctx) {
    const { view: v, all } = await requireItem(ctx, input.id);
    if (v.payment.version !== input.expectedVersion) throw AppFailure.stale(STALE);
    const link = v.payment.link;
    if (link && !link.createdByMe) {
      throw AppFailure.notPermitted(
        `Only ${v.payment.counterparty} can change the details of this shared item. You can still record a settlement.`,
      );
    }
    if (link && input.linkedUserId != null && input.linkedUserId !== link.userId) {
      throw AppFailure.notPermitted('The person on a shared item cannot change.');
    }
    const users = await knownUsers(ctx, [input.linkedUserId]);
    throwIfErrors(validatePending(input, ctx, users, v.settledPaise));
    const lines: PreviewLine[] = [
      { label: 'Original amount', value: formatInr(input.amount), emphasis: true },
      { label: 'Already settled', value: formatInr(v.settledPaise) },
      { label: 'Outstanding after edit', value: formatInr(input.amount - v.settledPaise) },
    ];
    const split = v.payment.split;
    if (split && input.amount !== v.payment.originalPaise) {
      const bill = collectSplits(all).get(split.id)!;
      lines.push({ label: 'Split bill after edit', value: formatInr(bill.totalPaise - v.payment.originalPaise + input.amount) });
    }
    return {
      title: 'Save changes',
      summary: `Update ${v.payment.purpose} with ${input.counterparty}`,
      lines,
    };
  },
  async execute(input, ctx): Promise<PendingPayment> {
    const { target, view: v } = await requireItem(ctx, input.id);
    const p = v.payment;
    // A private item can be shared later; a shared one keeps its person.
    const user =
      p.link == null && input.linkedUserId != null ? ((await knownUsers(ctx, [input.linkedUserId])).get(input.linkedUserId) ?? null) : null;
    if (user) await ctx.lockUsers([user.userId]);
    // A new amount no longer follows the split's rule; the bill total follows
    // it (it is always the sum of the items).
    const splitChange =
      p.split && input.amount !== p.originalPaise ? { split_method: 'exact' as SplitMethod, split_part: input.amount } : {};
    const row = await updateItem(ctx, target, input.expectedVersion, {
      counterparty: p.link != null ? target.row.counterparty : (user?.name ?? input.counterparty.trim()),
      kind: input.kind,
      original_paise: input.amount,
      purpose: input.purpose.trim(),
      created_date: input.createdDate,
      notes: input.notes,
      ...(user ? { shared_id: ctx.ids.next('shr'), shared_with_user_id: user.userId, shared_with_handle: user.handle } : {}),
      ...splitChange,
    });
    if (user) {
      // Settlements recorded before the item was shared become visible to the
      // other person too (and re-sync), so both see the same outstanding amount.
      await ctx.tx
        .updateTable('pending_settlements')
        .set({ shared_with_user_id: user.userId })
        .where('pending_owner_id', '=', ctx.userId)
        .where('pending_id', '=', target.row.id)
        .where('shared_with_user_id', 'is', null)
        .execute();
    }
    ctx.touched.push(row.id);
    return pendingFromRow(row, ctx.userId);
  },
});

// ---------------------------------------------------------------------------
// pending.settle
// ---------------------------------------------------------------------------

const settleInput = z.object({
  pendingId: zId,
  amount: zMoney,
  date: zDate,
  /** Account the settlement money moved through (defaults to the default account). */
  accountId: zId.nullish().transform((v) => v ?? null),
  channel: zTextOpt,
  /**
   * When true, a linked income/expense transaction is created so the cash
   * balance reflects the settlement. False for settlements outside tracked
   * cash (e.g. offset against another debt).
   */
  recordCashMovement: zBool(true),
  note: zTextOpt,
});

export const settlePending = defineAction({
  descriptor: {
    id: 'pending.settle',
    module: 'pending',
    title: 'Settle money owed',
    description: 'Records a full or partial settlement. Creates the matching cash movement once (never twice).',
    risk: 'consequential',
    movesMoney: true,
    reversible: false,
    fields: [
      { name: 'pendingId', kind: 'id', description: 'Exact pending payment id. Use pending.resolve to find it by name; never guess.', required: true },
      { name: 'amount', kind: 'money', description: 'Amount settled now (≤ outstanding)', required: true },
      { name: 'date', kind: 'date', description: 'Settlement date', required: true },
      { name: 'accountId', kind: 'id', description: 'Account the money moved through (defaults to the default account)', required: false },
      { name: 'channel', kind: 'string', description: 'How it moved (free text, up to 30 characters)', required: false },
      { name: 'recordCashMovement', kind: 'boolean', description: 'Create the matching cash transaction (default true)', required: false },
      { name: 'note', kind: 'string', description: 'Reference', required: false },
    ],
  },
  input: settleInput,
  extraLocks: async (input, scope) => otherPartyOf(scope, input.pendingId),
  async prepare(input, ctx) {
    const { view: v } = await requireItem(ctx, input.pendingId);
    if (!isActiveStatus(v.status)) {
      throw AppFailure.validation(`This item is already ${PENDING_STATUS_LABELS[v.status].toLowerCase()}.`);
    }
    const e: Record<string, string> = {};
    if (input.amount <= 0) e.amount = 'Enter an amount greater than zero.';
    if (input.amount > v.outstandingPaise) e.amount = `Only ${formatInr(v.outstandingPaise)} is outstanding.`;
    if (input.date > ctx.today) e.date = 'The date cannot be in the future.';
    if (input.date < v.payment.createdDate) e.date = 'The date is before this item was created.';
    const ce = channelError(input.channel);
    if (ce) e.channel = ce;
    throwIfErrors(e);
    if (input.recordCashMovement) await resolveAccountId(ctx, input.accountId);

    const owe = v.payment.direction === 'iOwe';
    const remaining = v.outstandingPaise - input.amount;
    const warnings: string[] = [];
    if (owe && input.recordCashMovement) {
      const balance = await ctx.snapshot.balance();
      if (input.amount > balance.availablePaise) {
        warnings.push(`This is more than your available balance of ${formatInr(balance.availablePaise)}.`);
      }
    }
    const cashLine = !input.recordCashMovement ? 'Not recorded as cash' : signedInr(owe ? -input.amount : input.amount);
    return {
      title: remaining === 0 ? 'Settle in full' : 'Record partial settlement',
      summary: owe
        ? `Pay ${v.payment.counterparty} ${formatInr(input.amount)}`
        : `Receive ${formatInr(input.amount)} from ${v.payment.counterparty}`,
      lines: [
        { label: 'For', value: v.payment.purpose },
        { label: 'Original', value: formatInr(v.payment.originalPaise) },
        { label: 'Settled before', value: formatInr(v.settledPaise) },
        { label: 'This settlement', value: formatInr(input.amount), emphasis: true },
        { label: 'Remaining after', value: formatInr(remaining) },
        { label: 'Cash balance', value: cashLine },
      ],
      warnings,
      basis: { v: v.payment.version, settled: v.settledPaise },
    };
  },
  async execute(input, ctx): Promise<PendingSettlement> {
    const { target, view: v } = await requireItem(ctx, input.pendingId);
    const owe = v.payment.direction === 'iOwe';
    // The recorder's own cash movement (never the other person's).
    let transactionId: string | null = null;
    let accountId: string | null = null;
    if (input.recordCashMovement) {
      accountId = await resolveAccountId(ctx, input.accountId);
      const t = await insertTransaction(
        ctx.tx,
        ctx.userId,
        buildLinkedTransaction(ctx, {
          type: owe ? 'expense' : 'income',
          amountPaise: input.amount,
          categoryId: owe ? SystemCategories.settlementPaid : SystemCategories.settlementReceived,
          date: input.date,
          origin: 'pendingSettlement',
          originRefId: v.payment.id,
          accountId,
          channel: input.channel,
          counterparty: v.payment.counterparty,
          note: `Settlement · ${v.payment.purpose}`,
        }),
      );
      transactionId = t.id;
      ctx.touched.push(t.id);
    }
    const row = await ctx.tx
      .insertInto('pending_settlements')
      .values({
        user_id: ctx.userId,
        id: ctx.ids.next('set'),
        pending_owner_id: target.row.user_id,
        pending_id: target.row.id,
        shared_with_user_id: target.row.shared_with_user_id,
        amount_paise: input.amount,
        date: input.date,
        account_id: accountId,
        channel: accountId ? input.channel : null,
        transaction_id: transactionId,
        note: input.note,
        created_at: ctx.now.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Shared item: bump the item so both parties' sync sees the change (and
    // a concurrent edit based on the old state goes stale).
    if (target.otherUserId) await updateItem(ctx, target, v.payment.version, {});
    ctx.touched.push(row.id, v.payment.id);
    return settlementFromRow(row, ctx.userId, v.payment.id);
  },
});

// ---------------------------------------------------------------------------
// pending.cancel / pending.delete
// ---------------------------------------------------------------------------

const idInput = z.object({ id: zId });

/** Writes off an obligation that will not be settled. */
export const cancelPending = defineAction({
  descriptor: {
    id: 'pending.cancel',
    module: 'pending',
    title: 'Write off money owed',
    description: 'Marks the remaining amount as no longer expected. Recorded settlements are kept.',
    risk: 'consequential',
    movesMoney: false,
    reversible: true,
    fields: [{ name: 'id', kind: 'id', description: 'Pending payment id', required: true }],
  },
  input: idInput,
  extraLocks: async (input, scope) => otherPartyOf(scope, input.id),
  async prepare(input, ctx) {
    const { view: v } = await requireItem(ctx, input.id);
    if (!isActiveStatus(v.status)) throw AppFailure.validation('This item is already closed.');
    if (v.payment.link && v.payment.direction === 'iOwe') {
      throw AppFailure.notPermitted(`This is shared with ${v.payment.counterparty}, who is owed the money. Only they can write it off.`);
    }
    return {
      title: `Write off ${formatInr(v.outstandingPaise)}?`,
      summary: `Write off ${formatInr(v.outstandingPaise)} with ${v.payment.counterparty}`,
      lines: [
        { label: 'For', value: v.payment.purpose },
        { label: 'Already settled', value: formatInr(v.settledPaise) },
      ],
      basis: { v: v.payment.version, settled: v.settledPaise },
    };
  },
  async execute(input, ctx): Promise<PendingPayment> {
    const { target, view: v } = await requireItem(ctx, input.id);
    const row = await updateItem(ctx, target, v.payment.version, { is_cancelled: true });
    ctx.touched.push(v.payment.id);
    return asViewer(ctx, row);
  },
});

/** Deletes an item that has no settlements (mistaken entries only). */
export const deletePending = defineAction({
  descriptor: {
    id: 'pending.delete',
    module: 'pending',
    title: 'Delete pending item',
    description: 'Removes an item created by mistake. Items with settlements must be written off instead.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Pending payment id', required: true }],
  },
  input: idInput,
  extraLocks: async (input, scope) => otherPartyOf(scope, input.id),
  async prepare(input, ctx) {
    const { view: v } = await requireItem(ctx, input.id);
    // Settlements by either person block deletion: the other person's cash
    // records would otherwise lose their item.
    if (v.settlements.length > 0) {
      throw AppFailure.notPermitted('This item has settlements recorded. Write it off instead so your history stays accurate.');
    }
    const link = v.payment.link;
    if (link && !link.createdByMe) {
      throw AppFailure.notPermitted(`Only ${v.payment.counterparty} can delete this shared item.`);
    }
    return {
      title: 'Delete this item?',
      summary: `Delete ${v.payment.purpose} with ${v.payment.counterparty}`,
      warnings: ['This cannot be undone.'],
      basis: { v: v.payment.version },
    };
  },
  async execute(input, ctx): Promise<PendingPayment> {
    const { target, view: v } = await requireItem(ctx, input.id);
    if (target.row.user_id !== ctx.userId) throw AppFailure.notPermitted(`Only ${v.payment.counterparty} can delete this shared item.`);
    // Defensive: prepare refuses items with settlements, but if any of the
    // creator's own linked settlement transactions exist they go too — after
    // the item, because settlements reference transactions.
    const ownLinked = await ctx.tx
      .selectFrom('pending_settlements')
      .select('transaction_id')
      .where('user_id', '=', ctx.userId)
      .where('pending_owner_id', '=', ctx.userId)
      .where('pending_id', '=', target.row.id)
      .where('transaction_id', 'is not', null)
      .execute();
    const deleted = await ctx.tx
      .deleteFrom('pending_payments')
      .where('user_id', '=', ctx.userId)
      .where('id', '=', target.row.id)
      .where('version', '=', v.payment.version)
      .executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) throw AppFailure.stale(STALE);
    const txIds = ownLinked.map((r) => r.transaction_id!).filter(Boolean);
    if (txIds.length > 0) {
      await ctx.tx.deleteFrom('transactions').where('user_id', '=', ctx.userId).where('id', 'in', txIds).execute();
      ctx.touched.push(...txIds);
    }
    ctx.touched.push(v.payment.id);
    return v.payment;
  },
});

export const pendingActions: AnyAction[] = [
  createPending,
  splitPending,
  updatePending,
  settlePending,
  cancelPending,
  deletePending,
] as AnyAction[];
