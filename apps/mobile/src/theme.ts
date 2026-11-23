import type { Status } from "@huntaway/contracts"

// The board's dark colours (apps/web/src/index.css's --color-*), so the app and a plugin's page in it (HE-99) look like
// the board.
export const colors = {
  bg: "#0b0b0e",
  panel: "#111116",
  panel2: "#16161d",
  raised: "#1c1c25",
  line: "#24242e",
  lineStrong: "#33333f",
  fg: "#e6e6ec",
  muted: "#9a9aab",
  faint: "#6b6b7b",
  accent: "#7c7cf8",
  accentStrong: "#6366f1",
  red: "#f87171",
  amber: "#f59e0b",
  green: "#34d399",
  blue: "#60a5fa",
} as const

/** The board's status colours (index.css's --color-st-*). */
export const STATUS_COLOR: Readonly<Record<Status, string>> = {
  backlog: "#5f5f6e",
  todo: "#8b8b9c",
  in_progress: "#60a5fa",
  needs_attention: "#f59e0b",
  in_review: "#a78bfa",
  ready_for_merge: "#f472b6",
  done: "#34d399",
}

/** A colour with an alpha (`tint("#f59e0b", 0.15)`), for a pill's or a card's wash. */
export const tint = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** Spacing and corners, in one place. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const

/**
 * The theme as a plugin's page gets it (docs/plan/15-plugins.md, Pages): the declarations of its frame's `:root`, the
 * names the web board's own frames have (`--color-*`, `--font-*`), with the fonts a phone has.
 */
export const frameVars: string = [
  "color-scheme:dark",
  `--color-bg:${colors.bg}`,
  `--color-panel:${colors.panel}`,
  `--color-panel-2:${colors.panel2}`,
  `--color-raised:${colors.raised}`,
  `--color-line:${colors.line}`,
  `--color-line-strong:${colors.lineStrong}`,
  `--color-fg:${colors.fg}`,
  `--color-muted:${colors.muted}`,
  `--color-faint:${colors.faint}`,
  `--color-accent:${colors.accent}`,
  `--color-accent-strong:${colors.accentStrong}`,
  `--color-st-todo:${STATUS_COLOR.todo}`,
  `--color-st-progress:${STATUS_COLOR.in_progress}`,
  `--color-st-attention:${STATUS_COLOR.needs_attention}`,
  `--color-st-review:${STATUS_COLOR.in_review}`,
  `--color-st-merge:${STATUS_COLOR.ready_for_merge}`,
  `--color-st-done:${STATUS_COLOR.done}`,
  `--color-st-backlog:${STATUS_COLOR.backlog}`,
  "--font-sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  "--font-mono:ui-monospace,Menlo,'Roboto Mono',monospace",
].join(";")
