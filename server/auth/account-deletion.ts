// Permanent account deletion, confirmed with an emailed one-time code.
//
// 1. requestAccountDeletionCode: emails a 6-digit code to the account's
//    address (the address on record, not the one in the access token).
// 2. deleteAccount: checks the code and deletes the finn_auth.users row.
//    Every user_id foreign key cascades, so the profile, preferences, sessions
//    and all finance data go in the same transaction. Pending items shared
//    with other people are unlinked on their side and they get tombstones, so
//    their next sync drops the mirrored rows.
//
// Like the rest of finn_auth, this runs on the API's own connection (no user
// context): the field guards on shared items let maintenance changes through.

import { getDb } from '../db/client';
import { lockUsers } from '../db/tx';
import { AppFailure } from '../core/failure';
import { logger } from '../http/logger';
import { sendMail } from '../mail/mailer';
import { accountDeletionCodeEmail, noticeEmail } from '../mail/templates';
import { consumeCode, issueCode, limit, limiters, lockEmail, readCode, type CodeSent } from './service';

function accountGone(): AppFailure {
  return new AppFailure('unauthenticated', 'Your session has expired. Please sign in again.');
}

async function accountEmail(userId: string): Promise<string> {
  const row = await getDb().selectFrom('finn_auth.users').select('email').where('id', '=', userId).executeTakeFirst();
  if (!row) throw accountGone();
  return row.email;
}

export async function requestAccountDeletionCode(userId: string, ip: string, now = new Date()): Promise<CodeSent> {
  limit(limiters.otp, ip);
  const email = await accountEmail(userId);
  return issueCode(email, 'delete_account', (code, ttlMinutes) => accountDeletionCodeEmail(email, code, ttlMinutes), now);
}

export async function deleteAccount(userId: string, rawCode: unknown, ip: string, now = new Date()): Promise<{ deleted: true }> {
  const code = readCode(rawCode);
  limit(limiters.verify, ip);
  const email = await accountEmail(userId);

  // A wrong guess must be committed before failing, so the transaction
  // returns an outcome instead of throwing.
  const outcome = await getDb()
    .transaction()
    .execute(async (tx): Promise<'deleted' | 'invalid' | 'gone'> => {
      await lockEmail(tx, email);
      if (!(await consumeCode(tx, email, 'delete_account', code, now))) return 'invalid';
      // Wait for in-flight writes of this user and of everyone sharing items
      // with them, so their sync order stays consistent with commit order.
      const linked = await tx
        .selectFrom('pending_payments')
        .select(['user_id', 'shared_with_user_id'])
        .where((eb) => eb.or([eb('user_id', '=', userId), eb('shared_with_user_id', '=', userId)]))
        .where('shared_with_user_id', 'is not', null)
        .execute();
      const others = linked.flatMap((r) => [r.user_id, r.shared_with_user_id!]).filter((id) => id !== userId);
      await lockUsers(tx, [userId, ...others]);
      const deleted = await tx.deleteFrom('finn_auth.users').where('id', '=', userId).executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) return 'gone';
      await tx.deleteFrom('finn_auth.email_otps').where('email', '=', email).execute();
      return 'deleted';
    });

  if (outcome === 'gone') throw accountGone();
  // Not 'unauthenticated': the caller's session is fine, only the code is wrong.
  if (outcome === 'invalid') throw AppFailure.fields({ code: 'The code was invalid or has expired.' });
  logger.info('account.deleted', { userId });

  // Best effort: the account is already gone, so a mail failure must not fail the request.
  await sendMail(
    noticeEmail(email, 'Your FiNN account was deleted', [
      'Your FiNN account and all of its data have been permanently deleted.',
      'You can sign up again at any time with this email address. You will start with a new, empty account.',
    ]),
  ).catch((err) => logger.error('account.deleted.mail', { userId, error: err instanceof Error ? err.message : String(err) }));
  return { deleted: true };
}
