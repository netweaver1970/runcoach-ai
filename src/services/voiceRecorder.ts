/**
 * Thin wrapper over expo-av audio recording for the chat voice-input button.
 * Records a single utterance to an .m4a file (AAC) that the transcription service uploads.
 */

import { Audio } from 'expo-av';

let recording: Audio.Recording | null = null;

/** Ask for the mic permission (iOS shows the prompt once). Returns whether it's granted. */
export async function ensureMicPermission(): Promise<boolean> {
  try {
    const { status } = await Audio.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Begin recording. Any in-flight recording is discarded first.
 *
 * Retries the audio-session activation: right after the mic-permission prompt (or any brief resign-active
 * like Control Center), iOS hasn't flipped the app back to "active" yet, so expo-av rejects with
 * "…currently in the background, so the audio session could not be activated." Waiting a beat and retrying
 * lets the did-become-active notification land, then it succeeds.
 */
export async function startRecording(): Promise<void> {
  if (recording) { try { await recording.stopAndUnloadAsync(); } catch {} recording = null; }
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY); // iOS → .m4a AAC
      await rec.startAsync();
      recording = rec;
      return;
    } catch (e: any) {
      lastErr = e;
      if (/background|audio session/i.test(e?.message ?? '')) { await sleep(400); continue; }
      throw e;
    }
  }
  throw lastErr;
}

/** Stop and return the recorded file URI (.m4a), or null if nothing was recording. */
export async function stopRecording(): Promise<string | null> {
  const rec = recording;
  recording = null;
  if (!rec) return null;
  try { await rec.stopAndUnloadAsync(); } catch { /* already stopped */ }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
  return rec.getURI();
}

/** Abort without transcribing (e.g. user cancelled or navigated away). */
export async function cancelRecording(): Promise<void> {
  const rec = recording;
  recording = null;
  if (rec) { try { await rec.stopAndUnloadAsync(); } catch {} }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}

export function isRecording(): boolean { return recording != null; }
