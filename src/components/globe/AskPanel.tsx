// The AI news-search answer card, shown over the globe while/after the reader asks
// a free-text question. It streams the synopsis token-by-token (subscribing to the
// isolated askStream store so streaming never re-renders the globe scene), then
// shows the located places the answer is about (tap one to fly there). The globe
// itself drops the markers; this card carries the prose + the per-place reads.

import React, { useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AskResult } from "../../types";
import { Cursor } from "../anim";
import { getAskStream, subscribeAskStream } from "../../lib/askStream";
import { useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";

export function AskPanel({
  query,
  asking,
  result,
  error,
  onClose,
  onPlaceTap,
}: {
  query: string;
  asking: boolean;
  result: AskResult | null;
  error: string | null;
  onClose: () => void;
  /** Tap a located place (has an ISO2) → fly the globe there. */
  onPlaceTap?: (iso2: string, label: string) => void;
}) {
  const t = useT();
  // Live synopsis tokens, isolated so streaming re-renders ONLY this card.
  const stream = useSyncExternalStore(subscribeAskStream, getAskStream, getAskStream);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="sparkles" size={15} color={colors.accent} />
        <Text style={styles.query} numberOfLines={1}>
          {query}
        </Text>
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("ask.close")}>
          <Ionicons name="close" size={16} color={colors.textDim} />
        </Pressable>
      </View>

      {error ? (
        <Text style={styles.error}>{t("ask.error")}</Text>
      ) : result ? (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {result.synopsis.length > 0 ? (
            <Text style={styles.synopsis}>{result.synopsis}</Text>
          ) : (
            <Text style={styles.empty}>{t("ask.empty")}</Text>
          )}
          {result.places.map((p, i) => (
            <Pressable
              key={`${p.iso2}-${i}`}
              style={styles.placeRow}
              onPress={() => p.iso2 && onPlaceTap?.(p.iso2, p.label)}
              accessibilityRole="button"
            >
              <View style={styles.placeDot} />
              <Text style={styles.placeText}>
                <Text style={styles.placeLabel}>{p.label}: </Text>
                {p.blurb}
              </Text>
            </Pressable>
          ))}
          {result.basedOn > 0 && (
            <Text style={styles.basedOn}>{t("ask.basedOn", { n: result.basedOn })}</Text>
          )}
        </ScrollView>
      ) : stream.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.loadingText}>{t("ask.searching")}</Text>
        </View>
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={styles.synopsis}>
            {stream}
            <Cursor />
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.accentDim,
    backgroundColor: colors.surface + "F2",
    maxHeight: 280,
    width: 360,
    maxWidth: "100%",
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  query: { flex: 1, color: colors.text, fontSize: font.small, fontWeight: "800" },
  body: { flexGrow: 0 },
  bodyContent: { gap: spacing.sm },
  synopsis: { color: colors.text, fontSize: font.body, lineHeight: 21 },
  empty: { color: colors.textDim, fontSize: font.body, fontStyle: "italic" },
  placeRow: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  placeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 7,
  },
  placeText: { flex: 1, color: colors.textDim, fontSize: font.small, lineHeight: 19 },
  placeLabel: { color: colors.text, fontWeight: "700" },
  basedOn: { color: colors.textFaint, fontSize: font.tiny, marginTop: spacing.xs },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  loadingText: { color: colors.textDim, fontSize: font.small },
  error: { color: colors.danger, fontSize: font.small },
});
