// Agent history (table agent_runs): one row per agent turn that proposed
// changes, so the user can review what they asked for and what actually
// happened. Rows are written by POST /plans/execute from the server's own step
// reports, never from what the client or the model claims. A turn whose
// dependent steps run in a second plan call (e.g. "create a category and add
// an expense to it") reuses the run id; the operations are merged by step id.
// Retrying an execute call replays its steps and rewrites the same row, so a
// retry never adds a second entry.
//
// History is for the user's review only: it is not sent to the LLM. Each
// operation stores its summary, status and record ids, never record copies.

import { sql } from 'kysely';
import { z } from 'zod';
import type { AuthUser } from '../auth/verify';
import { withUserTx } from '../db/tx';
import { logger } from '../http/logger';
import type { StepReport } from '../actions/plans';

/** Days an entry is kept; older ones are pruned on write. */
export const AGENT_HISTORY_RETENTION_DAYS = 180;

export const agentRunInputSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._\-]{8,64}$/, 'Use 8-64 letters, digits, dot, dash or underscore'),
  /** The user's message, stored trimmed to 500 characters. */
  request: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((s) => s.slice(0, 500)),
  /** App-side notes for parts that could not be planned ("No goal named Japan trip"). */
  notes: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Preview summaries by step id, used for steps the server did not run (declined). */
  labels: z.record(z.string(), z.string().max(300)).default({}),
});

export type AgentRunInput = z.infer<typeof agentRunInputSchema>;

export type AgentOpStatus = 'saved' | 'alreadySaved' | 'declined' | 'failed' | 'skipped' | 'changed';
export type AgentRunStatus = 'completed' | 'partial' | 'failed' | 'declined';

export interface AgentOperation {
  ref: string;
  actionId: string;
  summary: string;
  status: AgentOpStatus;
  recordIds: string[];
  message?: string;
}

