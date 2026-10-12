// Discovery must be complete: every input key an action accepts is described
// (GET /api/v1/actions feeds clients and future agents), and nothing described
// is unknown to the input schema.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeActions, getAction } from '@/server/actions/registry';

function inputKeys(schema: z.ZodType): string[] | null {
  let s: unknown = schema;
  // Unwrap pipes/transforms/effects to the underlying object, if any.
  for (let i = 0; i < 10; i++) {
    const def = (s as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return null;
    if (def.type === 'object') return Object.keys(def.shape as Record<string, unknown>);
    s = def.in ?? def.innerType ?? def.schema;
    if (!s) return null;
  }
  return null;
}

describe('action descriptors', () => {
  it('describe exactly the fields each input schema accepts', () => {
    const problems: string[] = [];
    for (const d of describeActions()) {
      const keys = inputKeys(getAction(d.id).input);
      if (!keys) continue;
      const described = new Set(d.fields.map((f) => f.name));
      for (const k of keys) if (!described.has(k)) problems.push(`${d.id}: input "${k}" not described`);
      for (const f of described) if (!keys.includes(f)) problems.push(`${d.id}: described "${f}" not accepted`);
    }
    expect(problems).toEqual([]);
  });

  it('has 40 unique action ids', () => {
    const ids = describeActions().map((d) => d.id);
    expect(new Set(ids).size).toBe(40);
  });
});
