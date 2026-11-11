// When a usage limit resets, as a card says it (from the old src/usageConfigs.ts: the part the board's cards need; the
// sidebar's usage panel and its alerts come with settings/Usage).

/** How long until `iso`: "21m", "3h 5m", or a weekday and time further out; "now" once it's past. */
export function resetsIn(iso: string, now: number): string {
  const at = new Date(iso)
  const ms = at.getTime() - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "now"
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min}m`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`
  return at.toLocaleString(undefined, { weekday: "short", hour: "numeric" })
}

/** The time `iso` is, in full: "Sun 2 Nov, 6:30 pm". */
export const resetTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
