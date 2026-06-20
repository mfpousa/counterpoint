// A calm, focus-oriented palette. Deliberately low-stimulation: no reds for
// "urgency", muted accents, generous spacing. The anti-engagement aesthetic.

export const colors = {
  bg: "#0E1116",
  surface: "#171B22",
  surfaceAlt: "#1F242D",
  border: "#2A313C",
  text: "#E6EAF0",
  textDim: "#9AA4B2",
  textFaint: "#6B7382",
  accent: "#6EA8FE", // calm blue
  accentDim: "#3D5A8A",
  // Lean spectrum: blue (left) -> grey (center) -> amber (right).
  // Intentionally NOT red/blue-tribal; amber + slate read as "perspective" not "team".
  left: "#5B8DEF",
  center: "#8B93A1",
  right: "#E0A94B",
  good: "#5BD6A6",
  warn: "#E6B86B",
  danger: "#E08A8A",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const font = {
  h1: 28,
  h2: 22,
  h3: 18,
  body: 15,
  small: 13,
  tiny: 11,
} as const;
