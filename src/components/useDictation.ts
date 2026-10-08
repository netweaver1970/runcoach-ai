import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { transcribeAudio, transcriptionReady } from '../services/transcription';
import { startRecording, stopRecording, cancelRecording, ensureMicPermission } from '../services/voiceRecorder';

// ─── Voice: dictate a meal ────────────────────────────────────────────────────────────────────────
/** Record → transcribe (the app's Voice-input key) → onText. One button: tap = start, tap again = stop. */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const cb = useRef(onText); cb.current = onText;
  const stRef = useRef(state); stRef.current = state;
  const toggle = async () => {
    if (state === 'transcribing') return;
    if (state === 'recording') {
      setState('transcribing');
      try {
        const uri = await stopRecording();
        const text = uri ? (await transcribeAudio(uri)).trim() : '';
        setState('idle');
        if (text) cb.current(text); else Alert.alert('Voice input', 'No speech detected — try again.');
      } catch (e: any) { setState('idle'); Alert.alert('Voice input', e?.message ?? 'Could not transcribe.'); }
      return;
    }
    if (!(await transcriptionReady())) { Alert.alert('Voice input not set up', "Add a transcription key in Settings → Voice input first — it's free with Groq."); return; }
    if (!(await ensureMicPermission())) { Alert.alert('Microphone needed', 'Enable microphone access for RunCoachAI in iOS Settings to use voice input.'); return; }
    try { await startRecording(); setState('recording'); } catch (e: any) { Alert.alert('Voice input', e?.message ?? 'Could not start recording.'); }
  };
  // leaving mid-recording must not leave the mic running (only THIS recorder's — the recorder is app-global)
  useEffect(() => () => { if (stRef.current === 'recording') cancelRecording().catch(() => {}); }, []);
  return { state, toggle };
}
/** Speech → the parser's list: sentence ends and "then" become separators, filler words go. */
export function cleanDictation(t: string): string {
  return t.replace(/[.!?]+(\s|$)/g, ', ').replace(/\b(and then|then|daarna|dan|ook|also|uh+|euh+|ehm+)\b/gi, ', ')
    .replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
}

