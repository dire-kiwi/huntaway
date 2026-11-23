import { DateTime, Option } from "effect"

// Times as a phone's list shows them: how long ago, in a couple of characters.

/** When `iso` was, in milliseconds since the epoch; null when it isn't a time. */
export const millisOf = (iso: string | null | undefined): number | null =>
  iso == null ? null : Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toEpochMillis))

/** How long before `now` (milliseconds) `iso` was: "now", "5m", "3h", "2d", "6w", "1y"; "" when it isn't a time. */
export function ago(iso: string | null | undefined, now: number): string {
  const at = millisOf(iso)
  if (at === null) return ""
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 365) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 365)}y`
}
