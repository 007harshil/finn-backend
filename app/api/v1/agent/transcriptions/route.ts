import { relayTranscription } from '@/server/agent/transcribe';
import { preflight, route } from '@/server/http/handler';

/**
 * POST /api/v1/agent/transcriptions
 * Speech-to-text relay for voice input: body is `{ audio (base64), mimeType,
 * language? }`, forwarded to Groq Whisper. Returns `{ text, language,
 * durationSeconds }`. The server adds the key and never stores or logs audio
 * or transcript text.
 */
export const POST = route(relayTranscription);

export const OPTIONS = preflight();

/** Seconds; above the relay's default 30 s upstream timeout (GROQ_STT_TIMEOUT_MS) so it fires first. */
export const maxDuration = 45;
