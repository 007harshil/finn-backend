// Structured server logs (one JSON line per event). Never log tokens,
// secrets, request bodies or amounts: callers pass identifiers and codes only,
// and sensitive-looking keys are redacted defensively.

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACT = /token|secret|password|authorization|cookie|key|amount|paise|note/i;

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? '[redacted]' : v;
  return out;
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.FINN_LOG_SILENT === '1') return;
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...clean(fields) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') write('debug', event, fields);
  },
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
