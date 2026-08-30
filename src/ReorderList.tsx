// Generic drag-to-reorder + show/hide list for "Customise cards" sheets (Statistics, Biology, …).
// Self-contained: PanResponder + Animated only (no gesture-handler/reanimated dep). Rows are absolutely
// positioned at index·ROW_H; dragging one drives its translateY from the finger while the others animate to
// their shifted slots. The grip (≡) owns the pan so the Switch stays independently tappable. Order commits
// to the parent on release; toggles commit immediately. Generic over any { id: string; on: boolean } item.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Switch, PanResponder, Animated, StyleSheet } from 'react-native';
import { useThemedStyles, Palette } from './theme';

export interface ReorderItem { id: string; on: boolean }
export const REORDER_ROW_H = 46;

export function ReorderList<T extends ReorderItem>({ items, titleOf, onCommit, onDragActive }: {
  items: T[]; titleOf: (id: string) => string; onCommit: (next: T[]) => void;
  onDragActive?: (active: boolean) => void;   // parent disables its ScrollView while a drag is in progress
}) {
  const rs = useThemedStyles(makeReorder);
  const onDragActiveRef = useRef(onDragActive); onDragActiveRef.current = onDragActive;
  const [order, setOrder] = useState<T[]>(items);
  // Re-seed only when the incoming set genuinely differs (ignores our own committed round-trips, which are
  // byte-identical to the internal order and would otherwise fight an in-flight drag).
  useEffect(() => {
    setOrder(prev => {
      const same = prev.length === items.length && prev.every((p, i) => p.id === items[i].id && p.on === items[i].on);
      return same ? prev : items;
    });
  }, [items]);

  const orderRef = useRef(order);
  orderRef.current = order;

  const tops = useRef(new Map<string, Animated.Value>()).current;
  order.forEach((it, i) => { if (!tops.has(it.id)) tops.set(it.id, new Animated.Value(i * REORDER_ROW_H)); });

  const [dragId, setDragId] = useState<string | null>(null);
  const dragStartY = useRef(0);   // dragged row's slot-Y at grab; its live Y = this + gesture dy (index-independent)

  const settle = (arr: T[], exceptId?: string) => {
    arr.forEach((it, i) => {
      if (it.id === exceptId) return;
      Animated.timing(tops.get(it.id)!, { toValue: i * REORDER_ROW_H, duration: 140, useNativeDriver: false }).start();
    });
  };
  const drop = (id: string) => {
    const arr = orderRef.current;
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) Animated.timing(tops.get(id)!, { toValue: idx * REORDER_ROW_H, duration: 140, useNativeDriver: false }).start();
    setDragId(null);
    onDragActiveRef.current?.(false);   // re-enable the parent ScrollView
    onCommit(arr);
  };

  // One PanResponder per id, created once and reused across renders.
  const responders = useRef(new Map<string, ReturnType<typeof PanResponder.create>>()).current;
  order.forEach(it => {
    if (responders.has(it.id)) return;
    const id = it.id;
    responders.set(id, PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,   // win the touch on the grip before any ancestor
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,     // don't yield the drag once it has started
      onPanResponderGrant: () => {
        dragStartY.current = orderRef.current.findIndex(x => x.id === id) * REORDER_ROW_H;
        setDragId(id);
        onDragActiveRef.current?.(true);   // freeze the parent ScrollView so it can't steal the drag
      },
      onPanResponderMove: (_e, g) => {
        // Live Y is anchored to the grab slot + gesture delta — NOT the row's live index, which changes as we
        // reorder. Recomputing from the live index would snap the row a whole slot on each swap.
        const y = dragStartY.current + g.dy;
        tops.get(id)!.setValue(y);
        const arr = orderRef.current;
        const cur = arr.findIndex(x => x.id === id);
        let to = Math.round(y / REORDER_ROW_H);
        to = Math.max(0, Math.min(arr.length - 1, to));
        if (cur >= 0 && to !== cur) {
          const next = arr.slice();
          const [moved] = next.splice(cur, 1);
          next.splice(to, 0, moved);
          orderRef.current = next;
          setOrder(next);
          settle(next, id);  // dragged row stays under the finger; the rest slide
        }
      },
      onPanResponderRelease: () => drop(id),
      onPanResponderTerminate: () => drop(id),
    }));
  });

  const toggle = (id: string) => {
    const next = orderRef.current.map(x => x.id === id ? { ...x, on: !x.on } : x) as T[];
    orderRef.current = next;
    setOrder(next);
    onCommit(next);
  };

  return (
    <View style={{ height: order.length * REORDER_ROW_H }}>
      {order.map(it => {
        const dragging = dragId === it.id;
        return (
          <Animated.View
            key={it.id}
            style={[rs.row, { height: REORDER_ROW_H, transform: [{ translateY: tops.get(it.id)! }], zIndex: dragging ? 10 : 1, elevation: dragging ? 6 : 0 }, dragging && rs.rowDragging]}
          >
            <View {...responders.get(it.id)!.panHandlers} style={rs.grip}>
              <Text style={rs.gripDots}>≡</Text>
            </View>
            <Text style={[rs.label, !it.on && rs.labelOff]} numberOfLines={1}>{titleOf(it.id)}</Text>
            <Switch value={it.on} onValueChange={() => toggle(it.id)} />
          </Animated.View>
        );
      })}
    </View>
  );
}

const makeReorder = (c: Palette) => StyleSheet.create({
  row: {
    position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingRight: 4,
    backgroundColor: c.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.gridline,
  },
  rowDragging: {
    borderBottomWidth: 0, borderRadius: 12, backgroundColor: c.surfaceAlt,
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  grip: { paddingHorizontal: 12, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  gripDots: { fontSize: 22, color: c.textFaint, fontWeight: '800' },
  label: { flex: 1, fontSize: 15, color: c.text, marginLeft: 2 },
  labelOff: { color: c.textSub },
});
