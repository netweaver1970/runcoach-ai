/**
 * Share a calibration/debug JSON dump as a FILE — via the OS share sheet
 * (AirDrop to the Mac, Save to Files, Mail, etc.) instead of the clipboard.
 *
 * Universal Clipboard iPhone→Mac is flaky, so the Copy buttons alone aren't
 * reliable for getting these dumps off-device; a real file always works.
 * Falls back to the clipboard when the share sheet is unavailable (matches the
 * pattern used in app/coach-knowledge-edit.tsx and app/settings.tsx).
 */
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';

/**
 * @param data        JSON-serialisable value (object/array) or a pre-stringified JSON string
 * @param fileName    descriptive file name, e.g. 'bodybattery-calibration.json'
 * @param dialogTitle share-sheet title
 */
export async function shareJson(data: unknown, fileName: string, dialogTitle: string): Promise<void> {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    const uri = `${FileSystem.cacheDirectory}${fileName}`;
    await FileSystem.writeAsStringAsync(uri, json);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle, UTI: 'public.json' });
    } else {
      await Clipboard.setStringAsync(json);
      Alert.alert('Copied', 'Sharing unavailable — data copied to clipboard.');
    }
  } catch (e: any) {
    // Last-ditch: at least get it onto the clipboard so the dump isn't lost.
    try { await Clipboard.setStringAsync(json); } catch {}
    Alert.alert('Share failed', e?.message ?? String(e));
  }
}
