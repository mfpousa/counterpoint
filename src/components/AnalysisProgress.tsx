// A compact live indicator of the backend's analysis pipeline, shown on the
// Today screen while the model works through the feed. Renders nothing when the
// backend is idle with no pending backlog.

import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { AnalysisStatus } from "../types";
import { useT } from "../store/AppContext";
import { colors, font, radius, spacing } from "../theme";

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, done / total));
}

export function AnalysisProgress({ status }: { status: AnalysisStatus | null }) {
  const t = useT();
  if (!status) return null;
  const { phase, active, done, total, pending, analyzed } = status;
  // Nothing happening and no backlog — stay out of the way.
  if (!active && pending === 0) return null;
  const phaseLabel = t(`analysis.${phase}`);

  const overallTotal = analyzed + pending;
  // Prefer the in-pass bar when we have one; otherwise fall back to overall.
  const ratio = total > 0 ? pct(done, total) : pct(analyzed, overallTotal);
  const showPassCount = total > 0 && (phase === "analyzing" || phase === "triage");

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <ActivityIndicator size="small" color={colors.accent} />
        <Text style={styles.label}>{phaseLabel}</Text>
        <Text style={styles.count}>
          {overallTotal > 0
            ? t("analysis.analyzed", {
                done: analyzed.toLocaleString(),
                total: overallTotal.toLocaleString(),
              })
            : t("analysis.analyzedOnly", { n: analyzed.toLocaleString() })}
        </Text>
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(ratio * 100)}%` }]} />
      </View>

      <Text style={styles.sub}>
        {showPassCount
          ? t("analysis.batch", { done: done.toLocaleString(), total: total.toLocaleString() })
          : phaseLabel}
        {pending > 0 ? ` · ${t("analysis.pending", { n: pending.toLocaleString() })}` : ` · ${t("analysis.done")}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  label: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: "600",
    flex: 1,
  },
  count: {
    color: colors.textDim,
    fontSize: font.small,
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  sub: {
    color: colors.textFaint,
    fontSize: font.tiny,
  },
});
