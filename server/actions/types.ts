// The action framework: every operation that changes financial records is a
// typed, validated, previewable action (mirrors lib/actions/action.dart in
// the Flutter app). HTTP endpoints, imports and a future agent all execute
// actions through the same dispatcher, so business rules exist exactly once.

import type { z } from 'zod';
import type { AuthUser } from '../auth/verify';
import type { IsoDate } from '../core/dates';
import type { Tx } from '../db/tx';
import type { FinanceSnapshot } from '../finance/snapshot';
import type { IdGenerator } from '../core/ids';

export const CHANNELS = ['ui', 'agent', 'voice', 'import', 'system'] as const;
export type Channel = (typeof CHANNELS)[number];

export type ActionRisk = 'low' | 'consequential';

export type FieldKind = 'string' | 'money' | 'date' | 'integer' | 'boolean' | 'enumeration' | 'id' | 'rate' | 'list' | 'object';

/** Machine-readable description of one input field, for discovery by clients and agents. */
export interface FieldSpec {
  name: string;
  kind: FieldKind;
  description: string;
  required: boolean;
  allowedValues?: readonly string[];
}

export interface ActionDescriptor {
  /** Stable identifier, e.g. `transactions.create`. */
  id: string;
  module: string;
  title: string;
  description: string;
  risk: ActionRisk;
  /** Whether execution records or changes a cash movement (never real money). */
  movesMoney: boolean;
  reversible: boolean;
  fields: FieldSpec[];
}

export interface PreviewLine {
  label: string;
  value: string;
  emphasis?: boolean;
}

/** Human-readable description of exactly what will happen. */
export interface ActionPreview {
  actionId: string;
  title: string;
  /** One sentence, e.g. "Record ₹12,602 EMI for Car loan". */
  summary: string;
  lines: PreviewLine[];
  warnings: string[];
  /**
   * Request fingerprint, optionally `.<hash>` of the record state the preview
   * was computed from. An approval is valid only for this exact input and state.
   */
  fingerprint: string;
  requiresConfirmation: boolean;
}

export interface PreviewSpec {
  title: string;
  summary: string;
  lines?: PreviewLine[];
  warnings?: string[];
  /** Small JSON description of the record state the preview depends on (e.g. version, outstanding). */
  basis?: unknown;
  requiresConfirmation?: boolean;
}

export interface FinnUser {
  id: string;
  name: string;
  handle: string;
  phoneHint: string | null;
}

/** Everything an action needs, independent of HTTP. */
export interface ActionContext {
  tx: Tx;
  user: AuthUser;
  userId: string;
  channel: Channel;
  today: IsoDate;
  now: Date;
  ids: IdGenerator;
  /** Fresh, lazily loaded view of the user's records inside this transaction. */
  snapshot: FinanceSnapshot;
  /** Record ids touched by execute (for the audit log). */
  touched: string[];
  /** Lock additional users' write locks (shared pending items). */
  lockUsers(userIds: string[]): Promise<void>;
}

export interface ActionDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  descriptor: ActionDescriptor;
  /** Decodes and validates untrusted JSON input (money as rupee strings/numbers, dates as yyyy-MM-dd). */
  input: S;
  /** Validates against current state and describes the effect. Must not write. */
  prepare(input: z.output<S>, ctx: ActionContext): Promise<PreviewSpec>;
  /** Performs the writes. Runs only after prepare succeeded in the same transaction. */
  execute(input: z.output<S>, ctx: ActionContext): Promise<O>;
  /**
   * Other users whose records this action may write (shared pending items).
   * The dispatcher locks them together with the caller, in one fixed order,
   * before anything else runs, so two people writing the same shared item
   * serialise instead of deadlocking. Read-only; runs before prepare.
   */
  extraLocks?(input: z.output<S>, scope: { tx: Tx; userId: string }): Promise<string[]>;
}

export function defineAction<S extends z.ZodType, O>(def: ActionDefinition<S, O>): ActionDefinition<S, O> {
  return def;
}

export type AnyAction = ActionDefinition<z.ZodType, unknown>;
