// Shared rendering of a summary grade: a score pill plus the teaching feedback
// (what you got right, what you missed, what was off, and the lesson). Used by
// the SummaryModal and the Learn tab so they stay visually consistent.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { PASS_SCORE } from "../lib/knowledge";
import type { SummaryGrade } from "../types";

/** Color for a 0..100 score: danger -> warn -> accent -> good. */
export function scoreColor(score: number): string {
  if (score >= 85) return colors.good;
  if (score >= PASS_SCORE) return colors.accent;
  if (score >= 50) return colors.warn;
  return colors.danger;
}

export function ScorePill({ score, size = "md" }: { score: number; size?: "sm" | "md" }) {
  const c = scoreColor(score);
  const passed = score >= PASS_SCORE;
  return (
    <View style={[styles.pill, size === "sm" && styles.pillSm, { borderColor: c }]}>
      <Ionicons name={passed ? "checkmark-circle" : "alert-circle"} size={size === "sm" ? 12 : 14} color={c} />
      <Text style={[styles.pillText, size === "sm" && styles.pillTextSm, { color: c }]}>{score}</Text>
    </View>
  );
}

function FeedbackList({
  icon,
  color,
  title,
  items,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.block}>
      <View style={styles.blockHeader}>
        <Ionicons name={icon} size={14} color={color} />
        <Text style={[styles.blockTitle, { color }]}>{title}</Text>
      </View>
      {items.map((it, i) => (
        <View key={i} style={styles.row}>
          <Text style={[styles.bullet, { color }]}>•</Text>
          <Text style={styles.rowText}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

export function GradeFeedback({ grade }: { grade: SummaryGrade }) {
  return (
    <View style={{ gap: spacing.md }}>
      {!!grade.verdict && <Text style={styles.verdict}>{grade.verdict}</Text>}
      <FeedbackList icon="checkmark-circle-outline" color={colors.good} title="You got right" items={grade.correct} />
      <FeedbackList icon="add-circle-outline" color={colors.warn} title="You missed" items={grade.missed} />
      <FeedbackList icon="close-circle-outline" color={colors.danger} title="Not quite" items={grade.inaccuracies} />
      {!!grade.lesson && (
        <View style={styles.lesson}>
          <Ionicons name="school-outline" size={16} color={colors.accent} />
          <Text style={styles.lessonText}>{grade.lesson}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },
  pillSm: { paddingHorizontal: 6, paddingVertical: 2 },
  pillText: { fontSize: font.body, fontWeight: "800" },
  pillTextSm: { fontSize: font.tiny },
  verdict: { color: colors.text, fontSize: font.body, fontWeight: "600", lineHeight: font.body * 1.4 },
  block: { gap: spacing.xs },
  blockHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  blockTitle: { fontSize: font.small, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  row: { flexDirection: "row", gap: spacing.sm, paddingLeft: spacing.xs },
  bullet: { fontSize: font.body, lineHeight: font.small * 1.5 },
  rowText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: font.small * 1.5 },
  lesson: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.accent + "14",
    borderColor: colors.accent + "44",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  lessonText: { flex: 1, color: colors.text, fontSize: font.small, lineHeight: font.small * 1.5 },
});
