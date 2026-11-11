import type {
  AgentConfig,
  Approval,
  BoardEvent,
  BoardMessage,
  BoardSnapshot,
  HostId,
  HostSettings,
  Pen,
  Profile,
  Project,
  ProfileId,
  Task,
  TaskId,
  Usage,
} from "@huntaway/contracts"

// One host's board, folded from its `board.watch` stream (docs/plan/09-frontend.md, The board). `applyBoardEvent` is
// pure and keeps every object that did not change identical, so a component that selects one task does not draw again
// when another changes. Everything is kept tagged with the host it came from, so the merged board (board.ts) can hand
// the same objects on.

/** A wire type tagged with the host it came from: the old API's `Host*` names, so components change one import. */
export type OnHost<T> = T & { readonly host_id: HostId }
export type HostTask = OnHost<Task>
export type HostProfile = OnHost<Profile>
export type HostProject = OnHost<Project>
export type HostAgentConfig = OnHost<AgentConfig>
export type HostPen = OnHost<Pen>
export type HostUsage = OnHost<Usage>
export type HostApproval = OnHost<Approval>

/** A host's restart or update in progress, as its events tell it (from M6; always null before). */
export interface RestartState {
  readonly phase: string
  readonly error: string | null
  readonly log: ReadonlyArray<string>
}

/** Everything one host's board stream has said so far. */
export interface HostBoard {
  readonly host_id: HostId
  /** The boot of the host the stream came from, and the last event applied: where a resubscription continues from. */
  readonly boot: string
  readonly seq: number
  readonly profiles: ReadonlyArray<HostProfile>
  readonly configs: ReadonlyArray<HostAgentConfig>
  readonly projects: ReadonlyArray<HostProject>
  readonly archived: ReadonlyArray<HostProject>
  /** Every task of the host, those of archived projects too (the merged board leaves those out). */
  readonly tasks: ReadonlyMap<TaskId, HostTask>
  readonly pens: ReadonlyArray<HostPen>
  readonly settings: HostSettings
  /** By agent config id. */
  readonly usage: ReadonlyMap<string, HostUsage>
  /** The board's own approvals waiting for the user, oldest first. */
  readonly approvals: ReadonlyArray<HostApproval>
  readonly restart: RestartState | null
  /**
   * By task: the number of the latest `checkpoints` event about it (a turn's checkpoint was taken, or it was rewound),
   * which what shows its turns reads them again on.
   */
  readonly checkpoints: ReadonlyMap<TaskId, number>
  /**
   * 6.5: by owner (a project's id, or a profile's for its routines) and by automation, the number of the latest
   * `automations_changed` event about it, which what shows them reads them again on.
   */
  readonly automations: ReadonlyMap<string, number>
  /**
   * 6.3: the number of the latest event about a profile's documents (`docs <profile>`), a document's comments
   * (`comments <profile> <slug>`) and a profile's docs site (`site <profile>`), which the Docs page reads them again on.
   */
  readonly docs: ReadonlyMap<string, number>
  /**
   * 6.7: the number of the latest `approval_rules` and `approval_log` event about a profile (`rules <profile>`,
   * `log <profile>`), which the assistant's rules and action log read them again on.
   */
  readonly approvalRules: ReadonlyMap<string, number>
}

const noSettings: HostSettings = {
  default_model: null,
  default_effort: null,
  default_permission_mode: null,
  scratch_host: null,
  terminal_tools: [],
  public_url: null,
  release_prereleases: false,
  settings_sync: false,
}

/** A host's board before its first snapshot: what a stream folds into. */
export const emptyHostBoard = (host_id: HostId): HostBoard => ({
  host_id,
  boot: "",
  seq: 0,
  profiles: [],
  configs: [],
  projects: [],
  archived: [],
  tasks: new Map(),
  pens: [],
  settings: noSettings,
  usage: new Map(),
  approvals: [],
  restart: null,
  checkpoints: new Map(),
  automations: new Map(),
  docs: new Map(),
  approvalRules: new Map(),
})

// ---- identity -----------------------------------------------------------------------------------------------------

/** Whether two plain JSON values are the same, deeply. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]))
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.hasOwn(b, k) && sameJson(Reflect.get(a, k), Reflect.get(b, k)))
}

/** `next`, or `prev` when it is the same, so an unchanged object keeps its identity. */
const keep = <T>(prev: T | undefined, next: T): T => (prev !== undefined && sameJson(prev, next) ? prev : next)

