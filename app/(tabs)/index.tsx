import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useApp, useT } from "../../src/store/AppContext";
import { assessDrift } from "../../src/lib/lean";
import { topicMeta, TOPIC_ORDER } from "../../src/lib/topics";
import { FeedCard } from "../../src/components/FeedCard";
import { StoryCard } from "../../src/components/StoryCard";
import { FadeInView } from "../../src/components/anim";
import { BriefingCard } from "../../src/components/BriefingCard";
import { AnalysisProgress } from "../../src/components/AnalysisProgress";
import { WorldSwitcher } from "../../src/components/WorldSwitcher";
import { Globe } from "../../src/components/globe/Globe";
import { ArticlesPanel, type PanelState } from "../../src/components/ArticlesPanel";
import { GEO_ROOT_ID, geoNodeIdOf, poolIdForNode } from "../../src/data/geo";
import { DEFAULT_WORLD_ID } from "../../src/data/worlds";
import { fetchStories } from "../../src/lib/api";
import { cacheStories } from "../../src/lib/storyCache";
import { lastMinuteStories } from "../../src/lib/storyUpdates";
import { openNews, openStory } from "../../src/lib/nav";
import { router, useLocalSearchParams } from "expo-router";
import { LeanDial, QuotaMeter } from "../../src/components/meters";
import { colors, font, radius, spacing } from "../../src/theme";
import type { FeedItem, Story, Topic } from "../../src/types";

const MAX_CONTENT_WIDTH = 1180;
const H_PAD = spacing.lg;

// Per world+language story cache at MODULE scope so it SURVIVES a remount of the
// Today screen. Backing out of a /news/[id] or /story/[id] route remounts this
// screen; a component-local ref would be wiped, blanking the already-built
// stories (and collapsing the scroll). Module scope keeps them on screen.
const storiesByKey = new Map<string, Story[]>();
const storyKeyFor = (worldId: string, language: string) => `${worldId}:${language}`;

/** Pick a column count from the available content width (desktop-friendly). */
function columnsFor(contentWidth: number): number {
  if (contentWidth >= 1040) return 3;
  if (contentWidth >= 680) return 2;
  return 1;
}

