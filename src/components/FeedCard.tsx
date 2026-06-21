// A single feed item card.

import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { topicMeta } from "../lib/topics";
import { useT } from "../store/AppContext";
import type { FeedItem, StoredSummary } from "../types";
import { ScorePill } from "./GradeFeedback";
import { IssueTag, LeanBadge } from "./ui";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Human "when": minutes/hours/days ago, then an absolute date past a week. */
export function whenLabel(ms: number, t: T): string {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.round(diff / 60000);
  if (mins < 60) return t("time.mAgo", { n: Math.max(1, mins) });
  const h = Math.round(diff / 3_600_000);
  if (h < 24) return t("time.hAgo", { n: h });
  const d = Math.round(h / 24);
  if (d <= 6) return t("time.dAgo", { n: d });
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** YouTube brand red, for the bespoke "found via YouTube search" tag. */
const YT_RED = "#FF3D33";

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
  const t = useT();
  const m = topicMeta(topic);
  return (
    <View style={[styles.topicPill, { borderColor: m.color, backgroundColor: m.color + "22" }]}>
      <Ionicons name={m.icon} size={12} color={m.color} />
      <Text style={[styles.topicPillText, { color: m.color }]}>{t(`topic.${topic}`)}</Text>
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
  issue,
  onOpenIssue,
}: {
  item: FeedItem;
  done: boolean;
  /** This reader's graded recall summary for the item, if any. */
  summary?: StoredSummary;
  /** Open the recall-summary gate (write / review). */
  onSummarize: (item: FeedItem) => void;
  onRead?: (item: FeedItem) => void;
  /** The ongoing issue this article belongs to (drives the severity-colored tag). */
  issue?: { id: string; title: string; severity: number };
  onOpenIssue?: (id: string) => void;
}) {
  const t = useT();
  const [imgError, setImgError] = useState(false);
  // Tapping the card opens the in-app reader (the article panel) — same behavior
  // as story cards. The original source is reachable from the reader's top-right
  // link. Falls back to the summarize gate if no reader handler is provided.
  const open = () => (onRead ? onRead(item) : onSummarize(item));
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
        {item.youtubeSearch && (
          <View style={styles.ytBadge}>
            <Ionicons name="logo-youtube" size={12} color={YT_RED} />
            <Text style={styles.ytText}>{t("card.youtube")}</Text>
          </View>
        )}
        {typeof item.relevance === "number" && <ScoreBadge relevance={item.relevance} />}
        <View style={{ flex: 1 }} />
        <LeanBadge lean={item.lean} source={item.leanSource} rationale={item.leanRationale} />
      </View>

      {issue && onOpenIssue && (
        <IssueTag title={issue.title} severity={issue.severity} onPress={() => onOpenIssue(issue.id)} />
      )}

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
        <Text style={styles.time}>{t("card.min", { n: item.estMinutes })}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.time}>{whenLabel(item.publishedAt, t)}</Text>
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
        <Pressable
          onPress={() => onSummarize(item)}
          style={[styles.doneBtn, done && styles.doneBtnActive]}
          accessibilityRole="button"
        >
          {summary ? (
            <>
              <ScorePill score={summary.grade.score} size="sm" />
              <Text style={[styles.doneText, done && { color: colors.good }]}>
                {done ? t("card.read") : t("card.revise")}
              </Text>
            </>
          ) : (
            <>
              <Ionicons name="create-outline" size={16} color={colors.accent} />
              <Text style={styles.doneText}>{t("card.summarizeToRead")}</Text>
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
  ytBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: YT_RED,
    backgroundColor: YT_RED + "1A",
  },
  ytText: { color: YT_RED, fontSize: font.tiny, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
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
    justifyContent: "flex-end",
    marginTop: spacing.xs,
  },
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
