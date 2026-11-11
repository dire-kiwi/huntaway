import { Context, Effect, Layer } from "effect"
import type { ItemType, Notice, ProfileId, QuestionRequest, TaskId, Timestamp, ToolCall } from "@huntaway/contracts"
import { writeNoOf } from "./model.ts"
import type { Entry, WriteNo } from "./model.ts"
import { ThreadStore } from "./ThreadStore.ts"
import type { Scan } from "./ThreadStore.ts"

// The board's readers of a task's thread (inventory 08, section 3.8; the old threads/history.ts): what review,
// summaries, titles, the wait tool, pull-request watching, `last_message`, prompts, checkpoints, Telegram and analytics
// read of a thread, each with its old meaning. They read items in place, newest first, and only the item types they
// need (tool results are most of a thread). Who sent a user message is in its meta (`auto`, `from_agent`,
// `user_text`…), a turn's result text is its turn result's `result_text`, a subagent's id is its call's
// `subagent_task`, the agent's API errors are error notices with a `code`, and an item a write made names it in its
// id (`legacy:<n>[:<block>]`) and its `write_no`. The scans are pure functions of the entries, newest first, below the
// service, which feeds them as many as they read.

/** How a turn ended: `reply`, as it should; `compact`, a compaction's end, which answers nothing; `failed`, an error, the usage limit, or stopped part way. */
export type TurnEnd = "reply" | "compact" | "failed"

/** The user's own messages, each with what the agent said last before it (null for nothing). */
export interface UserReplies {
  /** Oldest first: `[what the agent said before, what the user wrote]`. */
  readonly replies: ReadonlyArray<readonly [string | null, string]>
  /** What the agent has said since the latest of them. */
  readonly since: string | null
  /** How many of the user's messages a limit left out. */
  readonly earlier: number
}

/** A user message as the readers give it: its text, and what the board knows of who sent it. */
export interface UserMessageData {
  readonly text: string
  readonly auto?: boolean
  readonly from_agent?: boolean
  readonly user_text?: string
  readonly start?: boolean
  readonly routine?: boolean
  readonly review_round?: number
}

