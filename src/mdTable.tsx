import React from 'react';
import { ScrollView, View } from 'react-native';

// Markdown tables from the LLM (run structure, prescription checks, run comparisons) have many columns.
// react-native-markdown-display lays them out with flex:1 cells that SHARE the screen width, so every
// column gets squeezed and the text wraps into unreadable stacks ("Powe r", "not cleari ng"). Instead:
// give each cell a FIXED width (keeps columns aligned across rows) and wrap the whole table in a
// HORIZONTAL ScrollView so a wide table scrolls sideways instead of crushing. Font is shrunk via the
// stylesheet's th/td fontSize (the library cascades a cell's text props down to its inner <Text>).

export const TABLE_COL_W = 92;                       // per-column width; 6 cols ≈ 552px → scrolls on a phone
// Spread into a stylesheet's `th`/`td` to override the library's default flex:1 with a fixed width.
export const TABLE_CELL = { flex: 0 as const, width: TABLE_COL_W, minWidth: TABLE_COL_W };

// Custom `table` rule: render the table inside a horizontal ScrollView. The border/radius live on the
// inner View (styles._VIEW_SAFE_table) so they wrap the real table width, not the viewport.
export const scrollableTableRules = {
  table: (node: any, children: React.ReactNode, _parent: any, styles: any) => (
    <ScrollView
      key={node.key}
      horizontal
      showsHorizontalScrollIndicator
      bounces={false}
      contentContainerStyle={{ flexGrow: 0 }}
    >
      <View style={styles._VIEW_SAFE_table}>{children}</View>
    </ScrollView>
  ),
};