/** `next`, or `prev` when every element is the same object in the same place. */
const keepArray = <T>(prev: ReadonlyArray<T>, next: ReadonlyArray<T>): ReadonlyArray<T> =>
  prev.length === next.length && prev.every((x, i) => x === next[i]) ? prev : next

const tag = <T extends object>(host_id: HostId, x: T): OnHost<T> => ({ ...x, host_id })

/** A list as received, tagged, with the objects of `prev` that did not change kept as they were. */
function reuse<T extends { readonly id: string }>(host_id: HostId, prev: ReadonlyArray<OnHost<T>>, next: ReadonlyArray<T>): ReadonlyArray<OnHost<T>> {
  const before = new Map(prev.map((x) => [x.id, x]))
  return keepArray(
    prev,
    next.map((x) => keep(before.get(x.id), tag(host_id, x))),
  )
}

/** `list` with `item` in its place (by id), or at the end. */
function upsert<T extends { readonly id: string }>(list: ReadonlyArray<T>, item: T): ReadonlyArray<T> {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [...list, item]
  if (list[i] === item) return list
  return list.map((x, j) => (j === i ? item : x))
}

const without = <T extends { readonly id: string }>(list: ReadonlyArray<T>, id: string): ReadonlyArray<T> =>
  list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : list

// ---- the reducer ----------------------------------------------------------------------------------------------------

/**
 * Applies one message of `board.watch` to a host's board. A snapshot replaces everything (keeping what did not change);
 * an event at or below the board's `seq` is one it has already (a late one, or one a replay repeats) and changes
 * nothing. `hello` and `resync` are the stream's own: `hello` says which boot the stream is from, `resync` changes
 * nothing (the subscriber subscribes again without `since`). A kind this version does not know is ignored.
 */
export function applyBoardEvent(board: HostBoard, message: BoardMessage): HostBoard {
  if (message.type === "hello")
    return message.host_id === board.host_id && message.boot === board.boot ? board : { ...board, host_id: message.host_id, boot: message.boot }
  if (message.type === "resync") return board
  if (message.type === "snapshot") return fromSnapshot(board, message)
  return applyEvent(board, message)
}

/** The board as a snapshot has it, with the objects it repeats kept. */
function fromSnapshot(board: HostBoard, message: BoardSnapshot): HostBoard {
  const h = board.host_id
  const usage = new Map(message.usage.map((u) => [u.config_id, keep(board.usage.get(u.config_id), tag(h, u))]))
  const tasks = new Map(message.tasks.map((t) => [t.id, keep(board.tasks.get(t.id), tag(h, t))]))
  return {
    ...board,
    seq: message.seq,
    profiles: reuse(h, board.profiles, message.profiles),
    configs: reuse(h, board.configs, message.configs),
    projects: reuse(h, board.projects, message.projects),
    archived: reuse(h, board.archived, message.archived_projects),
    tasks: sameMap(board.tasks, tasks) ? board.tasks : tasks,
    pens: reuse(h, board.pens, message.pens),
    settings: keep(board.settings, message.settings),
    usage: sameMap(board.usage, usage) ? board.usage : usage,
    approvals: reuseApprovals(h, board.approvals, message.approvals),
  }
}

/** Approvals as received, tagged, with the unchanged ones of `prev` kept as they were. */
function reuseApprovals(h: HostId, prev: ReadonlyArray<HostApproval>, next: ReadonlyArray<Approval>): ReadonlyArray<HostApproval> {
  const before = new Map(prev.map((a) => [a.request_id, a]))
  return keepArray(
    prev,
    next.map((a) => keep(before.get(a.request_id), tag(h, a))),
  )
}

/** 6.3: the key of `HostBoard.docs` for a profile's documents, a document's comments, or a profile's docs site. */
export const docsKey = (kind: "docs" | "comments" | "site", profile: string, slug = ""): string => `${kind} ${profile} ${slug}`

