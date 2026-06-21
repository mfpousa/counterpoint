// Small shared UI atoms: chips, lean badge, and lean spectrum color helper.

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { leanBucket, leanBucketLabel } from "../lib/lean";
import type { Lean, LeanSource } from "../types";

/** A 0..1 opacity as a 2-digit hex alpha suffix for "#rrggbb" + alpha colors. */
export function alphaHex(a: number): string {
  const v = Math.max(0, Math.min(255, Math.round(Math.max(0, Math.min(1, a)) * 255)));
  return v.toString(16).padStart(2, "0");
}

/**
 * A tappable tag linking a story/article up to the ONGOING ISSUE it belongs to.
 * Color intensity scales with the issue's severity so bigger stories pull more
 * attention. Tapping opens the issue panel.
 */
export function IssueTag({
  title,
  severity,
  onPress,
}: {
  title: string;
  severity: number;
  onPress: () => void;
}) {
  const s = Math.max(0, Math.min(1, severity));
  const bg = colors.warn + alphaHex(0.1 + 0.4 * s);
  const border = colors.warn + alphaHex(0.35 + 0.55 * s);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`Part of developing issue: ${title}`}
      style={[styles.issueTag, { backgroundColor: bg, borderColor: border }]}
    >
      <Ionicons name="pulse" size={11} color={colors.warn} />
      <Text style={styles.issueTagText} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

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

export function LeanBadge({
  lean,
  source,
  rationale,
}: {
  lean: Lean;
  source: LeanSource;
  /** Short justification for the lean tag, shown in a tooltip on hover/press. */
  rationale?: string;
}) {
  const [open, setOpen] = useState(false);
  const bucket = leanBucket(lean);
  const c = leanColor(lean);
  const label = leanBucketLabel(bucket);
  const value = lean === null ? "" : ` ${lean > 0 ? "+" : ""}${lean.toFixed(2)}`;

  const badge = (
    <View style={styles.leanBadge}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.leanText, { color: c }]}>
        {label}
        {value}
      </Text>
      <Text style={styles.provenance}>{source === "llm" ? "AI-tagged" : "source"}</Text>
    </View>
  );

  // No rationale (e.g. non-political items) -> plain badge, no interaction.
  const hasTip = !!rationale && lean !== null;
  if (!hasTip) return badge;

  return (
    <View style={styles.leanWrap}>
      {open && (
        <View style={styles.tooltip} pointerEvents="none">
          <Text style={styles.tooltipText}>{rationale}</Text>
        </View>
      )}
      <Pressable
        // Hover works on web; press toggles on touch devices.
        onHoverIn={() => setOpen(true)}
        onHoverOut={() => setOpen(false)}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`Lean rationale: ${rationale}`}
        hitSlop={6}
      >
        {badge}
      </Pressable>
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
  issueTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  issueTagText: { color: colors.warn, fontSize: font.tiny, fontWeight: "800", flexShrink: 1 },
  leanBadge: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  leanText: { fontSize: font.tiny, fontWeight: "700" },
  provenance: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontStyle: "italic",
    marginLeft: 2,
  },
  leanWrap: { position: "relative" },
  tooltip: {
    position: "absolute",
    bottom: "100%",
    right: 0,
    marginBottom: spacing.xs,
    maxWidth: 260,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    zIndex: 50,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  tooltipText: {
    color: colors.text,
    fontSize: font.tiny,
    fontStyle: "italic",
    lineHeight: 16,
  },
});
