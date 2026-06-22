/**
 * Horizontal swipe between the three KPI detail screens (Strain ↔ Recovery ↔ Sleep),
 * carrying the same day's data so the date stays put. Only claims clear horizontal
 * gestures that don't start at the very left edge, so vertical scroll and the iOS
 * edge-swipe-back both keep working.
 */
import { useRef } from 'react';
import { PanResponder } from 'react-native';
import { useRouter } from 'expo-router';

const ORDER = ['/strain-detail', '/recovery-detail', '/sleep-detail'];

export function useDetailSwipe(current: string, params: Record<string, string | undefined>) {
  const router = useRouter();
  const pref = useRef(params);
  pref.current = params;

  const pan = useRef(PanResponder.create({
    // g.x0 = where the touch STARTED; ignore gestures from the left edge so the iOS
    // back-swipe still works.
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 30 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6 && g.x0 > 40,
    onPanResponderRelease: (_e, g) => {
      const i = ORDER.indexOf(current);
      if (i < 0) return;
      let j = i;
      if (g.dx < -55)      j = (i + 1) % ORDER.length;            // swipe left  → next
      else if (g.dx > 55)  j = (i - 1 + ORDER.length) % ORDER.length; // swipe right → prev
      if (j !== i) router.replace({ pathname: ORDER[j] as any, params: pref.current as any });
    },
  })).current;

  return pan.panHandlers;
}
