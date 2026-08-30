import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

// Placeholder mode — nutrition / intake. Structure is here to grow into.
export default function FoodMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠  Home</Text></TouchableOpacity>
      <Text style={s.emoji}>🍽️</Text>
      <Text style={s.h1}>Food</Text>
      <Text style={s.sub}>Fuelling and intake — how what you eat interacts with training, recovery and body composition.</Text>
      <View style={s.card}>
        <Text style={s.cardTitle}>Coming here</Text>
        <Text style={s.li}>• Intake / fuelling log around key sessions</Text>
        <Text style={s.li}>• Hydration & electrolytes (you sweat heavily)</Text>
        <Text style={s.li}>• Links to weight & body-fat trends in Biology</Text>
        <Text style={s.li}>• Supplement timing (already tracked in the timeline)</Text>
      </View>
      <Text style={s.note}>Supplements you already log live in the <Text style={s.bold}>Home</Text> timeline; this mode will build on them.</Text>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  homeBtn:   { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, marginBottom: 18 },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 16 },
  emoji:     { fontSize: 44, textAlign: 'center', marginTop: 8 },
  h1:        { color: c.text, fontSize: 26, fontWeight: '800', textAlign: 'center', marginTop: 6 },
  sub:       { color: c.textSub, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, marginBottom: 20 },
  card:      { backgroundColor: c.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  li:        { color: c.textSub, fontSize: 14, lineHeight: 24 },
  note:      { color: c.textFaint, fontSize: 13, lineHeight: 19, marginTop: 18, textAlign: 'center' },
  bold:      { color: c.text, fontWeight: '700' },
});
