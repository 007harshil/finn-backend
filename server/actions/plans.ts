// Multi-step plans (lib/actions/action_plan.dart), e.g. a future agent's
// "pay Rahul 500 and add 2,000 to my Japan goal".
//
// Planning is separate from execution: `preparePlan` validates and previews
// every step without writing. `executePlan` runs only steps whose exact
// previews were approved, in order, skipping steps whose dependencies did not
// succeed. Each step commits on its own (no cross-step rollback); the report
// says exactly which steps ran, so a retry with the same planId only runs what
// is left (step idempotency key = `<planId>:<stepId>`).

import { z } from 'zod';
import type { AuthUser } from '../auth/verify';
import { AppFailure, type FailureBody } from '../core/failure';
import { fingerprintMatchesRequest, requestFingerprint } from '../core/fingerprint';
import { toFailure } from '../core/errors';
import { dispatch, previewAction } from './dispatcher';
import { getAction } from './registry';
import type { ActionPreview, Channel } from './types';

export const planSchema = z.object({
  planId: z.string().regex(/^[A-Za-z0-9._\-]{8,64}$/, 'Use 8-64 letters, digits, dot, dash or underscore'),
  channel: z.enum(['ui', 'agent', 'voice']).default('agent'),
  steps: z
    .array(
      z.object({
        stepId: z.string().regex(/^[A-Za-z0-9_\-]{1,32}$/),
        actionId: z.string().min(1).max(64),
        input: z.record(z.string(), z.unknown()),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(20),
});

export type Plan = z.infer<typeof planSchema>;

export type StepStatus = 'ready' | 'invalid' | 'succeeded' | 'failed' | 'skipped' | 'notApproved';

export interface StepReport {
  stepId: string;
  actionId: string;
  status: StepStatus;
  preview?: ActionPreview;
  failure?: FailureBody;
  result?: unknown;
  replayed?: boolean;
}

function validateGraph(plan: Plan): void {
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.stepId)) throw AppFailure.validation(`Duplicate step id "${step.stepId}".`);
    for (const dep of step.dependsOn) {
      if (!seen.has(dep)) throw AppFailure.validation(`Step "${step.stepId}" depends on "${dep}", which must come earlier.`);
    }
    seen.add(step.stepId);
  }
}

export async function preparePlan(user: AuthUser, plan: Plan): Promise<StepReport[]> {
  validateGraph(plan);
  const reports: StepReport[] = [];
  for (const step of plan.steps) {
    try {
      const preview = await previewAction(user, step.actionId, step.input, plan.channel as Channel);
      reports.push({ stepId: step.stepId, actionId: step.actionId, status: 'ready', preview });
    } catch (err) {
      reports.push({ stepId: step.stepId, actionId: step.actionId, status: 'invalid', failure: toFailure(err).toJSON() });
    }
  }
  return reports;
}

export async function executePlan(
  user: AuthUser,
  plan: Plan,
  approvedFingerprints: string[],
  stopOnFailure = true,
): Promise<StepReport[]> {
  validateGraph(plan);
  const reports: StepReport[] = [];
  const succeeded = new Set<string>();
  let halted = false;
  for (const step of plan.steps) {
    const base = { stepId: step.stepId, actionId: step.actionId };
    if (halted || step.dependsOn.some((d) => !succeeded.has(d))) {
      reports.push({ ...base, status: 'skipped' });
      continue;
    }
    let request: string;
    try {
      const action = getAction(step.actionId);
      const parsed = action.input.safeParse(step.input);
      if (!parsed.success) throw AppFailure.validation('Invalid input for this step.');
      request = requestFingerprint(step.actionId, parsed.data);
    } catch (err) {
      reports.push({ ...base, status: 'invalid', failure: toFailure(err).toJSON() });
      halted = stopOnFailure;
      continue;
    }
    const approved = approvedFingerprints.find((fp) => fingerprintMatchesRequest(fp, request));
    if (!approved) {
      reports.push({ ...base, status: 'notApproved' });
      continue;
    }
    try {
      const outcome = await dispatch(user, step.actionId, step.input, {
        idempotencyKey: `${plan.planId}:${step.stepId}`,
        confirmation: { fingerprint: approved, confirmedBy: `plan:${plan.planId}` },
        channel: plan.channel as Channel,
        includeChanges: false,
      });
      if (outcome.status === 'completed') {
        succeeded.add(step.stepId);
        reports.push({ ...base, status: 'succeeded', preview: outcome.preview, result: outcome.result, replayed: outcome.replayed });
      } else {
        // The record changed after approval: the preview no longer matches.
        reports.push({
          ...base,
          status: 'notApproved',
          preview: outcome.preview,
          failure: new AppFailure('staleData', 'Details changed since approval. Please review again.').toJSON(),
        });
        halted = stopOnFailure;
      }
    } catch (err) {
      reports.push({ ...base, status: 'failed', failure: toFailure(err).toJSON() });
      halted = stopOnFailure;
    }
  }
  return reports;
}
