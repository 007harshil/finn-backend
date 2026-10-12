// Agent speech-to-text relay (Groq Whisper): validation, multipart request
// shape, no-speech handling, error mapping and the separate rate limiter. The
// provider is a stubbed global fetch; every key here is fake.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as completionsRoute from '@/app/api/v1/agent/completions/route';
import * as sttRoute from '@/app/api/v1/agent/transcriptions/route';
import { resetAgentRateLimits } from '@/server/agent/rate-limit';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

const PATH = '/api/v1/agent/transcriptions';
const KEY = 'gsk_fake-test-key-123';
const AUDIO = Buffer.from('fake-audio-bytes-0123456789');
const AUDIO_B64 = AUDIO.toString('base64');

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
});
afterAll(async () => t.close());

beforeEach(() => {
  resetAgentRateLimits();
  vi.stubEnv('GROQ_API_KEY', KEY);
  vi.stubEnv('GROQ_BASE_URL', 'https://groq.test/openai/v1/');
  vi.stubEnv('GROQ_STT_MODEL', '');
  vi.stubEnv('GROQ_STT_LANGUAGE', '');
  vi.stubEnv('GROQ_STT_PROMPT', '');
  vi.stubEnv('GROQ_STT_TIMEOUT_MS', '30000');
  vi.stubEnv('AGENT_STT_RATE_LIMIT_PER_MINUTE', '50');
  vi.stubEnv('AGENT_STT_DAILY_LIMIT', '500');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const body = (extra: Record<string, unknown> = {}) => ({ audio: AUDIO_B64, mimeType: 'audio/m4a', ...extra });

const upstreamOk = {
  task: 'transcribe',
  language: 'english',
  duration: 3.4,
  text: '  Spent 250 rupees on Swiggy  ',
  segments: [{ id: 0, text: ' Spent 250 rupees on Swiggy', no_speech_prob: 0.01 }],
};

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => impl(String(input), init ?? {}));
}

