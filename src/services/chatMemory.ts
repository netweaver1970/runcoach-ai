/**
 * Chat memory — persists conversation history (with timestamps) and a
 * coach-generated memory note across app sessions.
 *
 * PersistedMessage wraps ChatMessage with a local timestamp so the UI can
 * show session dividers and the AI prompt can include compact time-gap labels.
 * Timestamps are stripped before messages are sent to the API.
 */

import * as FileSystem from 'expo-file-system';
import { ChatMessage } from './claude';

const CHAT_FILE = `${FileSystem.documentDirectory}runcoach-chat-history.json`;

// Keep at most this many messages. Older ones are already encoded in the
// memory note via summarisation.
const MAX_STORED_MESSAGES = 60;

// A gap larger than this between consecutive messages gets a compact time
// label prepended to the later message so Claude knows it's a new session.
const GAP_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersistedMessage {
  role:    'user' | 'assistant';
  content: string;
  ts:      string; // ISO-8601 — stored locally, NOT sent to the API as-is
}

export interface ChatPersistence {
  messages:          PersistedMessage[];
  memoryNote:        string;
  savedAt:           string;           // ISO — last write time
  lastSeenRunUUID?:  string;           // UUID of the run that was auto-analysed last
}

// ─── toApiMessages ────────────────────────────────────────────────────────────
// Convert PersistedMessage[] → ChatMessage[] for the Anthropic API.
// When two consecutive messages are separated by > GAP_THRESHOLD_MS, a compact
// date label is prepended to the later message content so Claude knows that
// time has passed between exchanges.

export function toApiMessages(msgs: PersistedMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m    = msgs[i];
    const prev = msgs[i - 1];
    let content = m.content;

    if (prev) {
      const gapMs = new Date(m.ts).getTime() - new Date(prev.ts).getTime();
      if (gapMs > GAP_THRESHOLD_MS) {
        const label = new Date(m.ts).toLocaleString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: '2-digit', minute: '2-digit',
        });
        content = `[${label}] ${content}`;
      }
    }
    out.push({ role: m.role, content });
  }
  return out;
}

// ─── makeMsg ─────────────────────────────────────────────────────────────────

export function makeMsg(
  role:    'user' | 'assistant',
  content: string,
  ts?:     string,
): PersistedMessage {
  return { role, content, ts: ts ?? new Date().toISOString() };
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadChatPersistence(): Promise<ChatPersistence | null> {
  try {
    const info = await FileSystem.getInfoAsync(CHAT_FILE);
    if (!info.exists) return null;
    const raw    = await FileSystem.readAsStringAsync(CHAT_FILE);
    const parsed = JSON.parse(raw) as any;

    // Backward-compat: old format had ChatMessage[] without a ts field.
    const fallbackTs: string = parsed.savedAt ?? new Date().toISOString();
    const messages: PersistedMessage[] = (parsed.messages ?? []).map((m: any) => ({
      role:    m.role,
      content: m.content,
      ts:      m.ts ?? fallbackTs,
    }));

    return {
      messages,
      memoryNote:       parsed.memoryNote       ?? '',
      savedAt:          parsed.savedAt           ?? fallbackTs,
      lastSeenRunUUID:  parsed.lastSeenRunUUID,
    };
  } catch {
    return null;
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveChatPersistence(
  messages:          PersistedMessage[],
  memoryNote:        string,
  lastSeenRunUUID?:  string,
): Promise<void> {
  try {
    const data: ChatPersistence = {
      messages:         messages.slice(-MAX_STORED_MESSAGES),
      memoryNote,
      savedAt:          new Date().toISOString(),
      lastSeenRunUUID,
    };
    await FileSystem.writeAsStringAsync(CHAT_FILE, JSON.stringify(data));
  } catch {
    // Silently fail — memory is nice-to-have, not critical
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────

export async function clearChatPersistence(): Promise<void> {
  try {
    await FileSystem.deleteAsync(CHAT_FILE, { idempotent: true });
  } catch {}
}
