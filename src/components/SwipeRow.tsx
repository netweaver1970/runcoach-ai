import React, { useRef } from 'react';
import { View, Text, Animated, PanResponder, TouchableOpacity, StyleSheet } from 'react-native';

/**
 * Swipe LEFT on a row → a red Delete button slides in; tap it to delete (Geert 2026-10-08: "a swipe and a delete
 * button appears — a GUI element to delete elements from the lists on screen"). Core RN only (no gesture-handler →
 * no native build). Only a clearly HORIZONTAL drag claims the touch, so vertical list scrolling and taps still work.
 */
const ACTION_W = 84;
export function SwipeRow({ onDelete, children, label = 'Delete', disabled }: { onDelete: () => void; children: React.ReactNode; label?: string; disabled?: boolean }) {
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const dis = useRef(disabled); dis.current = disabled;   // the responder is created once → read the LIVE prop
  const del = useRef(onDelete); del.current = onDelete;
  const settle = (to: number) => { open.current = to !== 0; Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 20 }).start(); };
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !dis.current && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => { x.setValue(Math.max(-ACTION_W * 1.4, Math.min(0, g.dx + (open.current ? -ACTION_W : 0)))); },
    onPanResponderRelease: (_, g) => settle(g.dx + (open.current ? -ACTION_W : 0) < -ACTION_W / 2 ? -ACTION_W : 0),
    onPanResponderTerminate: () => settle(open.current ? -ACTION_W : 0),
    onPanResponderTerminationRequest: () => true,
  })).current;
  return (
    <View style={st.wrap}>
      {/* the red underlay only shows while swiped (no red flash when a row is merely tapped) */}
      <Animated.View style={[st.under, { opacity: x.interpolate({ inputRange: [-8, 0], outputRange: [1, 0], extrapolate: 'clamp' }) }]}>
        <TouchableOpacity style={st.del} onPress={() => { settle(0); del.current(); }} accessibilityLabel={label}>
          <Text style={st.delTxt}>🗑 {label}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap:   { overflow: 'hidden' },
  under:  { ...StyleSheet.absoluteFillObject, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: '#e5484d' },
  del:    { width: ACTION_W, alignItems: 'center', justifyContent: 'center' },
  delTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
