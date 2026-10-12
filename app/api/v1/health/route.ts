import { publicRoute } from '@/server/http/handler';

/** Liveness probe. Does not touch the database. */
export const GET = publicRoute(async () => ({ status: 'ok' }));
