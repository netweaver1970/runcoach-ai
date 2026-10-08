import React, { useEffect, useState } from 'react';
import { View, Image, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Exercise, exerciseImages } from '../services/strength';

/**
 * What the exercise LOOKS like, without leaving the session (Geert 2026-10-08: "new to the technical names… one tap to
 * see what the exercise is about, without opening the video — it takes the flow out"). A thumbnail on the card; tap →
 * it grows in place and alternates start / end position (~1 s each) like a flip-book. Tap again to shrink.
 */
export function ExerciseThumb({ ex, open, onToggle }: { ex?: Exercise; open: boolean; onToggle: () => void }) {
  const imgs = exerciseImages(ex);
  if (!imgs.length) return null;
  return (
    <TouchableOpacity onPress={onToggle} hitSlop={6} accessibilityLabel="Show the exercise">
      <Image source={{ uri: imgs[0] }} style={[st.thumb, open && st.thumbOn]} resizeMode="cover" />
    </TouchableOpacity>
  );
}
export function ExercisePeek({ ex, onClose }: { ex?: Exercise; onClose: () => void }) {
  const imgs = exerciseImages(ex);
  const [k, setK] = useState(0);
  useEffect(() => {
    if (imgs.length < 2) return;
    const t = setInterval(() => setK(v => (v + 1) % imgs.length), 1000);
    return () => clearInterval(t);
  }, [imgs.length]);
  if (!imgs.length) return null;
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onClose} style={st.peek}>
      {/* both frames mounted (no reload flicker); the inactive one is hidden */}
      {imgs.map((u, i) => <Image key={u} source={{ uri: u }} style={[st.big, i !== k && st.hidden]} resizeMode="contain" />)}
      {imgs.length > 1 && <Text style={st.lbl}>{k === 0 ? 'start' : 'end'}</Text>}
    </TouchableOpacity>
  );
}
/** A small static picture for lists (exercise database, routine editor, picker). */
export function ExerciseMini({ ex, size = 44 }: { ex?: Exercise; size?: number }) {
  const imgs = exerciseImages(ex);
  if (!imgs.length) return <View style={[st.mini, { width: size * 1.33, height: size }]} />;
  return <Image source={{ uri: imgs[0] }} style={[st.mini, { width: size * 1.33, height: size }]} resizeMode="cover" />;
}
const st = StyleSheet.create({
  mini:   { borderRadius: 6, backgroundColor: '#8882', marginRight: 10 },
  thumb:  { width: 64, height: 48, borderRadius: 8, backgroundColor: '#0002', marginRight: 10 },
  thumbOn:{ opacity: 0.5 },
  peek:   { marginTop: 8, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  big:    { width: '100%', aspectRatio: 1.5 },
  hidden: { position: 'absolute', opacity: 0 },
  lbl:    { position: 'absolute', right: 8, bottom: 6, color: '#fff', fontSize: 11, fontWeight: '700', backgroundColor: '#0008', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
});
