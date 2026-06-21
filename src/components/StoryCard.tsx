// A card for a synthesized cross-source story: neutral headline + dek, the
// outlets that fed it (as a lean-colored spread), and quick signals (contradiction
// count, recency). Tapping opens the full StoryReader.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import { storyChange } from "../lib/storyUpdates";
import { useApp, useT } from "../store/AppContext";
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
  const t = useT();
  const { storyViews } = useApp();
  const m = topicMeta(story.topic);
  const outlets = story.sources.length;
  const developing = !!story.developing;
  const events = story.timeline?.length ?? 0;
  // What changed since the reader last opened this story (new coverage).
  const change = storyChange(story, storyViews[story.id]);
  return (
    <View style={[styles.card, developing && styles.cardDeveloping, change.hasUpdates && styles.cardUpdated]}>
      <Pressable
        style={styles.body}
        onPress={() => onOpen(story)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${developing ? "developing issue" : "story"}: ${story.title}`}
      >
      <View style={styles.headRow}>
        <View style={[styles.topicPill, { backgroundColor: m.color + "22" }]}>
          <Ionicons name={m.icon} size={12} color={m.color} />
          <Text style={[styles.topicText, { color: m.color }]}>{t(`topic.${story.topic}`)}</Text>
        </View>
        {developing ? (
          <View style={styles.developingTag}>
            <Ionicons name="pulse" size={11} color={colors.warn} />
            <Text style={styles.developingText}>{t("story.developing")}</Text>
          </View>
        ) : (
          <View style={styles.synthTag}>
            <Ionicons name="git-merge-outline" size={11} color={colors.accent} />
            <Text style={styles.synthText}>{t("story.synthesis")}</Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        {change.hasUpdates && (
          <View style={styles.newBadge} accessibilityLabel={t("story.updatedA11y")}>
            <View style={styles.newDot} />
            <Text style={styles.newText}>
              {change.newSources > 0
                ? t(change.newSources === 1 ? "story.newArticlesOne" : "story.newArticles", {
                    count: change.newSources,
                  })
                : t("story.updated")}
            </Text>
          </View>
        )}
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
          {t(outlets === 1 ? "story.outletsOne" : "story.outlets", { count: outlets })}
        </Text>
        {developing && events > 0 && (
          <View style={styles.events}>
            <Ionicons name="time-outline" size={11} color={colors.textDim} />
            <Text style={styles.outlets}>{t("story.events", { count: events })}</Text>
          </View>
        )}
        {story.contradictions.length > 0 && (
          <View style={styles.conflict}>
            <Ionicons name="flash-outline" size={11} color={colors.warn} />
            <Text style={styles.conflictText}>
              {t(
                story.contradictions.length === 1 ? "story.differencesOne" : "story.differences",
                { count: story.contradictions.length },
              )}
            </Text>
          </View>
        )}
        {story.degraded && (
          <Text style={styles.degraded}>{t("story.limited")}</Text>
        )}
      </View>
      </Pressable>

      {issue && onOpenIssue && (
        <IssueTag title={issue.title} severity={issue.severity} onPress={() => onOpenIssue(issue.id)} />
      )}
    </View>
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
  cardUpdated: { borderColor: colors.accent + "99" },
  newBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.accent + "22",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  newDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  newText: { color: colors.accent, fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  body: { gap: spacing.sm },
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
