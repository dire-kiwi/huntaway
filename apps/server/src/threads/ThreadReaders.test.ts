import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Ref } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient, Statement } from "effect/sql"
import { ProfileId, Timestamp } from "@huntaway/contracts"
import type { Item, NewEvent, TaskId, ToolKind } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Attachments } from "../tasks/Attachments.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { WriteNo } from "./model.ts"
import type { ItemMeta } from "./model.ts"
import { ThreadReaders } from "./ThreadReaders.ts"
import { Threads } from "./Threads.ts"
import type { UserMessageMeta } from "./Threads.ts"

// The board's readers of a thread (the old threads/history.test.ts), on the items a translator makes of a history: the
// old cases wrote messages and rebuilt items from them; here each step writes the items the old translator made of it
// (`write` below: `legacy:<n>:<block>` for a message's blocks, `legacy:<n>` for a turn's result, the metas it kept),
// a second apart on the test clock. Dropped: "a task still on messages" (no messages any more), `turn_end` of a
// result message's data (the Claude driver's, 2.4; `lastTurnEnd` keeps its rule), `changes_code` (git, M4),
// `permissions.moved_on`/`routine_call` (3.3), the merge gate's settling of its card (4.7), `pending_approvals` (3.3,
// over `permission_requests`), prompt analytics' kinds (6.9; the range query and its index are here).

// ---- a history, as the translator wrote it ----------------------------------------------------------------------

type Block = { readonly text: string } | { readonly thinking: string } | { readonly call: string; readonly name: string; readonly input?: unknown }

type Step =
  | { readonly _tag: "user"; readonly text: string; readonly meta: UserMessageMeta }
  | { readonly _tag: "assistant"; readonly blocks: ReadonlyArray<Block>; readonly parent?: string; readonly apiError?: string }
  | { readonly _tag: "results"; readonly results: ReadonlyArray<readonly [id: string, content: string, isError: boolean]> }
  | {
      readonly _tag: "done"
      readonly text?: string
      readonly subtype?: string
      readonly isError?: boolean
      readonly interrupted?: boolean
      readonly compact?: boolean
    }
  | { readonly _tag: "started"; readonly call: string; readonly task: string }
  | { readonly _tag: "question"; readonly question: string; readonly metadata?: Record<string, unknown> }
  | { readonly _tag: "answer"; readonly question: string; readonly outcome: "answer" | "cancel" }
  | { readonly _tag: "nothing" }

const user = (text: string, meta: UserMessageMeta = {}): Step => ({ _tag: "user", text, meta })
const assistant = (blocks: ReadonlyArray<Block>, more: { readonly parent?: string; readonly apiError?: string } = {}): Step => ({
  _tag: "assistant",
  blocks,
  ...more,
})
const results = (...list: ReadonlyArray<readonly [string, string, boolean?]>): Step => ({
  _tag: "results",
  results: list.map(([id, content, isError]) => [id, content, isError === true] as const),
})
const done = (text?: string, more: Omit<Extract<Step, { _tag: "done" }>, "_tag" | "text"> = {}): Step => ({
  _tag: "done",
  ...(text === undefined ? {} : { text }),
  ...more,
})
const text = (t: string): Block => ({ text: t })
const call = (id: string, name: string, input: unknown = {}): Block => ({ call: id, name, input })

/** A tool's fields as the translator gives them (inventory 08, 3.5 `tool_fields`), as far as these cases need. */
const toolFields = (name: string): { readonly name: string; readonly kind: ToolKind; readonly server?: string } => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp?.[1] !== undefined && mcp[2] !== undefined) return mcp[1] === "app" ? { name: mcp[2], kind: "app" } : { name: mcp[2], kind: "mcp", server: mcp[1] }
  const kinds: Record<string, ToolKind> = { Bash: "shell", Read: "read", Edit: "edit", Write: "edit", Agent: "subagent", Task: "subagent" }
  return { name, kind: kinds[name] ?? "other" }
}

