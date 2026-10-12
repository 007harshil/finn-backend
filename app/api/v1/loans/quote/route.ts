import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { quote, quoteBody } from '@/server/modules/loans/api';

/**
 * POST /api/v1/loans/quote  body = loan terms (LoanInput JSON)
 * Live estimate for the loan form: {quote: {installmentPaise, installments, totalInterestPaise, ...} | null, schedule}. Writes nothing.
 */
export const POST = route(async (ctx) => {
  const body = parseWith(quoteBody, await readJson(ctx.request));
  return withUserTx(ctx.user, async (tx) => quote(body, (await createContext(tx, ctx.user, 'ui')).today));
});

export const OPTIONS = preflight();
