/**
 * Provider-agnostic LLM service
 *
 * Two wire formats, several providers each:
 *   • messages-format — the Messages API (`POST {base}/v1/messages`). Spoken natively by Anthropic (Claude)
 *     and by the compatible endpoints DeepSeek, GLM (Z.ai) and Kimi (Moonshot) expose. These all speak
 *     the same request/response shape INCLUDING tool_use/tool_result, so the agentic coach loop works on
 *     every one of them.
 *   • openai-format — OpenAI Chat Completions (`POST {base}/chat/completions`). Native OpenAI plus any
 *     OpenAI-compatible endpoint (Groq, Mistral, Ollama, LM Studio, …) via the 'custom' provider.
 *
 * Config is stored per-provider in the iOS Keychain via expo-secure-store.
 * On first load, the old `anthropic_api_key` is migrated automatically.
 */

import { recordUsage } from './tokenUsage';
import * as SecureStore from 'expo-secure-store';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'deepseek' | 'glm' | 'kimi' | 'openai' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  model:    string;
  apiKey:   string;
  baseUrl?: string; // only used for 'custom'
}

export interface LLMValidationResult {
  valid:    boolean;
  error?:   string;
  warning?: string;
}

// ─── Provider registry ────────────────────────────────────────────────────────
// One row per provider drives everything: which wire format, base URL, how to authenticate, default/
// suggested models, and whether it supports the native agentic tool loop. Add a provider by adding a row.

export type ApiFlavor = 'messages' | 'openai';
export type AuthStyle = 'x-api-key' | 'bearer' | 'both';

export interface ProviderSpec {
  id:              LLMProvider;
  label:           string;
  api:             ApiFlavor;
  baseUrl:         string | null;   // null → user supplies it ('custom')
  auth:            AuthStyle;        // 'both' sends x-api-key AND Authorization: Bearer (safe for proxies)
  keyPlaceholder:  string;
  defaultModel:    string;
  suggestedModels: string[];
  agentic:         boolean;         // supports the native tool loop (⇒ api === 'messages')
  liveModels:      boolean;         // provider implements a listable /models (or /v1/models) endpoint
  hint?:           string;          // shown under the field in Settings
}

export const PROVIDERS: Record<LLMProvider, ProviderSpec> = {
  anthropic: {
    id: 'anthropic', label: 'Anthropic', api: 'messages',
    baseUrl: 'https://api.anthropic.com', auth: 'x-api-key',
    keyPlaceholder: 'sk-ant-api03-…', defaultModel: 'claude-sonnet-4-6',
    suggestedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-5'],
    agentic: true, liveModels: true,
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', api: 'messages',
    baseUrl: 'https://api.deepseek.com/anthropic', auth: 'both',
    keyPlaceholder: 'sk-… (DeepSeek key)', defaultModel: 'deepseek-v4-flash',
    suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    agentic: true, liveModels: false,
    hint: 'DeepSeek — supports the agentic coach (tools).',
  },
  glm: {
    id: 'glm', label: 'GLM · Z.ai', api: 'messages',
    baseUrl: 'https://api.z.ai/api/anthropic', auth: 'both',
    keyPlaceholder: 'Z.ai API key', defaultModel: 'glm-4.6',
    suggestedModels: ['glm-4.6', 'glm-4.7', 'glm-4.5-air'],
    agentic: true, liveModels: false,
    hint: 'Zhipu GLM — supports the agentic coach (tools).',
  },
  kimi: {
    id: 'kimi', label: 'Kimi · Moonshot', api: 'messages',
    baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'both',
    keyPlaceholder: 'Moonshot API key', defaultModel: 'kimi-k2-turbo-preview',
    suggestedModels: ['kimi-k2-turbo-preview', 'kimi-k2-0711-preview', 'kimi-latest'],
    agentic: true, liveModels: false,
    hint: 'Moonshot Kimi — supports the agentic coach (tools).',
  },
  openai: {
    id: 'openai', label: 'OpenAI', api: 'openai',
    baseUrl: 'https://api.openai.com/v1', auth: 'bearer',
    keyPlaceholder: 'sk-proj-…', defaultModel: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    agentic: false, liveModels: true,
  },
  custom: {
    id: 'custom', label: 'Custom · OpenAI-compatible', api: 'openai',
    baseUrl: null, auth: 'bearer',
    keyPlaceholder: 'API key', defaultModel: '',
    suggestedModels: [],
    agentic: false, liveModels: true,
    hint: 'Any OpenAI-compatible endpoint (Groq, Mistral, Ollama, LM Studio, …).',
  },
};

