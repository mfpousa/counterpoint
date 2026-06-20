// Shared presentation metadata for topics: a label, an icon, and an accent
// color. Centralized so feed cards, section headers, and filter chips all read
// identically. Colors are muted to fit the calm, anti-engagement palette.

import type { Ionicons } from "@expo/vector-icons";
import type { Topic } from "../types";

export interface TopicMeta {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}

export const TOPIC_META: Record<Topic, TopicMeta> = {
  world: { label: "World", icon: "earth", color: "#6EA8FE" },
  politics: { label: "Politics", icon: "people", color: "#E0A94B" },
  economics: { label: "Economics", icon: "trending-up", color: "#5BD6A6" },
  science: { label: "Science", icon: "flask", color: "#9B8CFF" },
  technology: { label: "Technology", icon: "hardware-chip", color: "#56C2D6" },
  history: { label: "History", icon: "book", color: "#C9A06B" },
  health: { label: "Health", icon: "fitness", color: "#E08AA8" },
  culture: { label: "Culture", icon: "color-palette", color: "#D98C5F" },
};

export function topicMeta(topic: Topic): TopicMeta {
  return TOPIC_META[topic] ?? { label: topic, icon: "ellipse", color: "#9AA4B2" };
}

/** Stable display order for sections / filters. */
export const TOPIC_ORDER: Topic[] = [
  "world",
  "politics",
  "economics",
  "technology",
  "science",
  "health",
  "history",
  "culture",
];
