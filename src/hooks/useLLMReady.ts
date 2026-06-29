import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { getLLMStatus } from '../services/llm';

export type LLMReason = 'no-key' | 'unreachable' | null;

/**
 * Whether the LLM can be used right now — a key is set AND the last call/validation didn't fail.
 * Re-checks on screen focus, so it reflects a key just added/removed in Settings or a call that
 * just failed (the daily-plan path and validateLLMKey both update the underlying flag). UI uses
 * this to grey out LLM-only actions (chat, report, run analysis, enhance) in keyless/broken-key mode.
 *
 * Starts optimistic (ready) to avoid a disabled flash before the async check resolves.
 */
export function useLLMReady(): { ready: boolean; reason: LLMReason } {
  const [state, setState] = useState<{ ready: boolean; reason: LLMReason }>({ ready: true, reason: null });
  useFocusEffect(useCallback(() => {
    let alive = true;
    getLLMStatus().then(s => {
      if (!alive) return;
      setState(!s.hasKey      ? { ready: false, reason: 'no-key' }
             : !s.reachable   ? { ready: false, reason: 'unreachable' }
             :                  { ready: true,  reason: null });
    }).catch(() => {});
    return () => { alive = false; };
  }, []));
  return state;
}
