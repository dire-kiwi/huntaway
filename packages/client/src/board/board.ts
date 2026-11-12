import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { Host, HostId, HostSettings } from "@huntaway/contracts"
import type { SessionView } from "../session/HostSession.ts"
import { hostSessionAtom, hubHostListAtom, localHostIdAtom, tokenPendingAtom } from "../session/sessions.ts"
import {
  sameJson,
  type HostAgentConfig,
  type HostApproval,
  type HostBoard,
  type HostPen,
  type HostProfile,
  type HostProject,
  type HostTask,
  type HostUsage,
  type RestartState,
} from "./hostBoard.ts"
import { pendingMarksAtom, withPendingMarks } from "./marks.ts"
import { hostBoardAtom } from "./watch.ts"

/**
 * Every host's board, merged into the shape the components read (docs/plan/09-frontend.md, The board): the old store's
 * field names, so its selectors change by one word.
 */
export interface Board {
  /** null until known; false when the page's own server turned the token down (the token screen). */
  readonly authed: boolean | null
  /** The page's own server's session is live. */
  readonly connected: boolean
  /** The page's own host's first snapshot has arrived. */
  readonly loaded: boolean
  /** The page's own host first, then every host the hub links (offline ones too, with their last board). */
  readonly hosts: ReadonlyArray<Host>
  readonly localHostId: HostId | null
  /** Tagged with their host; merged by name in the UI, as before. */
  readonly profiles: ReadonlyArray<HostProfile>
  readonly claudeConfigs: ReadonlyArray<HostAgentConfig>
  /** Unarchived, by name (then host and id). */
  readonly projects: ReadonlyArray<HostProject>
  readonly archived: ReadonlyArray<HostProject>
  /** By bare id, the first host's where two hosts have one id; without the tasks of archived projects. */
  readonly tasks: Readonly<Record<string, HostTask>>
  readonly hostSettings: Readonly<Record<string, HostSettings>>
  /** By `usageKey(host, config id)`. */
  readonly usage: Readonly<Record<string, HostUsage>>
  readonly approvals: ReadonlyArray<HostApproval>
  readonly pens: ReadonlyArray<HostPen>
  readonly restart: RestartState | null
}

/** The board before anything is known. */
export const emptyBoard: Board = {
  authed: null,
  connected: false,
  loaded: false,
  hosts: [],
  localHostId: null,
  profiles: [],
  claudeConfigs: [],
  projects: [],
  archived: [],
  tasks: {},
  hostSettings: {},
  usage: {},
  approvals: [],
  pens: [],
  restart: null,
}

/** Usage is by host and agent config. */
export const usageKey = (host: string, configId: string): string => `${host}:${configId}`

/** Compares names as the sidebar orders them: alphabetically, ignoring case, with numbers in numeric order. */
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })

/** Projects in alphabetical order, then by host and id so the order is stable. */
export const sortProjects = <P extends HostProject>(projects: ReadonlyArray<P>): Array<P> =>
  projects.toSorted((a, b) => byName(a.name, b.name) || a.name.localeCompare(b.name) || `${a.host_id}:${a.id}`.localeCompare(`${b.host_id}:${b.id}`))

/**
 * What one host contributes: its session, once its first snapshot has come its board, and for a linked host the hub's
 * entry for it (`hub.hosts.watch`).
 */
export interface HostPart {
  readonly host_id: HostId
  readonly session: SessionView
  readonly board: HostBoard | undefined
  readonly entry?: Host | undefined
}

/**
 * A host as the board shows it. A linked host is the hub's entry (its link's name, mode, URL, uplink and live state),
 * connected while its own session is live; the page's own host is what its session says of itself.
 */
const hostOf = ({ host_id: id, session: view, entry }: HostPart, local: boolean): Host =>
  entry && !local ? linkedHost(entry, view.state._tag === "live") : ownHost(id, view, local)

const linkedHost = (entry: Host, live: boolean): Host => ({
  id: entry.id,
  name: entry.name,
  local: false,
  connected: live,
  mode: entry.mode,
  agents: entry.agents,
  url: entry.url,
  version: entry.version,
  protocol: entry.protocol,
  capabilities: entry.capabilities,
  commit: entry.commit,
  updates_from: entry.updates_from,
  last_seen: entry.last_seen,
  last_message_at: entry.last_message_at,
  uplink: entry.uplink,
  ...(entry.status !== undefined && { status: entry.status }),
  ...(entry.status_reason !== undefined && { status_reason: entry.status_reason }),
})

const ownHost = (id: HostId, view: SessionView, local: boolean): Host => ({
  id,
  name: view.info?.host_name ?? id,
  local,
  connected: view.state._tag === "live",
  mode: local ? "local" : "outbound",
  agents: view.info?.agents ?? null,
  url: null,
  version: view.info?.version ?? null,
  protocol: view.info?.protocol ?? null,
  capabilities: view.info?.capabilities ?? [],
  commit: view.info?.commit ?? null,
  updates_from: view.info?.updates_from ?? null,
  last_seen: null,
  last_message_at: null,
  uplink: false,
})