/** The time of a history's `i`th step: a second apart from the epoch (the test clock's start). */
const at = (i: number) => Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(i * 1000)))

/**
 * A task with the history `steps`, each written a second after the one before (step `i` at `at(i)`). Returns the task
 * and each step's write number (for a step that takes one).
 */
const history = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tasks = yield* Tasks
    const threads = yield* Threads
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${at(0)})`.pipe(Effect.orDie)
    const task = (yield* tasks.create({ profile_id: ProfileId.make("p") }, Actor.user).pipe(Effect.orDie)).id
    // What the turn said so far (its main-conversation texts), which a result that says the same does not repeat.
    const said = yield* Ref.make<string | null>(null)
    const questions = new Map<string, string>()
    const numbers: Array<WriteNo | null> = []
    const start = yield* DateTime.now
    for (const [i, step] of steps.entries()) {
      // Step i is written at at(i), whatever ran before.
      const now = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(start)
      yield* TestClock.adjust(i * 1000 - now)
      numbers.push(yield* writeStep(task, step, said, questions).pipe(Effect.provideService(Threads, threads)))
    }
    return { task, numbers }
  })

const writeStep = (task: TaskId, step: Step, said: Ref.Ref<string | null>, questions: Map<string, string>) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    switch (step._tag) {
      case "user":
        yield* Ref.set(said, null)
        return yield* threads.userMessage(task, step.text, step.meta)
      case "assistant": {
        const parent = step.parent === undefined ? {} : { parent_id: step.parent }
        const { writeNo } = yield* threads.writeFromAgent(task, (n) => {
          const events: Array<NewEvent> = []
          const metas = new Map<string, ItemMeta>()
          if (step.apiError !== undefined) {
            const all = step.blocks.flatMap((b) => ("text" in b ? [b.text] : []))
            events.push({
              type: "item.added",
              item: { id: `legacy:${n}`, type: "notice", level: "error", text: all.join("\n"), code: step.apiError, ...parent },
            })
            return { events }
          }
          for (const [i, b] of step.blocks.entries()) {
            let item: Item | null = null
            if ("text" in b && b.text.trim() !== "") item = { id: `legacy:${n}:${i}`, type: "assistant_message", text: b.text, ...parent }
            else if ("thinking" in b && b.thinking.trim() !== "") item = { id: `legacy:${n}:${i}`, type: "reasoning", text: b.thinking, ...parent }
            else if ("call" in b) {
              item = { id: b.call, type: "tool_call", ...toolFields(b.name), input: b.input, status: "running", ...parent }
              metas.set(b.call, { session: "s1" })
            }
            if (item !== null) events.push({ type: "item.added", item })
          }
          return { events, metas }
        })
        const texts = step.blocks.flatMap((b) => ("text" in b && b.text.trim() !== "" ? [b.text] : []))
        if (step.parent === undefined && texts.length > 0) yield* Ref.set(said, texts.join("\n"))
        return writeNo
      }
      case "results":
        yield* threads.appendFromAgent(
          task,
          step.results.map(([id, content, isError]): NewEvent => ({
            type: "item.updated",
            item_id: id,
            patch: { status: isError ? "failed" : "completed", result: { content } },
          })),
        )
        return null
      case "started":
        yield* threads.appendFromAgent(
          task,
          [{ type: "item.updated", item_id: step.call, patch: { kind: "subagent", subagent: { status: "running" } } }],
          new Map([[step.call, { session: "s1", subagent_task: step.task }]]),
        )
        return null
      case "done": {
        const before = yield* Ref.getAndSet(said, null)
        const { writeNo } = yield* threads.writeFromAgent(task, (n) => {
          const ok = (step.subtype ?? "success") === "success" && step.isError !== true
          const events: Array<NewEvent> = []
          const metas = new Map<string, ItemMeta>()
          const result = step.text
          if (result !== undefined && ok && result.trim() !== "" && before?.trim() !== result.trim()) {
            events.push({ type: "item.added", item: { id: `legacy:${n}:result`, type: "assistant_message", text: result, metadata: { from_result: true } } })
            metas.set(`legacy:${n}:result`, { from_result: true })
          }
          const error = !ok && (result !== undefined || step.interrupted !== true) ? { error: result ?? step.subtype ?? "error" } : {}
          events.push({
            type: "item.added",
            item: { id: `legacy:${n}`, type: "turn_result", ok, ...(step.interrupted === true ? { interrupted: true } : {}), ...error },
          })
          metas.set(`legacy:${n}`, { ...(result === undefined ? {} : { result_text: result }), compact: step.compact === true })
          return { events, metas }
        })
        return writeNo
      }
      case "question": {
        const n = yield* threads.openRequest(task, {
          type: "question",
          questions: [{ id: "q", question: step.question, options: [{ label: "A" }] }],
          ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
        })
        questions.set(step.question, `legacy:${n}`)
        return n
      }
      case "answer":
        yield* threads.resolveRequest(task, questions.get(step.question) ?? "", { outcome: step.outcome }).pipe(Effect.orDie)
        return null
      case "nothing":
        break
    }
    return null
  }).pipe(Effect.orDie)

/** A routine's report in the assistant's thread, read or not. */
const report = (n: number, read: boolean): NewEvent => ({
  type: "item.added",
  item: { id: `legacy:${n}`, type: "notice", level: "info", code: "routine_report", text: `report ${n}`, metadata: { outcome: "reported", read } },
})

const run = <A, E>(effect: Effect.Effect<A, E, ThreadReaders | Threads | Tasks | Attachments | SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

// ---- the readers ------------------------------------------------------------------------------------------------

describe("ThreadReaders", () => {
  it.effect("what the agent said: its messages' text, results' and API errors", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id } = yield* history([
          user("start", { auto: true, start: true }),
          assistant([text("Looking."), call("t1", "Bash", { command: "ls" }), text("Found it.")]),
          results(["t1", "a\nb"]),
          // A thinking block and a whitespace text block say nothing.
          assistant([{ thinking: "hmm" }, text("  "), text("Done: two files.")]),
          done("Done: two files."),
          user("And now?"),
          assistant([text("Working on it.")]),
          // A result that says what no message did.
          done("All finished."),
        ])
        assert.strictEqual(yield* readers.lastAssistantText(id), "All finished.")
        assert.strictEqual(yield* readers.saidSinceAsked(id), "All finished.")
        assert.deepStrictEqual(yield* readers.userReplies(id, null), { replies: [["Done: two files.", "And now?"]], since: "Working on it.", earlier: 0 })

        // A message's text blocks, joined.
        const joined = yield* history([user("go"), assistant([text("one"), call("t1", "Read", { file_path: "/x" }), text("two")])])
        assert.strictEqual(yield* readers.lastAssistantText(joined.task), "one\ntwo")
        // An API error in the agent's place.
        const limited = yield* history([user("go"), assistant([text("Before.")]), assistant([text("You've hit your limit.")], { apiError: "rate_limit" })])
        assert.strictEqual(yield* readers.lastAssistantText(limited.task), "You've hit your limit.")
        assert.deepStrictEqual(yield* readers.userReplies(limited.task, null), { replies: [[null, "go"]], since: "You've hit your limit.", earlier: 0 })
        // Nothing since it was asked.
        const asked = yield* history([assistant([text("Earlier.")]), user("Summarize?", { auto: true })])
        assert.isNull(yield* readers.saidSinceAsked(asked.task))
        assert.strictEqual(yield* readers.lastAssistantText(asked.task), "Earlier.")
        // An empty thread, and an error result with no text.
        assert.isNull(yield* readers.lastAssistantText((yield* history([])).task))
        const failed = yield* history([user("go"), assistant([text("Trying.")]), done(undefined, { subtype: "error_during_execution", isError: true })])
        assert.strictEqual(yield* readers.saidSinceAsked(failed.task), "Trying.")
        // HA-218: a routine's report (an error notice for a failed run) is the board's, not the agent's.
        const reported = yield* history([user("go"), assistant([text("Mine.")])])
        const threads = yield* Threads
        yield* threads.appendFromAgent(reported.task, [
          {
            type: "item.added",
            item: { id: "legacy:99", type: "notice", level: "error", code: "routine_report", text: "It broke", metadata: { outcome: "failed" } },
          },
        ])
        assert.strictEqual(yield* readers.lastAssistantText(reported.task), "Mine.")
      }),
    ),
  )

  it.effect("Telegram's: what the agent said in a turn, and how the latest turn ended", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const steps = [
          user("go"),
          assistant([text("Looking."), call("t1", "Bash", { command: "ls" }), text("Found it.")]),
          results(["t1", "a"]),
          // A result with no text: the turn's last message is its reply.
          done(),
          // A turn that said nothing doesn't say the one before's again.
          { _tag: "nothing" } as const,
          done(""),
          user("And?"),
          assistant([text("Thinking.")]),
          // A result that says what no message did.
          done("All finished."),
          user("Compact", { auto: true }),
          done("", { compact: true }),
          user("Again"),
          assistant([text("Partly.")]),
          done(undefined, { subtype: "error_during_execution", isError: true }),
          user("Stop?"),
          done(undefined, { interrupted: true }),
          user("Late"),
          assistant([text("After the turn.")]),
        ]
        const { task: id, numbers } = yield* history(steps)
        const ends = steps.flatMap((s, i) => (s._tag === "done" ? [i] : []))
        const endNumbers = ends.map((i) => numbers[i] ?? WriteNo.make(0))
        assert.deepStrictEqual(yield* Effect.forEach(endNumbers, (n) => readers.saidInTurn(id, n), { concurrency: 1 }), [
          "Looking.\nFound it.",
          null,
          "All finished.",
          null,
          "Partly.",
          null,
        ])
        // No such turn's end, and a write that is not one.
        assert.isNull(yield* readers.saidInTurn(id, WriteNo.make(99999)))
        assert.isNull(yield* readers.saidInTurn(id, numbers[0] ?? WriteNo.make(0)))
        // The latest: an interrupted turn, then each before it as the latest.
        assert.deepStrictEqual(yield* readers.lastTurnEnd(id), { write_no: endNumbers[5], end: "failed" })
        for (const [n, end] of [
          [4, "failed"],
          [3, "compact"],
          [2, "reply"],
          [0, "reply"],
        ] as const) {
          const cut = yield* history(steps.slice(0, (ends[n] ?? 0) + 1))
          assert.strictEqual((yield* readers.lastTurnEnd(cut.task))?.end, end, `end ${n}`)
        }
        assert.isNull(yield* readers.lastTurnEnd((yield* history([user("go")])).task))
      }),
    ),
  )

  it.effect("the user's replies: their own words, with what the agent said before each, and limits", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id } = yield* history([
          user("Start working on this task.", { auto: true, start: true }),
          assistant([text("Which colour?")]),
          user("Blue."),
          assistant([text("And the size?")]),
          // Other agents' messages, and the board's, aren't the user's.
          user("From another agent", { from_agent: true }),
          user("Review found issues", { auto: true }),
          assistant([text("Fixed.")]),
          user("[agent] note\n\nLarge.", { user_text: "  Large.  " }),
          user("Also round corners."),
          assistant([text("Will do.")]),
        ])
        assert.deepStrictEqual(yield* readers.userReplies(id, null), {
          replies: [
            ["Which colour?", "Blue."],
            ["Fixed.", "Large."],
            [null, "Also round corners."],
          ],
          since: "Will do.",
          earlier: 0,
        })
        assert.deepStrictEqual(yield* readers.userReplies(id, 1), { replies: [[null, "Also round corners."]], since: "Will do.", earlier: 2 })
        assert.deepStrictEqual(yield* readers.userReplies(id, 2), {
          replies: [
            ["Fixed.", "Large."],
            [null, "Also round corners."],
          ],
          since: "Will do.",
          earlier: 1,
        })
      }),
    ),
  )

  it.effect("reads a long thread back as far as it needs", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        // More than the first read: the agent's message is far behind the user's replies.
        const steps: Array<Step> = [user("first"), assistant([text("Long ago.")])]
        for (let i = 0; i < 150; i++) steps.push(user(`From an agent ${i}`, { from_agent: true }))
        steps.push(user("Mine."))
        const { task: id } = yield* history(steps)
        assert.deepStrictEqual(yield* readers.userReplies(id, null), {
          replies: [
            [null, "first"],
            ["Long ago.", "Mine."],
          ],
          since: null,
          earlier: 0,
        })
        assert.deepStrictEqual(yield* readers.userReplies(id, 1), { replies: [["Long ago.", "Mine."]], since: null, earlier: 1 })
        assert.strictEqual(yield* readers.lastAssistantText(id), "Long ago.")
      }),
    ),
  )

  it.effect("tool calls since a time, as Claude's blocks", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id } = yield* history([
          user("go"),
          assistant([call("e1", "Edit", { file_path: "/a", old_string: "x", new_string: "y" })]),
          results(["e1", "error: no match", true]),
          assistant([call("b1", "Bash", { command: "echo hi > /repo/file" })]),
          results(["b1", "The user denied this action.", true]),
          assistant([call("m1", "mcp__huntaway__list_tasks"), call("a1", "mcp__app__thing")]),
          results(["m1", "[]"], ["a1", "ok"]),
          assistant([call("e2", "Write", { file_path: "/b", content: "z" })]),
          results(["e2", "written"]),
          // A subagent's, and one with no result yet.
          assistant([call("e3", "Edit", { file_path: "/c" })], { parent: "x1" }),
          assistant([call("b2", "Bash", { command: "git commit -m x" })]),
        ])
        const calls = (yield* readers.toolCallsSince(id, null)).map((r) => [r.call.id, r.call.name, r.result?.is_error ?? null])
        assert.deepStrictEqual(calls, [
          ["e1", "Edit", true],
          ["b1", "Bash", true],
          ["m1", "mcp__huntaway__list_tasks", false],
          ["a1", "mcp__app__thing", false],
          ["e2", "Write", false],
          ["e3", "Edit", null],
          ["b2", "Bash", null],
        ])
        assert.deepStrictEqual(
          (yield* readers.toolCallsSince(id, at(6))).map((r) => r.call.id),
          ["e2", "e3", "b2"],
        )
        const [first] = yield* readers.toolCallsSince(id, null)
        assert.deepStrictEqual(first?.result, { type: "tool_result", tool_use_id: "e1", content: "error: no match", is_error: true })
        // A call's name and input.
        assert.deepStrictEqual(yield* readers.toolUse(id, "m1"), { name: "mcp__huntaway__list_tasks", input: {} })
        assert.isNull(yield* readers.toolUse(id, "nope"))
      }),
    ),
  )

  it.effect("who wrote since a time", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id } = yield* history([
          user("start", { auto: true }),
          assistant([text("ok")]),
          user("from an agent", { from_agent: true }),
          user("mine"),
          assistant([text("ok")]),
          user("merge", { auto: true }),
        ])
        assert.isTrue(yield* readers.userWroteSince(id, at(2)))
        assert.isFalse(yield* readers.userWroteSince(id, at(3)))
        assert.isTrue(yield* readers.userMessagedSince(id, at(5)))
        assert.isFalse(yield* readers.userMessagedSince(id, at(6)))
      }),
    ),
  )

  it.effect("a subagent's call, from what its lifecycle lines say", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id } = yield* history([
          user("go"),
          assistant([
            call("ag1", "Agent", { description: "look", prompt: "look around" }),
            call("sk1", "Skill", { skill: "x" }),
            call("bg1", "Bash", { command: "sleep 9" }),
          ]),
          { _tag: "started", call: "ag1", task: "T1" },
          // A forked skill becomes a subagent call, but it is no Agent or Task call; a background shell's is not one.
          { _tag: "started", call: "sk1", task: "T2" },
          results(["ag1", "found it"], ["sk1", "done"], ["bg1", "started"]),
          // A Codex subagent, as its driver writes it.
          assistant([call("codex-sub-1", "Agent", { description: "d", prompt: "p", run_in_background: true })]),
          { _tag: "started", call: "codex-sub-1", task: "thread-9" },
        ])
        const about = [
          { tool_use_id: "ag1" },
          { task_id: "T1" },
          { task_id: "T1", tool_use_id: "ag1" },
          { task_id: "T2" },
          { tool_use_id: "sk1" },
          { task_id: "T3" },
          { tool_use_id: "bg1" },
          { task_id: "thread-9" },
          { task_id: "nope" },
          {},
        ]
        const found = yield* Effect.forEach(about, (a) => readers.subagentCall(id, a), { concurrency: 1 })
        assert.deepStrictEqual(found, ["ag1", "ag1", "ag1", null, null, null, null, "codex-sub-1", null, null])
      }),
    ),
  )

  it.effect("a question's conversation moving on, the first user message and turns' messages", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const { task: id, numbers } = yield* history([
          assistant([text("hello")]),
          user("Start", { auto: true, start: true }),
          { _tag: "question", question: "Which?" },
          assistant([text("waiting")]),
          user("Fix these", { auto: true, review_round: 2 }),
          user("A routine's prompt", { routine: true, auto: true }),
          user("[from x]\n\nmine", { user_text: "mine" }),
        ])
        const n = (i: number) => numbers[i] ?? WriteNo.make(0)
        assert.isTrue(yield* readers.movedOn(id, n(2)))
        assert.isFalse(yield* readers.movedOn(id, n(6)))
        assert.strictEqual(yield* readers.firstUserMessage(id), n(1))
        assert.isNull(yield* readers.firstUserMessage((yield* history([assistant([text("x")])])).task))
        assert.deepStrictEqual(yield* readers.userMessage(id, n(4)), { text: "Fix these", auto: true, review_round: 2 })
        assert.deepStrictEqual(yield* readers.userMessage(id, n(5)), { text: "A routine's prompt", auto: true, routine: true })
        assert.isNull(yield* readers.userMessage(id, WriteNo.make(99999)))
        // A write that is no user message.
        assert.isNull(yield* readers.userMessage(id, n(3)))
        assert.deepStrictEqual(yield* readers.lastUserMessage(id), { text: "[from x]\n\nmine", user_text: "mine" })
      }),
    ),
  )

  it.effect("the board's questions still waiting for an answer, and whether a call asked one", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const threads = yield* Threads
        const { task: id } = yield* history([
          user("go"),
          { _tag: "question", question: "Answered?" },
          { _tag: "answer", question: "Answered?", outcome: "answer" },
          { _tag: "question", question: "Open?", metadata: { call_id: "c1" } },
          { _tag: "question", question: "Replied?" },
          { _tag: "answer", question: "Replied?", outcome: "cancel" },
          { _tag: "question", question: "Merge?", metadata: { merge_approval: true } },
        ])
        // A question prompt (AskUserQuestion) is a question request too, but not the board's own.
        yield* threads.openRequest(id, { id: "r1", type: "question", questions: [{ id: "Pick", question: "Pick" }] })
        const open = Effect.map(readers.openQuestions(id), (qs) => qs.map((q) => q.request.questions[0].question))
        assert.deepStrictEqual(yield* open, ["Open?", "Merge?"])
        const [first] = yield* readers.openQuestions(id)
        yield* threads.resolveRequest(id, first?.request.id ?? "", { outcome: "cancel", message: "Answered with a message instead" })
        assert.deepStrictEqual(yield* open, ["Merge?"])
        assert.isTrue(yield* readers.asked(id, "c1"))
        assert.isFalse(yield* readers.asked(id, "c2"))
      }),
    ),
  )

  it.effect("the routines' reports the assistant hasn't read", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const threads = yield* Threads
        const { task: id } = yield* history([user("go")])
        yield* threads.appendFromAgent(id, [report(10, true), report(11, false)])
        assert.deepStrictEqual(
          (yield* readers.unreadReports(id)).map((r) => r.text),
          ["report 11"],
        )
      }),
    ),
  )

  it.effect("prompt analytics reads the user messages in its time range by their index, and one task's queries its own items", () =>
    run(
      Effect.gen(function* () {
        const readers = yield* ThreadReaders
        const sql = yield* SqlClient.SqlClient
        const { task: id } = yield* history([
          user("Do the thing, please", { auto: true, start: true }),
          user("A prompt"),
          user("From an agent", { from_agent: true }),
          assistant([text("ok")]),
          user("Review issues", { auto: true }),
        ])
        const profile = ProfileId.make("p")
        assert.deepStrictEqual(
          (yield* readers.userMessagesBetween(profile, at(1), at(4))).map((m) => [m.at, m.task_id === id, m.data.text]),
          [
            [at(1), true, "A prompt"],
            [at(2), true, "From an agent"],
          ],
        )
        // HA-262: analytics read every item of the profile's tasks (thread_items had only its (task_id, pos) indexes).
        // The index for it mustn't take over a query of one task's items either.
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = []
        const capture: Statement.Transformer = (self) =>
          Effect.sync(() => {
            statements.push(self.compile())
            return self
          })
        yield* Effect.all([readers.userMessagesBetween(profile, at(0), at(9)), readers.userMessagedSince(id, at(1))], { concurrency: 1 }).pipe(
          Effect.provideService(Statement.CurrentTransformer, capture),
        )
        const plan = ([query, params]: readonly [string, ReadonlyArray<unknown>]) =>
          Effect.map(sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params).pipe(Effect.orDie), (rows) => rows.map((r) => r.detail).join("; "))
        const [range, since] = statements.filter(([q]) => q.includes("FROM thread_items"))
        assert.match(yield* plan(range ?? ["", []]), /SEARCH i USING INDEX thread_items_user_time \(type=\? AND created_at>\? AND created_at<\?\)/)
        const own = yield* plan(since ?? ["", []])
        // The task's own rows by its key (the table is WITHOUT ROWID on (task_id, id)), never the board-wide index.
        assert.match(own, /SEARCH thread_items USING (?:PRIMARY KEY|INDEX thread_items_pos) \(task_id=\?\)/)
        assert.notInclude(own, "thread_items_user_time")
      }),
    ),
  )

  it.effect("attachments a thread links are referenced", () =>
    run(
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const threads = yield* Threads
        const a = "0123456789abcdef0123456789abcdef"
        const b = "fedcba9876543210fedcba9876543210"
        const { task: id } = yield* history([
          user(`Look\n\nAttached files:\n- /data/attachments/${a}/shot.png`),
          assistant([call("r1", "Read", { file_path: `/data/attachments/${b}/notes.txt` })]),
        ])
        assert.deepStrictEqual([...(yield* attachments.ofTask(id))].toSorted(), [a, b].toSorted())
        // In a request too (a permission prompt's input).
        const asked = (yield* history([])).task
        yield* threads.openRequest(asked, {
          id: "r9",
          type: "permission",
          name: "Read",
          kind: "read",
          input: { file_path: `/data/attachments/${"a".repeat(32)}/y` },
        })
        assert.deepStrictEqual([...(yield* attachments.ofTask(asked))], ["a".repeat(32)])
        assert.isTrue((yield* attachments.referenced).has(b))
      }),
    ),
  )
})