/** Display order in the Settings provider picker. */
export const PROVIDER_ORDER: LLMProvider[] = ['anthropic', 'deepseek', 'glm', 'kimi', 'openai', 'custom'];

export function providerSpec(p: LLMProvider): ProviderSpec {
  return PROVIDERS[p] ?? PROVIDERS.anthropic;
}

/** Human label for the CURRENTLY-configured provider + model, e.g. "DeepSeek · deepseek-v4-flash".
 *  Use this for any user-facing "which model produced this" readout instead of a hard-coded model id. */
export async function activeModelLabel(): Promise<string> {
  const cfg = await loadLLMConfig();
  const label = providerSpec(cfg.provider).label;
  return cfg.model ? `${label} · ${cfg.model}` : label;
}

// Back-compat derived maps (still imported around the app).
export const PROVIDER_LABELS         = Object.fromEntries(PROVIDER_ORDER.map(p => [p, PROVIDERS[p].label]))          as Record<LLMProvider, string>;
export const PROVIDER_KEY_PLACEHOLDER = Object.fromEntries(PROVIDER_ORDER.map(p => [p, PROVIDERS[p].keyPlaceholder])) as Record<LLMProvider, string>;
export const DEFAULT_MODELS          = Object.fromEntries(PROVIDER_ORDER.map(p => [p, PROVIDERS[p].defaultModel]))    as Record<LLMProvider, string>;
export const SUGGESTED_MODELS        = Object.fromEntries(PROVIDER_ORDER.map(p => [p, PROVIDERS[p].suggestedModels])) as Record<LLMProvider, string[]>;

// ─── SecureStore keys ─────────────────────────────────────────────────────────

const SK_PROVIDER     = 'llm_provider_v1';
const SK_MODEL        = (p: LLMProvider) => `llm_model_${p}_v1`;
const SK_APIKEY       = (p: LLMProvider) => `llm_apikey_${p}_v1`;
const SK_BASEURL      = 'llm_baseurl_custom_v1';
const SK_HISTORY      = (p: LLMProvider) => `llm_model_history_${p}_v1`;
const SK_MODEL_LIST   = (p: LLMProvider) => `llm_model_list_${p}_v1`;   // live list fetched from /models
const SK_OLD_ANTHRO   = 'anthropic_api_key'; // legacy key — migrated on first load

// ─── Request helpers ──────────────────────────────────────────────────────────

/** Auth + version headers for a messages-format request. 'both' covers proxies that want either. */
function messagesHeaders(spec: ProviderSpec, key: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (spec.auth === 'x-api-key' || spec.auth === 'both') h['x-api-key'] = key;
  if (spec.auth === 'bearer'    || spec.auth === 'both') h['Authorization'] = `Bearer ${key}`;
  return h;
}

/** Build the `system` field. Native Anthropic gets a cached block (10% input billing on repeat); the
 *  third-party messages-format proxies may reject the unknown `cache_control`, so they get a plain
 *  string (still a valid Messages shape). */
function systemField(spec: ProviderSpec, system?: string): any {
  if (!system) return undefined;
  return spec.id === 'anthropic'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;
}

/** Resolve the OpenAI-format base URL (fixed for 'openai', user-supplied for 'custom'). */
function openaiBase(spec: ProviderSpec, cfgBaseUrl?: string): string {
  return (spec.baseUrl ?? cfgBaseUrl ?? '').replace(/\/+$/, '');
}

