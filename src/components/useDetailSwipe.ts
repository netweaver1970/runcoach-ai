/**
 * Horizontal swipe navigates a KPI detail screen DAY BY DAY: swipe right → previous day, swipe left →
 * next day (never past today). `rec`/`str` are today's serialised snapshot, so they're DROPPED on a day
 * change — the screen reloads the viewed day from its own history fetch. KPI switching (Strain/Recovery/
 * Sleep) moved to the tab bar (see KpiTabs). Ignores left-edge gestures so the iOS back-swipe keeps working,
 * and small drags so vertical scroll is unaffected.
 */
import { useRef } from 'react';
import { PanResponder } from 'react-native';
import { useRouter } from 'expo-router';

const DAY = 86_400_000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function useDetailSwipe(_current: string, params: Record<string, string | undefined>) {
  const router = useRouter();
  const pref = useRef(params);
  pref.current = params;

  const pan = useRef(PanResponder.create({
    // Claim clearly-horizontal swipes in the CAPTURE phase — otherwise the child ScrollView swallows the
    // gesture and the swipe never fires. Vertical drags (|dy| dominant) fall through to the ScrollView.
    onMoveShouldSetPanResponderCapture: (_e, g) =>
      Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4 && g.x0 > 40,
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.4 && g.x0 > 40,
    onPanResponderRelease: (_e, g) => {
      if (Math.abs(g.dx) < 55) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cur = pref.current.date ? new Date(pref.current.date + 'T00:00:00') : new Date(today);
      const next = new Date(cur.getTime() + (g.dx < 0 ? DAY : -DAY)); // left → next day, right → previous day
      if (next.getTime() > today.getTime()) return;                  // never navigate into the future
      // setParams updates the CURRENT screen's date in place — reliable re-render, no remount/refetch, and it
      // KEEPS rec/str so returning to today still shows the rich HR-aware snapshot. Landing ON today clears the
      // date param entirely — screens gate their rich today-only sections on "no date", so leaving it set hid
      // the recovery breakdown / readiness card forever after any day navigation.
      router.setParams({ date: next.getTime() >= today.getTime() ? '' : iso(next) });
    },
  })).current;

  return pan.panHandlers;
}
