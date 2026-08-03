/**
 * Speech-to-text via a cloud transcription model (Whisper-class).
 *
 * The chat LLM providers (Anthropic, DeepSeek, GLM, Kimi) have NO audio API, so voice input needs its own
 * transcription service + key. OpenAI and Groq both expose the identical OpenAI `/audio/transcriptions`
 * multipart endpoint, so one implementation covers both — pick a preset in Settings → Voice input.
 *
 * Default: Groq whisper-large-v3-turbo — free tier, extremely fast, near-best accuracy.
 */

import * as SecureStore from 'expo-secure-store';

const SK_ENABLED = 'stt_enabled_v1';
const SK_BASEURL = 'stt_baseurl_v1';
const SK_APIKEY  = 'stt_apikey_v1';
const SK_MODEL   = 'stt_model_v1';

export interface TranscriptionConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey:  string;
  model:   string;
}

export interface SttPreset {
  id:       string;
  label:    string;
  baseUrl:  string;
  model:    string;
  keyHint:  string;
  getKey:   string;   // where to create a key
}

export const STT_PRESETS: SttPreset[] = [
  { id: 'groq-turbo', label: 'Groq · whisper-large-v3-turbo', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyHint: 'gsk_…', getKey: 'console.groq.com/keys' },
  { id: 'groq-v3',    label: 'Groq · whisper-large-v3',       baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3',       keyHint: 'gsk_…', getKey: 'console.groq.com/keys' },
  { id: 'openai-4o',  label: 'OpenAI · gpt-4o-transcribe',    baseUrl: 'https://api.openai.com/v1',      model: 'gpt-4o-transcribe',      keyHint: 'sk-…',  getKey: 'platform.openai.com/api-keys' },
  { id: 'openai-w1',  label: 'OpenAI · whisper-1',            baseUrl: 'https://api.openai.com/v1',      model: 'whisper-1',              keyHint: 'sk-…',  getKey: 'platform.openai.com/api-keys' },
];

export const DEFAULT_STT = STT_PRESETS[0];

/** The preset that matches a stored (baseUrl, model), for showing the current selection. */
export function matchPreset(baseUrl: string, model: string): SttPreset | null {
  return STT_PRESETS.find(p => p.baseUrl === baseUrl && p.model === model) ?? null;
}

export async function loadTranscriptionConfig(): Promise<TranscriptionConfig> {
  const [enabled, baseUrl, apiKey, model] = await Promise.all([
    SecureStore.getItemAsync(SK_ENABLED),
    SecureStore.getItemAsync(SK_BASEURL),
    SecureStore.getItemAsync(SK_APIKEY),
    SecureStore.getItemAsync(SK_MODEL),
  ]);
  return {
    enabled: enabled === '1',
    baseUrl: baseUrl || DEFAULT_STT.baseUrl,
    apiKey:  apiKey  || '',
    model:   model   || DEFAULT_STT.model,
  };
}

export async function saveTranscriptionConfig(fields: Partial<TranscriptionConfig>): Promise<void> {
  if (fields.enabled !== undefined) await SecureStore.setItemAsync(SK_ENABLED, fields.enabled ? '1' : '0');
  if (fields.baseUrl !== undefined) await SecureStore.setItemAsync(SK_BASEURL, fields.baseUrl.trim());
  if (fields.apiKey  !== undefined) await SecureStore.setItemAsync(SK_APIKEY, fields.apiKey.trim());
  if (fields.model   !== undefined) await SecureStore.setItemAsync(SK_MODEL, fields.model.trim());
}

export async function deleteTranscriptionKey(): Promise<void> {
  await SecureStore.deleteItemAsync(SK_APIKEY);
}

/** Voice input is usable right now: enabled AND a key + endpoint are configured. */
export async function transcriptionReady(): Promise<boolean> {
  const c = await loadTranscriptionConfig();
  return c.enabled && !!c.apiKey && !!c.baseUrl && !!c.model;
}

/**
 * Send a recorded audio file to the configured OpenAI-compatible /audio/transcriptions endpoint.
 * Returns the transcript text. Throws on auth / rate-limit / empty-speech.
 */
export async function transcribeAudio(
  fileUri: string,
  opts?: { mimeType?: string; fileName?: string; language?: string },
): Promise<string> {
  const cfg = await loadTranscriptionConfig();
  if (!cfg.apiKey) throw new Error('No transcription key — add one in Settings → Voice input.');
  const base = cfg.baseUrl.replace(/\/+$/, '');

  const form = new FormData();
  // React Native FormData accepts a { uri, name, type } file part.
  form.append('file', { uri: fileUri, name: opts?.fileName ?? 'speech.m4a', type: opts?.mimeType ?? 'audio/m4a' } as any);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (opts?.language) form.append('language', opts.language);

  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    // Do NOT set Content-Type — RN must add the multipart boundary itself.
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    let body: any = {}; try { body = await res.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (res.status === 401) throw new Error('Transcription key rejected (401). Check Settings → Voice input.');
    if (res.status === 429) throw new Error('Transcription rate-limited — wait a moment and try again.');
    throw new Error(`Transcription error ${res.status}: ${msg || JSON.stringify(body).slice(0, 150)}`);
  }
  const data = await res.json();
  const text = String(data?.text ?? '').trim();
  if (!text) throw new Error('No speech detected — try again, closer to the mic.');
  return text;
}
