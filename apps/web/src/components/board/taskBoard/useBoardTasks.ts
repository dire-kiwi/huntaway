import { useCallback, useMemo } from "react"
import { useShallow } from "../../boardHelpers"
import {
  hostStatuses,
  isArchived,
  isAssistants,
  isPenThreads,
  keyPrefix,
  STATUSES,
  taskLabels,
  type HostProject as Project,
  type HostTask as Task,
} from "@huntaway/client"
import type { Host, Status } from "@huntaway/contracts"
import { groupTasks } from "../../../projectGroups"
import { isGroupTask } from "../../boardHelpers"
import { useClock } from "../../ui"
import { showsStatus, sortTasks, taskKinds, taskMatcher, isFiltering, type BoardQuery, type SortKey, type TaskKind } from "../boardQuery"
import type { FilterOption } from "../BoardControls"
import { useCreatedProgress } from "../TaskCard"
import { byStatus } from "../stacks"
import { useBoard } from "../../../state/board"

/** What each board's task picker (below) picked last, from which tasks. */
const lastPicked = new WeakMap<object, { from: Readonly<Record<string, Task>>; picked: Task[] }>()

/** The board's tasks by status, what `query` and `sort` leave of them to show, and the filter menu's choices. */
export function useBoardTasks({
  hosts,
  hostId,
  projects,
  group,
  profiles,
  only,
  query,
  sort,
}: {
  hosts: ReadonlyArray<Host>
  hostId?: string | undefined
  projects: ReadonlyArray<Project>
  group?: string | undefined
  profiles?: Set<string> | undefined
  only?: ((t: Task) => boolean) | undefined
  query: BoardQuery
  sort: SortKey
}) {
  // Across hosts, the columns any of them has (each takes the tasks it can): those with the
  // projects, and for a profile's board every host with the profile, whose tasks in no project
  // show whether or not it has projects or can run agents.
  const statuses = useMemo(() => {
    const on: (Host | undefined)[] = hostId
      ? [hosts.find((h) => h.id === hostId)]
      : hosts.filter((h) => projects.some((p) => p.host_id === h.id) || [...(profiles ?? [])].some((k) => k.startsWith(`${h.id}:`)))
    const ids = new Set(on.flatMap((h) => hostStatuses(h).map((s) => s.id)))
    const shown = STATUSES.filter((s) => ids.has(s.id) || s.id === "todo")
    // Parked work comes first in both views, where it's out of the way collapsed.
    return [...shown.filter((s) => s.id === "backlog"), ...shown.filter((s) => s.id !== "backlog")]
  }, [hosts, hostId, projects, profiles])
  const createdProgress = useCreatedProgress()
  const progressOf = (t: Task) => (isGroupTask(t) || taskLabels(t).includes("plan") ? createdProgress[t.id] : undefined)
  // Project ids are only unique on their host.
  const byId = useMemo(() => new Map(projects.map((p) => [`${p.host_id}:${p.id}`, p])), [projects])

  // The board's tasks, picked in the store: an event about a task on another board leaves this one be.
  // Worked out again only when the tasks change, and the same list while it has the same tasks.
  const pickTasks = useMemo(() => {
    const pick = (s: { tasks: Readonly<Record<string, Task>> }): Task[] => {
      const last = lastPicked.get(pick)
      if (last?.from === s.tasks) return last.picked
      const list = Object.values(s.tasks)
      const picked = [
        ...list.filter((t) => t.project_id && byId.has(`${t.host_id}:${t.project_id}`) && t.kind === "task" && !t.parent_id),
        ...(group && hostId ? groupTasks(list, hostId, group) : []),
        // Not the profile's assistant, which the sidebar opens, nor its routines' threads, nor its pens thread, which the
        // pens' tab bar does.
        ...(profiles
          ? list.filter((t) => !t.project_id && t.kind === "task" && !isAssistants(t) && !isPenThreads(t) && profiles.has(`${t.host_id}:${t.profile_id}`))
          : []),
      ]
      const kept = only ? picked.filter(only) : picked
      lastPicked.set(pick, { from: s.tasks, picked: kept })
      return kept
    }
    return pick
  }, [byId, group, hostId, profiles, only])
  const tasks = useBoard(useShallow(pickTasks))

  // Done tasks are archived as they pass two days in Done, while the board is open too.
  const now = useClock(60_000)
  const { columns, archived } = useMemo(() => {
    const by = byStatus((): Task[] => [])
    const old: Task[] = []
    for (const t of tasks) (isArchived(t, now) ? old : by[t.status]).push(t)
    // The latest done first.
    const doneAt = (t: Task) => t.done_at ?? t.updated_at
    return {
      columns: byStatus((k) => by[k].toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))),
      archived: old.toSorted((a, b) => doneAt(b).localeCompare(doneAt(a))),
    }
  }, [tasks, now])
  const projectOf = (t: Task) => byId.get(`${t.host_id}:${t.project_id ?? ""}`)

  // What the filters and sort leave of `columns` and `archived`, to show. Dropping a task
  // still places it among all of its column's tasks, filtered out or not.
  const shownStatuses = useMemo(() => statuses.filter((s) => showsStatus(query, s.id)), [statuses, query])
  const filtering = isFiltering(query)
  // What the filters keep.
  const keep = useMemo(() => taskMatcher(query), [query])
  // What the search box finds tasks by.
  const keyOf = useCallback((t: Task) => `${keyPrefix(t, byId.get(`${t.host_id}:${t.project_id ?? ""}`))}-${t.number}`, [byId])
  const projectName = useCallback((t: Task) => byId.get(`${t.host_id}:${t.project_id ?? ""}`)?.name ?? t.group_name ?? undefined, [byId])
  const { shown, shownArchived } = useMemo(() => {
    return { shown: byStatus((k) => sortTasks(columns[k].filter(keep), sort)), shownArchived: sortTasks(archived.filter(keep), sort) }
  }, [columns, archived, sort, keep])
  // For the views that aren't by status: every task shown, in the order of the statuses.
  const shownTasks = useMemo(
    () => [...shownStatuses.flatMap((s) => shown[s.id]), ...(showsStatus(query, "done") ? shownArchived : [])],
    [shown, shownArchived, shownStatuses, query],
  )
  const total = statuses.reduce((n, s) => n + columns[s.id].length, archived.length)
  const shownCount = shownStatuses.reduce((n, s) => n + shown[s.id].length, showsStatus(query, "done") ? shownArchived.length : 0)
  // The filter menu's choices: the board's statuses, the kinds of task it has, and its projects (with "No project" for its group and scratch tasks).
  const statusOptions: FilterOption<Status>[] = statuses.map((s) => ({ id: s.id, label: s.label }))
  const kinds = useMemo(() => {
    const on = new Set<TaskKind>(query.kinds)
    for (const ts of [...Object.values(columns), archived]) for (const t of ts) for (const k of taskKinds(t)) on.add(k)
    return [...on]
  }, [columns, archived, query.kinds])
  const projectOptions = useMemo(() => {
    const options: FilterOption<string>[] = projects.map((p) => ({
      id: `${p.host_id}:${p.id}`,
      label: hosts.length > 1 && !hostId ? `${p.name} (${hosts.find((h) => h.id === p.host_id)?.name ?? "?"})` : p.name,
    }))
    if (group || profiles) options.push({ id: "", label: group ? "Group tasks" : "No project" })
    return options
  }, [projects, hosts, hostId, group, profiles])

  return {
    statuses,
    progressOf,
    tasks,
    columns,
    archived,
    projectOf,
    shownStatuses,
    filtering,
    keyOf,
    projectName,
    keep,
    now,
    shown,
    shownArchived,
    shownTasks,
    total,
    shownCount,
    statusOptions,
    kinds,
    projectOptions,
  }
}

export type BoardTasks = ReturnType<typeof useBoardTasks>