export default function FeedScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const {
    feed,
    progress,
    prefs,
    loadingFeed,
    feedError,
    briefing,
    loadingBriefing,
    briefingStream,
    status,
    summaries,
    storyViews,
    worldId,
    feedWorldId,
    busyWorld,
    refreshFeed,
    setWorld,
    updatePrefs,
  } = useApp();
  const t = useT();
  const [selected, setSelected] = useState<Topic | "all">("all");
  // Feed sort order (persisted): relevance (the AI score, default) or recency.
  const sort = prefs.feedSort ?? "relevance";

  // Synthesized stories (developing issues + deduped multi-source events) are
  // interest-independent and built from the full pool, so we fetch them
  // alongside the feed and merge them in below. Seeded LAZILY from the module
  // cache so a remount (e.g. backing out of a story) shows the already-built set
  // immediately instead of blanking to empty.
  const [stories, setStories] = useState<Story[]>(
    () => storiesByKey.get(storyKeyFor(feedWorldId, prefs.language)) ?? [],
  );
  const [loadingStories, setLoadingStories] = useState(false);
  const storiesLoadedOnce = useRef(false);
  // The story set the reader is currently looking at (world + language). A fetch
  // is only applied if this STILL matches when it resolves — otherwise an
  // in-flight request for the world we just switched AWAY from could overwrite
  // the current world's stories (cross-world contamination in "Last minute").
  const currentKey = storyKeyFor(feedWorldId, prefs.language);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const loadStories = useCallback(
    async (force = false) => {
      const key = storyKeyFor(feedWorldId, prefs.language);
      setLoadingStories(true);
      try {
        const res = await fetchStories({ world: feedWorldId, force, lang: prefs.language });
        // Drop a response the reader has since navigated away from (world/language
        // changed mid-flight) so it can't bleed another world's stories into view.
        if (currentKeyRef.current !== key) return;
        // Never WIPE a populated set while the backend is mid-rebuild: /api/stories
        // can transiently return [] during synthesis. Keep showing the stale set
        // until real stories arrive, then swap them in (they eventually update).
        if (res.stories.length > 0) {
          setStories(res.stories);
          storiesByKey.set(key, res.stories);
          // Share with the routed story panel so opening a listed story is instant
          // and never dead-ends on an id that changed during a rebuild.
          cacheStories(res.stories);
        }
        storiesLoadedOnce.current = true;
      } finally {
        // Only clear the spinner if we're still on the same world/language (the new
        // world's own load owns its spinner once we've switched).
        if (currentKeyRef.current === key) setLoadingStories(false);
      }
    },
    [feedWorldId, prefs.language],
  );
  useEffect(() => {
    // Show this world+language's cached stories immediately (no skeleton flash)
    // when we've built them before. Otherwise CLEAR to empty: a remount keeps the
    // module cache so the same world stays populated, but a genuine switch to a
    // world we haven't built yet must not leave the previous world's stories on
    // screen (that's what surfaced foreign stories in "Last minute").
    const cached = storiesByKey.get(storyKeyFor(feedWorldId, prefs.language));
    if (cached) {
      setStories(cached);
      storiesLoadedOnce.current = true;
    } else {
      setStories([]);
      storiesLoadedOnce.current = false;
    }
    void loadStories();
  }, [loadStories, feedWorldId, prefs.language]);

  // Live: when the backend finishes analyzing a chunk (analyzed count grows),
  // silently re-fetch stories so new/updated ones appear in real time.
  const prevAnalyzed = useRef(0);
  useEffect(() => {
    const a = status?.analyzed ?? 0;
    if (prevAnalyzed.current === 0) {
      prevAnalyzed.current = a;
      return;
    }
    if (a > prevAnalyzed.current) {
      prevAnalyzed.current = a;
      void loadStories();
    }
  }, [status?.analyzed, loadStories]);

  // Map item id -> this reader's graded summary, for the card badge.
  const summaryById = useMemo(() => {
    const m = new Map<string, (typeof summaries)[number]>();
    for (const s of summaries) m.set(s.id, s);
    return m;
  }, [summaries]);

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

  // Developing issues (ongoing storylines) are highlighted in their own band.
  const developingStories = useMemo(() => stories.filter((s) => s.developing), [stories]);

  // Map each article id -> the ongoing issue it belongs to (with severity), so
  // stories/articles can show a severity-colored tag linking up to the issue.
  const issueByArticle = useMemo(() => {
    const map = new Map<string, { id: string; title: string; severity: number }>();
    for (const iss of developingStories) {
      const tag = { id: iss.id, title: iss.title, severity: iss.severity };
      for (const src of iss.sources) if (!map.has(src.id)) map.set(src.id, tag);
    }
    return map;
  }, [developingStories]);
  const issueForStory = useCallback(
    (s: Story) => {
      for (const src of s.sources) {
        const t = issueByArticle.get(src.id);
        if (t) return t;
      }
      return undefined;
    },
    [issueByArticle],
  );

  // Synthesized SINGLE-EVENT stories present in the current feed. These live
  // INSIDE their topic sections alongside articles (their member articles are
  // deduped out — the synthesis card stands in for them). Ongoing/DEVELOPING
  // issues do NOT go here; they surface in the "last hour" band below.
  const synthStories = useMemo(() => {
    const feedIds = new Set(feed.map((it) => it.id));
    return stories.filter((s) => !s.developing && s.sources.some((src) => feedIds.has(src.id)));
  }, [feed, stories]);

  // Per-topic stream: synthesized event story cards interleaved with the
  // standalone articles that no story absorbed, ordered by recency (read articles
  // sink to the bottom). Stories sort by their latest update.
  type Entry =
    | { kind: "story"; story: Story; topic: Topic; at: number; score: number; done: false }
    | { kind: "item"; item: FeedItem; topic: Topic; at: number; score: number; done: boolean };
  const sections = useMemo(() => {
    const absorbed = new Set<string>();
    for (const s of synthStories) for (const src of s.sources) absorbed.add(src.id);
    const standalone = feed.filter((it) => !absorbed.has(it.id));

    // Relevance score per entry: items carry the AI relevance; a synthesized story
    // inherits the highest relevance among its member articles (it stands in for them).
    const relById = new Map(feed.map((it) => [it.id, it.relevance ?? 0.5]));
    const storyScore = (s: Story) =>
      s.sources.reduce((m, src) => Math.max(m, relById.get(src.id) ?? 0.5), 0.5);

    const entries: Entry[] = [
      ...synthStories.map(
        (story): Entry => ({
          kind: "story",
          story,
          topic: story.topic,
          at: story.updatedAt,
          score: storyScore(story),
          done: false,
        }),
      ),
      ...standalone.map(
        (item): Entry => ({
          kind: "item",
          item,
          topic: item.topic,
          at: item.publishedAt,
          score: item.relevance ?? 0.5,
          done: completedSet.has(item.id),
        }),
      ),
    ];

    const byTopic = new Map<Topic, Entry[]>();
    for (const e of entries) {
      const arr = byTopic.get(e.topic);
      if (arr) arr.push(e);
      else byTopic.set(e.topic, [e]);
    }
    // Read items always sink. Otherwise sort by the chosen mode: relevance (the AI
    // score, default) or recency (newest first); each falls back to the other.
    const order = (a: Entry, b: Entry) => {
      const da = a.done ? 1 : 0;
      const db = b.done ? 1 : 0;
      if (da !== db) return da - db;
      if (sort === "relevance" && b.score !== a.score) return b.score - a.score;
      return b.at - a.at;
    };
    return TOPIC_ORDER.filter((t) => byTopic.has(t)).map((t) => ({
      topic: t,
      entries: (byTopic.get(t) as Entry[]).slice().sort(order),
    }));
  }, [feed, synthStories, completedSet, sort]);

  const unreadCount = useMemo(
    () =>
      sections.reduce((n, s) => n + s.entries.filter((e) => e.kind === "story" || !e.done).length, 0),
    [sections],
  );

  const activeSelected =
    selected !== "all" && sections.some((s) => s.topic === selected) ? selected : "all";
  const visibleSections =
    activeSelected === "all" ? sections : sections.filter((s) => s.topic === activeSelected);
  // "Last hour": ONGOING (developing) issues moving right now — recent activity
  // or new coverage since the reader last opened them. Synthesized single-event
  // stories never appear here (they live in their topic sections). Honors the
  // active topic filter AND the search: when a steering interest is set, restrict
  // to developing issues present in the (relevance-narrowed) feed so the band
  // honours the search like the article stream; otherwise surface all active ones.
  const visibleLastMinute = useMemo(() => {
    const searching = (prefs.interestPrompt ?? "").trim().length > 0;
    let developing = stories.filter((s) => s.developing);
    if (searching) {
      const feedIds = new Set(feed.map((it) => it.id));
      developing = developing.filter((s) => s.sources.some((src) => feedIds.has(src.id)));
    }
    const lm = lastMinuteStories(developing, storyViews);
    return activeSelected === "all" ? lm : lm.filter((s) => s.topic === activeSelected);
  }, [stories, feed, storyViews, activeSelected, prefs.interestPrompt]);

  const [panelState, setPanelState] = useState<PanelState>("hidden");
  // The selected place's name, shown as the panel title (e.g. "Spain" instead of "Today").
  const [placeTitle, setPlaceTitle] = useState<string | null>(null);
  // Map navigation lives in the URL so the browser's back/forward arrows move the map.
  const navParams = useLocalSearchParams<{ place?: string }>();
  // URL param first, then the committed pool, else the WORLD (the globe opens on the
  // world landing; the saved home is reached via the globe's home button, not auto).
  const place =
    (typeof navParams.place === "string" && navParams.place) ||
    (prefs.geoPool && geoNodeIdOf(prefs.geoPool)) ||
    GEO_ROOT_ID;

  // Responsive layout math — the feed now lives in the side/sheet panel, so card
  // sizing is driven by the PANEL width, not the full viewport.
  const isWide = width >= 820;
  const panelW = isWide ? Math.min(480, Math.max(360, Math.round(width * 0.42))) : width;
  const contentW = panelW - H_PAD * 2;
  const cols = columnsFor(contentW);
  const GAP = spacing.lg;
  const cardW = cols === 1 ? contentW : Math.floor((contentW - GAP * (cols - 1)) / cols);

  const atQuota = progress.consumedMin >= prefs.dailyQuotaMin;

  return (
    <View style={styles.root}>
      {/* Full-screen globe landing + centered place search — the branding anchor. */}
      <Globe
        variant="hero"
        activePoolId={prefs.geoPool}
        home={prefs.geoHome}
        stories={stories}
        worldActive={worldId === DEFAULT_WORLD_ID && !prefs.geoPool}
        topInset={insets.top}
        // Desktop: while the side panel is open it covers the right; tell the globe so it
        // recenters into the visible area (and recenters back when the panel closes).
        rightInset={isWide && panelState === "open" ? panelW : 0}
        status={status}
        onAlertPress={(id) => openStory(id)}
        onPlace={setPlaceTitle}
        browseNode={place}
        onNavigate={(nodeId) =>
          router.push(
            nodeId && nodeId !== GEO_ROOT_ID ? `/?place=${encodeURIComponent(nodeId)}` : "/",
          )
        }
        onSelectWorld={() => {
          setWorld(DEFAULT_WORLD_ID);
          setPlaceTitle(null);
          setPanelState(isWide ? "open" : "peek");
        }}
        onSelect={(poolId) => {
          // World root = the Front Page (clear any geographic override).
          const next = !poolId || poolId === poolIdForNode(GEO_ROOT_ID) ? undefined : poolId;
          if (next !== prefs.geoPool) void updatePrefs({ geoPool: next });
        }}
        onSetHome={(nodeId) => void updatePrefs({ geoHome: nodeId })}
        onOpenArticles={() => setPanelState(isWide ? "open" : "peek")}
      />

      {/* Articles surface: desktop right slide-in / mobile bottom pull-up sheet. */}
      <ArticlesPanel
        state={panelState}
        wide={isWide}
        width={panelW}
        topInset={insets.top}
        peekTitle={placeTitle ?? t("feed.title")}
        peekSubtitle={
          unreadCount > 0
            ? t(unreadCount === 1 ? "feed.summaryOne" : "feed.summary", {
                count: unreadCount,
                topics: sections.length,
              })
            : t("feed.caughtUp")
        }
        refreshing={loadingFeed}
        onRefresh={() => {
          void refreshFeed({ force: true });
          void loadStories(true);
        }}
        onExpand={() => setPanelState("open")}
        onClose={() => setPanelState(isWide ? "hidden" : "peek")}
      >
        {/* World switcher: pick which news universe to browse (front page = World).
            Switching the topical world EXITS geo mode, so clear the globe's place too
            (otherwise the map keeps showing the old place while the feed has moved). */}
        <WorldSwitcher
          worldId={worldId}
          busyWorld={busyWorld}
          onSelect={(id) => {
            setWorld(id);
            setPlaceTitle(null);
            router.push("/");
          }}
        />

        {/* Only one world refreshes at a time. Surface this only when the
            selected world has nothing to show because another is hogging the lock. */}
        {busyWorld && busyWorld !== feedWorldId && feed.length === 0 && (
          <View style={styles.busyBanner}>
            <ActivityIndicator size="small" color={colors.warn} />
            <Text style={styles.busyText}>{t("feed.busy", { world: t(`world.${busyWorld}`) })}</Text>
          </View>
        )}

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
            placeholder={t("feed.searchPlaceholder")}
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
            <Text style={styles.title}>{t("feed.title")}</Text>
            {feed.length > 0 && (
              <Text style={styles.subtitle}>
                {unreadCount > 0
                  ? t(unreadCount === 1 ? "feed.summaryOne" : "feed.summary", {
                      count: unreadCount,
                      topics: sections.length,
                    })
                  : t("feed.caughtUp")}
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              void refreshFeed({ force: true });
              void loadStories(true);
            }}
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
              {t("feed.refresh")}
            </Text>
          </Pressable>
        </View>

        <AnalysisProgress status={status} />

        <BriefingCard briefing={briefing} loading={loadingBriefing} stream={briefingStream} />

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

        {/* Sort toggle: relevance (default) vs recency — applies within each topic. */}
        {sections.length > 0 && (
          <View style={styles.sortRow}>
            <Pressable
              onPress={() => {
                if (sort !== "relevance") void updatePrefs({ feedSort: "relevance" });
              }}
              style={[styles.sortBtn, sort === "relevance" && styles.sortBtnActive]}
              accessibilityRole="button"
            >
              <Ionicons
                name="flame"
                size={12}
                color={sort === "relevance" ? colors.bg : colors.textDim}
              />
              <Text style={[styles.sortText, sort === "relevance" && styles.sortTextActive]}>
                {t("feed.sortRelevant")}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (sort !== "recency") void updatePrefs({ feedSort: "recency" });
              }}
              style={[styles.sortBtn, sort === "recency" && styles.sortBtnActive]}
              accessibilityRole="button"
            >
              <Ionicons name="time" size={12} color={sort === "recency" ? colors.bg : colors.textDim} />
              <Text style={[styles.sortText, sort === "recency" && styles.sortTextActive]}>
                {t("feed.sortRecent")}
              </Text>
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
              label={t("feed.all")}
              icon="albums"
              color={colors.accent}
              count={sections.reduce((n, s) => n + s.entries.length, 0)}
              active={activeSelected === "all"}
              onPress={() => setSelected("all")}
            />
            {sections.map((s) => {
              const m = topicMeta(s.topic);
              return (
                <FilterChip
                  key={s.topic}
                  label={t(`topic.${s.topic}`)}
                  icon={m.icon}
                  color={m.color}
                  count={s.entries.length}
                  active={activeSelected === s.topic}
                  onPress={() => setSelected(s.topic)}
                />
              );
            })}
          </ScrollView>
        )}

        {/* Last minute — stories that changed since the reader last opened them
            (new articles / fresher coverage). Only shown once there's something
            genuinely new to surface, so a first-time reader never sees it. */}
        {visibleLastMinute.length > 0 && (
          <View style={{ gap: spacing.md }}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: colors.accent + "22" }]}>
                <Ionicons name="flash" size={15} color={colors.accent} />
              </View>
              <Text style={styles.sectionTitle}>{t("feed.lastMinute")}</Text>
              <Text style={styles.sectionCount}>{visibleLastMinute.length}</Text>
            </View>
            <Text style={styles.lastMinuteSub}>{t("feed.lastMinuteSub")}</Text>
            <View style={[styles.grid, { gap: GAP }]}>
              {visibleLastMinute.map((story) => (
                <FadeInView key={`lm-${story.id}`} style={{ width: cardW }}>
                  <StoryCard story={story} onOpen={(s) => openStory(s.id)} />
                </FadeInView>
              ))}
            </View>
          </View>
        )}

        {/* Body: per-topic stream of story cards + standalone articles, treated
            alike. Developing/synthesized stories sit in their own topic section
            (no separate band) and just show stale until a refresh updates them. */}
        {sections.length === 0 ? (
          loadingFeed ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.emptySub}>{t("feed.curating")}</Text>
            </View>
          ) : feedError ? null : (
            <View style={styles.empty}>
              <Ionicons
                name={atQuota ? "checkmark-done-circle-outline" : "newspaper-outline"}
                size={40}
                color={colors.textFaint}
              />
              <Text style={styles.emptyTitle}>
                {atQuota ? t("feed.empty.quotaTitle") : t("feed.empty.noItemsTitle")}
              </Text>
              <Text style={styles.emptySub}>
                {atQuota ? t("feed.empty.quotaSub") : t("feed.empty.noItemsSub")}
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
                  <Text style={styles.sectionTitle}>{t(`topic.${section.topic}`)}</Text>
                  <Text style={styles.sectionCount}>{section.entries.length}</Text>
                </View>
                <View style={[styles.grid, { gap: GAP }]}>
                  {section.entries.map((e) =>
                    e.kind === "story" ? (
                      <FadeInView key={e.story.id} style={{ width: cardW }}>
                        <StoryCard
                          story={e.story}
                          onOpen={(s) => openStory(s.id)}
                          issue={issueForStory(e.story)}
                          onOpenIssue={openStory}
                        />
                      </FadeInView>
                    ) : (
                      <FadeInView key={e.item.id} style={{ width: cardW }}>
                        <FeedCard
                          item={e.item}
                          done={completedSet.has(e.item.id)}
                          summary={summaryById.get(e.item.id)}
                          onSummarize={(it) => openNews(it.id)}
                          onRead={(it) => openNews(it.id)}
                          issue={issueByArticle.get(e.item.id)}
                          onOpenIssue={openStory}
                        />
                      </FadeInView>
                    ),
                  )}
                </View>
              </View>
            );
          })
        )}
      </ArticlesPanel>
    </View>
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
  root: { flex: 1, backgroundColor: colors.bg },
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
  busyBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn + "55",
    backgroundColor: colors.warn + "14",
  },
  busyText: { color: colors.textDim, fontSize: font.small, flex: 1, lineHeight: 18 },
  sortRow: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.xs },
  sortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sortBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  sortText: { color: colors.textDim, fontSize: font.small, fontWeight: "700" },
  sortTextActive: { color: colors.bg },
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
  lastMinuteSub: { color: colors.textDim, fontSize: font.small, marginTop: -spacing.xs, lineHeight: font.small * 1.4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  empty: { padding: spacing.xl, alignItems: "center", gap: spacing.sm, marginTop: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700", textAlign: "center" },
  emptySub: { color: colors.textDim, fontSize: font.small, textAlign: "center" },
});
