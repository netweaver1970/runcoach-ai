import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';

// LLM answers mix prose with GFM tables. react-native-markdown-display renders tables with flex cells
// that either share the screen width (columns crushed, text wraps) or, with fixed widths, need a nested
// horizontal ScrollView that fights the chat's vertical scroll ("teleport" jumps). Instead we render
// tables OURSELVES: split the markdown into prose + table blocks, hand prose to the library, and lay
// tables out as a plain View grid with TIGHT, per-column, content-sized widths so columns stay aligned
// AND the whole table is as narrow as possible — it usually fits in portrait, and always in landscape,
// with no nested scrolling.

type Seg =
  | { type: 'md'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] };

const isSepRow = (line: string) =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function parseSegments(content: string): Seg[] {
  const lines = (content ?? '').split('\n');
  const segs: Seg[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) { segs.push({ type: 'md', text: buf.join('\n') }); buf = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    // A GFM table = a header row containing '|' immediately followed by a |---|---| separator.
    if (line.includes('|') && isSepRow(next)) {
      flush();
      const header = splitCells(line);
      const rows: string[][] = [];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitCells(lines[i]));
        i++;
      }
      i--; // step back so the for-loop's i++ lands on the next unconsumed line
      segs.push({ type: 'table', header, rows });
    } else {
      buf.push(line);
    }
  }
  flush();
  return segs;
}

// Strip the inline markdown a cell might carry; report whether the whole cell was bold (**…**).
function cellText(raw: string): { text: string; bold: boolean } {
  const t = raw.trim();
  const bold = /^\*\*[\s\S]+\*\*$/.test(t);
  const text = t.replace(/\*\*/g, '').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/`/g, '');
  return { text: text.trim(), bold };
}

const TFS = 11;          // table font size
const PAD = 6;           // cell horizontal padding (each side)
const COL_MIN = 38;      // narrowest a column may be (short numeric columns)
const COL_MAX = 132;     // widest before the cell is allowed to wrap instead of growing

// Rough text-width estimate (no measuring pass): letters/digits ~0.56em, spaces ~0.3em, arrows/emoji ~1.15em.
function estWidth(text: string, bold: boolean): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === ' ') w += TFS * 0.3;
    else if (cp > 0x2100) w += TFS * 1.15;              // arrows, symbols, emoji
    else w += TFS * (bold ? 0.6 : 0.56);
  }
  return w;
}

function columnWidths(header: string[], rows: string[][]): number[] {
  const n = Math.max(header.length, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < n; c++) {
    const h = cellText(header[c] ?? '');
    let max = estWidth(h.text, true);
    for (const r of rows) {
      const cell = cellText(r[c] ?? '');
      const w = estWidth(cell.text, cell.bold);
      if (w > max) max = w;
    }
    widths.push(Math.round(Math.min(COL_MAX, Math.max(COL_MIN, max)) + PAD * 2));
  }
  return widths;
}

interface Palette { text: string; textSub: string; border: string; surfaceAlt: string; }

function MdTable({ header, rows, c }: { header: string[]; rows: string[][]; c: Palette }) {
  const widths = columnWidths(header, rows);
  const total = widths.reduce((a, b) => a + b, 0);
  // Measure the width actually available (fills the parent). A table WIDER than that must NOT be left to
  // overflow — a child wider than a vertical ScrollView makes the scroll view horizontally scrollable too,
  // and that dual-axis overflow is what makes the page jitter/"dance" when you drag near the table. So when
  // it overflows we put the table in its OWN horizontal ScrollView BOUNDED to the available width
  // (directionalLockEnabled → vertical drags pass through to the page), keeping the vertical scroll clean.
  const [avail, setAvail] = useState(0);
  const Cell = (raw: string, ci: number, head: boolean) => {
    const { text, bold } = cellText(raw ?? '');
    return (
      <View key={ci} style={[s.cell, { width: widths[ci], borderColor: c.border }]}>
        <Text style={{ fontSize: TFS, color: c.text, fontWeight: head || bold ? '700' : '400' }}>{text}</Text>
      </View>
    );
  };
  const grid = (
    <View style={[s.table, { borderColor: c.border, width: total }]}>
      <View style={[s.row, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}>
        {header.map((h, ci) => Cell(h, ci, true))}
      </View>
      {rows.map((r, ri) => (
        <View key={ri} style={[s.row, { borderColor: c.border }]}>
          {widths.map((_, ci) => Cell(r[ci] ?? '', ci, false))}
        </View>
      ))}
    </View>
  );
  const overflow = avail > 0 && total > avail;
  return (
    <View
      style={s.tableWrap}
      onLayout={e => { const w = Math.round(e.nativeEvent.layout.width); if (Math.abs(w - avail) > 1) setAvail(w); }}
    >
      {overflow ? (
        <ScrollView horizontal directionalLockEnabled nestedScrollEnabled showsHorizontalScrollIndicator style={{ width: avail }}>
          {grid}
        </ScrollView>
      ) : grid}
    </View>
  );
}

// Drop-in replacement for <Markdown style rules>{content}</Markdown> that renders tables as tight grids.
export default function MarkdownBody({
  content, style, rules, c,
}: {
  content: string;
  style: any;
  rules?: any;
  c: Palette;
}) {
  const segs = parseSegments(content);
  return (
    <>
      {segs.map((seg, i) =>
        seg.type === 'md'
          ? (seg.text.trim() ? <Markdown key={i} style={style} rules={rules}>{seg.text}</Markdown> : null)
          : <MdTable key={i} header={seg.header} rows={seg.rows} c={c} />,
      )}
    </>
  );
}

const s = StyleSheet.create({
  tableWrap: { marginVertical: 6 },
  table: { borderWidth: 1, borderRadius: 6, overflow: 'hidden' },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: PAD, paddingVertical: 5, borderRightWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
});
