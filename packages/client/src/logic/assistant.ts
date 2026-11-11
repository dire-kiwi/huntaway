import type { ApprovalRule, Host, Profile, RuleDecision, Task } from "@huntaway/contracts"
import { decide } from "@huntaway/shared"

/** A profile's assistant thread: off the board, keyed `A-<n>`. */
export const isAssistant = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "assistant"

/** A routine's run of the assistant: a thread under it (`parent_id`), off the board, keyed `A-<n>` too. */
export const isRoutine = (t: Pick<Task, "kind" | "task_type">): boolean => t.kind === "task" && t.task_type === "routine"

/** The assistant or one of its routine threads: off the board. */
export const isAssistants = (t: Pick<Task, "kind" | "task_type">): boolean => isAssistant(t) || isRoutine(t)

/**
 * Where a profile's assistant is. `profileId` is its profile on that host, missing when it cannot be opened there: the
 * host is `offline` or has `no_profile` of that name.
 */
export interface AssistantHome {
  readonly hostId: string
  readonly profileId?: string
  readonly unavailable?: "offline" | "no_profile"
}

type HostedProfile = Pick<Profile, "id" | "name" | "assistant_host"> & { readonly host_id: string }

/**
 * Where profile `name`'s assistant is: the one place a board looks for it. Profiles are merged across hosts by name. The
 * board's own host's profile can name an assistant host, which it is on then, whatever state that host is in; otherwise
 * it is on the board's own host, else the first connected host that has the profile. None when no host has one.
 */
export function assistantHome(
  profiles: ReadonlyArray<HostedProfile>,
  hosts: ReadonlyArray<Pick<Host, "id" | "local" | "connected">>,
  name: string,
): AssistantHome | undefined {
  const local = hosts.find((h) => h.local)
  // A link's id is the other host's id.
  const picked: string | null | undefined = profiles.find((p) => p.name === name && p.host_id === local?.id)?.assistant_host
  if (picked && picked !== local?.id) {
    const host = hosts.find((h) => h.id === picked)
    if (!host?.connected) return { hostId: picked, unavailable: "offline" }
    const there = profiles.find((p) => p.name === name && p.host_id === picked)
    return there ? { hostId: picked, profileId: there.id } : { hostId: picked, unavailable: "no_profile" }
  }
  const homes = profiles.flatMap((profile) => {
    const host = hosts.find((h) => h.id === profile.host_id)
    return profile.name === name && host?.connected ? [{ profile, host }] : []
  })
  const home = homes.find(({ host }) => host.local) ?? homes[0]
  return home && { hostId: home.profile.host_id, profileId: home.profile.id }
}

/** 6.7: an approval rule's decisions, weakest first. */
export const RULE_DECISIONS: ReadonlyArray<RuleDecision> = ["allow", "ask", "never"]

/** 6.7: which of `rules` decides `tool`, as the host decides it (none for questions and plans, which no rule holds for). */
export const ruleFor = (rules: ReadonlyArray<ApprovalRule>, tool: string): ApprovalRule | undefined => decide({ rules, expiry_minutes: 0 }, tool) ?? undefined
