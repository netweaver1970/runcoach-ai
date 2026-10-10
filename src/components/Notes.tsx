/**
 * Standard explanation text, COLLAPSED by default (Geert 2026-10-10: "all over the app there are standard pieces of
 * text, explanation, that can be hidden"). Two shapes, same look as the Statistics cards:
 *   • <CardHead title="…">explanation</CardHead> — a card title with "▸ Notes" on the right
 *   • <Note>explanation</Note>                   — a small "▸ Notes" line on its own (under a chart, a list, …)
 * Numbers that change (today's values, warnings) stay OUTSIDE — only the standing explanation folds away.
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { useTheme } from '../theme';

const HIT = { top: 10, bottom: 10, left: 10, right: 10 };

export function CardHead({ title, children, titleStyle }: { title: string; children?: React.ReactNode; titleStyle?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const has = React.Children.toArray(children).filter(x => x !== '' && x != null).length > 0;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[{ color: c.text, fontSize: 15, fontWeight: '700' }, titleStyle, { flex: 1 }]} numberOfLines={1}>{title}</Text>
        {has && (
          <TouchableOpacity onPress={() => setOpen(o => !o)} hitSlop={HIT}>
            <Text style={{ color: c.textFaint, fontSize: 11.5, fontWeight: '700' }}>{open ? '▾ Notes' : '▸ Notes'}</Text>
          </TouchableOpacity>
        )}
      </View>
      {has && open && <Text style={{ color: c.textSub, fontSize: 11.5, lineHeight: 16, marginTop: 5 }}>{children}</Text>}
    </View>
  );
}

export function Note({ children, label = 'Notes', style }: { children?: React.ReactNode; label?: string; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const has = React.Children.toArray(children).filter(x => x !== '' && x != null).length > 0;
  if (!has) return null;
  return (
    <View style={[{ marginTop: 4 }, style]}>
      <TouchableOpacity onPress={() => setOpen(o => !o)} hitSlop={HIT} style={{ alignSelf: 'flex-start' }}>
        <Text style={{ color: c.textFaint, fontSize: 11.5, fontWeight: '700' }}>{open ? `▾ ${label}` : `▸ ${label}`}</Text>
      </TouchableOpacity>
      {open && <Text style={{ color: c.textSub, fontSize: 11.5, lineHeight: 16, marginTop: 3 }}>{children}</Text>}
    </View>
  );
}
