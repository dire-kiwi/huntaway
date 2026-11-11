// What the old store.ts gave the components besides `useStore`: lookups and derived values over the board, kept by name
// so the components change one import (docs/plan/09-frontend.md, step 1). They read `state/board.ts`.
import {
  canRunAgents,
  optimisticMove,
  usableHost,
  type Board,
  type HostAgentConfig as ClaudeConfig,
  type HostProfile as Profile,
  type HostProject as Project,
  type HostTask as Task,
} from "@huntaway/client"
import type { Task as WireTask, TaskPatch } from "@huntaway/contracts"
import { Cause } from "effect"
import { useMemo, useRef } from "react"
import { board, useBoard } from "../state/board"
import { registry } from "../state/registry"
import { noteMove } from "../state/notify"

/** The board as the components read it (the old store's `State`). */
export type State = Board

/**
 * A selector that keeps the value it returned last while the new one is shallowly equal to it (the same items, or the
 * same keys with the same values), so `useBoard` does not redraw for a new array or object that says the same. As
 * zustand's `useShallow`.
 */
export function useShallow<S, T>(selector: (s: S) => T): (s: S) => T {
  const prev = useRef<{ value: T } | null>(null)
  return (s) => {
    const next = selector(s)
    if (prev.current && shallow(prev.current.value, next)) return prev.current.value
    prev.current = { value: next }
    return next
  }
}

function shallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && Object.is(Reflect.get(a, k), Reflect.get(b, k)))
}

/**
 * Moves, reorders or stars `task` as `patch` says (`tasks.update`), showing it on the board at once until the host's
 * event replaces it, or putting it back if the host refuses (the client's `optimisticMove`). It takes the place of the
 * old components' `upsertTask` before a request and again after its failure. Rejects with the call's tagged error.
 */
export function moveTask(task: { readonly host_id: string; readonly id: string }, patch: TaskPatch): Promise<WireTask> {
  // A move of the user's own doesn't notify them (6.8): noted before the request, as its event reaches every tab first.
  if (patch.status) noteMove(task.host_id, task.id, patch.status)
  const fn = optimisticMove({ host_id: task.host_id, id: task.id })
  const { promise, resolve, reject } = Promise.withResolvers<WireTask>()
  const unmount = registry.mount(fn)
  const cancel = registry.subscribe(fn, (result) => {
    if (result._tag === "Initial" || result.waiting) return
    cancel()
    unmount()
    if (result._tag === "Success") resolve(result.value)
    else reject(Cause.squash(result.cause))
  })
  registry.set(fn, patch)
  return promise
}

/** Where new work goes by default: this host if it can run agents, else the first one that can. */
export function defaultAgentHost(hosts: State["hosts"] = board.get().hosts): string | null {
  return (hosts.find((h) => h.local && canRunAgents(h)) ?? hosts.find(usableHost))?.id ?? null
}

/**
 * Where a profile's new scratch tasks go: this host if it can run agents, otherwise the host picked in Settings → Hosts
 * (if it's usable), otherwise the default; or failing those, the first usable host with the profile. Null when none of
 * them has it.
 */
export function scratchHost(profileName: string, s: Pick<State, "hosts" | "hostSettings" | "profiles"> = board.get()): Profile | null {
  const usable = s.hosts.filter(usableHost)
  const local = s.hosts.find((h) => h.local)
  const picked = s.hostSettings[local?.id ?? ""]?.scratch_host
  const preferred = [
    local && canRunAgents(local) ? local.id : null,
    usable.find((h) => picked != null && String(h.id) === String(picked))?.id,
    defaultAgentHost(s.hosts),
    ...usable.map((h) => h.id),
  ]
  const on = (h: string | null | undefined) => s.profiles.find((p) => p.host_id === h && p.name === profileName)
  return preferred.map(on).find((p) => !!p) ?? null
}

/** The configs a new thread can pick from: the project's override, else the profile's, the default first. */
export function availableConfigs(s: Pick<State, "profiles" | "claudeConfigs">, hostId: string, profileId: string, project?: Project | null): ClaudeConfig[] {
  const own = project?.claude_config_ids?.length ? project.claude_config_ids : null
  const ids = own ?? s.profiles.find((p) => p.host_id === hostId && p.id === profileId)?.claude_config_ids ?? []
  return ids.map((id) => s.claudeConfigs.find((c) => c.host_id === hostId && c.id === id)).filter((c): c is ClaudeConfig => !!c)
}

/**
 * The config a task's agent runs with: its own, or else the first its project (or profile) offers. A config deleted
 * since falls back to that too. None for one that started with none (its profile had no configs then), which stays in
 * Claude's default config.
 */
export function taskConfig(s: Pick<State, "profiles" | "claudeConfigs" | "projects">, task: Task): ClaudeConfig | undefined {
  const own = s.claudeConfigs.find((c) => c.host_id === task.host_id && c.id === task.claude_config_id)
  if (own) return own
  if (!task.claude_config_id && task.session_id) return undefined
  return availableConfigs(
    s,
    task.host_id,
    task.profile_id,
    s.projects.find((p) => p.host_id === task.host_id && p.id === task.project_id),
  )[0]
}

export function useAvailableConfigs(hostId: string, profileId: string, project?: Project | null): ClaudeConfig[] {
  const profiles = useBoard((s) => s.profiles)
  const claudeConfigs = useBoard((s) => s.claudeConfigs)
  return useMemo(() => availableConfigs({ profiles, claudeConfigs }, hostId, profileId, project), [profiles, claudeConfigs, hostId, profileId, project])
}

/** Distinct profile names across hosts, in first-seen order. */
export function profileNames(profiles: ReadonlyArray<Pick<Profile, "name">>): string[] {
  return [...new Set(profiles.map((p) => p.name))]
}

/** The name of the profile a task or project is in (profiles are merged across hosts by name). */
export function profileNameOf(s: Pick<State, "profiles">, x: { host_id: string; profile_id: string }): string | undefined {
  return s.profiles.find((p) => p.host_id === x.host_id && p.id === x.profile_id)?.name
}

export function useProfileName(x: { host_id: string; profile_id: string } | undefined): string | undefined {
  return useBoard((s) => (x ? profileNameOf(s, x) : undefined))
}

export function useProject(id: string | null | undefined): Project | undefined {
  return useBoard((s) => s.projects.find((p) => p.id === id))
}

export function useHost(id: string | null | undefined): State["hosts"][number] | undefined {
  return useBoard((s) => s.hosts.find((h) => h.id === id))
}

/** A group task: in no project, it plans the work of its group's projects. */
export { isGroupTask } from "@huntaway/client"

/** The names of a profile's configs, for a list of profiles (6.12). */
export function profileConfigLabel(s: Pick<State, "claudeConfigs">, p: Pick<Profile, "host_id" | "claude_config_ids">): string {
  const names = p.claude_config_ids.map((id) => s.claudeConfigs.find((c) => c.host_id === p.host_id && c.id === id)?.name).filter((n) => n !== undefined)
  return names.length ? names.join(", ") : "Claude's default config"
}
