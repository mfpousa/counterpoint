// The AI news-search answer card, shown over the globe while/after the reader asks
// a free-text question. It streams the synopsis token-by-token (subscribing to the
// isolated askStream store so streaming never re-renders the globe scene), then
// shows the located places the answer is about (tap one to fly there). The globe
// itself drops the markers; this card carries the prose + the per-place reads.

import React, { useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AskResult, AskSource } from "../../types";
import { Cursor } from "../anim";
import { getAskStream, subscribeAskStream } from "../../lib/askStream";
import { useT } from "../../store/AppContext";
import { colors, font, radius, spacing } from "../../theme";

// Inline citation markers the model emits: [3], [1][4], [2, 5]. Matched globally.
const CITE = /\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g;

/** Render prose with inline `[n]` citations turned into TAPPABLE links to the matching
 *  source (sources[n-1]) — so a specific term/claim hyperlinks to where it came from.
 *  Unknown / out-of-range numbers are left as plain text. */
function renderCited(text: string, sources: AskSource[]): React.ReactNode {
  if (!text) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(CITE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    for (const numStr of m[0].match(/\d+/g) ?? []) {
      const n = Number(numStr);
      const src = sources[n - 1];
      if (src) {
        out.push(
          <Text
            key={`cite-${key++}`}
            style={styles.cite}
            onPress={() => void Linking.openURL(src.url)}
            accessibilityRole="link"
            accessibilityLabel={`${src.sourceTitle}: ${src.title}`}
          >
            {`\u200a[${n}]`}
          </Text>,
        );
      } else {
        out.push(` [${numStr}]`);
      }
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

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
            <Text style={styles.synopsis}>{renderCited(result.synopsis, result.sources)}</Text>
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
                {renderCited(p.blurb, result.sources)}
              </Text>
            </Pressable>
          ))}
          {result.sources.length > 0 && (
            <View style={styles.sourcesBlock}>
              <Text style={styles.sourcesHeading}>
                {t("ask.sources")} · {result.basedOn}
              </Text>
              {result.sources.slice(0, 8).map((s) => (
                <Pressable
                  key={s.id}
                  style={styles.sourceRow}
                  onPress={() => void Linking.openURL(s.url)}
                  accessibilityRole="link"
                  accessibilityLabel={`${s.sourceTitle}: ${s.title}`}
                >
                  <Ionicons name="open-outline" size={12} color={colors.accent} />
                  <Text style={styles.sourceRowText} numberOfLines={1}>
                    <Text style={styles.sourceOutlet}>{s.sourceTitle}</Text>
                    {`  ${s.title}`}
                  </Text>
                </Pressable>
              ))}
            </View>
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
  // Inline citation link ([n]) sitting within the prose / blurb.
  cite: { color: colors.accent, fontWeight: "700" },
  // Overall grounding sources (back the synopsis), as tappable rows.
  sourcesBlock: {
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sourcesHeading: {
    color: colors.textDim,
    fontSize: font.tiny,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourceRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sourceRowText: { flex: 1, color: colors.textDim, fontSize: font.tiny, lineHeight: 16 },
  sourceOutlet: { color: colors.text, fontWeight: "700" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  loadingText: { color: colors.textDim, fontSize: font.small },
  error: { color: colors.danger, fontSize: font.small },
});