/** A numbered event, applied unless the board has it already. */
function applyEvent(board: HostBoard, message: Exclude<BoardEvent, { readonly type: "hello" | "resync" }>): HostBoard {
  const h = board.host_id
  if (typeof message.seq !== "number" || message.seq <= board.seq) return board
  const next = { ...board, seq: message.seq }
  switch (message.type) {
    case "task": {
      const task = keep(board.tasks.get(message.task.id), tag(h, message.task))
      if (board.tasks.get(task.id) === task) return next
      return { ...next, tasks: new Map(board.tasks).set(task.id, task) }
    }
    case "task_deleted": {
      if (!board.tasks.has(message.id)) return next
      const tasks = new Map(board.tasks)
      tasks.delete(message.id)
      return { ...next, tasks }
    }
    case "project": {
      const prev = [...board.projects, ...board.archived].find((p) => p.id === message.project.id)
      const project = keep(prev, tag(h, message.project))
      // An archived project goes off the board; its tasks stay in the host's board, and the merged board leaves them out.
      return project.archived_at
        ? { ...next, projects: without(board.projects, project.id), archived: upsert(board.archived, project) }
        : { ...next, archived: without(board.archived, project.id), projects: upsert(board.projects, project) }
    }
    case "project_deleted": {
      // Its tasks go with it.
      const theirs = [...board.tasks.values()].some((t) => t.project_id === message.id)
      const tasks = theirs ? new Map([...board.tasks].filter(([, t]) => t.project_id !== message.id)) : board.tasks
      return { ...next, projects: without(board.projects, message.id), archived: without(board.archived, message.id), tasks }
    }
    case "profiles_changed":
      return { ...next, profiles: reuse(h, board.profiles, message.profiles), configs: reuse(h, board.configs, message.configs) }
    case "settings_changed":
      return { ...next, settings: keep(board.settings, message.settings) }
    case "pens":
      return { ...next, pens: replacePens(board.pens, h, message.profile_id, message.pens) }
    case "usage": {
      const usage = keep(board.usage.get(message.usage.config_id), tag(h, message.usage))
      if (board.usage.get(usage.config_id) === usage) return next
      return { ...next, usage: new Map(board.usage).set(usage.config_id, usage) }
    }
    case "approval": {
      // Asked (in its place, or at the end), or no longer waiting.
      const others = board.approvals.filter((a) => a.request_id !== message.request_id)
      if (message.approval === null) return others.length === board.approvals.length ? next : { ...next, approvals: others }
      const at = board.approvals.findIndex((a) => a.request_id === message.request_id)
      const approval = keep(board.approvals[at], tag(h, message.approval))
      if (board.approvals[at] === approval) return next
      const approvals = at < 0 ? [...board.approvals, approval] : board.approvals.map((a, i) => (i === at ? approval : a))
      return { ...next, approvals }
    }
    case "restart":
      // A new job starts its log afresh.
      return {
        ...next,
        restart: { phase: message.phase, error: message.error, log: message.phase === "starting" ? [] : (board.restart?.log ?? []) },
      }
    case "restart_log": {
      const log = [...(board.restart?.log ?? []), message.line]
      return { ...next, restart: { phase: board.restart?.phase ?? "starting", error: board.restart?.error ?? null, log: log.slice(-500) } }
    }
    case "release_checked":
    case "release_download":
      // What a release check found is read where Settings shows it (`admin.status`).
      return next
    case "checkpoints":
      return { ...next, checkpoints: new Map(board.checkpoints).set(message.task_id, message.seq) }
    case "automations_changed": {
      const automations = new Map(board.automations)
      automations.set(message.project_id ?? message.profile_id, message.seq)
      automations.set(message.automation_id, message.seq)
      return { ...next, automations }
    }
    // 6.3
    case "docs":
      return { ...next, docs: new Map(board.docs).set(docsKey("docs", message.profile_id), message.seq) }
    case "doc_comments":
      return { ...next, docs: new Map(board.docs).set(docsKey("comments", message.profile_id, message.slug), message.seq) }
    case "docs_site":
      return { ...next, docs: new Map(board.docs).set(docsKey("site", message.profile_id), message.seq) }
    // 6.7
    case "approval_rules":
      return { ...next, approvalRules: new Map(board.approvalRules).set(`rules ${message.profile_id}`, message.seq) }
    case "approval_log":
      return { ...next, approvalRules: new Map(board.approvalRules).set(`log ${message.profile_id}`, message.seq) }
    // 6.8: for push; the board has nothing of them.
    case "assistant_reply":
    case "routine_report":
      return next
    default:
      // A kind this version does not know (a newer host's): its number is taken, as nothing in it applies.
      return next
  }
}

/** A profile's pens replaced by `pens`, keeping the others and the unchanged ones. */
function replacePens(all: ReadonlyArray<HostPen>, h: HostId, profile: ProfileId, pens: ReadonlyArray<Pen>): ReadonlyArray<HostPen> {
  const theirs = all.filter((p) => p.profile_id === profile)
  const others = all.filter((p) => p.profile_id !== profile)
  const kept = reuse(h, theirs, pens)
  return kept === theirs ? all : [...others, ...kept]
}

/** Whether two maps hold the same objects under the same keys, in the same order. */
function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false
  const bs = [...b]
  return [...a].every(([k, v], i) => bs[i]?.[0] === k && bs[i]?.[1] === v)
}