const sameItems = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** `next`, or `prev` when it holds the same objects (so a selector of it does not see a change). */
const keepList = <T>(prev: ReadonlyArray<T>, next: ReadonlyArray<T>): ReadonlyArray<T> => (sameItems(prev, next) ? prev : next)

function keepRecord<T>(prev: Readonly<Record<string, T>>, next: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  const keys = Object.keys(next)
  return keys.length === Object.keys(prev).length && keys.every((k) => Object.hasOwn(prev, k) && prev[k] === next[k]) ? prev : next
}

/**
 * The hosts' boards merged (pure). `prev` is the board this replaces, whose unchanged lists and records are kept as they
 * were. Hosts come in order, the page's own first; a task id two hosts have is the first host's.
 */
export function mergeBoards(prev: Board, parts: ReadonlyArray<HostPart>, localHostId: HostId | null): Board {
  const local = parts.find((p) => p.host_id === localHostId)
  const boards = parts.flatMap((p) => (p.board ? [p.board] : []))
  const hosts = parts.map((p) => {
    const host = hostOf(p, p.host_id === localHostId)
    const before = prev.hosts.find((h) => h.id === host.id)
    return before && sameJson(before, host) ? before : host
  })
  const archived = new Set(boards.flatMap((b) => b.archived.map((p) => `${b.host_id}:${p.id}`)))
  const tasks: Record<string, HostTask> = {}
  for (const b of boards) {
    for (const t of b.tasks.values()) {
      if (Object.hasOwn(tasks, t.id)) continue
      if (t.project_id && archived.has(`${b.host_id}:${t.project_id}`)) continue
      tasks[t.id] = t
    }
  }
  const usage: Record<string, HostUsage> = {}
  for (const b of boards) for (const u of b.usage.values()) usage[usageKey(b.host_id, u.config_id)] = u
  const state = local?.session.state._tag
  return {
    authed: state === "unauthorized" ? false : state === "live" || local?.board ? true : null,
    connected: state === "live",
    loaded: !!local?.board,
    hosts: keepList(prev.hosts, hosts),
    localHostId,
    profiles: keepList(
      prev.profiles,
      boards.flatMap((b) => b.profiles),
    ),
    claudeConfigs: keepList(
      prev.claudeConfigs,
      boards.flatMap((b) => b.configs),
    ),
    projects: keepList(prev.projects, sortProjects(boards.flatMap((b) => b.projects))),
    archived: keepList(
      prev.archived,
      boards.flatMap((b) => b.archived),
    ),
    tasks: keepRecord(prev.tasks, tasks),
    hostSettings: keepRecord(prev.hostSettings, Object.fromEntries(boards.map((b) => [b.host_id, b.settings]))),
    usage: keepRecord(prev.usage, usage),
    approvals: keepList(
      prev.approvals,
      boards.flatMap((b) => b.approvals),
    ),
    pens: keepList(
      prev.pens,
      boards.flatMap((b) => b.pens),
    ),
    restart: local?.board?.restart ?? null,
  }
}

/**
 * The hosts on the board: the page's own, then every host the hub links, offline ones too (they keep showing their last
 * board, marked by their session's state).
 */
export const boardHostIdsAtom: Atom.Atom<ReadonlyArray<HostId>> = Atom.make((get) => {
  if (get(tokenPendingAtom)) return []
  const local = get(localHostIdAtom)
  if (!local) return []
  return [local, ...get(hubHostListAtom).flatMap((h) => (h.local || h.id === local ? [] : [h.id]))]
})

/**
 * The merged board as the hosts' streams have it, without optimistic changes. A linked host that needs an update is
 * listed but not subscribed to.
 */
export const serverBoardAtom: Atom.Atom<Board> = Atom.make((get) => {
  const local = get(localHostIdAtom)
  const listed = get(hubHostListAtom)
  const parts = get(boardHostIdsAtom).map((host): HostPart => {
    const session = get(hostSessionAtom(host))
    const outdated = host !== local && session.state._tag === "needs_update"
    return {
      host_id: host,
      session,
      entry: listed.find((h) => h.id === host),
      board: outdated ? undefined : Option.getOrUndefined(AsyncResult.value(get(hostBoardAtom(host)))),
    }
  })
  return mergeBoards(
    Option.getOrElse(get.self<Board>(), () => emptyBoard),
    parts,
    local,
  )
}).pipe(Atom.keepAlive)

/** The merged board with the moves and reorders in flight (tasks.ts) shown until the host's event for them arrives. */
export const movesBoardAtom: Atom.Writable<Board, Atom.Atom<AsyncResult.AsyncResult<Board, unknown>>> = Atom.optimistic(serverBoardAtom).pipe(Atom.keepAlive)

/**
 * What components read: every host's board merged, with the optimistic changes in flight shown until the host's event
 * for them arrives: moves and reorders (tasks.ts), and on top of them stars and reminders (marks.ts), which, unlike a
 * move, don't hold back the host's events while they save.
 */
export const boardAtom: Atom.Atom<Board> = Atom.make((get) => {
  const board = get(movesBoardAtom)
  const tasks = withPendingMarks(board.tasks, get(pendingMarksAtom))
  return tasks === board.tasks ? board : { ...board, tasks }
}).pipe(Atom.keepAlive)
