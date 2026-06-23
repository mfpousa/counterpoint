// The articles surface for the globe-first home — a Google-Maps-style reveal that
// keeps the globe as the branding anchor:
//   - WIDE (desktop): a translucent panel that slides in from the RIGHT when a place
//     is chosen, and slides out on close (the globe stays visible behind it).
//   - NARROW (mobile): a bottom SHEET that first "peeks" as a pull tab (so the reader
//     can keep searching), expands when tapped, and collapses back when dismissed.
//
// Presentational only: the feed content is passed as `children`, so all the feed's
// state/handlers stay in the Today screen. State is driven by the parent:
//   "hidden" → gone   |   "peek" → mobile pull tab   |   "open" → full panel.

import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";

export type PanelState = "hidden" | "peek" | "open";

const PEEK_H = 80;

export function ArticlesPanel({
  state,
  wide,
  width,
  topInset = 0,
  peekTitle,
  peekSubtitle,
  refreshing,
  onRefresh,
  onExpand,
  onClose,
  children,
}: {
  state: PanelState;
  wide: boolean;
  width: number;
  topInset?: number;
  peekTitle: string;
  peekSubtitle?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  onExpand: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { height } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current; // 0 = closed/peek, 1 = open
  const open = state === "open";
  const sheetH = Math.round(height * 0.86);
  const travel = sheetH - PEEK_H; // px the sheet slides between peek and open
  const dragStart = useRef(0); // anim progress (0..1) when a drag begins

  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: 280,
      useNativeDriver: true,
    }).start();
  }, [open, anim]);

  // Drag the handle to pull the sheet up / push it down; a near-stationary release is
  // treated as a TAP (toggle). The sheet follows the finger live, then snaps on release.
  const sheetPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
        onPanResponderGrant: () => {
          dragStart.current = open ? 1 : 0;
        },
        onPanResponderMove: (_e, g) => {
          const p = Math.min(1, Math.max(0, dragStart.current + -g.dy / travel));
          anim.setValue(p);
        },
        onPanResponderRelease: (_e, g) => {
          const tap = Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6;
          const p = Math.min(1, Math.max(0, dragStart.current + -g.dy / travel));
          const goOpen = tap ? !open : p > 0.5 || g.vy < -0.5;
          Animated.timing(anim, {
            toValue: goOpen ? 1 : 0,
            duration: 200,
            useNativeDriver: true,
          }).start();
          if (goOpen) onExpand();
          else onClose();
        },
      }),
    [open, travel, anim, onExpand, onClose],
  );

  const refresh = onRefresh ? (
    <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
  ) : undefined;

  // DESKTOP: always mounted; slides in/out from the right (off-screen when not open).
  if (wide) {
    const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [width + 24, 0] });
    return (
      <>
        <Animated.View
          style={[styles.deskPanel, { width, transform: [{ translateX }] }]}
          pointerEvents={open ? "auto" : "none"}
        >
          <View style={[styles.header, { paddingTop: topInset + spacing.sm }]}>
            <Text style={styles.title} numberOfLines={1}>
              {peekTitle}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn} accessibilityRole="button">
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} refreshControl={refresh}>
            {children}
          </ScrollView>
        </Animated.View>
        {/* Desktop has no peek state, so when closed leave a tab on the right edge to
            REOPEN the panel (otherwise it slides off-screen with no way back). */}
        {!open && (
          <Pressable
            style={styles.reopenTab}
            onPress={onExpand}
            accessibilityRole="button"
            accessibilityLabel="Open articles"
          >
            <Ionicons name="chevron-back" size={16} color={colors.textDim} />
            <Ionicons name="newspaper" size={15} color={colors.accent} />
            <Text style={styles.reopenText} numberOfLines={1}>
              {peekTitle}
            </Text>
          </Pressable>
        )}
      </>
    );
  }

  // MOBILE: gone entirely when hidden; otherwise a bottom sheet that peeks or opens.
  if (state === "hidden") return null;
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });
  return (
    <Animated.View style={[styles.sheet, { height: sheetH, transform: [{ translateY }] }]}>
      <View
        style={styles.peek}
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse articles" : "Open articles"}
        {...sheetPan.panHandlers}
      >
        <View style={styles.grabber} />
        <View style={styles.peekRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {peekTitle}
            </Text>
            {!!peekSubtitle && (
              <Text style={styles.peekSub} numberOfLines={1}>
                {peekSubtitle}
              </Text>
            )}
          </View>
          <Ionicons name={open ? "chevron-down" : "chevron-up"} size={20} color={colors.textDim} />
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        scrollEnabled={open}
        refreshControl={refresh}
      >
        {children}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  deskPanel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg + "F0",
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg + "F4",
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, color: colors.text, fontSize: font.h3, fontWeight: "800" },
  reopenTab: {
    position: "absolute",
    right: 0,
    top: "42%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: 220,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopLeftRadius: radius.pill,
    borderBottomLeftRadius: radius.pill,
    backgroundColor: colors.bg + "F2",
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: colors.border,
  },
  reopenText: { color: colors.text, fontSize: font.small, fontWeight: "700", flexShrink: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  peek: { height: PEEK_H, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  peekRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  peekSub: { color: colors.textDim, fontSize: font.small, marginTop: 1 },
  scroll: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
});
