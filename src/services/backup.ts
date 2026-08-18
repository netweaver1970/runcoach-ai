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
import { clearAccountingCache } from './accounting';
import { PROVIDER_ORDER } from './llm';

// Meaningful settings only — caches like `training_rec_v1` and the internal `scan_marker_v1`
// are deliberately omitted (they're rebuilt from HealthKit on the next scan).
const STATIC_SECURE_KEYS = [
  'theme_mode_v1', 'font_scale_v1',
  'anthropic_api_key',            // legacy key, still read on migration
  'sync_months', 'long_run_minutes', 'ai_weeks',
  'power_zones', 'run_overrides', 'hr_unreliable_runs',
  'sleep_weights_custom_v1', 'recovery_weights_v1', 'personal_sleep_goal_min_v1',
  'llm_provider_v1', 'llm_baseurl_custom_v1',
  // added so a wipe + restore rebuilds EXACTLY:
  'accounting_switches',          // volume-accounting regime switch list (work↔full by date)
  'load_cap_pct_switches',        // +cap% by date (point-in-time history); 'load_cap_pct' kept as the legacy mirror
  'load_cap_pct', 'load_cap_basis', // progression cap settings
  'user_max_hr', 'max_hr_history_v1', 'body_mass_kg', // physiology (incl. date-keyed max-HR changes) that drives zones/strain/power. (observed_max_hr is a HK-derived cache → excluded, rebuilt on scan.)
  'dayview_auto_v1', 'watch_kpi_v1', // auto day-view toggle, watch complication choice
  'coaching_mode_v1',             // self (LLM) vs coach (cloud prescription) mode
  'athlete_status_v1',            // overall status (Active/Sick/Injured/On a break) + until
  'shrink_to_fit_v1', 'periodization_v1', 'min_tsb', // coach cycle/shape settings
  'heat_sensitivity_v1', 'max_run_days_v1', // coach tuning: heat-strain ×multiplier + max running days/wk (were MISSING → lost on restore)
  'accent_color_v1',              // theme accent colour (was MISSING)
  'long_run_style_v1',            // long run: whole / auto-split / opt-in (per-date opt-in flags are transient → excluded)
  'warmup_meters_v1', 'cooldown_meters_v1', 'drills_minutes_v1', // workout structure (0 metres = open goal)
  'plan_mode_v1', 'race_config_v1', // leisure vs race + race config
  'agentic_mode_v1',              // agentic (tool-using) coach toggle
  'onboarding_done_v1', 'user_profile_v1', // onboarding + age/sex profile
  'stt_enabled_v1', 'stt_baseurl_v1', 'stt_apikey_v1', 'stt_model_v1', // voice input (cloud transcription)
];

// Driven off the live provider list (PROVIDER_ORDER) so adding a provider auto-includes its model/key/
// history in backups — the old hard-coded [anthropic,openai,custom] silently dropped DeepSeek/GLM/Kimi.
function providerKeys(): string[] {
  const out: string[] = [];
  for (const p of PROVIDER_ORDER) out.push(`llm_model_${p}_v1`, `llm_apikey_${p}_v1`, `llm_model_history_${p}_v1`);
  return out;
}
const ALL_SECURE = [...STATIC_SECURE_KEYS, ...providerKeys()];
const isApiKeyKey = (k: string) => k.includes('apikey') || k === 'anthropic_api_key';

// Fixed file-backed stores (relative to documentDirectory). User-entered data that can't be
// rebuilt from HealthKit. Caches (snapshot, workout, cardio-trimp, dayview, run-analysis, the
// regenerable coach-plan-*) are excluded — they recompute from HK on the next scan.
const FILES = [
  'runcoach-chat-history.json',     // coach memory + chat
  'runcoach-bevel-data.json',       // Bevel daily values
  'runcoach-bevel-averages.json',   // Bevel 30-day averages
  'bevel-calibration.json',         // Bevel calibration data
  'runcoach-run-meta.json',         // per-run notes + manual temps (user-entered)
  'runcoach-timeline.json',         // timeline events (injuries / races / notes)
  'runcoach-supplements.json',      // supplement list + daily intake log
  'runcoach-labs.json',             // imported blood-test / clinical-lab history
  'runcoach-lab-templates.json',    // saved lab marker templates (named selections)
  'runcoach-labs-driveurl.json',    // remembered Google Drive import link
  'runcoach-labs-chat.json',        // Labs chat history
  'runcoach-biology-chat.json',     // Biology chat history
];
// Per-date files captured by prefix — the prescription plan-logs that drive deterministic
// run-detail phase labels (HealthKit has no record of the prescribed structure).
const FILE_PREFIXES = ['coach-plan-log-'];

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
  const captureFile = async (f: string) => {
    try {
      const uri = FileSystem.documentDirectory + f;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) files[f] = await FileSystem.readAsStringAsync(uri);
    } catch { /* skip */ }
  };
  for (const f of FILES) await captureFile(f);
  // Per-date prefix files (plan-logs).
  try {
    const dir = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory!);
    for (const f of dir) if (FILE_PREFIXES.some(p => f.startsWith(p))) await captureFile(f);
  } catch { /* skip */ }
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
    const ok = FILES.includes(f) || FILE_PREFIXES.some(p => f.startsWith(p));
    if (!ok || f.includes('/') || f.includes('..')) continue; // allowlist + path-traversal guard
    try { await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + f, String(content)); res.files++; } catch { /* skip */ }
  }
  if (b.knowledge) res.knowledge = await importKnowledgeBundle(b.knowledge);
  clearAccountingCache(); // re-read the restored switch list
  return res;
}
