// The daily AI briefing: a synthesized read on what's happening now and where
// things are headed, tuned to the reader's interest. Rendered at the top of the
// Today screen. Quietly hides itself when there's nothing to show.

import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Briefing } from "../types";
import { Typewriter } from "./anim";
import { colors, font, radius, spacing } from "../theme";

export function BriefingCard({
  briefing,
  loading,
}: {
  briefing: Briefing | null;
  loading: boolean;
}) {
  // While first synthesizing (and we have nothing yet), show a calm placeholder.
  if (loading && !briefing) {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Ionicons name="sparkles" size={16} color={colors.accent} />
          <Text style={styles.heading}>Briefing</Text>
        </View>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.loadingText}>Synthesizing today’s briefing…</Text>
        </View>
      </View>
    );
  }

  if (!briefing) return null;
  const { mood, threads, outlook, interest } = briefing;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="sparkles" size={16} color={colors.accent} />
        <Text style={styles.heading}>Briefing</Text>
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

      {mood.length > 0 && <Typewriter text={mood} cps={260} style={styles.mood} />}

      {threads.length > 0 && (
        <View style={styles.threads}>
          {threads.map((t, i) => (
            <View key={i} style={styles.threadRow}>
              <View style={styles.dot} />
              <Text style={styles.threadText}>
                {t.title.length > 0 && <Text style={styles.threadTitle}>{t.title}: </Text>}
                {/* Nested in <Text>, so no animated cursor here. */}
                <Typewriter text={t.detail} cps={260} cursor={false} />
              </Text>
            </View>
          ))}
        </View>
      )}

      {outlook.length > 0 && (
        <View style={styles.outlookRow}>
          <Ionicons name="trending-up" size={14} color={colors.good} />
          <Text style={styles.outlookText}>
            <Text style={styles.outlookLabel}>Where it’s headed: </Text>
            <Typewriter text={outlook} cps={260} cursor={false} />
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
  },
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
