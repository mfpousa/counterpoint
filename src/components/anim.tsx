// Lightweight entrance animation used to make new feed cards feel "live": each
// card fades + lifts into place on mount. Because React reuses elements by key,
// only genuinely NEW cards (new ids) mount and animate; existing cards stay put.

import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Text, type TextStyle, type ViewStyle } from "react-native";
import { colors } from "../theme";

export function FadeInView({
  children,
  style,
  /** Stagger (ms) so a batch of new cards cascades in instead of popping at once. */
  delay = 0,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  delay?: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: 320,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [progress, delay]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** A blinking text cursor — shown at the end of streaming text ("AI is writing"). */
export function Cursor({ style }: { style?: TextStyle }) {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.1, duration: 500, useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.Text style={[{ color: colors.accent, fontWeight: "800", opacity: o }, style]}>▌</Animated.Text>;
}

/**
 * Reveals `text` progressively (typewriter) while `active`, then shows it whole.
 * Used for structured story text that arrives complete but should still feel like
 * the AI is writing it. Reveals ~`cps` characters/second.
 */
export function Typewriter({
  text,
  active = true,
  cps = 220,
  style,
  cursor = true,
}: {
  text: string;
  active?: boolean;
  cps?: number;
  style?: TextStyle;
  /** Show the blinking cursor while typing. Disable when nesting inside another
   *  <Text> (an Animated cursor can't be a Text child on web). */
  cursor?: boolean;
}) {
  const [shown, setShown] = useState(active ? "" : text);
  useEffect(() => {
    if (!active) {
      setShown(text);
      return;
    }
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const n = Math.min(text.length, Math.floor(((ts - start) / 1000) * cps));
      setShown(text.slice(0, n));
      if (n < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, active, cps]);
  const done = shown.length >= text.length;
  return (
    <Text style={style}>
      {shown}
      {cursor && active && !done ? <Cursor /> : null}
    </Text>
  );
}

/**
 * Reveals an ARRAY of paragraphs as ONE continuous typewriter: a single cursor
 * moves top-to-bottom, paragraph by paragraph (vs one independent Typewriter per
 * paragraph, which animates them all at once). Each paragraph is its own <Text>
 * so paragraph spacing/styles still apply.
 */
export function TypewriterParagraphs({
  paragraphs,
  active = true,
  cps = 320,
  style,
}: {
  paragraphs: string[];
  active?: boolean;
  cps?: number;
  style?: TextStyle;
}) {
  const total = paragraphs.reduce((sum, p) => sum + p.length, 0);
  const [n, setN] = useState(active ? 0 : total);
  // Re-run when the content changes (join is a cheap identity for the deps).
  const key = paragraphs.join("\u0001");
  useEffect(() => {
    if (!active) {
      setN(total);
      return;
    }
    setN(0);
    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const c = Math.min(total, Math.floor(((ts - start) / 1000) * cps));
      setN(c);
      if (c < total) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, active, cps, total]);

  const out: React.ReactNode[] = [];
  let remaining = n;
  for (let i = 0; i < paragraphs.length; i++) {
    const take = Math.max(0, Math.min(paragraphs[i].length, remaining));
    remaining -= take;
    const started = take > 0 || (i === 0 && total === 0);
    if (!started) break; // below the frontier — reveal as we get there
    // The "frontier" paragraph is the one that consumed the last revealed char.
    const isFrontier = active && n < total && remaining <= 0;
    out.push(
      <Text key={i} style={style}>
        {paragraphs[i].slice(0, take)}
        {isFrontier ? <Cursor /> : null}
      </Text>,
    );
    if (isFrontier) break;
  }
  return <>{out}</>;
}
