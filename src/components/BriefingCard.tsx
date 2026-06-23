// The daily AI briefing: a synthesized read on what's happening now and where
// things are headed, tuned to the reader's interest. Rendered at the top of the
// Today screen. Quietly hides itself when there's nothing to show.

import React, { useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Briefing } from "../types";
import { Cursor } from "./anim";
import { getBriefingStream, subscribeBriefingStream } from "../lib/briefingStream";
import { Skeleton } from "./Skeleton";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";

export function BriefingCard({
  briefing,
  loading,
}: {
  briefing: Briefing | null;
  loading: boolean;
}) {
  const t = useT();
  // Live token stream subscribed in ISOLATION (see lib/briefingStream): only this
  // card re-renders as tokens arrive — never the whole Today screen.
  const stream = useSyncExternalStore(
    subscribeBriefingStream,
    getBriefingStream,
    getBriefingStream,
  );
  // No briefing yet: keep the SAME reserved footprint (minHeight). While the model
  // writes, show its tokens live with a single top-to-bottom cursor; before any
  // token arrives, show a skeleton so the cards below don't jump when it lands.
  if (!briefing) {
    const lines = stream
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Ionicons name="sparkles" size={16} color={colors.accent} />
          <Text style={styles.heading}>{t("briefing.title")}</Text>
          {loading && <ActivityIndicator size="small" color={colors.accent} />}
        </View>
        {lines.length > 0 ? (
          <View style={styles.streamBox}>
            {lines.map((line, i) => (
              <Text key={i} style={styles.streamLine}>
                {line}
                {i === lines.length - 1 ? <Cursor /> : null}
              </Text>
            ))}
          </View>
        ) : loading ? (
          <View style={styles.skeleton}>
            <Skeleton width="65%" height={18} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="94%" height={12} />
            <Skeleton width="78%" height={12} />
          </View>
        ) : (
          <Text style={styles.loadingText}>{t("briefing.unavailable")}</Text>
        )}
      </View>
    );
  }
  const { mood, threads, outlook, interest } = briefing;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="sparkles" size={16} color={colors.accent} />
        <Text style={styles.heading}>{t("briefing.title")}</Text>
        {interest.length > 0 && (
          <View style={styles.interestPill}>
            <Ionicons name="navigate" size={11} color={colors.accent} />
            <Text style={styles.interestText} numberOfLines={1}>
              {interest}
            </Text>
          </View>
        )}
        {loading && <ActivityIndicator size="small" color={colors.accent} />}
      </View>

      {mood.length > 0 && <Text style={styles.mood}>{mood}</Text>}

      {threads.length > 0 && (
        <View style={styles.threads}>
          {threads.map((thread, i) => (
            <View key={i} style={styles.threadRow}>
              <View style={styles.dot} />
              <Text style={styles.threadText}>
                {thread.title.length > 0 && <Text style={styles.threadTitle}>{thread.title}: </Text>}
                {thread.detail}
              </Text>
            </View>
          ))}
        </View>
      )}

      {outlook.length > 0 && (
        <View style={styles.outlookRow}>
          <Ionicons name="trending-up" size={14} color={colors.good} />
          <Text style={styles.outlookText}>
            <Text style={styles.outlookLabel}>{t("briefing.headed")}</Text>
            {outlook}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accentDim,
    backgroundColor: colors.surface,
    // Reserve a stable footprint so the feed below doesn't jump when the briefing
    // finishes loading (the reader may be mid-tap on a card).
    minHeight: 132,
  },
  skeleton: { gap: spacing.sm, marginTop: spacing.xs },
  streamBox: { gap: spacing.xs, marginTop: spacing.xs },
  streamLine: { color: colors.textDim, fontSize: font.body, lineHeight: 21 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  heading: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    flex: 1,
  },
  interestPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  interestText: { color: colors.accent, fontSize: font.tiny, fontWeight: "700", flexShrink: 1 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  loadingText: { color: colors.textDim, fontSize: font.small },
  mood: { color: colors.text, fontSize: font.h3, fontWeight: "700", lineHeight: 24 },
  threads: { gap: spacing.sm, marginTop: spacing.xs },
  threadRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 7,
  },
  threadText: { color: colors.textDim, fontSize: font.body, lineHeight: 21, flex: 1 },
  threadTitle: { color: colors.text, fontWeight: "700" },
  outlookRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  outlookText: { color: colors.textDim, fontSize: font.small, lineHeight: 19, flex: 1 },
  outlookLabel: { color: colors.good, fontWeight: "700" },
});
