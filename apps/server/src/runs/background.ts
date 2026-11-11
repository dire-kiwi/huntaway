import { Option, Predicate, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { BackgroundItem, BackgroundWork, RunId } from "@huntaway/contracts"

// A run's background work (HA-405; inventory 01, sections 2 and 3; huntaway's runs/background.ts and
// runner/background.ts): what the run's files say of the agent's background tasks, and the rules over them, as plain
// functions. `BackgroundWork` keeps the files and the task's column; `RunInput` decides what they mean for the input.

/**
 * One of the agent's background tasks, as Claude Code's `background_tasks_changed` lists it: its `task_type`
 * (`local_bash` for a shell, which the Bash tool's `run_in_background` and the Monitor tool start; `local_agent` for a
 * subagent), its description, and when the board first saw it; for a shell, the command and the tool that started it,
 * from its `task_started`. Null for what isn't known.
 */
export interface BackgroundTask {
  readonly id: string | null
  readonly type: string | null
  readonly description: string | null
  readonly since: string | null
  readonly command?: string | null | undefined
  readonly tool?: string | null | undefined
}

/**
 * The background tasks that ended during the agent's turn, and those whose outcome Claude Code has given it (`taken`:
 * the `<task-notification>` it replays when it does). One whose outcome it hasn't gets a turn of its own after that one.
 */
export interface BackgroundEnded {
  readonly ended: ReadonlyArray<string | null>
  readonly taken: ReadonlyArray<string>
}

/** A calls that may start a background shell, by tool use id (`background-calls`). */
export type BackgroundCalls = Readonly<Record<string, { readonly tool: string; readonly command: string | null }>>

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const json = (text: string | null): unknown => (text === null ? undefined : Option.getOrUndefined(parseJson(text)))
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const field = (v: unknown, key: string): unknown => (Predicate.isObject(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined)

const decodeTimestamp = Schema.decodeUnknownOption(Timestamp)

/** `background`: a JSON list of tasks, or (older builds) of their ids, or just their count. */
export const parseBackground = (text: string | null): ReadonlyArray<BackgroundTask> => {
  if (text === null) return []
  const list = json(text)
  if (Array.isArray(list)) {
    return list.map((t): BackgroundTask =>
      Predicate.isObject(t)
        ? {
            id: str(field(t, "id")),
            type: str(field(t, "type")),
            description: str(field(t, "description")),
            since: str(field(t, "since")),
            command: str(field(t, "command")),
            tool: str(field(t, "tool")),
          }
        : { id: str(t), type: null, description: null, since: null },
    )
  }
  const n = Number.parseInt(text, 10)
  return Number.isFinite(n) && n > 0 ? Array.from({ length: n }, (): BackgroundTask => ({ id: null, type: null, description: null, since: null })) : []
}

/** A JSON list of strings (`background-waited`); anything else is none. */
export const parseIds = (text: string | null): ReadonlyArray<string> => {
  const v = json(text)
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []
}

/** `background-killed`: the tasks the board stopped. */
export const parseKilled = (text: string | null): ReadonlyArray<BackgroundTask> => {
  const v = json(text)
  return Array.isArray(v) ? parseBackground(text).filter((_, i) => Predicate.isObject(v[i])) : []
}

/** `background-ended`; an unreadable one (an older build's empty file) says some ended, none known taken in. */
export const parseEnded = (text: string | null): BackgroundEnded | null => {
  if (text === null) return null
  const v = json(text)
  const ended = field(v, "ended")
  const taken = field(v, "taken")
  if (Array.isArray(ended) && Array.isArray(taken)) {
    return { ended: ended.map(str), taken: taken.filter((id): id is string => typeof id === "string") }
  }
  return { ended: [null], taken: [] }
}

/** `background-calls`. */
export const parseCalls = (text: string | null): BackgroundCalls => {
  const v = json(text)
  if (!Predicate.isObject(v) || Array.isArray(v)) return {}
  const out: Record<string, { readonly tool: string; readonly command: string | null }> = {}
  for (const [id, call] of Object.entries(v)) {
    const tool = str(field(call, "tool"))
    if (tool !== null) out[id] = { tool, command: str(field(call, "command")) }
  }
  return out
}

/** The tasks in `e` whose outcome Claude Code hasn't given the agent yet. */
export const notTakenIn = (e: BackgroundEnded): ReadonlyArray<string | null> => e.ended.filter((id) => id === null || !e.taken.includes(id))

/**
 * Whether a background task keeps its run's task working once the turn that started it has ended: a subagent does, but
 * a shell (a dev server or a watcher as often as a build) only if the agent said it waits on it (`background_wait`).
 */
export const holds = (t: BackgroundTask, waited: ReadonlyArray<string>): boolean => t.type !== "local_bash" || (t.id !== null && waited.includes(t.id))

/** What a background task is, for the board. */
export const kindOf = (t: BackgroundTask): BackgroundItem["kind"] =>
  t.type === "local_bash" ? "shell" : t.type === "local_agent" || t.type === "remote_agent" || t.type === "in_process_teammate" ? "subagent" : "other"

/**
 * The run's background work as its task shows it; null without any. Idle: its turn has ended, no message sent to it
 * waits to start the next, and nothing left holds it.
 */
export const workOf = (
  run: RunId,
  list: ReadonlyArray<BackgroundTask>,
  waited: ReadonlyArray<string>,
  facts: { readonly betweenTurns: boolean; readonly live: boolean; readonly sent: boolean },
): BackgroundWork | null => {
  if (list.length === 0) return null
  return {
    run_id: run,
    idle: facts.betweenTurns && facts.live && !facts.sent && !list.some((t) => holds(t, waited)),
    tasks: list.map((t) => ({
      id: t.id,
      kind: kindOf(t),
      description: t.description ?? t.command ?? null,
      command: t.command ?? null,
      since: Option.getOrNull(decodeTimestamp(t.since)),
      waited: t.id !== null && waited.includes(t.id),
    })),
  }
}

/**
 * Claude Code's list (`tasks` of its `background_tasks_changed`), with what was known of each before: its type and
 * description, when it was first seen (`now` for a new one), and what started it.
 */
export const listed = (before: ReadonlyArray<BackgroundTask>, tasks: ReadonlyArray<unknown>, now: string): ReadonlyArray<BackgroundTask> =>
  tasks.map((t): BackgroundTask => {
    const id = str(field(t, "task_id"))
    const old = id === null ? undefined : before.find((b) => b.id === id)
    return {
      id,
      type: str(field(t, "task_type")) ?? old?.type ?? null,
      description: str(field(t, "description")) ?? old?.description ?? null,
      since: old?.since ?? now,
      command: old?.command ?? null,
      tool: old?.tool ?? null,
    }
  })

/** Most lines the lost-work note keeps, each at most this long. */
export const NOTE_ITEMS = 10
const NOTE_LABEL = 160

/** A stopped task's line in the note. */
export const labelOf = (t: BackgroundTask): string => {
  const what =
    t.command != null && t.description !== null && t.command !== t.description
      ? `${t.command} (${t.description})`
      : (t.command ?? t.description ?? "(no description)")
  const one = what.replace(/\s+/gu, " ").trim()
  return one.length > NOTE_LABEL ? `${one.slice(0, NOTE_LABEL - 1)}…` : one
}

/** What the end of a run stopped of its background work: what the board stopped, then what was left going. */
export const lostAtEnd = (killed: ReadonlyArray<BackgroundTask>, left: ReadonlyArray<BackgroundTask>): ReadonlyArray<BackgroundTask> => [
  ...killed,
  ...left.filter((t) => t.id === null || !killed.some((k) => k.id === t.id)),
]

/** `tasks` added to `before` (what the board stopped), each id once. */
export const addKilled = (before: ReadonlyArray<BackgroundTask>, tasks: ReadonlyArray<BackgroundTask>): ReadonlyArray<BackgroundTask> => [
  ...before,
  ...tasks.filter((t) => t.id === null || !before.some((b) => b.id === t.id)),
]
