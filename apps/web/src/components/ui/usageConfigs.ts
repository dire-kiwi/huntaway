import type { HostAgentConfig, HostProfile, HostProject } from "@huntaway/client"
import type { Usage, UsageLimit } from "@huntaway/contracts"
import { nowMillis } from "../../state/clock"
import { localeString, millisOf } from "./dates"

// Usage limits as the board shows them (the old src/usageConfigs.ts): when a limit resets, which configs the sidebar's
// usage panel shows, and when a config is running low.

/** How long until `iso`: "21m", "3h 5m", or a weekday and time further out; "now" once it's past. */
export function resetsIn(iso: string, now: number): string {
  const ms = millisOf(iso) - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "now"
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min}m`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`
  return localeString(iso, { weekday: "short", hour: "numeric" })
}

/** The time `iso` is, in full: "Sun 2 Nov, 6:30 pm". */
export const resetTime = (iso: string): string => localeString(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

/**
 * The configs whose usage the sidebar shows for the profile named `profile`: those set to show it
 * that one of its profiles (on each host) uses, or one of their projects picks instead.
 */
export function usageConfigs<C extends Pick<HostAgentConfig, "host_id" | "id" | "show_usage">>(
  configs: ReadonlyArray<C>,
  profiles: ReadonlyArray<Pick<HostProfile, "host_id" | "id" | "name" | "claude_config_ids">>,
  projects: ReadonlyArray<Pick<HostProject, "host_id" | "profile_id" | "claude_config_ids">>,
  profile: string | undefined,
): C[] {
  const used = new Set<string>()
  for (const p of profiles.filter((x) => x.name === profile)) {
    for (const id of p.claude_config_ids) used.add(`${p.host_id}:${id}`)
    for (const pr of projects.filter((x) => x.host_id === p.host_id && x.profile_id === p.id)) {
      for (const id of pr.claude_config_ids ?? []) used.add(`${p.host_id}:${id}`)
    }
  }
  return configs.filter((c) => c.show_usage && used.has(`${c.host_id}:${c.id}`))
}

/** How much of a limit (percent) is used when the board warns that it's running low. */
export const WARN_AT = 80

/** "resets in 2h 10m", or "resets Tue 6 PM" further out. */
export function resetsPhrase(iso: string, now: number): string {
  const ms = millisOf(iso) - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "has reset"
  return ms < 24 * 3600_000 ? `resets in ${resetsIn(iso, now)}` : `resets ${resetsIn(iso, now)}`
}

/** A config's usage worth warning about: `out` (a run was refused, or a limit is used up), or `warn` at `WARN_AT`% or more. */
export interface UsageAlert {
  level: "warn" | "out"
  /** "Session 85% used · resets in 2h 10m". */
  text: string
  /** "85% used", "out of usage": by its name in a picker. */
  short: string
  /** When it resets, if known. */
  until: string | null
}

/**
 * For a config with a proxy each shown limit is one account's (the one that resets first), so the alert is worked out
 * from its accounts instead: the pool has room while any account does, so it's the alert of the account with the most
 * room, taking each account's limit with the least left.
 */
export function usageAlert(u: Pick<Usage, "limits" | "out_until" | "accounts"> | undefined, now = nowMillis()): UsageAlert | null {
  if (!u) return null
  const live = (iso: string | null | undefined): boolean => !iso || millisOf(iso) > now
  const when = (iso: string | null | undefined): string => (iso ? ` · ${resetsPhrase(iso, now)}` : "")
  if (u.out_until && live(u.out_until)) return { level: "out", text: `Out of usage${when(u.out_until)}`, short: "out of usage", until: u.out_until }
  // The limit with the least left, of those that haven't reset since they were read.
  const worstOf = (limits: Usage["limits"]): UsageLimit | undefined => limits.filter((l) => live(l.resets_at)).toSorted((a, b) => b.percent - a.percent)[0]
  // Accounts whose usage couldn't be read say nothing either way.
  const read = (u.accounts ?? []).filter((a) => a.limits.length > 0)
  // An account with nothing live to report has room.
  const each = read.map((a) => worstOf(a.limits))
  const worst =
    read.length === 0
      ? worstOf(u.limits)
      : each.some((l) => !l)
        ? undefined
        : each.filter((l): l is UsageLimit => !!l).toSorted((a, b) => a.percent - b.percent)[0]
  if (!worst || worst.percent < WARN_AT) return null
  const used = worst.percent >= 100
  const amount = used ? "used up" : `${Math.round(worst.percent)}% used`
  return {
    level: used ? "out" : "warn",
    text: `${worst.label} ${amount}${when(worst.resets_at)}`,
    short: `${worst.label.toLowerCase()} ${amount}`,
    until: worst.resets_at,
  }
}
