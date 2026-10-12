// Agent speech-to-text relay: forwards short voice recordings from the app to
// Groq Whisper with the server-held key and returns the transcript.
//
// Privacy: audio and transcript text are never logged. Logs carry only the
// request id, a hashed user id, upstream status, latency and sizes. The API
// key and raw upstream bodies never reach the client.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppFailure } from '../core/failure';
import { agentEnv } from '../env';
import { parseWith, readJson, type RequestContext } from '../http/handler';
import { logger } from '../http/logger';
import { takeTranscriptionRequest } from './rate-limit';

/** Decoded audio ceiling. */
export const STT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** Request body cap: 10 MB of audio is ~13.4 MB of base64, plus JSON overhead. */
export const STT_MAX_BODY_BYTES = 14 * 1024 * 1024;
/** Segments above this no_speech_prob count as silence. */
const NO_SPEECH_THRESHOLD = 0.6;

const EXTENSIONS = {
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
} as const;

type SttMime = keyof typeof EXTENSIONS;
const MIME_TYPES = Object.keys(EXTENSIONS) as [SttMime, ...SttMime[]];

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const transcriptionRequestSchema = z.strictObject({
  audio: z.string().min(1, 'Audio is required.'),
  mimeType: z.enum(MIME_TYPES),
  language: z
    .string()
    .regex(/^[a-z]{2}$/, 'Use a 2-letter ISO-639-1 language code.')
    .optional(),
});

export interface TranscriptionResult {
  text: string;
  language: string | null;
  durationSeconds: number | null;
}

const UNAVAILABLE = 'Voice input is unavailable right now. Please try again.';
const MALFORMED = 'Voice input returned an unexpected response. Please try again.';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) seconds = Math.ceil(Number(trimmed));
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(3600, Math.max(1, seconds));
}

/** Strict base64 decode; throws a validation failure for bad, empty or oversized audio. */
function decodeAudio(b64: string): Buffer {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length === 0) throw AppFailure.validation('Audio is required.');
  if (clean.length % 4 !== 0 || !BASE64.test(clean)) throw AppFailure.validation('The audio is not valid base64.');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  if ((clean.length / 4) * 3 - padding > STT_MAX_AUDIO_BYTES) {
    throw new AppFailure('validation', 'This recording is too large. Keep it under 10 MB.', { details: { reason: 'tooLarge' } });
  }
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length === 0) throw AppFailure.validation('Audio is required.');
  return bytes;
}

/** Trims Groq's verbose_json to the app contract; null when the payload is not usable. */
function toResult(payload: unknown): TranscriptionResult | null {
  if (!isRecord(payload) || typeof payload.text !== 'string') return null;
  const text = payload.text.trim();
  const segments = Array.isArray(payload.segments) ? payload.segments.filter(isRecord) : [];
  const silent = segments.length > 0 && segments.every((s) => (num(s.no_speech_prob) ?? 0) > NO_SPEECH_THRESHOLD);
  return {
    text: silent ? '' : text,
    language: typeof payload.language === 'string' && payload.language ? payload.language : null,
    durationSeconds: num(payload.duration) ?? null,
  };
}

/** Handles POST /api/v1/agent/transcriptions for an authenticated user. */
export async function relayTranscription(ctx: RequestContext): Promise<TranscriptionResult> {
  const config = agentEnv();
  if (!config.GROQ_API_KEY) {
    throw new AppFailure('unavailable', 'Voice input is not configured on this server.', {
      retryable: false,
      details: { reason: 'notConfigured' },
    });
  }

  const req = parseWith(transcriptionRequestSchema, await readJson(ctx.request, STT_MAX_BODY_BYTES));
  const audio = decodeAudio(req.audio);

  const decision = takeTranscriptionRequest(ctx.user.userId, {
    perMinute: config.AGENT_STT_RATE_LIMIT_PER_MINUTE,
    perDay: config.AGENT_STT_DAILY_LIMIT,
  });
  if (!decision.allowed) {
    throw new AppFailure('unavailable', "You're sending requests too quickly. Please wait a moment.", {
      retryable: true,
      details: { reason: 'rateLimited', retryAfterSeconds: decision.retryAfterSeconds },
    });
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: req.mimeType }), `audio.${EXTENSIONS[req.mimeType]}`);
  form.append('model', config.GROQ_STT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const language = req.language ?? config.GROQ_STT_LANGUAGE;
  if (language) form.append('language', language);
  if (config.GROQ_STT_PROMPT) form.append('prompt', config.GROQ_STT_PROMPT);

  const user = sha256Hex(ctx.user.userId).slice(0, 12);
  const started = Date.now();
  const timeout = AbortSignal.timeout(config.GROQ_STT_TIMEOUT_MS);
  // Also stop paying for the call if the app disconnects.
  const signal = ctx.request.signal ? AbortSignal.any([timeout, ctx.request.signal]) : timeout;

  let res: Response;
  try {
    // No content-type header: fetch sets the multipart boundary itself.
    res = await fetch(`${config.GROQ_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.GROQ_API_KEY}` },
      body: form,
      signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, outcome: reason, ms: Date.now() - started });
    throw new AppFailure('unavailable', UNAVAILABLE, { retryable: true, details: { reason } });
  }

  const ms = Date.now() - started;
  const upstreamStatus = res.status;

  if (!res.ok) {
    // Error bodies are never read, logged or returned.
    await res.body?.cancel().catch(() => undefined);

    if (upstreamStatus === 429 || upstreamStatus === 498) {
      const retry = retryAfterSeconds(res.headers.get('retry-after'));
      logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('unavailable', UNAVAILABLE, {
        retryable: true,
        details: { reason: 'providerRateLimited', ...(retry !== undefined ? { retryAfterSeconds: retry } : {}) },
      });
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      logger.error('agent.stt.upstream.auth', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('unavailable', 'Voice input is not configured correctly on this server.', {
        retryable: false,
        details: { reason: 'notConfigured' },
      });
    }
    if (upstreamStatus === 413) {
      logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('validation', 'This recording is too large. Keep it shorter.', { details: { reason: 'tooLarge' } });
    }
    if (upstreamStatus >= 500) {
      logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('unavailable', UNAVAILABLE, { retryable: true });
    }
    logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
    throw new AppFailure('unknown', 'Voice input could not process this recording.', { details: { upstreamStatus } });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    payload = null;
  }
  const result = toResult(payload);
  if (!result) {
    logger.warn('agent.stt.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms, outcome: 'malformed' });
    throw new AppFailure('unknown', MALFORMED, { retryable: true });
  }

  logger.info('agent.stt.upstream', {
    requestId: ctx.requestId,
    user,
    upstreamStatus,
    ms,
    audioBytes: audio.length,
    empty: result.text === '',
  });
  return result;
}
