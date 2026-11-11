import type { PenColor, Task } from "@huntaway/contracts"

/**
 * The colours a pen can have, in the order the host gives them to new pens: each as a base (for backgrounds and borders,
 * mixed with transparency) and text shades for light and dark themes.
 */
export const PEN_COLORS = {
  blue: { base: "#3b82f6", light: "#1d4ed8", dark: "#93c5fd" },
  orange: { base: "#f97316", light: "#c2410c", dark: "#fdba74" },
  green: { base: "#22c55e", light: "#15803d", dark: "#86efac" },
  pink: { base: "#ec4899", light: "#be185d", dark: "#f9a8d4" },
  violet: { base: "#8b5cf6", light: "#6d28d9", dark: "#c4b5fd" },
  teal: { base: "#14b8a6", light: "#0f766e", dark: "#5eead4" },
  amber: { base: "#f59e0b", light: "#b45309", dark: "#fcd34d" },
  red: { base: "#ef4444", light: "#b91c1c", dark: "#fca5a5" },
  lime: { base: "#84cc16", light: "#4d7c0f", dark: "#bef264" },
  indigo: { base: "#6366f1", light: "#4338ca", dark: "#a5b4fc" },
} as const satisfies Record<PenColor, { readonly base: string; readonly light: string; readonly dark: string }>

export const PEN_COLOR_NAMES: ReadonlyArray<PenColor> = ["blue", "orange", "green", "pink", "violet", "teal", "amber", "red", "lime", "indigo"]

export const isPenColor = (c: unknown): c is PenColor => typeof c === "string" && Object.hasOwn(PEN_COLORS, c)

/** A profile's pens thread: the one thread that arranges its pens, off the board's columns, keyed `S-<n>`. */
export const isPensThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "pens"

/** A pen's own thread: the thread that works on one pen's tasks, off the board's columns, keyed `S-<n>`. */
export const isPenThread = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "pen"

/** The pens thread or a pen's own: lasting threads in no project, off the board, that look after pens. */
export const isPenThreads = (t: Pick<Task, "kind" | "task_type">): boolean => isPensThread(t) || isPenThread(t)
