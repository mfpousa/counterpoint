import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../../src/store/AppContext";
import { assessDrift } from "../../src/lib/lean";
import { topicMeta, TOPIC_ORDER } from "../../src/lib/topics";
import { FeedCard } from "../../src/components/FeedCard";
import { LeanDial, QuotaMeter } from "../../src/components/meters";
import { colors, font, radius, spacing } from "../../src/theme";
import type { FeedItem, Topic } from "../../src/types";

const MAX_CONTENT_WIDTH = 1180;
const H_PAD = spacing.lg;

/** Pick a column count from the available content width (desktop-friendly). */
function columnsFor(contentWidth: number): number {
  if (contentWidth >= 1040) return 3;
  if (contentWidth >= 680) return 2;
  return 1;
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { feed, progress, prefs, loadingFeed, feedError, completeItem, refreshFeed, updatePrefs } =
    useApp();
  const [selected, setSelected] = useState<Topic | "all">("all");

  // Search box bound to the steering interest. Submitting updates the saved
  // interest, which triggers a re-fetch (the heavy analysis is cached, so this
  // is fast). Kept in sync if the interest is changed elsewhere (Settings).
  const [query, setQuery] = useState(prefs.interestPrompt);
  useEffect(() => setQuery(prefs.interestPrompt), [prefs.interestPrompt]);
  const submitSearch = () => {
    const v = query.trim();
    if (v !== prefs.interestPrompt.trim()) void updatePrefs({ interestPrompt: v });
  };
  const clearSearch = () => {
    setQuery("");
    if (prefs.interestPrompt.trim().length > 0) void updatePrefs({ interestPrompt: "" });
  };

  const todayDrift = useMemo(
    () =>
      assessDrift(
        progress.leanWeightSum,
        progress.leanMinutesSum,
        progress.leftMinutesSum,
        progress.rightMinutesSum,
        prefs.driftThreshold,
      ),
    [progress, prefs.driftThreshold],
  );

  const completedSet = useMemo(
    () => new Set(progress.completedItemIds),
    [progress.completedItemIds],
  );

  // Group the balanced feed into per-topic sections for discoverability.
  const sections = useMemo(() => {
    const byTopic = new Map<Topic, FeedItem[]>();
    for (const it of feed) {
      const arr = byTopic.get(it.topic);
      if (arr) arr.push(it);
      else byTopic.set(it.topic, [it]);
    }
    return TOPIC_ORDER.filter((t) => byTopic.has(t)).map((t) => ({
      topic: t,
      items: byTopic.get(t) as FeedItem[],
    }));
  }, [feed]);

  const activeSelected = selected !== "all" && sections.some((s) => s.topic === selected)
    ? selected
    : "all";
  const visibleSections =
    activeSelected === "all" ? sections : sections.filter((s) => s.topic === activeSelected);

  // Responsive layout math.
  const contentW = Math.min(width, MAX_CONTENT_WIDTH) - H_PAD * 2;
  const cols = columnsFor(contentW);
  const GAP = spacing.lg;
  const cardW = cols === 1 ? contentW : Math.floor((contentW - GAP * (cols - 1)) / cols);

  const atQuota = progress.consumedMin >= prefs.dailyQuotaMin;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + spacing.md,
        paddingBottom: spacing.xxl,
        paddingHorizontal: H_PAD,
        alignItems: "center",
      }}
      refreshControl={
        <RefreshControl
          refreshing={loadingFeed}
          onRefresh={() => refreshFeed({ force: true })}
          tintColor={colors.accent}
        />
      }
    >
      <View style={{ width: contentW, gap: spacing.md }}>
        {/* Search / steering bar */}
        <View style={styles.searchBar}>
          <Pressable onPress={submitSearch} hitSlop={8}>
            <Ionicons name="search" size={18} color={colors.textDim} />
          </Pressable>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={submitSearch}
            placeholder="Search your feed — e.g. AI and scientific progress"
            placeholderTextColor={colors.textFaint}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {loadingFeed ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : query.length > 0 ? (
            <Pressable onPress={clearSearch} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>

        {/* Header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Today</Text>
            {feed.length > 0 && (
              <Text style={styles.subtitle}>
                {feed.length} picks across {sections.length} topic
                {sections.length === 1 ? "" : "s"}, balanced for you
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => refreshFeed({ force: true })}
            style={styles.refreshBtn}
            accessibilityRole="button"
            disabled={loadingFeed}
          >
            <Ionicons
              name="refresh"
              size={16}
              color={loadingFeed ? colors.textFaint : colors.accent}
            />
            <Text style={[styles.refreshText, loadingFeed && { color: colors.textFaint }]}>
              Refresh
            </Text>
          </Pressable>
        </View>

        <QuotaMeter consumed={progress.consumedMin} target={prefs.dailyQuotaMin} />
        <LeanDial drift={todayDrift} threshold={prefs.driftThreshold} compact />

        {feedError && (
          <View style={styles.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{feedError}</Text>
            <Pressable onPress={() => refreshFeed({ force: true })} hitSlop={8}>
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* Tag filter bar */}
        {sections.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            <FilterChip
              label="All"
              icon="albums"
              color={colors.accent}
              count={feed.length}
              active={activeSelected === "all"}
              onPress={() => setSelected("all")}
            />
            {sections.map((s) => {
              const m = topicMeta(s.topic);
              return (
                <FilterChip
                  key={s.topic}
                  label={m.label}
                  icon={m.icon}
                  color={m.color}
                  count={s.items.length}
                  active={activeSelected === s.topic}
                  onPress={() => setSelected(s.topic)}
                />
              );
            })}
          </ScrollView>
        )}

        {/* Body */}
        {feed.length === 0 ? (
          loadingFeed ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.emptySub}>Curating your balanced feed…</Text>
            </View>
          ) : feedError ? null : (
            <View style={styles.empty}>
              <Ionicons
                name={atQuota ? "checkmark-done-circle-outline" : "newspaper-outline"}
                size={40}
                color={colors.textFaint}
              />
              <Text style={styles.emptyTitle}>
                {atQuota ? "You've hit today's quota." : "No items to show."}
              </Text>
              <Text style={styles.emptySub}>
                {atQuota
                  ? "Come back tomorrow, or raise your quota in Settings."
                  : "Pull down to refresh, or steer your feed in Settings."}
              </Text>
            </View>
          )
        ) : (
          visibleSections.map((section) => {
            const m = topicMeta(section.topic);
            return (
              <View key={section.topic} style={{ gap: spacing.md }}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIcon, { backgroundColor: m.color + "22" }]}>
                    <Ionicons name={m.icon} size={15} color={m.color} />
                  </View>
                  <Text style={styles.sectionTitle}>{m.label}</Text>
                  <Text style={styles.sectionCount}>{section.items.length}</Text>
                </View>
                <View style={[styles.grid, { gap: GAP }]}>
                  {section.items.map((item) => (
                    <View key={item.id} style={{ width: cardW }}>
                      <FeedCard
                        item={item}
                        done={completedSet.has(item.id)}
                        onComplete={completeItem}
                      />
                    </View>
                  ))}
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function FilterChip({
  label,
  icon,
  color,
  count,
  active,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.filterChip,
        active && { borderColor: color, backgroundColor: color + "22" },
      ]}
    >
      <Ionicons name={icon} size={13} color={active ? color : colors.textDim} />
      <Text style={[styles.filterChipText, active && { color }]}>{label}</Text>
      <Text style={[styles.filterChipCount, active && { color }]}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  title: { color: colors.text, fontSize: font.h1, fontWeight: "800" },
  subtitle: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  refreshText: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    height: 50,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: font.body,
    paddingVertical: 0,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.surface,
  },
  errorText: { color: colors.textDim, fontSize: font.small, flex: 1, lineHeight: 18 },
  retry: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  filterRow: { gap: spacing.sm, paddingVertical: spacing.xs, paddingRight: spacing.lg },
  filterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  filterChipText: { color: colors.textDim, fontSize: font.small, fontWeight: "700" },
  filterChipCount: { color: colors.textFaint, fontSize: font.tiny, fontWeight: "700" },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  sectionIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: { color: colors.text, fontSize: font.h3, fontWeight: "800" },
  sectionCount: { color: colors.textFaint, fontSize: font.small, fontWeight: "700" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm, marginTop: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center" },
});
