// Visual meters: the daily quota bar and the 50/50 lean dial.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, font, radius, spacing } from "../theme";
import { useT } from "../store/AppContext";
import type { DriftStatus } from "../lib/lean";

export function QuotaMeter({
  consumed,
  target,
}: {
  consumed: number;
  target: number;
}) {
  const t = useT();
  const pct = target > 0 ? Math.min(1, consumed / target) : 0;
  const remaining = Math.max(0, target - consumed);
  const done = consumed >= target && target > 0;
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.label}>{t("meter.todayLearning")}</Text>
        <Text style={styles.label}>
          {t("meter.minXY", { consumed: Math.round(consumed), target })}
        </Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${pct * 100}%`, backgroundColor: done ? colors.good : colors.accent },
          ]}
        />
      </View>
      <Text style={styles.sub}>
        {done ? t("meter.quotaReached") : t("meter.toGo", { n: Math.round(remaining) })}
      </Text>
    </View>
  );
}

/**
 * The lean dial: a left↔right spectrum with a marker at your weighted-mean lean,
 * plus a left/right share split and a drift message.
 */
export function LeanDial({
  drift,
  threshold,
  title,
  compact = false,
}: {
  drift: DriftStatus;
  threshold: number;
  title?: string;
  compact?: boolean;
}) {
  const t = useT();
  const mean = drift.mean ?? 0;
  // Marker position: map -1..+1 to 0..100%.
  const markerPct = ((mean + 1) / 2) * 100;
  const leftPct = Math.round(drift.leftShare * 100);
  const rightPct = Math.round(drift.rightShare * 100);

  let message: string;
  let messageColor: string = colors.good;
  if (drift.mean === null) {
    message = t("meter.noPolitical");
    messageColor = colors.textDim;
  } else if (drift.warn) {
    message = drift.direction === "left" ? t("meter.tooLeft") : t("meter.tooRight");
    messageColor = colors.warn;
  } else {
    message = t("meter.balanced");
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{title ?? t("meter.balanceTitle")}</Text>

      <View style={styles.spectrum}>
        <View style={styles.spectrumGradient}>
          <View style={[styles.spectrumSeg, { backgroundColor: colors.left }]} />
          <View style={[styles.spectrumSeg, { backgroundColor: colors.center }]} />
          <View style={[styles.spectrumSeg, { backgroundColor: colors.right }]} />
        </View>
        {/* center reference */}
        <View style={[styles.centerTick]} />
        {/* threshold band edges */}
        <View style={[styles.threshTick, { left: `${((-threshold + 1) / 2) * 100}%` }]} />
        <View style={[styles.threshTick, { left: `${((threshold + 1) / 2) * 100}%` }]} />
        {drift.mean !== null && (
          <View style={[styles.marker, { left: `${markerPct}%` }]} />
        )}
      </View>

      <View style={styles.rowBetween}>
        <Text style={[styles.endLabel, { color: colors.left }]}>{t("meter.left", { pct: leftPct })}</Text>
        <Text style={styles.endLabelCenter}>{t("meter.target")}</Text>
        <Text style={[styles.endLabel, { color: colors.right }]}>{t("meter.right", { pct: rightPct })}</Text>
      </View>

      {!compact && <Text style={[styles.driftMsg, { color: messageColor }]}>{message}</Text>}
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
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  sub: { color: colors.textDim, fontSize: font.small },
  track: {
    height: 10,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: radius.pill },
  spectrum: { height: 22, justifyContent: "center", marginVertical: spacing.xs },
  spectrumGradient: {
    flexDirection: "row",
    height: 8,
    borderRadius: radius.pill,
    overflow: "hidden",
    opacity: 0.5,
  },
  spectrumSeg: { flex: 1, height: "100%" },
  centerTick: {
    position: "absolute",
    left: "50%",
    width: 2,
    height: 16,
    backgroundColor: colors.textFaint,
    marginLeft: -1,
  },
  threshTick: {
    position: "absolute",
    width: 1,
    height: 12,
    backgroundColor: colors.textFaint,
    opacity: 0.6,
  },
  marker: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.text,
    borderWidth: 2,
    borderColor: colors.bg,
    marginLeft: -7,
  },
  endLabel: { fontSize: font.tiny, fontWeight: "700" },
  endLabelCenter: { color: colors.textFaint, fontSize: font.tiny },
  driftMsg: { fontSize: font.small, fontWeight: "600", marginTop: spacing.xs },
});
