// HE-79: a line of the Code tab's file in pieces: its highlighted runs, cut where the symbol picked starts and ends in
// it, so its uses are marked in their colours.
import { occurrences } from "@huntaway/shared"
import type { Run } from "../changes/highlight"

/** Part of a line: its text, its style (an index into the highlighter's; 0 is the default), and whether it's the symbol. */
export interface Piece {
  readonly text: string
  readonly style: number
  readonly mark: boolean
  /** Where it starts in the line. */
  readonly at: number
}

/** The line's pieces: its runs (all of it in the default style when it has none), with `name`'s uses marked. */
export function pieces(text: string, runs: ReadonlyArray<Run> | undefined, name: string | null): Array<Piece> {
  const marks = name ? occurrences(text, name).map((s): [number, number] => [s, s + name.length]) : []
  // Where each piece ends: the runs' ends and the marks' ends, in order.
  const cuts = new Set<number>([text.length])
  let end = 0
  for (const [n] of runs ?? []) cuts.add((end += n))
  for (const [s, e] of marks) cuts.add(s).add(e)
  const ends = [...cuts].filter((c) => c > 0 && c <= text.length).toSorted((a, b) => a - b)
  // Each run's style by where it starts.
  const styleAt: Array<[start: number, style: number]> = []
  let at = 0
  for (const [n, s] of runs ?? []) {
    styleAt.push([at, s])
    at += n
  }
  const out: Array<Piece> = []
  let start = 0
  let r = 0
  for (const e of ends) {
    while (r + 1 < styleAt.length && (styleAt[r + 1]?.[0] ?? Infinity) <= start) r++
    const style = start < at ? (styleAt[r]?.[1] ?? 0) : 0
    out.push({ text: text.slice(start, e), style, mark: marks.some(([s, me]) => start >= s && e <= me), at: start })
    start = e
  }
  return out
}

/** A file's text as lines (its last newline ends the last line rather than starting another). */
export function splitLines(text: string): Array<string> {
  const lines = text.split("\n")
  if (lines.length > 1 && lines.at(-1) === "") lines.pop()
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
}
