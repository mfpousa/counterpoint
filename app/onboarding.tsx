import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useT } from "../src/store/AppContext";
import { colors, font, radius, spacing } from "../src/theme";
import type { Kind, Topic } from "../src/types";

const QUOTAS = [30, 60, 90, 120, 180];
const TOPICS: Topic[] = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "culture",
];
const KINDS: Kind[] = ["video", "podcast", "news"];

export default function Onboarding() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { prefs, updatePrefs } = useApp();
  const t = useT();

  const [quota, setQuota] = useState(prefs.dailyQuotaMin);
  const [topics, setTopics] = useState<Topic[]>(prefs.enabledTopics);
  const [kinds, setKinds] = useState<Kind[]>(prefs.includeKinds);

  const toggleTopic = (t: Topic) =>
    setTopics((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const toggleKind = (k: Kind) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const canStart = topics.length > 0 && kinds.length > 0;

  const start = async () => {
    await updatePrefs({
      dailyQuotaMin: quota,
      enabledTopics: topics,
      includeKinds: kinds,
      onboarded: true,
    });
    router.replace("/(tabs)");
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.xl, paddingTop: insets.top + spacing.xl, gap: spacing.xl }}
    >
      <View>
        <Text style={styles.brand}>Counterpoint</Text>
        <Text style={styles.tagline}>{t("onb.tagline")}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.h}>{t("onb.quota")}</Text>
        <View style={styles.row}>
          {QUOTAS.map((q) => (
            <Pressable
              key={q}
              onPress={() => setQuota(q)}
              style={[styles.pill, quota === q && styles.pillActive]}
            >
              <Text style={[styles.pillText, quota === q && styles.pillTextActive]}>
                {q < 60 ? `${q}m` : `${q / 60}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.h}>{t("onb.learnAbout")}</Text>
        <View style={styles.wrap}>
          {TOPICS.map((topic) => (
            <Pressable
              key={topic}
              onPress={() => toggleTopic(topic)}
              style={[styles.pill, topics.includes(topic) && styles.pillActive]}
            >
              <Text style={[styles.pillText, topics.includes(topic) && styles.pillTextActive]}>
                {t(`topic.${topic}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.h}>{t("onb.contentTypes")}</Text>
        <View style={styles.row}>
          {KINDS.map((k) => (
            <Pressable
              key={k}
              onPress={() => toggleKind(k)}
              style={[styles.pill, kinds.includes(k) && styles.pillActive]}
            >
              <Text style={[styles.pillText, kinds.includes(k) && styles.pillTextActive]}>
                {t(`settings.kind.${k}`)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable
        onPress={start}
        disabled={!canStart}
        style={[styles.cta, !canStart && styles.ctaDisabled]}
      >
        <Text style={styles.ctaText}>{t("onb.start")}</Text>
      </Pressable>
      <Text style={styles.footnote}>{t("onb.footnote")}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  brand: { color: colors.text, fontSize: font.h1, fontWeight: "800", marginBottom: spacing.sm },
  tagline: { color: colors.textDim, fontSize: font.body, lineHeight: 22 },
  section: { gap: spacing.md },
  h: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  row: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  wrap: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  pill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  pillText: { color: colors.textDim, fontSize: font.small, fontWeight: "600", textTransform: "capitalize" },
  pillTextActive: { color: colors.text },
  cta: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: "#0E1116", fontSize: font.body, fontWeight: "800" },
  footnote: { color: colors.textFaint, fontSize: font.tiny, textAlign: "center" },
});
