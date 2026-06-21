// A card for a synthesized cross-source story: neutral headline + dek, the
// outlets that fed it (as a lean-colored spread), and quick signals (contradiction
// count, recency). Tapping opens the full StoryReader.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import type { Story } from "../types";
import { leanColor } from "./ui";

/** Compact relative age, e.g. "3h" or "2d". */
function age(ms: number): string {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  if (h < 1) return "now";
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function StoryCard({ story, onOpen }: { story: Story; onOpen: (s: Story) => void }) {
  const m = topicMeta(story.topic);
  const outlets = story.sources.length;
  return (
    <Pressable
      style={styles.card}
      onPress={() => onOpen(story)}
      accessibilityRole="button"
      accessibilityLabel={`Open story: ${story.title}`}
    >
      <View style={styles.headRow}>
        <View style={[styles.topicPill, { backgroundColor: m.color + "22" }]}>
          <Ionicons name={m.icon} size={12} color={m.color} />
          <Text style={[styles.topicText, { color: m.color }]}>{m.label}</Text>
        </View>
        <View style={styles.synthTag}>
          <Ionicons name="git-merge-outline" size={11} color={colors.accent} />
          <Text style={styles.synthText}>Synthesis</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text style={styles.age}>{age(story.updatedAt)}</Text>
      </View>

      <Text style={styles.title}>{story.title}</Text>
      {!!story.summary && (
        <Text style={styles.summary} numberOfLines={3}>
          {story.summary}
        </Text>
      )}

      <View style={styles.footer}>
        {/* Lean spread: one dot per source, colored by its lean. */}
        <View style={styles.spread}>
          {story.sources.slice(0, 8).map((s, i) => (
            <View key={`${s.id}-${i}`} style={[styles.spreadDot, { backgroundColor: leanColor(s.lean) }]} />
          ))}
        </View>
        <Text style={styles.outlets}>
          {outlets} outlet{outlets === 1 ? "" : "s"}
        </Text>
        {story.contradictions.length > 0 && (
          <View style={styles.conflict}>
            <Ionicons name="flash-outline" size={11} color={colors.warn} />
            <Text style={styles.conflictText}>
              {story.contradictions.length} difference{story.contradictions.length === 1 ? "" : "s"}
            </Text>
          </View>
        )}
        {story.degraded && (
          <Text style={styles.degraded}>limited</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  headRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  topicPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  topicText: { fontSize: font.tiny, fontWeight: "700" },
  synthTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.accent + "18",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  synthText: { color: colors.accent, fontSize: font.tiny, fontWeight: "700" },
  age: { color: colors.textFaint, fontSize: font.tiny, fontWeight: "600" },
  title: { color: colors.text, fontSize: font.h3, fontWeight: "800", lineHeight: font.h3 * 1.3 },
  summary: { color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.45 },
  footer: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 2 },
  spread: { flexDirection: "row", alignItems: "center", gap: 3 },
  spreadDot: { width: 9, height: 9, borderRadius: 5 },
  outlets: { color: colors.textDim, fontSize: font.tiny, fontWeight: "700" },
  conflict: { flexDirection: "row", alignItems: "center", gap: 3 },
  conflictText: { color: colors.warn, fontSize: font.tiny, fontWeight: "700" },
  degraded: { color: colors.textFaint, fontSize: font.tiny, fontStyle: "italic" },
});
