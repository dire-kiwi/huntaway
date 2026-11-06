// The board's dark colours (apps/web/src/index.css), for the app.
import type { Status } from "@huntaway/client";

export const colors = {
  bg: "#0f0f13",
  panel: "#16161c",
  raised: "#1c1c24",
  line: "#2a2a35",
  fg: "#e7e7ee",
  muted: "#a0a0b0",
  faint: "#6e6e80",
  accent: "#8b7cf6",
  accentStrong: "#6d5ae6",
  red: "#f87171",
  amber: "#fbbf24",
  green: "#34d399",
  blue: "#60a5fa",
};

/** The board's status colours (index.css's --color-st-*). */
export const STATUS_COLOR: Record<Status, string> = {
  backlog: "#5f5f6e",
  todo: "#8b8b9c",
  in_progress: "#60a5fa",
  needs_attention: "#f59e0b",
  in_review: "#a78bfa",
  ready_for_merge: "#f472b6",
  done: "#34d399",
};
