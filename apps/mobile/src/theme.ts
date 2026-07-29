/**
 * Colours and spacing, mirroring the web client's dark palette.
 *
 * A meeting app is looked at in the dark more often than not, and video is the
 * only thing on screen that should be bright. Everything here is deliberately
 * low-contrast against the tiles.
 */
export const theme = {
  color: {
    bg: '#0b0d10',
    surface: '#14171c',
    elevated: '#1c2027',
    border: '#272c35',
    fg: '#e8eaed',
    muted: '#9aa2ad',
    accent: '#3b82f6',
    danger: '#ef4444',
    success: '#22c55e',
  },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  space: (units: number) => units * 4,
  /** Minimum comfortable touch target. Below this, taps start missing. */
  tapTarget: 48,
} as const;