// ─── Defaults (legacy export shape kept above) ─────────────────────────────────

// ─── Config load / save ───────────────────────────────────────────────────────

/** Load the active LLM config. Migrates the old Anthropic key on first run. */
export async function loadLLMConfig(): Promise<LLMConfig> {
  // Migrate legacy key if new slot is still empty
  try {
    const oldKey = await SecureStore.getItemAsync(SK_OLD_ANTHRO);
    const newKey = await SecureStore.getItemAsync(SK_APIKEY('anthropic'));
    if (oldKey && !newKey) {
      await SecureStore.setItemAsync(SK_APIKEY('anthropic'), oldKey);
    }
    // One-shot migration: clear the legacy slot so a later "delete key" is FINAL — leaving it in place
    // resurrected a deleted key on every config load.
    if (oldKey) await SecureStore.deleteItemAsync(SK_OLD_ANTHRO);
  } catch {}

  // Sanitize the stored provider: a backup restored onto an OLDER build (or any version skew) can carry a
  // provider this build doesn't know (e.g. 'deepseek' on a build that predates it). Fall back instead of
  // letting an undefined spec crash every consumer.
  const storedProvider = (await SecureStore.getItemAsync(SK_PROVIDER)) as LLMProvider | null;
  const provider: LLMProvider = storedProvider && PROVIDERS[storedProvider] ? storedProvider : 'anthropic';
  const model    = (await SecureStore.getItemAsync(SK_MODEL(provider))) ?? DEFAULT_MODELS[provider];
  const apiKey   = (await SecureStore.getItemAsync(SK_APIKEY(provider))) ?? '';
  const baseUrl  = provider === 'custom'
    ? ((await SecureStore.getItemAsync(SK_BASEURL)) ?? '')
    : undefined;

  return { provider, model, apiKey, baseUrl };
}

/** Save (partial) config changes. Only writes fields that are provided. */
export async function saveLLMConfig(
  provider: LLMProvider,
  fields: { model?: string; apiKey?: string; baseUrl?: string },
): Promise<void> {
  await SecureStore.setItemAsync(SK_PROVIDER, provider);
  if (fields.model !== undefined) {
    await SecureStore.setItemAsync(SK_MODEL(provider), fields.model.trim());
    await addToModelHistory(provider, fields.model.trim());
  }
  if (fields.apiKey !== undefined) {
    await SecureStore.setItemAsync(SK_APIKEY(provider), fields.apiKey.trim());
  }
  if (fields.baseUrl !== undefined && provider === 'custom') {
    await SecureStore.setItemAsync(SK_BASEURL, fields.baseUrl.trim());
  }
}

/** Remove the stored API key for a provider. */
export async function deleteLLMApiKey(provider: LLMProvider): Promise<void> {
  await SecureStore.deleteItemAsync(SK_APIKEY(provider));
  // The pre-provider slot too, or the migration in loadLLMConfig brings the key back from the dead.
  if (provider === 'anthropic') await SecureStore.deleteItemAsync(SK_OLD_ANTHRO);
}

/** Get just the active API key (used as a quick existence check). */
export async function getActiveApiKey(): Promise<string | null> {
  const cfg = await loadLLMConfig();
  return cfg.apiKey || null;
}

// ─── LLM reachability (keyless mode + greying LLM-only buttons) ────────────────
// '1' = the last real call/validation succeeded, '0' = it failed (bad key, auth, quota),
// unset = untested. The daily-plan path probes the LLM and updates this, so the UI can grey
// out LLM-only actions (chat, report, run analysis, enhance) when the key is missing OR broken.
const SK_REACHABLE = 'llm_reachable_v1';

export async function recordLLMReachable(ok: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(SK_REACHABLE, ok ? '1' : '0'); } catch {}
}

export interface LLMStatus {
  hasKey:    boolean;  // a usable key (and base URL for custom) is configured
  reachable: boolean;  // the LLM actually works (optimistic until a call proves otherwise)
}

