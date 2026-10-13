import { preflight, route } from '@/server/http/handler';
import { clientIp } from '@/server/auth/service';
import { requestAccountDeletionCode } from '@/server/auth/account-deletion';

/** POST /api/v1/me/delete/code -> { sent, expiresInSeconds, resendAfterSeconds }. Emails a code that confirms account deletion. */
export const POST = route(async (ctx) => requestAccountDeletionCode(ctx.user.userId, clientIp(ctx.request)));

export const OPTIONS = preflight();
