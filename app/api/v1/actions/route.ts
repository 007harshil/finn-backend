import { describeActions } from '@/server/actions/registry';
import { preflight, route } from '@/server/http/handler';

/** GET /api/v1/actions — every operation with its input fields, risk and confirmation needs. */
export const GET = route(async () => ({ actions: describeActions() }));

export const OPTIONS = preflight();