export interface AgentRun {
  id: string;
  request: string;
  status: AgentRunStatus;
  summary: string;
  operations: AgentOperation[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

function opStatus(r: StepReport): AgentOpStatus {
  switch (r.status) {
    case 'succeeded':
      return r.replayed ? 'alreadySaved' : 'saved';
    case 'notApproved':
      // With a failure the record changed after approval (staleData).
      return r.failure ? 'changed' : 'declined';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** Ids of the records a step's result describes (a record, a list, or a list under a key). */
export function recordIdsOf(result: unknown): string[] {
  const ids: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 2 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    const rec = v as Record<string, unknown>;
    if (typeof rec.id === 'string') {
      ids.push(rec.id);
      return;
    }
    for (const key of ['items', 'pending', 'upserted', 'transaction', 'settlement', 'payment']) visit(rec[key], depth + 1);
  };
  visit(result, 0);
  return [...new Set(ids)].slice(0, 20);
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function operationsFrom(reports: StepReport[], labels: Record<string, string>): AgentOperation[] {
  return reports.map((r) => {
    const status = opStatus(r);
    return {
      ref: r.stepId,
      actionId: r.actionId,
      summary: clip(r.preview?.summary || labels[r.stepId] || r.actionId, 300),
      status,
      recordIds: status === 'saved' || status === 'alreadySaved' ? recordIdsOf(r.result) : [],
      ...(r.failure && status !== 'declined' ? { message: clip(r.failure.message, 300) } : {}),
    };
  });
}

/**
 * The turn's overall outcome, judged on the operations the user approved:
 * completed = every approved one saved; partial = some saved, some not;
 * failed = none saved; declined = nothing was approved.
 */
export function runStatus(ops: AgentOperation[]): AgentRunStatus {
  const approved = ops.filter((o) => o.status !== 'declined');
  const saved = approved.filter((o) => o.status === 'saved' || o.status === 'alreadySaved').length;
  if (approved.length === 0) return 'declined';
  if (saved === approved.length) return 'completed';
  return saved > 0 ? 'partial' : 'failed';
}

export function runSummary(ops: AgentOperation[]): string {
  const count = (...s: AgentOpStatus[]) => ops.filter((o) => s.includes(o.status)).length;
  const saved = count('saved', 'alreadySaved');
  const parts = [
    ops.length === 1 ? (saved === 1 ? '1 change saved' : '') : `${saved} of ${ops.length} saved`,
    count('failed', 'changed') > 0 ? `${count('failed', 'changed')} not saved` : '',
    count('skipped') > 0 ? `${count('skipped')} skipped` : '',
    count('declined') > 0 ? `${count('declined')} declined` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'Nothing saved';
}

/** Merges [next] into [existing] by step ref (a later wave of the same turn). */
function merge(existing: AgentOperation[], next: AgentOperation[]): AgentOperation[] {
  const byRef = new Map(existing.map((o) => [o.ref, o]));
  for (const o of next) byRef.set(o.ref, o);
  return [...byRef.values()].slice(0, 40);
}

function toRun(r: {
  id: string;
  request: string;
  status: string;
  summary: string;
  operations: unknown;
  notes: string[];
  created_at: Date | string;
  updated_at: Date | string;
}): AgentRun {
  return {
    id: r.id,
    request: r.request,
    status: r.status as AgentRunStatus,
    summary: r.summary,
    operations: (Array.isArray(r.operations) ? r.operations : []) as AgentOperation[],
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * Records (or updates) the history entry of one agent turn from the step
 * reports of a plan execution. Returns the stored entry.
 */
export async function recordAgentRun(user: AuthUser, input: AgentRunInput, reports: StepReport[]): Promise<AgentRun> {
  return withUserTx(
    user,
    async (tx) => {
      const existing = await tx
        .selectFrom('agent_runs')
        .select(['request', 'operations', 'notes'])
        .where('user_id', '=', user.userId)
        .where('id', '=', input.runId)
        .executeTakeFirst();
      const previous = existing && Array.isArray(existing.operations) ? (existing.operations as AgentOperation[]) : [];
      const operations = merge(previous, operationsFrom(reports, input.labels));
      const notes = [...new Set([...(existing?.notes ?? []), ...input.notes])].slice(0, 10);
      const values = {
        request: existing?.request ?? input.request,
        status: runStatus(operations),
        summary: runSummary(operations),
        operations: JSON.stringify(operations),
        notes,
      };
      const row = await tx
        .insertInto('agent_runs')
        .values({ user_id: user.userId, id: input.runId, ...values })
        .onConflict((oc) => oc.columns(['user_id', 'id']).doUpdateSet({ ...values, updated_at: sql`now()` }))
        .returning(['id', 'request', 'status', 'summary', 'operations', 'notes', 'created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      if (Math.random() < 0.02) {
        await sql`delete from public.agent_runs
                  where user_id = ${user.userId}
                    and created_at < now() - make_interval(days => ${AGENT_HISTORY_RETENTION_DAYS})`.execute(tx);
      }
      return toRun(row);
    },
    // Serialises with the user's other writes, so two retries of one turn
    // cannot both insert.
    { write: true },
  );
}

/** Records the turn without failing the plan call: its steps already committed. */
export async function recordAgentRunSafely(user: AuthUser, input: AgentRunInput, reports: StepReport[]): Promise<AgentRun | null> {
  try {
    return await recordAgentRun(user, input, reports);
  } catch (err) {
    logger.error('agent.history.write_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export const agentHistoryQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(20),
  before: z.string().regex(/^\d{1,18}$/).optional(),
  status: z.enum(['completed', 'partial', 'failed', 'declined']).optional(),
});

export type AgentHistoryQuery = z.infer<typeof agentHistoryQuerySchema>;

/** Newest first; `nextBefore` continues the list. */
export async function listAgentRuns(user: AuthUser, q: AgentHistoryQuery): Promise<{ items: AgentRun[]; nextBefore: string | null }> {
  return withUserTx(user, async (tx) => {
    let sel = tx
      .selectFrom('agent_runs')
      .select(['seq', 'id', 'request', 'status', 'summary', 'operations', 'notes', 'created_at', 'updated_at'])
      .where('user_id', '=', user.userId);
    if (q.status) sel = sel.where('status', '=', q.status);
    if (q.before) sel = sel.where('seq', '<', Number(q.before));
    const rows = await sel.orderBy('seq', 'desc').limit(q.limit + 1).execute();
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(toRun),
      nextBefore: rows.length > q.limit ? String(page[page.length - 1]!.seq) : null,
    };
  });
}

/** Deletes the user's whole agent history. */
export async function clearAgentRuns(user: AuthUser): Promise<{ deleted: number }> {
  return withUserTx(
    user,
    async (tx) => {
      const res = await tx.deleteFrom('agent_runs').where('user_id', '=', user.userId).executeTakeFirst();
      return { deleted: Number(res.numDeletedRows ?? 0) };
    },
    { write: true },
  );
}
