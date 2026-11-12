import type { HostProject as Project, HostTask as Task } from "@huntaway/client"
import { byName } from "./projectOrder.ts"

/** A row of a host's projects on the sidebar: a project on its own, or a group of them. */
export type SidebarEntry =
  | { kind: "project"; key: string; project: Project }
  | { kind: "group"; key: string; name: string; hostId: string; projects: Project[] }

/** Groups belong to a host: its projects with the same group name are in the same group. */
export const groupKey = (hostId: string, name: string) => `${hostId}:${name}`

/** The projects of a group, in sidebar order. */
export const groupProjects = (projects: ReadonlyArray<Project>, hostId: string, name: string) =>
  projects.filter((p) => p.host_id === hostId && p.group_name === name)

/** A host's group names, in sidebar order. */
export const groupNames = (projects: ReadonlyArray<Project>, hostId: string) => [
  ...new Set(projects.flatMap((p) => (p.host_id === hostId && p.group_name ? [p.group_name] : []))),
]

/** Whether a task is one of a host's group's group tasks. */
const inGroup = (t: Task, hostId: string, name?: string) =>
  t.host_id === hostId && t.kind === "task" && !t.project_id && !!t.group_name && (name === undefined || t.group_name === name)

/**
 * A group's group tasks, of every profile loaded: the board shows them all, as it shows the
 * group's projects of every profile in view, even if their own profile has no project left in
 * the group.
 */
export const groupTasks = (tasks: ReadonlyArray<Task>, hostId: string, name: string) => tasks.filter((t) => inGroup(t, hostId, name))

/** The groups that have group tasks among `tasks`, by groupKey. */
export const groupsWithTasks = (tasks: ReadonlyArray<Task>) =>
  new Set(tasks.flatMap((t) => (inGroup(t, t.host_id) && t.group_name ? [groupKey(t.host_id, t.group_name)] : [])))

/**
 * Groups on a host that only have group tasks left, their projects having been ungrouped or
 * deleted, by name. They keep a board so their tasks can still be opened.
 */
export function orphanGroupNames(tasks: ReadonlyArray<Task>, projects: ReadonlyArray<Project>, hostId: string) {
  const live = new Set(groupNames(projects, hostId))
  const names = tasks.flatMap((t) => (inGroup(t, hostId) && t.group_name && !live.has(t.group_name) ? [t.group_name] : []))
  return [...new Set(names)].toSorted((a, b) => a.localeCompare(b))
}

/** A host's (sorted) projects as sidebar rows, in alphabetical order: each group sits where its name does, its projects inside it. */
export function sidebarEntries(projects: ReadonlyArray<Project>): SidebarEntry[] {
  const entries: SidebarEntry[] = []
  const groups = new Map<string, Extract<SidebarEntry, { kind: "group" }>>()
  for (const p of projects) {
    if (!p.group_name) {
      entries.push({ kind: "project", key: `p:${p.id}`, project: p })
      continue
    }
    const key = groupKey(p.host_id, p.group_name)
    const group = groups.get(key)
    if (group) group.projects.push(p)
    else {
      const entry = { kind: "group" as const, key: `g:${key}`, name: p.group_name, hostId: p.host_id, projects: [p] }
      groups.set(key, entry)
      entries.push(entry)
    }
  }
  const name = (e: SidebarEntry) => (e.kind === "project" ? e.project.name : e.name)
  return entries.toSorted((a, b) => byName(name(a), name(b)))
}

/** How a project is named in the hidden, pinned and favourite sets (state/prefs.ts): by host, as ids are only unique on their host. */
export const hiddenKey = (p: Pick<Project, "host_id" | "id">) => `${p.host_id}:${p.id}`

/**
 * The projects the sidebar lists while `profile` is active: its own and the pinned ones, in
 * order. `profileOf` names a project's profile (profiles are merged across hosts by name).
 */
export const profileProjects = (
  projects: ReadonlyArray<Project>,
  profile: string | undefined,
  profileOf: (p: Project) => string | undefined,
  pinned: Set<string>,
) => projects.filter((p) => profileOf(p) === profile || pinned.has(hiddenKey(p)))

/**
 * The sidebar rows that aren't hidden (or favorites, which have a section of their own): a
 * group shows its other projects, and goes once there are none. A group whose projects left are
 * all favorites stays, with none, while it has group tasks (`withTasks`, by groupKey), as the
 * way to its board.
 */
export function visibleEntries(entries: SidebarEntry[], hidden: Set<string>, favorites = new Set<string>(), withTasks = new Set<string>()): SidebarEntry[] {
  const shown = (p: Project) => !hidden.has(hiddenKey(p))
  const listed = (p: Project) => shown(p) && !favorites.has(hiddenKey(p))
  return entries.flatMap((e): SidebarEntry[] => {
    if (e.kind === "project") return listed(e.project) ? [e] : []
    const projects = e.projects.filter(listed)
    return projects.length || (e.projects.some(shown) && withTasks.has(groupKey(e.hostId, e.name))) ? [{ ...e, projects }] : []
  })
}

/**
 * Whether a task a group task's agent created is in one of the group's projects. Its agent can
 * also create tasks elsewhere (anything the user asks for along the way), which aren't the
 * group's work.
 */
export const inGroupTaskGroup = (t: Task, groupTask: Task, projects: ReadonlyArray<Project>) =>
  !!t.project_id && projects.some((p) => p.id === t.project_id && p.host_id === groupTask.host_id && p.group_name === groupTask.group_name)
