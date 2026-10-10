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
// Speech settings: MONO AAC. The HIGH_QUALITY preset is 44.1 kHz STEREO, and AVAudioRecorder refuses to prepare it
// ("recorder not prepared") when the input route can't give that — Bluetooth earbuds' mic (HFP) is mono 16 kHz, and
// so can the mic be while another app / the phone holds the session. Mono is all transcription needs (and smaller).
const SPEECH = (sampleRate: number): Audio.RecordingOptions => ({
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  ios: { ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios, extension: '.m4a', outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH, sampleRate, numberOfChannels: 1, bitRate: 64000 },
  android: { ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android, sampleRate, numberOfChannels: 1, bitRate: 64000 },
});

export async function startRecording(): Promise<void> {
  if (recording) { try { await recording.stopAndUnloadAsync(); } catch {} recording = null; }
  let lastErr: any;
  // attempt 0: 44.1 kHz mono · then 16 kHz mono (any Bluetooth / HFP route) · each after resetting the audio session
  const rates = [44100, 16000, 16000, 44100];
  for (let attempt = 0; attempt < rates.length; attempt++) {
    const rec = new Audio.Recording();
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      await rec.prepareToRecordAsync(SPEECH(rates[attempt]));   // iOS → .m4a AAC
      await rec.startAsync();
      recording = rec;
      return;
    } catch (e: any) {
      lastErr = e;
      // release this half-prepared recorder (expo-av allows only ONE prepared Recording at a time), then reset the
      // session — after the permission prompt / Control Center / a call iOS needs a beat to hand the mic back
      try { await rec.stopAndUnloadAsync(); } catch {}
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
      await sleep(/background|audio session/i.test(e?.message ?? '') ? 400 : 250);
    }
  }
  throw new Error(/not prepared|prepare/i.test(lastErr?.message ?? '')
    ? 'The microphone is busy or unavailable — end a call / another recording app, or disconnect and reconnect your earbuds, then try again.'
    : lastErr?.message ?? 'Could not start recording.');
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
