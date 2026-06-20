// Small shared UI atoms: chips, lean badge, and lean spectrum color helper.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, font, radius, spacing } from "../theme";
import { leanBucket, leanBucketLabel } from "../lib/lean";
import type { Lean, LeanSource } from "../types";

/** Interpolate the lean spectrum color: blue (-1) -> slate (0) -> amber (+1). */
export function leanColor(lean: Lean): string {
  if (lean === null || Number.isNaN(lean)) return colors.center;
  const t = Math.max(-1, Math.min(1, lean));
  const left = hexToRgb(colors.left);
  const center = hexToRgb(colors.center);
  const right = hexToRgb(colors.right);
  const from = t < 0 ? left : center;
  const to = t < 0 ? center : right;
  const k = Math.abs(t);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
  return `rgb(${mix(from.r, to.r)}, ${mix(from.g, to.g)}, ${mix(from.b, to.b)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function Chip({
  label,
  tone = "neutral",
  color,
}: {
  label: string;
  tone?: "neutral" | "accent";
  color?: string;
}) {
  return (
    <View
      style={[
        styles.chip,
        tone === "accent" && { backgroundColor: colors.accentDim },
        color ? { backgroundColor: "transparent", borderColor: color, borderWidth: 1 } : null,
      ]}
    >
      <Text style={[styles.chipText, color ? { color } : null]}>{label}</Text>
    </View>
  );
}

export function LeanBadge({ lean, source }: { lean: Lean; source: LeanSource }) {
  const bucket = leanBucket(lean);
  const c = leanColor(lean);
  const label = leanBucketLabel(bucket);
  const value = lean === null ? "" : ` ${lean > 0 ? "+" : ""}${lean.toFixed(2)}`;
  return (
    <View style={styles.leanBadge}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.leanText, { color: c }]}>
        {label}
        {value}
      </Text>
      <Text style={styles.provenance}>{source === "llm" ? "AI-tagged" : "source"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  chipText: { color: colors.textDim, fontSize: font.tiny, fontWeight: "600" },
  leanBadge: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  leanText: { fontSize: font.tiny, fontWeight: "700" },
  provenance: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontStyle: "italic",
    marginLeft: 2,
  },
});