describe('POST /agent/transcriptions', () => {
  it('requires authentication', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const res = await call(sttRoute.POST, 'POST', PATH, { body: body() });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is unavailable (not retryable) when no API key is configured', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'unavailable', retryable: false, details: { reason: 'notConfigured' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends multipart form data with defaults and returns the trimmed transcript', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    mockFetch(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(upstreamOk);
    });
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: 'Spent 250 rupees on Swiggy', language: 'english', durationSeconds: 3.4 });

    expect(seenUrl).toBe('https://groq.test/openai/v1/audio/transcriptions');
    expect(seenInit.method).toBe('POST');
    expect((seenInit.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const form = seenInit.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.has('language')).toBe(false);
    const prompt = String(form.get('prompt'));
    expect(prompt).toContain('UPI');
    expect(prompt).toContain('lakh');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.m4a');
    expect(file.type).toBe('audio/m4a');
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('uses env overrides and prefers the request language', async () => {
    vi.stubEnv('GROQ_STT_MODEL', 'whisper-large-v3-turbo');
    vi.stubEnv('GROQ_STT_LANGUAGE', 'hi');
    vi.stubEnv('GROQ_STT_PROMPT', 'custom hint');
    const forms: FormData[] = [];
    mockFetch(async (_url, init) => {
      forms.push(init.body as FormData);
      return jsonResponse(upstreamOk);
    });
    const u = await t.createUser();
    await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    await call(sttRoute.POST, 'POST', PATH, { user: u, body: body({ language: 'en' }) });
    expect(forms[0].get('model')).toBe('whisper-large-v3-turbo');
    expect(forms[0].get('language')).toBe('hi');
    expect(forms[0].get('prompt')).toBe('custom hint');
    expect(forms[1].get('language')).toBe('en');
  });

  it('names the file after the mime type', async () => {
    const seen: { name: string; type: string }[] = [];
    mockFetch(async (_url, init) => {
      const f = (init.body as FormData).get('file') as File;
      seen.push({ name: f.name, type: f.type });
      return jsonResponse(upstreamOk);
    });
    const u = await t.createUser();
    const mimes = ['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/flac'];
    for (const mimeType of mimes) {
      expect((await call(sttRoute.POST, 'POST', PATH, { user: u, body: body({ mimeType }) })).status).toBe(200);
    }
    expect(seen.map((s) => s.name)).toEqual(['audio.mp4', 'audio.m4a', 'audio.aac', 'audio.webm', 'audio.ogg', 'audio.wav', 'audio.mp3', 'audio.flac']);
    expect(seen.map((s) => s.type)).toEqual(mimes);
  });

  it('rejects invalid requests with validation failures and never calls the provider', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const u = await t.createUser();
    const bad: Record<string, unknown>[] = [
      {},
      body({ audio: '' }),
      body({ audio: '   ' }),
      body({ audio: 'not base64!!' }),
      body({ audio: 'abc' }),
      body({ mimeType: 'video/mp4' }),
      body({ mimeType: undefined }),
      body({ language: 'eng' }),
      body({ language: 'EN' }),
      body({ extra: 1 }),
    ];
    for (const b of bad) {
      const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: b });
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(422);
      expect(res.body.error?.code).toBe('validation');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects decoded audio over 10 MB but accepts exactly 10 MB', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const u = await t.createUser();
    const over = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64');
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body({ audio: over }) });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation', details: { reason: 'tooLarge' } });
    expect(fetchSpy).not.toHaveBeenCalled();

    const exact = Buffer.alloc(10 * 1024 * 1024, 1).toString('base64');
    const ok = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body({ audio: exact }) });
    expect(ok.status).toBe(200);
  });

  it('rejects a body over the byte cap', async () => {
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body({ audio: 'A'.repeat(15 * 1024 * 1024) }) });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('validation');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns empty text when every segment is no-speech', async () => {
    mockFetch(async () =>
      jsonResponse({
        language: 'english',
        duration: 2,
        text: ' Thank you. ',
        segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.7 }],
      }),
    );
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: '', language: 'english', durationSeconds: 2 });
  });

  it('keeps the text when at least one segment has speech', async () => {
    mockFetch(async () =>
      jsonResponse({ text: 'hello', segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.1 }] }),
    );
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.body.data).toEqual({ text: 'hello', language: null, durationSeconds: null });
  });

  it('returns empty text for an empty or whitespace transcript', async () => {
    mockFetch(async () => jsonResponse({ text: '   ', language: 'hindi', duration: 1, segments: [] }));
    const u = await t.createUser();
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: '', language: 'hindi', durationSeconds: 1 });
  });

  it('maps provider 429 to retryable providerRateLimited with retryAfterSeconds', async () => {
    const u = await t.createUser();
    mockFetch(async () => jsonResponse({ error: {} }, 429, { 'retry-after': '7' }));
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'unavailable', retryable: true, details: { reason: 'providerRateLimited', retryAfterSeconds: 7 } });
  });

  it('maps provider 401/403 to notConfigured', async () => {
    const u = await t.createUser();
    for (const status of [401, 403]) {
      vi.restoreAllMocks();
      mockFetch(async () => jsonResponse({ error: { message: 'bad key' } }, status));
      const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'unavailable', retryable: false, details: { reason: 'notConfigured' } });
      expect(JSON.stringify(res.body)).not.toContain('bad key');
    }
  });

  it('maps provider 413 to validation tooLarge', async () => {
    const u = await t.createUser();
    mockFetch(async () => jsonResponse({ error: {} }, 413));
    const res = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'validation', details: { reason: 'tooLarge' } });
  });

  it('maps provider 5xx, network errors and timeouts to retryable unavailable', async () => {
    const u = await t.createUser();
    mockFetch(async () => jsonResponse({ error: { message: 'boom' } }, 500));
    const r500 = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(r500.status).toBe(503);
    expect(r500.body.error).toMatchObject({ code: 'unavailable', retryable: true });

    vi.restoreAllMocks();
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const net = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(net.status).toBe(503);
    expect(net.body.error).toMatchObject({ retryable: true, details: { reason: 'network' } });

    vi.restoreAllMocks();
    vi.stubEnv('GROQ_STT_TIMEOUT_MS', '100');
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const slow = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(slow.status).toBe(503);
    expect(slow.body.error).toMatchObject({ code: 'unavailable', retryable: true, details: { reason: 'timeout' } });
  });

  it('treats a malformed provider body as a retryable unknown failure', async () => {
    const u = await t.createUser();
    mockFetch(async () => new Response('<html>oops</html>', { status: 200 }));
    const html = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(html.status).toBe(500);
    expect(html.body.error).toMatchObject({ code: 'unknown', retryable: true });

    vi.restoreAllMocks();
    mockFetch(async () => jsonResponse({ language: 'english' }));
    const noText = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(noText.status).toBe(500);
  });

  it('rate limits per user per minute, separately from completions', async () => {
    vi.stubEnv('AGENT_STT_RATE_LIMIT_PER_MINUTE', '2');
    const fetchSpy = mockFetch(async () => jsonResponse(upstreamOk));
    const a = await t.createUser();
    const b = await t.createUser();
    expect((await call(sttRoute.POST, 'POST', PATH, { user: a, body: body() })).status).toBe(200);
    expect((await call(sttRoute.POST, 'POST', PATH, { user: a, body: body() })).status).toBe(200);
    const limited = await call(sttRoute.POST, 'POST', PATH, { user: a, body: body() });
    expect(limited.status).toBe(503);
    expect(limited.body.error).toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: "You're sending requests too quickly. Please wait a moment.",
      details: { reason: 'rateLimited' },
    });
    const retry = (limited.body.error?.details as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    // Another user is unaffected.
    expect((await call(sttRoute.POST, 'POST', PATH, { user: b, body: body() })).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // The completions budget is independent.
    vi.stubEnv('GROQ_MODEL', 'test-model');
    mockFetch(async () => jsonResponse({ id: 'c', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] }));
    const completion = await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', {
      user: a,
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(completion.status).toBe(200);
  });

  it('enforces the daily limit', async () => {
    vi.stubEnv('AGENT_STT_DAILY_LIMIT', '1');
    mockFetch(async () => jsonResponse(upstreamOk));
    const u = await t.createUser();
    expect((await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() })).status).toBe(200);
    const limited = await call(sttRoute.POST, 'POST', PATH, { user: u, body: body() });
    expect(limited.status).toBe(503);
    expect(limited.body.error).toMatchObject({ details: { reason: 'rateLimited' } });
    expect((limited.body.error?.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(60);
  });

  it('answers CORS preflight and exports maxDuration 45', async () => {
    const res = await sttRoute.OPTIONS(new Request(`http://localhost${PATH}`, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(sttRoute.maxDuration).toBe(45);
  });
});
