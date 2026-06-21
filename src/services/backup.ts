/**
 * One-shot backup / restore of ALL app settings.
 *
 * Bundles into a single JSON: SecureStore-backed settings (theme, LLM provider/model/
 * keys, training thresholds, power zones, sleep goal, custom weights…), the file-backed
 * stores (coach memory, Bevel calibration data) and the full coaching-knowledge bundle.
 * Caches (e.g. the recommendation cache, daily coach plans) are intentionally excluded.
 */
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import { exportKnowledgeBundle, importKnowledgeBundle, KnowledgeBundle } from './coachFiles';

const PROVIDERS = ['anthropic', 'openai', 'custom'] as const;

// Meaningful settings only — caches like `training_rec_v1` are deliberately omitted.
const STATIC_SECURE_KEYS = [
  'theme_mode_v1', 'font_scale_v1',
  'anthropic_api_key',            // legacy key, still read on migration
  'sync_months', 'long_run_minutes', 'ai_weeks',
  'power_zones', 'run_overrides', 'hr_unreliable_runs',
  'sleep_weights_custom_v1', 'recovery_weights_v1', 'personal_sleep_goal_min_v1',
  'llm_provider_v1', 'llm_baseurl_custom_v1',
];

function providerKeys(): string[] {
  const out: string[] = [];
  for (const p of PROVIDERS) out.push(`llm_model_${p}_v1`, `llm_apikey_${p}_v1`, `llm_model_history_${p}_v1`);
  return out;
}
const ALL_SECURE = [...STATIC_SECURE_KEYS, ...providerKeys()];
const isApiKeyKey = (k: string) => k.includes('apikey') || k === 'anthropic_api_key';

// File-backed stores (relative to documentDirectory).
const FILES = [
  'runcoach-chat-history.json',     // coach memory + chat
  'runcoach-bevel-data.json',       // Bevel daily values
  'runcoach-bevel-averages.json',   // Bevel 30-day averages
];

export interface SettingsBackup {
  app: 'RunCoachAI';
  kind: 'settings-backup';
  version: 1;
  exportedAt: string;
  includesApiKeys: boolean;
  secure: Record<string, string>;
  files: Record<string, string>;
  knowledge: KnowledgeBundle;
}

export async function exportAllSettings(includeApiKeys = true): Promise<string> {
  const secure: Record<string, string> = {};
  for (const k of ALL_SECURE) {
    if (!includeApiKeys && isApiKeyKey(k)) continue;
    try { const v = await SecureStore.getItemAsync(k); if (v != null) secure[k] = v; } catch { /* skip */ }
  }
  const files: Record<string, string> = {};
  for (const f of FILES) {
    try {
      const uri = FileSystem.documentDirectory + f;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) files[f] = await FileSystem.readAsStringAsync(uri);
    } catch { /* skip */ }
  }
  const knowledge = await exportKnowledgeBundle();
  const backup: SettingsBackup = {
    app: 'RunCoachAI', kind: 'settings-backup', version: 1,
    exportedAt: new Date().toISOString(), includesApiKeys: includeApiKeys,
    secure, files, knowledge,
  };
  return JSON.stringify(backup, null, 2);
}

export interface RestoreResult { secure: number; files: number; knowledge: number; }

export async function restoreAllSettings(json: string): Promise<RestoreResult> {
  let b: SettingsBackup;
  try { b = JSON.parse(json); } catch { throw new Error('Not valid JSON.'); }
  if (b?.kind !== 'settings-backup' || b?.app !== 'RunCoachAI') {
    throw new Error('Not a RunCoachAI settings backup.');
  }
  const res: RestoreResult = { secure: 0, files: 0, knowledge: 0 };

  for (const [k, v] of Object.entries(b.secure ?? {})) {
    if (!ALL_SECURE.includes(k)) continue; // ignore unknown keys
    try { await SecureStore.setItemAsync(k, String(v)); res.secure++; } catch { /* skip */ }
  }
  for (const [f, content] of Object.entries(b.files ?? {})) {
    if (!FILES.includes(f)) continue;
    try { await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + f, String(content)); res.files++; } catch { /* skip */ }
  }
  if (b.knowledge) res.knowledge = await importKnowledgeBundle(b.knowledge);
  return res;
}