/** A tool call as Claude's `tool_use` block has it, with its `tool_result` once it has one. */
export interface ToolUseRecord {
  readonly call: { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  readonly result: { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean } | null
}

/** A board question still waiting for its answer (`legacy:<n>`), with the write that asked it. */
export interface OpenQuestion {
  readonly write_no: WriteNo
  readonly request: QuestionRequest
}

export interface ThreadReadersShape {
  /** The last thing the agent said: its latest message, what its latest turn's result said, or an API error in its place. */
  readonly lastAssistantText: (task: TaskId) => Effect.Effect<string | null>
  /** What the agent said after the latest message it was sent (anyone's): null if nothing yet. Not trimmed. */
  readonly saidSinceAsked: (task: TaskId) => Effect.Effect<string | null>
  /**
   * What the agent said in the turn that ended with turn result `legacy:<n>`: its result's text, or its latest message
   * since the latest message it was sent and the turn before's end. Telegram's reply. Null if there is no such end.
   */
  readonly saidInTurn: (task: TaskId, n: WriteNo) => Effect.Effect<string | null>
  /** The latest turn's end: its result's write number and how it went. */
  readonly lastTurnEnd: (task: TaskId) => Effect.Effect<{ readonly write_no: WriteNo; readonly end: TurnEnd } | null>
  /** The user's own messages (the latest `limit` if given), each with what the agent said last before it. */
  readonly userReplies: (task: TaskId, limit: number | null) => Effect.Effect<UserReplies>
  /** Whether the user (not the board, not another agent) sent the agent a message after `since`. */
  readonly userWroteSince: (task: TaskId, since: Timestamp) => Effect.Effect<boolean>
  /** Whether the agent was sent a message (anyone's) at or after `at`. */
  readonly userMessagedSince: (task: TaskId, at: Timestamp) => Effect.Effect<boolean>
  /** Whether the conversation has moved on since write `n` (a question's or a prompt's): a message was sent after it. */
  readonly movedOn: (task: TaskId, n: WriteNo) => Effect.Effect<boolean>
  /** The write number of the first user message (anyone's): a rewind to before it starts afresh. */
  readonly firstUserMessage: (task: TaskId) => Effect.Effect<WriteNo | null>
  /** User message `legacy:<n>`; null if there is none. */
  readonly userMessage: (task: TaskId, n: WriteNo) => Effect.Effect<UserMessageData | null>
  /** The last message the agent was sent (anyone's); null for none. */
  readonly lastUserMessage: (task: TaskId) => Effect.Effect<UserMessageData | null>
  /** The tool calls made after `since` (all for null), subagents' too, oldest first, as Claude's blocks. */
  readonly toolCallsSince: (task: TaskId, since: Timestamp | null) => Effect.Effect<ReadonlyArray<ToolUseRecord>>
  /** The name and input of tool call `id` (the harness's id), the latest with it. */
  readonly toolUse: (task: TaskId, id: string) => Effect.Effect<{ readonly name: string; readonly input: unknown } | null>
  /**
   * The Agent or Task call a subagent's lifecycle line is about: the call it names (`tool_use_id`), or the one whose
   * subagent is its `task_id`. Null for none, or for a call that is no Agent or Task (a forked skill, a background shell).
   */
  readonly subagentCall: (
    task: TaskId,
    about: { readonly tool_use_id?: string | undefined; readonly task_id?: string | undefined },
  ) => Effect.Effect<string | null>
  /** The user messages of the profile's tasks made at `from` or later and before `to`, oldest first (prompt analytics). */
  readonly userMessagesBetween: (
    profile: ProfileId,
    from: Timestamp,
    to: Timestamp,
  ) => Effect.Effect<ReadonlyArray<{ readonly at: Timestamp; readonly task_id: TaskId; readonly data: UserMessageData }>>
  /** The board's questions (`legacy:<n>`) still waiting for an answer, oldest first. */
  readonly openQuestions: (task: TaskId) => Effect.Effect<ReadonlyArray<OpenQuestion>>
  /** Whether MCP call `callId` has asked its question already (it is run again if a restart cuts it short). */
  readonly asked: (task: TaskId, callId: string) => Effect.Effect<boolean>
  /** The routines' reports in the assistant's thread it has not read yet, oldest first. */
  readonly unreadReports: (task: TaskId) => Effect.Effect<ReadonlyArray<Notice>>
}

// ---- the pure part --------------------------------------------------------------------------------------------

/** What was said: user messages, the agent's messages, turns' results and notices (not tool calls, the bulk of a thread). */
export const SAID: ReadonlyArray<ItemType> = ["user_message", "assistant_message", "turn_result", "notice"]

/** The harness's id for a tool call: its item's, but for a second call with one id (whose item is `legacy:…`). */
export const callIdOf = (e: Entry): string => e.meta.call_id ?? e.item.id

/** A tool's name as the harness gave it (`mcp__<server>__<tool>` for an MCP tool), from its item's fields. */
export const toolName = (t: ToolCall): string => {
  if (t.kind === "app") return `mcp__app__${t.name}`
  if (t.server !== undefined) return `mcp__${t.server}__${t.name}`
  return t.name
}

/** A user message as the readers give it. */
export const userData = (e: Entry): UserMessageData => {
  const m = e.meta
  return {
    text: e.item.type === "user_message" ? e.item.text : "",
    ...(m.auto === undefined ? {} : { auto: m.auto }),
    ...(m.from_agent === undefined ? {} : { from_agent: m.from_agent }),
    ...(m.user_text === undefined ? {} : { user_text: m.user_text }),
    ...(m.start === undefined ? {} : { start: m.start }),
    ...(m.routine === undefined ? {} : { routine: m.routine }),
    ...(m.review_round === undefined ? {} : { review_round: m.review_round }),
  }
}

/** The user's own words in a user message, trimmed: not the board's messages, nor other agents'. Null for none. */
export const usersText = (e: Entry): string | null => {
  if (e.item.type !== "user_message" || e.meta.auto === true || e.meta.from_agent === true) return null
  const text = (e.meta.user_text ?? e.item.text).trim()
  return text === "" ? null : text
}

/** Something said, as `said` sees it. */
export type Said =
  /** A user message (anyone's), with the user's own words if they wrote it. */
  | { readonly kind: "user"; readonly text: string | null; readonly pos: number }
  /** One of the agent's messages (a message's text blocks, joined by newlines), or an API error in its place. */
  | { readonly kind: "agent"; readonly text: string }
  /** What a turn's result said: null if it said nothing, which only `ends` gives. */
  | { readonly kind: "ended"; readonly text: string | null; readonly pos: number }

/**
 * What was said, newest first, from entries of `SAID` types newest first. The text blocks of one of the agent's
 * messages are items of their own (`legacy:<n>:<block>`), which come together: they are joined, as the message had
 * them. A result's text that no message said (a `from_result` assistant message) is left to its turn result. With
 * `ends`, every turn's end is given, those whose result said nothing too.
 */
export function* said(entries: Iterable<Entry>, ends = false): Generator<Said> {
  let agent: { readonly message: WriteNo | undefined; readonly texts: Array<string> } | null = null
  for (const e of entries) {
    const item = e.item
    if (agent !== null) {
      const m = writeNoOf(item.id)
      if (item.type === "assistant_message" && e.meta.from_result !== true && m !== undefined && m === agent.message) {
        agent.texts.push(item.text)
        continue
      }
      yield { kind: "agent", text: agent.texts.toReversed().join("\n") }
      agent = null
    }
    switch (item.type) {
      case "user_message":
        yield { kind: "user", text: usersText(e), pos: e.pos }
        break
      case "assistant_message":
        if (e.meta.from_result !== true) agent = { message: writeNoOf(item.id), texts: [item.text] }
        break
      case "turn_result": {
        const text = e.meta.result_text ?? ""
        if (text !== "" || ends) yield { kind: "ended", text: text === "" ? null : text, pos: e.pos }
        break
      }
      case "notice":
        // The agent's API errors (a usage limit, say), which it gives as its text, have a code; the board's own events
        // have none, and an interrupt's is info. A routine's report (a failed run's is an error) is the board's.
        if (item.level === "error" && item.code !== undefined && item.code !== "routine_report" && item.text !== "") yield { kind: "agent", text: item.text }
        break
      case "reasoning":
      case "tool_call":
      case "compaction":
        // Not said: not scanned either.
        break
    }
  }
  if (agent !== null) yield { kind: "agent", text: agent.texts.toReversed().join("\n") }
}

/** `lastAssistantText` of entries of `SAID` types, newest first. */
export const lastAssistantTextOf = (entries: Iterable<Entry>): string | null => {
  for (const s of said(entries)) if (s.kind !== "user") return s.text
  return null
}

/** `saidSinceAsked` of entries of `SAID` types, newest first. */
export const saidSinceAskedOf = (entries: Iterable<Entry>): string | null => {
  for (const s of said(entries)) return s.kind === "user" ? null : s.text
  return null
}

/** `saidInTurn` of entries of `SAID` types at or before the turn's end (at `end`), newest first. */
export const saidInTurnOf = (entries: Iterable<Entry>, end: number): string | null => {
  for (const s of said(entries, true)) {
    if (s.kind === "user") return null
    if (s.kind === "agent") return s.text
    // The turn before's end.
    if (s.pos !== end) return null
    if (s.text !== null) return s.text
  }
  return null
}

/** How the turn that `e` (a turn result) ended went. */
export const turnEndOf = (e: Entry): TurnEnd => {
  if (e.meta.compact === true) return "compact"
  return e.item.type === "turn_result" && e.item.ok && e.item.interrupted !== true ? "reply" : "failed"
}

/**
 * `userReplies` of entries of `SAID` types, newest first, but for `earlier`: also returns where a limit cut them (the
 * replies before this position were left out), for the caller to count.
 */
export const userRepliesOf = (entries: Iterable<Entry>, limit: number | null): { readonly replies: UserReplies; readonly cut: number | null } => {
  const replies: Array<readonly [string | null, string]> = []
  let since: string | null = null
  // Nothing from the user yet (going back), so what the agent says is what it said `since`.
  let latest = true
  // The reply found last (its position and text), until what the agent said before it is.
  let pending: readonly [number, string] | null = null
  // Where a limit cut them.
  let cut: number | null = null
  for (const s of said(entries)) {
    if (s.kind === "user") {
      if (s.text === null) continue
      latest = false
      // Nothing from the agent between the two.
      if (pending !== null) replies.push([null, pending[1]])
      pending = null
      if (limit !== null && replies.length >= limit) {
        cut = s.pos + 1
        break
      }
      pending = [s.pos, s.text]
    } else if (s.kind === "agent" && (latest || pending !== null)) {
      if (latest) {
        since = s.text
        latest = false
      } else if (pending !== null) {
        const [at, text] = pending
        pending = null
        replies.push([s.text, text])
        if (limit !== null && replies.length >= limit) {
          cut = at
          break
        }
      }
    }
  }
  if (pending !== null) replies.push([null, pending[1]])
  return { replies: { replies: replies.toReversed(), since, earlier: 0 }, cut }
}

// ---- the service ----------------------------------------------------------------------------------------------

/** How many entries a scan reads first; it reads four times as many each time a reader wants more. */
const FIRST_READ = 64

/** The board's readers of a thread (inventory 08, 3.8). */
export class ThreadReaders extends Context.Service<ThreadReaders, ThreadReadersShape>()("huntaway-server/threads/ThreadReaders") {
  static readonly layer = Layer.effect(
    ThreadReaders,
    Effect.gen(function* () {
      const store = yield* ThreadStore

      /**
       * `read` of the thread's entries matching `scan`, newest first: it is given the newest few, and as many again
       * (and more) each time it reads past the last of them while the thread has more.
       */
      const scan = <A>(task: TaskId, where: Omit<Scan, "limit">, read: (entries: Iterable<Entry>) => A) =>
        Effect.gen(function* () {
          for (let limit = FIRST_READ; ; limit *= 4) {
            const rows = yield* store.newest(task, { ...where, limit })
            let past = false
            const entries: Iterable<Entry> = {
              *[Symbol.iterator]() {
                yield* rows
                past = true
              },
            }
            const result = read(entries)
            if (!past || rows.length < limit) return result
          }
        })
      const first = (task: TaskId, where: Omit<Scan, "limit">) => Effect.map(store.newest(task, { ...where, limit: 1 }), (rows) => rows[0] ?? null)

      const lastAssistantText = (task: TaskId) => scan(task, { types: SAID }, lastAssistantTextOf)
      const saidSinceAsked = (task: TaskId) => scan(task, { types: SAID }, saidSinceAskedOf)

      const saidInTurn = Effect.fnUntraced(function* (task: TaskId, n: WriteNo) {
        const end = yield* store.item(task, `legacy:${n}`)
        if (end === null || end.item.type !== "turn_result") return null
        return yield* scan(task, { types: SAID, upto: end.pos }, (entries) => saidInTurnOf(entries, end.pos))
      })

      const lastTurnEnd = Effect.fnUntraced(function* (task: TaskId) {
        const e = yield* first(task, { types: ["turn_result"] })
        if (e === null) return null
        const n = writeNoOf(e.item.id)
        return n === undefined ? null : { write_no: n, end: turnEndOf(e) }
      })

      const userReplies = Effect.fnUntraced(function* (task: TaskId, limit: number | null) {
        const { replies, cut } = yield* scan(task, { types: SAID }, (entries) => userRepliesOf(entries, limit))
        if (cut === null) return replies
        const earlier = yield* scan(task, { types: ["user_message"], before: cut }, (entries) => {
          let n = 0
          for (const e of entries) if (usersText(e) !== null) n++
          return n
        })
        const result: UserReplies = { replies: replies.replies, since: replies.since, earlier }
        return result
      })

      const userWroteSince = (task: TaskId, since: Timestamp) =>
        scan(task, { types: ["user_message"], after: since }, (entries) => {
          for (const e of entries) if (e.meta.auto !== true && e.meta.from_agent !== true) return true
          return false
        })

      const userMessage = (task: TaskId, n: WriteNo) =>
        Effect.map(store.item(task, `legacy:${n}`), (e) => (e === null || e.item.type !== "user_message" ? null : userData(e)))
      const lastUserMessage = (task: TaskId) => Effect.map(first(task, { types: ["user_message"] }), (e) => (e === null ? null : userData(e)))

      const toolCallsSince = (task: TaskId, since: Timestamp | null) =>
        Effect.map(store.toolCallsSince(task, since), (entries) =>
          entries.flatMap((e): ReadonlyArray<ToolUseRecord> => {
            if (e.item.type !== "tool_call") return []
            const t = e.item
            const id = callIdOf(e)
            const result =
              t.result === undefined ? null : { type: "tool_result" as const, tool_use_id: id, content: t.result.content, is_error: t.status !== "completed" }
            return [{ call: { type: "tool_use", id, name: toolName(t), input: t.input }, result }]
          }),
        )

      /** The latest call with harness id `id`, if it passes `ok`. */
      const callWithId = (task: TaskId, id: string, ok: (t: ToolCall) => boolean) =>
        scan(task, { types: ["tool_call"], id }, (entries) => {
          for (const e of entries) if (e.item.type === "tool_call" && callIdOf(e) === id && ok(e.item)) return e
          return null
        })

      const toolUse = Effect.fnUntraced(function* (task: TaskId, id: string) {
        const e = yield* callWithId(task, id, () => true)
        return e === null || e.item.type !== "tool_call" ? null : { name: toolName(e.item), input: e.item.input }
      })

      const subagentCall = Effect.fnUntraced(function* (
        task: TaskId,
        about: { readonly tool_use_id?: string | undefined; readonly task_id?: string | undefined },
      ) {
        let id = about.tool_use_id ?? null
        if (id === null) {
          if (about.task_id === undefined) return null
          const started = yield* first(task, { types: ["tool_call"], subagentTask: about.task_id })
          if (started === null) return null
          id = callIdOf(started)
        }
        const call = yield* callWithId(task, id, (t) => ["Agent", "Task"].includes(toolName(t)))
        return call === null ? null : id
      })

      const userMessagesBetween = (profile: ProfileId, from: Timestamp, to: Timestamp) =>
        Effect.map(store.userMessagesBetween(profile, from, to), (rows) =>
          rows.map((r) => ({ at: r.entry.created_at, task_id: r.task_id, data: userData(r.entry) })),
        )

      const openQuestions = (task: TaskId) =>
        Effect.map(store.openQuestions(task), (rows) =>
          rows.flatMap((r): ReadonlyArray<OpenQuestion> => {
            const n = /^legacy:\d+$/.test(r.request.id) ? writeNoOf(r.request.id) : undefined
            return n === undefined || r.request.type !== "question" ? [] : [{ write_no: n, request: r.request }]
          }),
        )

      const unreadReports = (task: TaskId) =>
        Effect.map(store.unreadReports(task), (entries) => entries.flatMap((e) => (e.item.type === "notice" ? [e.item] : [])))

      return ThreadReaders.of({
        lastAssistantText,
        saidSinceAsked,
        saidInTurn,
        lastTurnEnd,
        userReplies,
        userWroteSince,
        userMessagedSince: store.userMessagedSince,
        movedOn: store.userMessageAfter,
        firstUserMessage: store.firstUserMessage,
        userMessage,
        lastUserMessage,
        toolCallsSince,
        toolUse,
        subagentCall,
        userMessagesBetween,
        openQuestions,
        asked: store.askedIn,
        unreadReports,
      })
    }),
  )
}
