/**
 * Chat memory — persists conversation history and a coach-generated
 * running memory note across app sessions.
 *
 * Memory note: a short paragraph Claude updates after each exchange,
 * capturing the runner's goals, patterns noticed, and key agreements.
 * It is injected back into the system prompt on the next session so
 * Claude "remembers" across conversations.
 */

import * as FileSystem from 'expo-file-system';
import { ChatMessage } from './claude';

const CHAT_FILE = `${FileSystem.documentDirectory}runcoach-chat-history.json`;

// Keep at most this many messages in the persisted file. Older ones are
// dropped (they're already encoded in the memory note via summarisation).
const MAX_STORED_MESSAGES = 60;

export interface ChatPersistence {
  messages:   ChatMessage[];   // role + content only (no UI state)
  memoryNote: string;          // coach's running summary across sessions
  savedAt:    string;          // ISO timestamp
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadChatPersistence(): Promise<ChatPersistence | null> {
  try {
    const info = await FileSystem.getInfoAsync(CHAT_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(CHAT_FILE);
    return JSON.parse(raw) as ChatPersistence;
  } catch {
    return null;
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveChatPersistence(
  messages:   ChatMessage[],
  memoryNote: string,
): Promise<void> {
  try {
    const data: ChatPersistence = {
      // Drop oldest messages beyond the cap — the memory note covers their content
      messages:   messages.slice(-MAX_STORED_MESSAGES),
      memoryNote,
      savedAt:    new Date().toISOString(),
    };
    await FileSystem.writeAsStringAsync(CHAT_FILE, JSON.stringify(data));
  } catch {
    // Silently fail — memory is a nice-to-have, not critical
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────

export async function clearChatPersistence(): Promise<void> {
  try {
    await FileSystem.deleteAsync(CHAT_FILE, { idempotent: true });
  } catch {}
}
