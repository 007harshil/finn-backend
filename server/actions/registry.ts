// Every registered operation (lib/app/di/action_catalog.dart). Discovery
// (GET /api/v1/actions) publishes the descriptors so clients and a future
// agent can build valid input.

import { AppFailure } from '../core/failure';
import { assetsActions } from '../modules/assets/actions';
import { budgetsActions } from '../modules/budgets/actions';
import { categoriesActions } from '../modules/categories/actions';
import { emergencyFundActions } from '../modules/emergency-fund/actions';
import { goalsActions } from '../modules/goals/actions';
import { loansActions } from '../modules/loans/actions';
import { pendingActions } from '../modules/pending/actions';
import { profileActions } from '../modules/account/actions';
import { subscriptionsActions } from '../modules/subscriptions/actions';
import { transactionsActions } from '../modules/transactions/actions';
import type { ActionDescriptor, AnyAction } from './types';

const all: AnyAction[] = [
  ...transactionsActions,
  ...categoriesActions,
  ...budgetsActions,
  ...pendingActions,
  ...loansActions,
  ...subscriptionsActions,
  ...goalsActions,
  ...emergencyFundActions,
  ...assetsActions,
  ...profileActions,
];

const byId = new Map<string, AnyAction>();
for (const a of all) {
  if (byId.has(a.descriptor.id)) throw new Error(`Duplicate action id ${a.descriptor.id}`);
  byId.set(a.descriptor.id, a);
}

export function getAction(id: string): AnyAction {
  const action = byId.get(id);
  if (!action) throw AppFailure.notFound(`Unknown operation "${id.slice(0, 64)}".`);
  return action;
}

export function hasAction(id: string): boolean {
  return byId.has(id);
}

export function describeActions(): ActionDescriptor[] {
  return all.map((a) => a.descriptor);
}
