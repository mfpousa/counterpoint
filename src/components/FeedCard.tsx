// A single feed item card.

import React, { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import type { FeedItem, StoredSummary } from "../types";
import { ScorePill } from "./GradeFeedback";
import { LeanBadge } from "./ui";

const KIND_ICON: Record<FeedItem["kind"], keyof typeof Ionicons.glyphMap> = {
  video: "play-circle",
  podcast: "mic",
  news: "newspaper",
};

/** Color for a 0..1 relevance score: faint -> warn -> accent -> good. */
function scoreColor(r: number): string {
  if (r >= 0.75) return colors.good;
  if (r >= 0.5) return colors.accent;
  if (r >= 0.3) return colors.warn;
  return colors.textFaint;
}

/** A bold, colored topic pill (icon + label) for at-a-glance scanning. */
function TopicPill({ topic }: { topic: FeedItem["topic"] }) {
  const m = topicMeta(topic);
  return (
    <View style={[styles.topicPill, { borderColor: m.color, backgroundColor: m.color + "22" }]}>
      <Ionicons name={m.icon} size={12} color={m.color} />
      <Text style={[styles.topicPillText, { color: m.color }]}>{m.label}</Text>
    </View>
  );
}

/** A prominent relevance/match score badge (0..100). */
function ScoreBadge({ relevance }: { relevance: number }) {
  const pct = Math.round(relevance * 100);
  const c = scoreColor(relevance);
  return (
    <View style={[styles.scoreBadge, { borderColor: c }]}>
      <Ionicons name="flame" size={11} color={c} />
      <Text style={[styles.scoreText, { color: c }]}>{pct}</Text>
    </View>
  );
}

export function FeedCard({
  item,
  done,
  summary,
  onSummarize,
  onRead,
}: {
  item: FeedItem;
  done: boolean;
  /** This reader's graded recall summary for the item, if any. */
  summary?: StoredSummary;
  /** Open the recall-summary gate (write / review). */
  onSummarize: (item: FeedItem) => void;
  onRead?: (item: FeedItem) => void;
}) {
  const [imgError, setImgError] = useState(false);
  const open = () => {
    void Linking.openURL(item.url);
  };
  const showThumb = !!item.thumbnail && !imgError;

  return (
    <View style={[styles.card, done && styles.cardDone]}>
      {showThumb && (
        <Pressable onPress={open} accessibilityRole="link">
          <Image
            source={{ uri: item.thumbnail }}
            style={styles.thumb}
            resizeMode="cover"
            onError={() => setImgError(true)}
          />
          <View style={styles.thumbKind}>
            <Ionicons name={KIND_ICON[item.kind]} size={12} color={colors.text} />
          </View>
        </Pressable>
      )}

      <View style={styles.tagRow}>
        <TopicPill topic={item.topic} />
        {typeof item.relevance === "number" && <ScoreBadge relevance={item.relevance} />}
        <View style={{ flex: 1 }} />
        <LeanBadge lean={item.lean} source={item.leanSource} rationale={item.leanRationale} />
      </View>

      {(item.reason || item.aiReason) && (
        <View style={styles.reasonRow}>
          <Ionicons name="sparkles-outline" size={12} color={colors.accent} />
          <Text style={styles.reason} numberOfLines={2}>
            {item.reason || item.aiReason}
          </Text>
        </View>
      )}

      <View style={styles.metaRow}>
        <Ionicons name={KIND_ICON[item.kind]} size={14} color={colors.textDim} />
        <Text style={styles.source} numberOfLines={1}>
          {item.sourceTitle}
        </Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.time}>{item.estMinutes} min</Text>
      </View>

      <Pressable onPress={open} accessibilityRole="link">
        <Text style={[styles.title, done && styles.titleDone]} numberOfLines={3}>
          {item.title}
        </Text>
      </Pressable>

      {!!item.summary && (
        <Text style={styles.summary} numberOfLines={2}>
          {item.summary}
        </Text>
      )}

      {!!item.aiReason && item.aiReason !== item.reason && (
        <View style={styles.aiNoteRow}>
          <Ionicons name="bulb-outline" size={12} color={colors.textDim} />
          <Text style={styles.aiNote} numberOfLines={2}>
            {item.aiReason}
          </Text>
        </View>
      )}

      <View style={styles.footer}>
        {onRead ? (
          <Pressable
            onPress={() => onRead(item)}
            style={styles.readBtn}
            accessibilityRole="button"
          >
            <Ionicons name="sparkles-outline" size={15} color={colors.accent} />
            <Text style={styles.readText}>Read in app</Text>
          </Pressable>
        ) : (
          <View style={styles.chips} />
        )}
        <Pressable
          onPress={() => onSummarize(item)}
          style={[styles.doneBtn, done && styles.doneBtnActive]}
          accessibilityRole="button"
        >
          {summary ? (
            <>
              <ScorePill score={summary.grade.score} size="sm" />
              <Text style={[styles.doneText, done && { color: colors.good }]}>
                {done ? "Read" : "Revise"}
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="create-outline" size={16} color={colors.accent} />
              <Text style={styles.doneText}>Summarize to mark read</Text>
            </>
          )}
        </Pressable>
      </View>
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
  cardDone: { opacity: 0.55 },
  thumb: {
    width: "100%",
    height: 156,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  thumbKind: {
    position: "absolute",
    top: spacing.sm,
    left: spacing.sm,
    backgroundColor: "rgba(14,17,22,0.72)",
    borderRadius: radius.pill,
    padding: spacing.xs,
  },
  tagRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  topicPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  topicPillText: { fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  scoreBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  scoreText: { fontSize: font.tiny, fontWeight: "800" },
  reasonRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  reason: { color: colors.accent, fontSize: font.tiny, fontWeight: "600", flexShrink: 1 },
  aiNoteRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.xs },
  aiNote: { color: colors.textDim, fontSize: font.small, lineHeight: 18, flexShrink: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  source: { color: colors.textDim, fontSize: font.small, fontWeight: "600", flexShrink: 1 },
  dot: { color: colors.textFaint },
  time: { color: colors.textDim, fontSize: font.small },
  title: { color: colors.text, fontSize: font.h3, fontWeight: "700", lineHeight: 24 },
  titleDone: { textDecorationLine: "line-through" },
  summary: { color: colors.textDim, fontSize: font.small, lineHeight: 19 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  chips: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  readBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  readText: { color: colors.accent, fontSize: font.small, fontWeight: "600" },
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  doneBtnActive: { borderColor: colors.good },
  doneText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
});
