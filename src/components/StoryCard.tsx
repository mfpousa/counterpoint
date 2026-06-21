// A card for a synthesized cross-source story: neutral headline + dek, the
// outlets that fed it (as a lean-colored spread), and quick signals (contradiction
// count, recency). Tapping opens the full StoryReader.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import type { Story } from "../types";
import { IssueTag, leanColor } from "./ui";

/** Compact relative age, e.g. "3h" or "2d". */
function age(ms: number): string {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  if (h < 1) return "now";
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function StoryCard({
  story,
  onOpen,
  issue,
  onOpenIssue,
}: {
  story: Story;
  onOpen: (s: Story) => void;
  /** The ongoing issue this story belongs to (severity-colored tag). */
  issue?: { id: string; title: string; severity: number };
  onOpenIssue?: (id: string) => void;
}) {
  const m = topicMeta(story.topic);
  const outlets = story.sources.length;
  const developing = !!story.developing;
  const events = story.timeline?.length ?? 0;
  return (
    <Pressable
      style={[styles.card, developing && styles.cardDeveloping]}
      onPress={() => onOpen(story)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${developing ? "developing issue" : "story"}: ${story.title}`}
    >
      <View style={styles.headRow}>
        <View style={[styles.topicPill, { backgroundColor: m.color + "22" }]}>
          <Ionicons name={m.icon} size={12} color={m.color} />
          <Text style={[styles.topicText, { color: m.color }]}>{m.label}</Text>
        </View>
        {developing ? (
          <View style={styles.developingTag}>
            <Ionicons name="pulse" size={11} color={colors.warn} />
            <Text style={styles.developingText}>Developing</Text>
          </View>
        ) : (
          <View style={styles.synthTag}>
            <Ionicons name="git-merge-outline" size={11} color={colors.accent} />
            <Text style={styles.synthText}>Synthesis</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        <Text style={styles.age}>{age(story.updatedAt)}</Text>
      </View>

      <Text style={styles.title}>{story.title}</Text>
      {!!story.summary && (
        <Text style={styles.summary} numberOfLines={3}>
          {story.summary}
        </Text>
      )}

      {issue && onOpenIssue && (
        <IssueTag title={issue.title} severity={issue.severity} onPress={() => onOpenIssue(issue.id)} />
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
        {developing && events > 0 && (
          <View style={styles.events}>
            <Ionicons name="time-outline" size={11} color={colors.textDim} />
            <Text style={styles.outlets}>{events} events</Text>
          </View>
        )}
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
  cardDeveloping: { borderColor: colors.warn + "66", borderLeftWidth: 3, borderLeftColor: colors.warn },
  developingTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.warn + "22",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  developingText: { color: colors.warn, fontSize: font.tiny, fontWeight: "800" },
  events: { flexDirection: "row", alignItems: "center", gap: 3 },
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
