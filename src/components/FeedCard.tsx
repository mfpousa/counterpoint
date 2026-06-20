// A single feed item card.

import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import type { FeedItem } from "../types";
import { Chip, LeanBadge } from "./ui";

const KIND_ICON: Record<FeedItem["kind"], keyof typeof Ionicons.glyphMap> = {
  video: "play-circle",
  podcast: "mic",
  news: "newspaper",
};

export function FeedCard({
  item,
  done,
  onComplete,
}: {
  item: FeedItem;
  done: boolean;
  onComplete: (item: FeedItem) => void;
}) {
  const open = () => {
    void Linking.openURL(item.url);
  };

  return (
    <View style={[styles.card, done && styles.cardDone]}>
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
        <View style={styles.chips}>
          <LeanBadge lean={item.lean} source={item.leanSource} />
          <Chip label={item.topic} />
          {typeof item.relevance === "number" && (
            <Chip label={`★ ${Math.round(item.relevance * 100)}`} />
          )}
        </View>
        <Pressable
          onPress={() => onComplete(item)}
          style={[styles.doneBtn, done && styles.doneBtnActive]}
          accessibilityRole="button"
          disabled={done}
        >
          <Ionicons
            name={done ? "checkmark-circle" : "checkmark-circle-outline"}
            size={16}
            color={done ? colors.good : colors.accent}
          />
          <Text style={[styles.doneText, done && { color: colors.good }]}>
            {done ? "Done" : "Mark done"}
          </Text>
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
