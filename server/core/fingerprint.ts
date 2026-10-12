// Request and preview fingerprints (lib/actions/action.dart): 64-bit FNV-1a
// over canonical JSON (object keys sorted). Same algorithm as the Flutter app,
// so fingerprints are stable across clients.

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

const MASK = (1n << 64n) - 1n;
const PRIME = 0x100000001b3n;
const OFFSET = 0xcbf29ce484222325n;

/** 64-bit FNV-1a as lowercase hex without leading zeros. */
export function fnv1a64(text: string): string {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16);
}

/** Identifies a request: action id + canonical input (used for idempotency). */
export function requestFingerprint(actionId: string, input: unknown): string {
  return fnv1a64(JSON.stringify(canonical({ action: actionId, input })));
}

/** Request fingerprint plus `.<hash>` of the record state the preview depends on. */
export function previewFingerprint(actionId: string, input: unknown, basis?: unknown): string {
  const request = requestFingerprint(actionId, input);
  if (basis === undefined || basis === null) return request;
  return `${request}.${fnv1a64(JSON.stringify(canonical(basis)))}`;
}

export function fingerprintMatchesRequest(preview: string, request: string): boolean {
  return preview === request || preview.startsWith(`${request}.`);
}
