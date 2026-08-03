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

/** Begin recording. Any in-flight recording is discarded first. */
export async function startRecording(): Promise<void> {
  if (recording) { try { await recording.stopAndUnloadAsync(); } catch {} recording = null; }
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  const rec = new Audio.Recording();
  await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY); // iOS → .m4a AAC
  await rec.startAsync();
  recording = rec;
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