/** Whether the LLM can be used right now: a key is set AND the last call/validation didn't fail. */
export async function getLLMStatus(): Promise<LLMStatus> {
  const cfg = await loadLLMConfig();
  const hasKey = !!cfg.apiKey && (cfg.provider !== 'custom' || !!cfg.baseUrl);
  if (!hasKey) return { hasKey: false, reachable: false };
  let flag: string | null = null;
  try { flag = await SecureStore.getItemAsync(SK_REACHABLE); } catch {}
  return { hasKey: true, reachable: flag !== '0' }; // unset/'1' → reachable; '0' → known-broken
}

// ─── Model history ────────────────────────────────────────────────────────────

export async function loadModelHistory(provider: LLMProvider): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(SK_HISTORY(provider));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

export async function addToModelHistory(provider: LLMProvider, model: string): Promise<void> {
  if (!model.trim()) return;
  const history = (await loadModelHistory(provider)).filter(m => m !== model);
  history.unshift(model);
  await SecureStore.setItemAsync(SK_HISTORY(provider), JSON.stringify(history.slice(0, 8)));
}

// ─── Validation ───────────────────────────────────────────────────────────────

export async function validateLLMKey(
  provider: LLMProvider, apiKey: string, baseUrl?: string,
): Promise<LLMValidationResult> {
  const result = await validateLLMKeyImpl(provider, apiKey, baseUrl);
  // Record reachability so LLM-only buttons grey out the moment a key is saved-but-broken.
  await recordLLMReachable(result.valid).catch(() => {});
  return result;
}

async function validateLLMKeyImpl(
  provider: LLMProvider,
  apiKey:   string,
  baseUrl?: string,
): Promise<LLMValidationResult> {
  const key  = apiKey.trim();
  const spec = providerSpec(provider);
  if (!key) return { valid: false, error: 'API key cannot be empty.' };

  try {
    if (spec.api === 'messages') {
      if (spec.id === 'anthropic') {
        if (!key.startsWith('sk-ant-')) return { valid: false, error: 'Anthropic keys start with "sk-ant-".' };
        const res = await fetch(`${spec.baseUrl}/v1/models`, { method: 'GET', headers: messagesHeaders(spec, key) });
        if (res.status === 401) return { valid: false, error: 'Key rejected (401). Check console.anthropic.com.' };
        if (res.status === 403) return { valid: false, error: 'Key has no permissions (403).' };
        return { valid: true };
      }
      // Third-party messages-format endpoints don't reliably expose /v1/models — do a 1-token
      // messages ping instead, which genuinely verifies the endpoint + auth. A model-not-found (400)
      // still proves the KEY works, so only 401/403 is a hard failure.
      const res = await fetch(`${spec.baseUrl}/v1/messages`, {
        method: 'POST', headers: messagesHeaders(spec, key),
        body: JSON.stringify({ model: spec.defaultModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      if (res.status === 401 || res.status === 403) return { valid: false, error: `Key rejected (${res.status}).` };
      return { valid: true };
    }

    // openai-format
    if (spec.id === 'custom') {
      const base = (baseUrl ?? '').replace(/\/+$/, '');
      if (!base) return { valid: false, error: 'Base URL is required for custom providers.' };
      try {
        const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (res.status === 401) return { valid: false, error: 'Key rejected (401).' };
        return { valid: true }; // some providers don't implement /models — anything but 401 is OK
      } catch {
        return { valid: true, warning: 'Could not verify key (no /models endpoint). Saved anyway.' };
      }
    }
    // native OpenAI
    const res = await fetch(`${spec.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 401) return { valid: false, error: 'Key rejected (401). Check platform.openai.com.' };
    if (res.status === 403) return { valid: false, error: 'Key has no permissions (403).' };
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: `Network error: ${e?.message ?? String(e)}` };
  }
}

// ─── Unified LLM call ─────────────────────────────────────────────────────────

export interface LLMCallOptions {
  system?:   string;
  messages:  { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  temperature?: number; // omit for the provider default; low (~0.2) for stable, repeatable plans
}

// Wrap a provider response so success/failure updates the reachability flag the UI reads.
async function recordingReturn(p: Promise<string>): Promise<string> {
  try {
    const text = await p;
    await recordLLMReachable(true);
    return text;
  } catch (e: any) {
    if (/invalid api key|no api key|401|403/i.test(e?.message ?? '')) await recordLLMReachable(false);
    throw e;
  }
}

/**
 * Make a single LLM request using the currently configured provider/model/key.
 * Returns the assistant's text response. Throws on network errors, auth failures, or rate limits.
 */
export async function callLLM(options: LLMCallOptions): Promise<string> {
  const cfg = await loadLLMConfig();
  if (!cfg.apiKey) { await recordLLMReachable(false); throw new Error('No API key configured — add one in Settings.'); }
  const spec = providerSpec(cfg.provider);

  const { system, messages, maxTokens, temperature } = options;

  // ── messages-format (native Anthropic + DeepSeek/GLM/Kimi) ───────
  if (spec.api === 'messages') {
    const sys = systemField(spec, system);
    const res = await fetch(`${spec.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: messagesHeaders(spec, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        ...(temperature != null ? { temperature } : {}),
        ...(sys ? { system: sys } : {}),
        messages,
      }),
    });
    return recordingReturn(handleMessagesResponse(res));
  }

  // ── OpenAI / Custom (OpenAI-compatible) ──────────────────────────────────────
  const baseUrl = openaiBase(spec, cfg.baseUrl);
  if (!baseUrl) throw new Error('Base URL is required for custom providers. Set it in Settings.');

  const allMessages = system
    ? [{ role: 'system' as const, content: system }, ...messages]
    : messages;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      ...(temperature != null ? { temperature } : {}),
      messages: allMessages,
    }),
  });
  return recordingReturn(handleOpenAIResponse(res));
}

