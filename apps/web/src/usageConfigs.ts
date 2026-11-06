import type { ClaudeConfig, Profile, Project, Usage } from "./api";

/**
 * The configs whose usage the sidebar shows for the profile named `profile`: those set to show it
 * that one of its profiles (on each host) uses, or one of their projects picks instead.
 */
export function usageConfigs(
  configs: ClaudeConfig[],
  profiles: Pick<Profile, "host_id" | "id" | "name" | "claude_config_ids">[],
  projects: Pick<Project, "host_id" | "profile_id" | "claude_config_ids">[],
  profile: string | undefined,
): ClaudeConfig[] {
  const used = new Set<string>();
  for (const p of profiles.filter((p) => p.name === profile)) {
    for (const id of p.claude_config_ids ?? []) used.add(`${p.host_id}:${id}`);
    for (const pr of projects.filter((pr) => pr.host_id === p.host_id && pr.profile_id === p.id)) {
      for (const id of pr.claude_config_ids ?? []) used.add(`${p.host_id}:${id}`);
    }
  }
  return configs.filter((c) => c.show_usage && used.has(`${c.host_id}:${c.id}`));
}

/** How much of a limit (percent) is used when the board warns that it's running low. */
export const WARN_AT = 80;

/** How long until `iso`: "21m", "3h 5m", or a weekday and time further out; "now" once it's past. */
export function resetsIn(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric" });
}

/** "resets in 2h 10m", or "resets Tue 6 PM" further out. */
export function resetsPhrase(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "has reset";
  return ms < 24 * 3600_000 ? `resets in ${resetsIn(iso, now)}` : `resets ${resetsIn(iso, now)}`;
}

/** The time `iso` is, in full: "Sun 2 Nov, 6:30 pm". */
export const resetTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A config's usage worth warning about: `out` (a run was refused, or a limit is used up), or `warn` at `WARN_AT`% or more. */
export interface UsageAlert {
  level: "warn" | "out";
  /** "Session 85% used · resets in 2h 10m". */
  text: string;
  /** "85% used", "out of usage": by its name in a picker. */
  short: string;
  /** When it resets, if known. */
  until: string | null;
}

export function usageAlert(u: Pick<Usage, "limits" | "out_until"> | undefined, now = Date.now()): UsageAlert | null {
  if (!u) return null;
  const live = (iso: string | null | undefined) => !iso || new Date(iso).getTime() > now;
  const when = (iso: string | null | undefined) => (iso ? ` · ${resetsPhrase(iso, now)}` : "");
  if (u.out_until && live(u.out_until)) return { level: "out", text: `Out of usage${when(u.out_until)}`, short: "out of usage", until: u.out_until };
  // The limit with the least left, of those that haven't reset since they were read.
  const worst = u.limits.filter((l) => live(l.resets_at)).sort((a, b) => b.percent - a.percent)[0];
  if (!worst || worst.percent < WARN_AT) return null;
  const used = worst.percent >= 100;
  const amount = used ? "used up" : `${Math.round(worst.percent)}% used`;
  return { level: used ? "out" : "warn", text: `${worst.label} ${amount}${when(worst.resets_at)}`, short: `${worst.label.toLowerCase()} ${amount}`, until: worst.resets_at };
}
