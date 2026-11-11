import type { PrChecks, Timestamp } from "@huntaway/contracts"
import { compare, outcome } from "./pr.ts"
import type { Check, Pr, Seen } from "./pr.ts"
import { emptyRow } from "./seen.ts"
import type { WatchRow } from "./seen.ts"

// Failed checks (huntaway's mcp/pr_watch/failed.ts): how they stand for the board (`boardChecks`), the ends of their
// logs (`logTail`), and what Fix broken checks counts as told (`toldFailures`). Plain functions.

/** The most failed checks a task keeps. */
export const FAILED_MAX = 20

/**
 * The most failed jobs whose logs a message gives, and how much of the end of each: lines, and characters (of each line,
 * and of the whole).
 */
export const LOGS_MAX = 5
export const LOG_LINES = 80
export const LOG_LINE_CHARS = 400
export const LOG_CHARS = 6000

/** How `checks` (of the pull request at `url`'s head commit `head`) stand, for the board, as of `now`. */
export const boardChecks = (url: string, head: string, checks: ReadonlyArray<Check>, now: Timestamp): PrChecks => {
  const failed = checks.filter((c) => c.state === "Failed")
  return {
    url,
    head,
    outcome: outcome(checks),
    failed: failed.slice(0, FAILED_MAX).map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    more_failed: Math.max(0, failed.length - FAILED_MAX),
    pending: checks.filter((c) => c.state === "Pending").length,
    passed: checks.filter((c) => c.state === "Passed").length,
    since: now,
  }
}

/** Whether two reads found the checks the same (`since` aside). */
export const sameChecks = (a: PrChecks | null, b: PrChecks | null): boolean => {
  if (a === null || b === null) return a === b
  return (
    a.url === b.url &&
    a.head === b.head &&
    a.outcome === b.outcome &&
    a.failed.length === b.failed.length &&
    a.failed.every((f, i) => f.name === b.failed[i]?.name && f.conclusion === b.failed[i]?.conclusion && f.url === b.failed[i]?.url) &&
    a.more_failed === b.more_failed &&
    a.pending === b.pending &&
    a.passed === b.passed
  )
}

const encoder = new TextEncoder()
const byteLen = (s: string) => encoder.encode(s).length

/** `s` without terminal colours and other escape sequences. */
const noAnsi = (s: string): string => {
  let out = ""
  const chars = Array.from(s)
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? ""
    if (c !== "\u001b") {
      out += c
      continue
    }
    // CSI (`ESC [ … final byte`); other escapes are two characters.
    i++
    if (chars[i] === "[") {
      for (i++; i < chars.length; i++) {
        const f = chars[i] ?? ""
        if (f >= "@" && f <= "~") break
      }
    }
  }
  return out
}

/**
 * The end of a job's log from `gh run view --log-failed` (`job<TAB>step<TAB>time line`), for the agent: its last
 * `LOG_LINES` lines (`LOG_CHARS` at most), each under a heading for its step, without times, colours or GitHub's
 * grouping markers.
 */
export const logTail = (raw: string): string => {
  const lines: Array<readonly [string, string]> = []
  const rawLines = raw.split("\n")
  if (rawLines[rawLines.length - 1] === "") rawLines.pop()
  for (let line of rawLines) {
    if (line.endsWith("\r")) line = line.slice(0, -1)
    const parts = line.split("\t")
    const step = parts.length >= 3 ? (parts[1] ?? "") : ""
    let text = parts.length >= 3 ? parts.slice(2).join("\t") : line
    // `2026-11-01T01:02:03.4567890Z ` before each line, and a byte order mark in the first.
    const sp = text.indexOf(" ")
    if (sp >= 0) {
      const time = text.slice(0, sp)
      if (byteLen(time) >= 20 && time.endsWith("Z") && time[4] === "-" && time.includes("T")) text = text.slice(sp + 1)
    }
    text = noAnsi(text.replace(/^﻿+/, "")).trimEnd()
    if (text === "##[endgroup]") continue
    if (text.startsWith("##[group]")) text = text.slice("##[group]".length)
    const chars = Array.from(text)
    if (chars.length > LOG_LINE_CHARS) text = `${chars.slice(0, LOG_LINE_CHARS).join("")}…`
    lines.push([step, text])
  }
  while (lines.length > 0 && lines[lines.length - 1]?.[1] === "") lines.pop()
  let start = Math.max(0, lines.length - LOG_LINES)
  let size = lines.slice(start).reduce((n, [, t]) => n + byteLen(t) + 1, 0)
  while (size > LOG_CHARS && start + 1 < lines.length) {
    size -= byteLen(lines[start]?.[1] ?? "") + 1
    start++
  }
  let out = ""
  if (start > 0) out += `[${start} earlier lines left out]\n`
  let step: string | null = null
  for (const [s, text] of lines.slice(start)) {
    if (step !== s && s !== "") out += `--- ${s} ---\n`
    step = s
    out += `${text}\n`
  }
  return out.trimEnd()
}

/**
 * `pr`'s failed checks have been sent to the agent by hand: they're not news to it any more (`row`, null for a pull
 * request it has none of). News found before but not told yet keeps them told too, and an in-review wake that's still
 * fetching logs isn't sent with them again.
 */
export const toldFailures = (row: WatchRow | null, pr: Pr): WatchRow => {
  const failed = ["checks_failed"]
  const told = (seen: Seen | null): Seen => {
    const c = compare(seen, pr, failed)
    return c.news === null ? c.quiet : c.news.told
  }
  const base = row ?? emptyRow
  const p = base.pending
  return {
    ...base,
    seen: told(row === null ? null : row.seen),
    ...(p === undefined ? {} : { pending: { ...p, told: told(p.told), ...(p.call_id.startsWith("in_review:") ? { superseded: true } : {}) } }),
  }
}