// ─── Tool-use (agentic) call — Messages format ───────────────────────
// Unlike callLLM (single-shot, returns text), this returns the RAW assistant content blocks + stop_reason
// so the agent loop can detect tool_use blocks, run the tools, feed results back, and continue. Works on
// every messages-format provider (native + DeepSeek/GLM/Kimi), which all support tool_use/tool_result.
export interface LLMToolsCallOptions {
  system?:      string;
  messages:     any[];   // content-block messages (may contain tool_use / tool_result blocks)
  tools:        any[];   // Tool schemas (Messages format)
  maxTokens:    number;
  temperature?: number;
}
export interface LLMToolsResult { stopReason: string; content: any[]; text: string; }

/** True when the active provider supports the native tool loop (any messages-format provider). */
export async function agenticSupported(): Promise<boolean> {
  return providerSpec((await loadLLMConfig()).provider).agentic;
}

export async function callLLMTools(opts: LLMToolsCallOptions): Promise<LLMToolsResult> {
  const cfg = await loadLLMConfig();
  if (!cfg.apiKey) { await recordLLMReachable(false); throw new Error('No API key configured — add one in Settings.'); }
  const spec = providerSpec(cfg.provider);
  if (spec.api !== 'messages') throw new Error('AGENTIC_UNSUPPORTED'); // caller falls back to single-shot

  const sys = systemField(spec, opts.system);
  const res = await fetch(`${spec.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: messagesHeaders(spec, cfg.apiKey),
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: opts.maxTokens,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(sys ? { system: sys } : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),   // omit when empty → forces a final text answer
      messages: opts.messages,
    }),
  });
  if (!res.ok) {
    let body: any = {}; try { body = await res.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (res.status === 401) { await recordLLMReachable(false); throw new Error('Invalid API key. Check Settings.'); }
    if (res.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    throw new Error(`API error ${res.status}: ${msg || JSON.stringify(body).slice(0, 200)}`);
  }
  const data = await res.json();
  await recordLLMReachable(true);
  captureUsage(data, data?.model ?? '');
  const content: any[] = data.content ?? [];
  const text = content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();
  return { stopReason: data.stop_reason ?? 'end_turn', content, text };
}

// ─── Model discovery — fetch the provider's live model list (Settings "Refresh") ──
export async function fetchAvailableModels(provider: LLMProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
  const spec = providerSpec(provider);

  // Providers without a listable /models endpoint (DeepSeek/GLM/Kimi (messages-format)) → surface the
  // curated suggestions so the picker is still useful. Cache them like a fetched list.
  if (!spec.liveModels) {
    const ids = [...spec.suggestedModels];
    if (ids.length) await SecureStore.setItemAsync(SK_MODEL_LIST(provider), JSON.stringify(ids)).catch(() => {});
    return ids;
  }

  const key = (apiKey ?? (await SecureStore.getItemAsync(SK_APIKEY(provider))) ?? '').trim();
  if (!key && provider !== 'custom') throw new Error('Add and save an API key first.');
  let url: string; let headers: Record<string, string>;
  if (spec.id === 'anthropic') {
    url = `${spec.baseUrl}/v1/models`;
    headers = messagesHeaders(spec, key);
  } else if (spec.id === 'openai') {
    url = `${spec.baseUrl}/models`;
    headers = { Authorization: `Bearer ${key}` };
  } else {
    const base = ((baseUrl ?? (await SecureStore.getItemAsync(SK_BASEURL)) ?? '')).replace(/\/+$/, '');
    if (!base) throw new Error('Set the Base URL first.');
    url = `${base}/models`;
    headers = { Authorization: `Bearer ${key}` };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(res.status === 401 ? 'Key rejected (401).' : `Couldn't fetch models (HTTP ${res.status}).`);
  const data = await res.json();
  let ids: string[] = (data?.data ?? []).map((m: any) => m?.id).filter((x: any) => typeof x === 'string');
  // Trim to chat-capable models — drop embeddings/audio/image/etc noise.
  if (spec.id === 'openai') ids = ids.filter(id => /^(gpt|o\d|chatgpt)/i.test(id) && !/embedding|whisper|tts|audio|image|moderation|dall|realtime|search|transcribe/i.test(id));
  if (spec.id === 'anthropic') ids = ids.filter(id => /^claude/i.test(id));
  ids = [...new Set(ids)].sort().reverse(); // roughly newest-first
  if (ids.length) await SecureStore.setItemAsync(SK_MODEL_LIST(provider), JSON.stringify(ids)).catch(() => {});
  return ids;
}
export async function loadModelList(provider: LLMProvider): Promise<string[]> {
  try { const raw = await SecureStore.getItemAsync(SK_MODEL_LIST(provider)); return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ─── Vision call (single image + prompt) ──────────────────────────────────────

export interface LLMVisionOptions {
  prompt:      string;       // instruction / extraction prompt
  imageBase64: string;       // raw base64 (no data: prefix)
  mediaType?:  string;       // default image/png
  maxTokens:   number;
}

/**
 * Send one image plus a text prompt to the configured provider's vision model.
 * Works with messages-format (image content blocks) and OpenAI-compatible (image_url data URI).
 * Returns the assistant's text response.
 */
export async function callLLMWithImage(options: LLMVisionOptions): Promise<string> {
  const cfg = await loadLLMConfig();
  if (!cfg.apiKey) { await recordLLMReachable(false); throw new Error('No API key configured — add one in Settings.'); }
  const spec = providerSpec(cfg.provider);
  const { prompt, imageBase64, maxTokens } = options;
  const mediaType = options.mediaType ?? 'image/png';

  if (spec.api === 'messages') {
    const res = await fetch(`${spec.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: messagesHeaders(spec, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    return recordingReturn(handleMessagesResponse(res));
  }

  // OpenAI / Custom (OpenAI-compatible vision)
  const baseUrl = openaiBase(spec, cfg.baseUrl);
  if (!baseUrl) throw new Error('Base URL is required for custom providers. Set it in Settings.');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
        ],
      }],
    }),
  });
  return recordingReturn(handleOpenAIResponse(res));
}

// ─── Response helpers ─────────────────────────────────────────────────────────

// The feature attributing the CURRENT call, so usage can be broken down by what spent it. Set by
// callLLM's callers via withFeature(); falls back to 'other'.
let currentFeature = 'other';
export function setUsageFeature(f: string): void { currentFeature = f; }

/** Pull the provider's usage block (Messages and OpenAI shapes) and record it. Never throws. */
function captureUsage(data: any, model: string): void {
  try {
    const u = data?.usage;
    if (!u) return;
    recordUsage({
      input:      u.input_tokens ?? u.prompt_tokens ?? 0,
      output:     u.output_tokens ?? u.completion_tokens ?? 0,
      cacheRead:  u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      model, at: new Date().toISOString(), feature: currentFeature,
    });
  } catch { /* accounting must never break a call */ }
}

async function handleMessagesResponse(res: Response): Promise<string> {
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (res.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (res.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    if (msg.match(/credit|quota|balance/i)) {
      throw new Error('Credits exhausted for this provider. Top up your account.');
    }
    throw new Error(`API error ${res.status}: ${msg || JSON.stringify(body).slice(0, 200)}`);
  }
  const data = await res.json();
  captureUsage(data, data?.model ?? '');
  // Join every text block — a reasoning model (e.g. DeepSeek via its messages-format endpoint) can emit a
  // `thinking` block before the answer, so content[0] is not necessarily the text.
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b?.text ?? '').join('').trim();
  if (!text) {
    const sr = data?.stop_reason;
    if (sr === 'max_tokens') throw new Error('The model hit its output-token limit before answering. Try a shorter question, or a model with a larger budget.');
    throw new Error(`The model returned an empty response${sr ? ` (stop_reason: ${sr})` : ''}.`);
  }
  return text;
}

async function handleOpenAIResponse(res: Response): Promise<string> {
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (res.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (res.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    throw new Error(`API error ${res.status}: ${msg || JSON.stringify(body).slice(0, 200)}`);
  }
  const data = await res.json();
  captureUsage(data, data?.model ?? '');
  const choice = data?.choices?.[0];
  const message = choice?.message ?? {};
  let text: any = message.content;
  // Some OpenAI-compatible servers return content as an array of parts rather than a plain string.
  if (Array.isArray(text)) text = text.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  // Reasoning models (DeepSeek deepseek-v4-pro / -reasoner, and others) emit the chain-of-thought in
  // `reasoning_content` and can leave `content` EMPTY when the max_tokens budget is spent thinking. Fall
  // back to reasoning_content so the answer bubble is never silently blank.
  if ((text == null || !String(text).trim()) && typeof message.reasoning_content === 'string') {
    text = message.reasoning_content;
  }
  text = text == null ? '' : String(text);
  if (!text.trim()) {
    // Empty content with a real completion → almost always a reasoning model that hit the token cap while
    // thinking. Surface it clearly instead of rendering an empty bubble.
    if (choice?.finish_reason === 'length') {
      throw new Error('The model ran out of output tokens before answering — likely a reasoning model spending the whole budget on its chain-of-thought. Switch to a non-reasoning model (e.g. deepseek-v4-flash) or ask a shorter question.');
    }
    throw new Error(`The model returned an empty response${choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ''}.`);
  }
  return text;
}

/**
 * Extract the FIRST balanced JSON object from LLM output. The old greedy regex (/\{[\s\S]*\}/) spanned
 * from the first '{' to the LAST '}' in the text — any trailing prose containing a brace made the whole
 * response unparseable and silently discarded. Walks braces, string- and escape-aware.
 */
export function extractJsonObject(txt: string): string | null {
  const start = txt.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return txt.slice(start, i + 1); }
  }
  return null;
}
