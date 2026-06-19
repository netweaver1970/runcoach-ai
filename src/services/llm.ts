/**
 * Provider-agnostic LLM service
 *
 * Supported providers:
 *   • anthropic  — native Anthropic Messages API
 *   • openai     — OpenAI Chat Completions API
 *   • custom     — any OpenAI-compatible endpoint (Groq, Mistral, Ollama, …)
 *
 * Config is stored per-provider in the iOS Keychain via expo-secure-store.
 * On first load, the old `anthropic_api_key` is migrated automatically.
 */

import * as SecureStore from 'expo-secure-store';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = 'anthropic' | 'openai' | 'custom';

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

// ─── SecureStore keys ─────────────────────────────────────────────────────────

const SK_PROVIDER     = 'llm_provider_v1';
const SK_MODEL        = (p: LLMProvider) => `llm_model_${p}_v1`;
const SK_APIKEY       = (p: LLMProvider) => `llm_apikey_${p}_v1`;
const SK_BASEURL      = 'llm_baseurl_custom_v1';
const SK_HISTORY      = (p: LLMProvider) => `llm_model_history_${p}_v1`;
const SK_OLD_ANTHRO   = 'anthropic_api_key'; // legacy key — migrated on first load

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  anthropic: 'Anthropic',
  openai:    'OpenAI',
  custom:    'Custom',
};

export const PROVIDER_KEY_PLACEHOLDER: Record<LLMProvider, string> = {
  anthropic: 'sk-ant-api03-…',
  openai:    'sk-proj-…',
  custom:    'API key',
};

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o-mini',
  custom:    '',
};

export const SUGGESTED_MODELS: Record<LLMProvider, string[]> = {
  anthropic: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
  ],
  openai: [
    'gpt-4o-mini',
    'gpt-4o',
    'o3-mini',
  ],
  custom: [],
};

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
  } catch {}

  const provider = ((await SecureStore.getItemAsync(SK_PROVIDER)) as LLMProvider | null) ?? 'anthropic';
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
}

/** Get just the active API key (used as a quick existence check). */
export async function getActiveApiKey(): Promise<string | null> {
  const cfg = await loadLLMConfig();
  return cfg.apiKey || null;
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
  provider: LLMProvider,
  apiKey:   string,
  baseUrl?: string,
): Promise<LLMValidationResult> {
  const key = apiKey.trim();
  if (!key) return { valid: false, error: 'API key cannot be empty.' };

  try {
    if (provider === 'anthropic') {
      if (!key.startsWith('sk-ant-')) {
        return { valid: false, error: 'Anthropic keys start with "sk-ant-".' };
      }
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      if (res.status === 401) return { valid: false, error: 'Key rejected (401). Check console.anthropic.com.' };
      if (res.status === 403) return { valid: false, error: 'Key has no permissions (403).' };
      return { valid: true };
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.status === 401) return { valid: false, error: 'Key rejected (401). Check platform.openai.com.' };
      if (res.status === 403) return { valid: false, error: 'Key has no permissions (403).' };
      return { valid: true };
    }

    if (provider === 'custom') {
      const base = (baseUrl ?? '').replace(/\/+$/, '');
      if (!base) return { valid: false, error: 'Base URL is required for custom providers.' };
      try {
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.status === 401) return { valid: false, error: 'Key rejected (401).' };
        // Some providers don't implement /models — anything other than 401 is treated as OK
        return { valid: true };
      } catch {
        // /models may not exist — treat as OK if no 401
        return { valid: true, warning: 'Could not verify key (no /models endpoint). Saved anyway.' };
      }
    }
  } catch (e: any) {
    return { valid: false, error: `Network error: ${e?.message ?? String(e)}` };
  }

  return { valid: false, error: 'Unknown provider.' };
}

// ─── Unified LLM call ─────────────────────────────────────────────────────────

export interface LLMCallOptions {
  system?:   string;
  messages:  { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
}

/**
 * Make a single LLM request using the currently configured provider/model/key.
 * Returns the assistant's text response.
 * Throws on network errors, auth failures, or rate limits.
 */
export async function callLLM(options: LLMCallOptions): Promise<string> {
  const cfg = await loadLLMConfig();
  if (!cfg.apiKey) throw new Error('No API key configured — add one in Settings.');

  const { system, messages, maxTokens } = options;

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (cfg.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
    return handleAnthropicResponse(res);
  }

  // ── OpenAI / Custom (OpenAI-compatible) ────────────────────────────────────
  const baseUrl = cfg.provider === 'custom'
    ? (cfg.baseUrl ?? '').replace(/\/+$/, '')
    : 'https://api.openai.com/v1';

  if (!baseUrl) throw new Error('Base URL is required for custom providers. Set it in Settings.');

  // OpenAI puts system as the first message
  const allMessages = system
    ? [{ role: 'system' as const, content: system }, ...messages]
    : messages;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: allMessages,
    }),
  });
  return handleOpenAIResponse(res);
}

// ─── Response helpers ─────────────────────────────────────────────────────────

async function handleAnthropicResponse(res: Response): Promise<string> {
  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch {}
    const msg: string = body?.error?.message ?? '';
    if (res.status === 401) throw new Error('Invalid API key. Check Settings.');
    if (res.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    if (msg.match(/credit|quota|balance/i)) {
      throw new Error('Anthropic credits exhausted. Top up at console.anthropic.com.');
    }
    throw new Error(`API error ${res.status}: ${msg || JSON.stringify(body).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content[0].text as string;
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
  return data.choices[0].message.content as string;
}
