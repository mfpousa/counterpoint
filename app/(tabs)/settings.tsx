import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { resetAll } from "../../src/storage/storage";
import { colors, font, radius, spacing } from "../../src/theme";
import type { Kind, Topic } from "../../src/types";

const QUOTAS = [30, 60, 90, 120, 180, 240];
const TOPICS: Topic[] = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "culture",
];
const KINDS: { id: Kind; label: string }[] = [
  { id: "video", label: "Videos" },
  { id: "podcast", label: "Podcasts" },
  { id: "news", label: "News" },
];
const THRESHOLDS = [0.15, 0.25, 0.35];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { prefs, updatePrefs, resetToday, refreshFeed } = useApp();
  const [apiKey, setApiKey] = useState(prefs.llmApiKey ?? "");

  const toggleTopic = (t: Topic) => {
    const next = prefs.enabledTopics.includes(t)
      ? prefs.enabledTopics.filter((x) => x !== t)
      : [...prefs.enabledTopics, t];
    void updatePrefs({ enabledTopics: next });
  };
  const toggleKind = (k: Kind) => {
    const next = prefs.includeKinds.includes(k)
      ? prefs.includeKinds.filter((x) => x !== k)
      : [...prefs.includeKinds, k];
    void updatePrefs({ includeKinds: next });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        padding: spacing.lg,
        paddingTop: insets.top + spacing.md,
        gap: spacing.lg,
        paddingBottom: spacing.xxl,
      }}
    >
      <Text style={styles.title}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.h}>Daily quota</Text>
        <View style={styles.wrap}>
          {QUOTAS.map((q) => (
            <Pressable
              key={q}
              onPress={() => updatePrefs({ dailyQuotaMin: q })}
              style={[styles.pill, prefs.dailyQuotaMin === q && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.dailyQuotaMin === q && styles.pillTextActive]}>
                {q < 60 ? `${q}m` : `${q / 60}h`}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Topics</Text>
        <View style={styles.wrap}>
          {TOPICS.map((t) => (
            <Pressable
              key={t}
              onPress={() => toggleTopic(t)}
              style={[styles.pill, prefs.enabledTopics.includes(t) && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.enabledTopics.includes(t) && styles.pillTextActive]}>
                {t}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Content types</Text>
        <View style={styles.wrap}>
          {KINDS.map((k) => (
            <Pressable
              key={k.id}
              onPress={() => toggleKind(k.id)}
              style={[styles.pill, prefs.includeKinds.includes(k.id) && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.includeKinds.includes(k.id) && styles.pillTextActive]}>
                {k.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Drift sensitivity</Text>
        <Text style={styles.sub}>How far from 50/50 before we warn you and counter-weight the feed.</Text>
        <View style={styles.wrap}>
          {THRESHOLDS.map((th) => (
            <Pressable
              key={th}
              onPress={() => updatePrefs({ driftThreshold: th })}
              style={[styles.pill, prefs.driftThreshold === th && styles.pillActive]}
            >
              <Text style={[styles.pillText, prefs.driftThreshold === th && styles.pillTextActive]}>
                {th === 0.15 ? "Strict" : th === 0.25 ? "Balanced" : "Relaxed"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.h}>AI item-level tagging</Text>
          <Switch
            value={prefs.llmTaggingEnabled}
            onValueChange={(v) => updatePrefs({ llmTaggingEnabled: v })}
            trackColor={{ true: colors.accentDim, false: colors.surfaceAlt }}
            thumbColor={prefs.llmTaggingEnabled ? colors.accent : colors.textFaint}
          />
        </View>
        <Text style={styles.sub}>
          Optional. By default each item inherits its source's lean. Enable this to classify each
          item individually with an LLM (needs your API key). Note: the model has its own biases —
          treat AI tags as a second opinion, not ground truth.
        </Text>
        {prefs.llmTaggingEnabled && (
          <View style={{ gap: spacing.sm }}>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              onBlur={() => updatePrefs({ llmApiKey: apiKey.trim() || undefined })}
              placeholder="OpenAI-compatible API key"
              placeholderTextColor={colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              style={styles.input}
            />
            <Text style={styles.sub}>Stored only on this device.</Text>
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Data</Text>
        <Pressable onPress={refreshFeed} style={styles.btn}>
          <Text style={styles.btnText}>Refresh feed now</Text>
        </Pressable>
        <Pressable onPress={resetToday} style={styles.btn}>
          <Text style={styles.btnText}>Reset today's progress</Text>
        </Pressable>
        <Pressable
          onPress={() => updatePrefs({ onboarded: false })}
          style={styles.btn}
        >
          <Text style={styles.btnText}>Re-run onboarding</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            await resetAll();
            await updatePrefs({ onboarded: false });
          }}
          style={[styles.btn, styles.btnDanger]}
        >
          <Text style={[styles.btnText, { color: colors.danger }]}>Erase all local data</Text>
        </Pressable>
      </View>

      <Text style={styles.footnote}>Counterpoint v0.1 — your feed, your balance, your device.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  sub: { color: colors.textDim, fontSize: font.small, lineHeight: 19 },
  wrap: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  pill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  pillActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  pillText: { color: colors.textDim, fontSize: font.small, fontWeight: "600", textTransform: "capitalize" },
  pillTextActive: { color: colors.text },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.body,
  },
  btn: {
    backgroundColor: colors.surfaceAlt,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  btnDanger: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.danger },
  btnText: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  footnote: { color: colors.textFaint, fontSize: font.tiny, textAlign: "center" },
});
