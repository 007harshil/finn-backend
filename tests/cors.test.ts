// CORS origin matching (no database needed).

import { describe, expect, it } from 'vitest';
import { originAllowed } from '@/server/http/handler';

describe('originAllowed', () => {
  const list = 'https://app.finn.example, http://localhost:*, https://*.vercel.app';

  it('matches exact origins', () => {
    expect(originAllowed('https://app.finn.example', list)).toBe(true);
    expect(originAllowed('https://app.finn.example:8443', list)).toBe(false);
  });

  it('matches any localhost port', () => {
    expect(originAllowed('http://localhost:64698', list)).toBe(true);
    expect(originAllowed('http://localhost', list)).toBe(false);
    expect(originAllowed('http://localhost.evil.com:80', list)).toBe(false);
    expect(originAllowed('https://localhost:64698', list)).toBe(false);
  });

  it('wildcard covers one subdomain label only', () => {
    expect(originAllowed('https://finn-web.vercel.app', list)).toBe(true);
    expect(originAllowed('https://a.b.vercel.app', list)).toBe(false);
    expect(originAllowed('https://vercel.app.evil.com', list)).toBe(false);
  });

  it('allows nothing when empty', () => {
    expect(originAllowed('http://localhost:64698', '')).toBe(false);
  });
});
