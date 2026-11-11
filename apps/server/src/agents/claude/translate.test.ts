import { assert, describe, it } from "@effect/vitest"
import {
  applyEvents,
  initialState,
  type Item,
  type NewEvent,
  type RequestResolution,
  type SavedEvent,
  type Snapshot,
  TaskId,
  type ThreadRequest,
  Timestamp,
  type ToolCall,
} from "@huntaway/contracts"
import { Result } from "effect"
import { decodeLine } from "./lines.ts"
import { ASK_USER, EXIT_PLAN, type Prompt, requestForPrompt } from "./requests.ts"
import { jsonText, RESULT_MAX_BYTES, truncate } from "./tools.ts"
import {
  emptyState,
  isForeignResult,
  type ItemMeta,
  type LineEffect,
  observe,
  resultError,
  stateFromItems,
  translate,
  type TranslatorState,
  type TurnFacts,
} from "./translate.ts"

// The old threads/translate.test.ts (HA-128's import tests) for what the translator still does, and what the old
// output.ts did on the way (`slim`, what a line tells the run). Each history is checked against rebuilding the state from
// the store before every write (but where it holds a result or prompt that came before its call, which a rebuild loses).
// Dropped, as the board's own writes are not the translator's any more (`Threads` and the permissions area write them):
// "a_prompt_answered_later_resolves_its_request" and "a_late_answer_after_its_run_ended_resolves_its_request_again" (a
// stored prompt fed again as its status changed), "board_questions" (request_user_input cards), the report notices of
// "what_the_board_draws_that_the_protocol_doesnt_say", "answers_to_claudes_questions_as_the_board_keeps_them" and
// "answers_to_codexs_questions_as_the_board_keeps_them" (the answers as `permission_requests` keeps them), and
// "the_tools_whose_prompts_are_questions_and_plans_are_the_boards" (no permissions module yet). `finish` (an import's
// end: open calls cancelled, subagents stopped, prompts cancelled, and its warnings `no_result`, `subagent_running`,
// `open_prompt`, `orphan_result`, `missing_parent`) went with the importer, so those cases check the open state instead.
// The old output.test.ts cases are the run's (its turns, costs, usage, context): the follower's, not ported here.

const thread = TaskId.make("t")
const atOf = (id: number) => Timestamp.make(`2026-11-01T00:00:${String(id % 60).padStart(2, "0")}.000Z`)

type Write =
  | { readonly _tag: "Line"; readonly id: number; readonly raw: unknown; readonly turn?: TurnFacts }
  | { readonly _tag: "Board"; readonly events: ReadonlyArray<NewEvent> }
  | { readonly _tag: "Prompt"; readonly prompt: Prompt; readonly resolution?: RequestResolution }

const msg = (id: number, raw: unknown, turn?: TurnFacts): Write => ({ _tag: "Line", id, raw, ...(turn === undefined ? {} : { turn }) })
const assistant = (id: number, parent: string | null, content: ReadonlyArray<unknown>) =>
  msg(id, { type: "assistant", message: { content }, parent_tool_use_id: parent, session_id: "s1" })
const results = (id: number, parent: string | null, content: ReadonlyArray<unknown>) =>
  msg(id, { type: "user", message: { content }, parent_tool_use_id: parent, session_id: "s1" })
const task = (id: number, fields: Readonly<Record<string, unknown>>) => msg(id, { type: "system", ...fields })
const result = (id: number, fields: Readonly<Record<string, unknown>>, turn?: TurnFacts) => msg(id, { type: "result", ...fields }, turn)
const userMessage = (id: number, text: string, extra: Partial<Extract<Item, { type: "user_message" }>> = {}): Write => ({
  _tag: "Board",
  events: [{ type: "item.added", item: { id: `legacy:${id}`, type: "user_message", text, created_at: atOf(id), ...extra } }],
})
const prompt = (fields: Omit<Prompt, "id"> & { readonly id: string }, resolution?: RequestResolution): Write => ({
  _tag: "Prompt",
  prompt: fields,
  ...(resolution === undefined ? {} : { resolution }),
})

interface Converted {
  readonly items: ReadonlyArray<Item>
  readonly requests: ReadonlyArray<ThreadRequest>
  readonly metas: ReadonlyMap<string, ItemMeta>
  readonly codes: ReadonlyArray<string>
  readonly effects: ReadonlyArray<ReadonlyArray<LineEffect>>
  /** The events each write made. */
  readonly made: ReadonlyArray<ReadonlyArray<NewEvent>>
  readonly state: TranslatorState
}

/** `writes` as the board takes them; with `rebuildAt`, the state is rebuilt from the store before that write. */
const run = (writes: ReadonlyArray<Write>, rebuildAt?: number): Converted => {
  let state = emptyState
  let snapshot: Snapshot = initialState({ id: thread, harness: "claude", status: "idle", created_at: atOf(0) })
  const metas = new Map<string, ItemMeta>()
  const codes: Array<string> = []
  const effects: Array<ReadonlyArray<LineEffect>> = []
  const made: Array<ReadonlyArray<NewEvent>> = []
  const append = (events: ReadonlyArray<NewEvent>) => {
    for (const e of events) snapshot = applyEvents(snapshot, [{ ...e, thread_id: thread, seq: snapshot.seq + 1 } satisfies SavedEvent])
  }
  writes.forEach((w, i) => {
    if (i === rebuildAt) state = stateFromItems(snapshot.items, snapshot.requests, (id) => metas.get(id))
    if (w._tag === "Board") {
      append(w.events)
      state = observe(state, w.events)
      made.push(w.events)
      effects.push([])
    } else if (w._tag === "Prompt") {
      const r = requestForPrompt(state, w.prompt)
      state = r.state
      codes.push(...r.warnings.map((x) => x.code))
      const events: Array<NewEvent> = r.request === null ? [] : [{ type: "request.opened", request: r.request }]
      if (r.request !== null && w.resolution !== undefined) events.push({ type: "request.resolved", request_id: r.request.id, resolution: w.resolution })
      append(events)
      state = observe(state, events)
      made.push(events)
      effects.push([])
    } else {
      const line = decodeLine(jsonText(w.raw))
      if (Result.isFailure(line)) {
        made.push([])
        effects.push([])
        return
      }
      const t = translate(state, line.success, { writeNo: w.id, at: atOf(w.id), ...(w.turn === undefined ? {} : { turn: w.turn }) })
      state = t.state
      append(t.events)
      for (const [id, meta] of t.metas) metas.set(id, meta)
      codes.push(...t.warnings.map((x) => x.code))
      made.push(t.events)
      effects.push(t.effects)
    }
  })
  return { items: snapshot.items, requests: snapshot.requests, metas, codes, effects, made, state }
}

/** `run`, checked against rebuilding the state from the store before every write. */
const convert = (writes: ReadonlyArray<Write>, o: { readonly rebuilds?: boolean } = {}): Converted => {
  const c = run(writes)
  if (o.rebuilds !== false) {
    for (let i = 0; i <= writes.length; i++) {
      const r = run(writes, i)
      assert.deepStrictEqual(r.items, c.items, `rebuilt before write ${i}: items`)
      assert.deepStrictEqual(r.requests, c.requests, `rebuilt before write ${i}: requests`)
      assert.deepStrictEqual([...r.metas], [...c.metas], `rebuilt before write ${i}: metas`)
    }
  }
  return c
}

const byId = (c: Converted): Readonly<Record<string, Item>> => Object.fromEntries(c.items.map((i) => [i.id, i]))
const call = (c: Converted, id: string): ToolCall => {
  const item = byId(c)[id]
  assert.isDefined(item, id)
  if (item?.type !== "tool_call") return assert.fail(`${id} is not a tool call`)
  return item
}
const requestsById = (c: Converted): Readonly<Record<string, ThreadRequest>> => Object.fromEntries(c.requests.map((r) => [r.id, r]))

/** A call with id `c` in session `session`, and its denied result. */
const bash = (id: number, session: string, command: string) =>
  msg(id, { type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command } }] } })
const bashDenied = (id: number, session: string) =>
  msg(id, { type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }] } })
const denied = (command: string) => prompt({ id: "r", tool_name: "Bash", input: { command }, tool_use_id: "c" }, { outcome: "deny" })

describe("translate", () => {
  it("converts a turn", () => {
    const c = convert([
      userMessage(1, "Fix the test", { metadata: { auto: true } }),
      assistant(2, null, [
        { type: "thinking", thinking: "Hmm" },
        { type: "text", text: "Looking" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "cargo test" } },
      ]),
      results(3, null, [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }]),
      assistant(4, null, [{ type: "text", text: "  " }]),
      userMessage(5, "and the docs", { steered: true }),
      result(6, { subtype: "success", is_error: false, duration_ms: 1200, num_turns: 3, total_cost_usd: 0.5 }, { cost: 0.5, stopping: false, compact: false }),
    ])
    assert.deepStrictEqual(
      c.items.map((i) => i.id),
      ["legacy:1", "legacy:2:0", "legacy:2:1", "tu1", "legacy:5", "legacy:6"],
    )
    const items = byId(c)
    assert.strictEqual(items["legacy:2:0"]?.type, "reasoning")
    const tu1 = call(c, "tu1")
    assert.deepStrictEqual([tu1.status, tu1.kind, tu1.command, tu1.result], ["completed", "shell", "cargo test", { content: "ok" }])
    assert.deepStrictEqual(items["legacy:6"], {
      id: "legacy:6",
      type: "turn_result",
      ok: true,
      created_at: atOf(6),
      duration_ms: 1200,
      // What the board shows of a turn's end that the item doesn't say: its cost is what the turn added.
      metadata: { subtype: "success", num_turns: 3, total_cost_usd: 0.5 },
    })
    // A blank text block makes nothing.
    assert.deepStrictEqual(c.made[3], [])
    assert.deepStrictEqual(c.codes, [])
    assert.deepStrictEqual(c.metas.get("tu1"), { session: "s1" })
    assert.strictEqual(c.state.session, "s1")
  })

  it("the same lines translate the same", () => {
    const writes = [userMessage(1, "hi"), assistant(2, null, [{ type: "text", text: "hello" }])]
    assert.deepStrictEqual(run(writes).made, run(writes).made)
  })

  it("subagents and their lines", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Look around", prompt: "Look", model: "haiku" } }]),
      task(2, { subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "ag", subagent_type: "Explore" }),
      results(3, "ag", [{ type: "text", text: "Look" }]),
      assistant(4, "ag", [{ type: "tool_use", id: "rd", name: "Read", input: { file_path: "/a" } }]),
      results(5, "ag", [{ type: "tool_result", tool_use_id: "rd", content: "text" }]),
      task(6, { subtype: "task_progress", task_id: "k1", description: "Reading /a", usage: { tool_uses: 1 } }),
      task(7, { subtype: "task_notification", task_id: "k1", status: "completed" }),
      msg(8, {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Found it" }] },
        tool_use_result: { agentId: "a1", agentType: "Explore", totalToolUseCount: 1, status: "completed" },
      }),
      // A Bash command's run: its call shows it.
      assistant(9, null, [{ type: "tool_use", id: "sh", name: "Bash", input: { command: "ls" } }]),
      task(10, { subtype: "task_started", task_type: "local_bash", task_id: "k2", tool_use_id: "sh" }),
      task(11, { subtype: "task_notification", task_id: "k2", status: "completed" }),
      results(12, null, [{ type: "tool_result", tool_use_id: "sh", content: "a" }]),
      // Not the subagent's prompt.
      results(13, "ag", [{ type: "text", text: "[Request interrupted by user]" }]),
    ])
    const ag = call(c, "ag")
    assert.deepStrictEqual([ag.kind, ag.title], ["subagent", "Look around"])
    // It ended with its task_notification (line 7), not its call's result after it.
    assert.deepStrictEqual(ag.subagent, { status: "completed", agent_type: "Explore", model: "haiku", activity: "Reading /a", tool_uses: 1, ended_at: atOf(7) })
    const rd = call(c, "rd")
    assert.deepStrictEqual([rd.parent_id, rd.path], ["ag", "/a"])
    const notice = byId(c)["legacy:13"]
    assert.deepStrictEqual(notice?.type === "notice" ? [notice.code, notice.parent_id] : [], ["interrupted", "ag"])
    // The subagent's prompt is its call's input, and the command's run its call's.
    for (const i of [2, 9, 10]) assert.deepStrictEqual(c.made[i], [], `line ${i + 1}`)
    assert.deepStrictEqual(c.codes, [])
    assert.deepStrictEqual(c.metas.get("ag"), { session: "s1", subagent_task: "k1" })
    assert.deepStrictEqual(c.metas.get("sh"), { session: "s1", shown_tasks: ["k2"] })
  })

  it("a background subagent and one that has not ended", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Away", run_in_background: true } }]),
      task(2, { subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "bg", is_backgrounded: true }),
      results(3, null, [{ type: "tool_result", tool_use_id: "bg", content: "Async agent launched successfully" }]),
      task(4, { subtype: "task_notification", task_id: "k1", status: "completed", summary: "Done away" }),
      assistant(5, null, [{ type: "tool_use", id: "bg2", name: "Agent", input: { description: "Lost" } }]),
      task(6, { subtype: "task_started", task_type: "local_agent", task_id: "k2", tool_use_id: "bg2", is_backgrounded: true }),
      results(7, null, [{ type: "tool_result", tool_use_id: "bg2", content: "Async agent launched successfully" }]),
    ])
    const bg = call(c, "bg")
    // Its call is done once it has started the subagent.
    assert.strictEqual(bg.status, "completed")
    assert.deepStrictEqual(bg.subagent, { status: "completed", background: true, summary: "Done away", ended_at: atOf(4) })
    assert.strictEqual(bg.result?.content, "Async agent launched successfully")
    assert.deepStrictEqual(call(c, "bg2").subagent, { status: "running", background: true })
    assert.strictEqual(call(c, "bg2").status, "completed")
    assert.deepStrictEqual(c.codes, [])
  })

  it("a forked skill becomes a subagent", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "sk", name: "Skill", input: { skill: "review" } }]),
      task(2, { subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "sk", description: "Review it" }),
      assistant(3, "sk", [{ type: "text", text: "Reviewing" }]),
      results(4, null, [{ type: "tool_result", tool_use_id: "sk", content: "Reviewed" }]),
    ])
    const sk = call(c, "sk")
    assert.deepStrictEqual([sk.kind, sk.title, sk.subagent?.status, sk.metadata], ["subagent", "Review it", "completed", { description: "Review it" }])
    assert.strictEqual(byId(c)["legacy:3:0"]?.parent_id, "sk")
    assert.deepStrictEqual(c.codes, [])
  })

  it("prompts become requests, linked to their calls", () => {
    const c = convert([
      // Asked before the call it's for, which is made in a subagent.
      assistant(1, null, [{ type: "tool_use", id: "ag", name: "Task", input: {} }]),
      prompt({ id: "r1", tool_name: "Bash", input: { command: "rm -rf x" }, tool_use_id: "rm" }, { outcome: "deny", message: "No" }),
      assistant(3, "ag", [{ type: "tool_use", id: "rm", name: "Bash", input: { command: "rm -rf x" } }]),
      results(4, "ag", [{ type: "tool_result", tool_use_id: "rm", content: "No", is_error: true }]),
      prompt({ id: "r2", tool_name: EXIT_PLAN, input: { plan: "# Plan" }, tool_use_id: "pl" }),
      prompt({
        id: "r3",
        tool_name: ASK_USER,
        input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multiSelect: true }] },
      }),
      prompt({ id: "r4", tool_name: "Write", input: { file_path: "/f" } }),
      prompt({ id: "r5", tool_name: "delete_task", kind: "delete_task", input: { task: "X-1" } }),
      prompt({ id: "r6", tool_name: "mcp__gh__pr_merge", input: {} }),
      prompt({ id: "r7", tool_name: ASK_USER, input: { questions: [] } }),
    ])
    const r = requestsById(c)
    const r1 = r["r1"]
    assert.deepStrictEqual(r1?.type === "permission" ? [r1.kind, r1.title, r1.tool_call_id, r1.parent_id, r1.resolution] : [], [
      "shell",
      "rm -rf x",
      "rm",
      "ag",
      { outcome: "deny", message: "No" },
    ])
    // Its prompt was denied: its error is a denial.
    assert.strictEqual(call(c, "rm").status, "denied")
    const r2 = r["r2"]
    assert.deepStrictEqual(r2?.type === "plan" ? [r2.plan, r2.tool_call_id] : [], ["# Plan", "pl"])
    // Claude's questions go by their text, and always take an answer of one's own (as agent-threads has them).
    const r3 = r["r3"]
    assert.deepStrictEqual(r3?.type === "question" ? r3.questions : [], [
      { id: "Which?", question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multi_select: true, allow_other: true },
    ])
    const kinds = ["r4", "r5", "r6"].map((id) => {
      const x = r[id]
      return x?.type === "permission" ? [x.kind, x.name, x.server, x.title] : []
    })
    assert.deepStrictEqual(kinds, [
      ["edit", "Write", undefined, "/f"],
      ["app", "delete_task", undefined, "delete_task"],
      ["mcp", "pr_merge", "gh", "pr_merge"],
    ])
    // A question prompt with no questions is no request.
    assert.isUndefined(r["r7"])
    assert.deepStrictEqual(c.codes, ["empty_question"])
  })

  it("a prompt for a call that has come is for it", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } }]),
      prompt({ id: "r", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "c" }),
    ])
    assert.deepStrictEqual(c.requests, [{ id: "r", type: "permission", tool_call_id: "c", kind: "shell", name: "Bash", input: { command: "ls" }, title: "ls" }])
  })

  it("a compaction and its summary", () => {
    const c = convert([
      task(1, { subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1234, post_tokens: 120 } }),
      msg(2, { type: "user", isSynthetic: true, message: { content: "Summary so far" } }),
      result(3, { subtype: "success", is_error: false, num_turns: 0 }, { cost: 0.01, stopping: false, compact: true }),
      result(4, { subtype: "error_during_execution", is_error: true }, { cost: 0, stopping: true, compact: false }),
      result(5, { subtype: "error_max_turns", is_error: true }),
    ])
    const items = byId(c)
    assert.deepStrictEqual(items["legacy:1"], {
      id: "legacy:1",
      type: "compaction",
      trigger: "manual",
      tokens_before: 1234,
      summary: "Summary so far",
      created_at: atOf(1),
      metadata: { post_tokens: 120 },
    })
    // A `/compact` run's turn ends with a turn_result too, which says so in its meta.
    assert.deepStrictEqual(items["legacy:3"]?.metadata, { subtype: "success", num_turns: 0, total_cost_usd: 0.01 })
    assert.deepStrictEqual(c.metas.get("legacy:3"), { compact: true })
    // The turn a stop cut short says nothing more than that.
    const stopped = items["legacy:4"]
    assert.deepStrictEqual(stopped?.type === "turn_result" ? [stopped.ok, stopped.interrupted, stopped.error] : [], [false, true, undefined])
    assert.deepStrictEqual(c.effects[3], [{ _tag: "TurnEnded", error: 'run ended with "error_during_execution"', interrupted: true, usageLimit: false }])
    const failed = items["legacy:5"]
    assert.deepStrictEqual(failed?.type === "turn_result" ? [failed.error, failed.metadata] : [], [
      "error_max_turns",
      { subtype: "error_max_turns", total_cost_usd: 0 },
    ])
    assert.deepStrictEqual(c.effects[0], [{ _tag: "Compacted", metadata: { trigger: "manual", pre_tokens: 1234, post_tokens: 120 } }])
  })

  it("a subagent that runs again keeps when it first ended until it does", () => {
    const start = [
      assistant(1, null, [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Away", run_in_background: true } }]),
      task(2, { subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "bg", is_backgrounded: true }),
      task(4, { subtype: "task_updated", task_id: "k1", patch: { status: "completed" } }),
      task(5, { subtype: "task_notification", task_id: "k1", status: "completed", summary: "Done" }),
    ]
    // Ended at its first end (line 4), not the notification after it.
    assert.deepStrictEqual(call(convert(start), "bg").subagent, { status: "completed", background: true, ended_at: atOf(4), summary: "Done" })
    // Continued after it ended: running again, with no end.
    const again = convert([...start, task(6, { subtype: "task_updated", task_id: "k1", patch: { status: "running" } })])
    assert.deepStrictEqual(call(again, "bg").subagent, { status: "running", background: true })
  })

  it("what the history doesn't say", () => {
    const long = "x".repeat(RESULT_MAX_BYTES + 5)
    const c = convert(
      [
        // A result before its call, and a call with no result.
        results(1, null, [{ type: "tool_result", tool_use_id: "early", content: "first" }]),
        assistant(2, null, [
          { type: "tool_use", id: "early", name: "Read", input: {} },
          { type: "tool_use", id: "open", name: "Grep", input: { pattern: "x" } },
        ]),
        // A result for a call that has one.
        results(3, null, [{ type: "tool_result", tool_use_id: "early", content: "?" }]),
        // The same call id again, and a result cut short as it is read.
        assistant(4, null, [{ type: "tool_use", id: "early", name: "Read", input: {} }]),
        results(5, null, [{ type: "tool_result", tool_use_id: "early", content: long }]),
        // A parent that isn't in the thread (yet).
        assistant(6, "missing", [{ type: "text", text: "orphan" }]),
        task(7, { subtype: "task_updated", task_id: "never" }),
        task(8, { subtype: "hook_response" }),
        results(9, null, [{ type: "text", text: "[Request interrupted by user]" }]),
        results(10, null, [{ type: "text", text: "Who said this?" }]),
      ],
      { rebuilds: false },
    )
    const items = byId(c)
    assert.strictEqual(call(c, "early").result?.content, "first")
    assert.strictEqual(call(c, "open").status, "running")
    const second = call(c, "legacy:4:0")
    assert.deepStrictEqual([second.result?.truncated, second.result?.content], [true, truncate(long, RESULT_MAX_BYTES)])
    assert.isTrue(second.result?.content.endsWith("\n… [truncated 5 bytes]"))
    assert.strictEqual(items["legacy:6:0"]?.parent_id, "missing")
    const notice = items["legacy:9"]
    assert.strictEqual(notice?.type === "notice" ? notice.code : undefined, "interrupted")
    assert.deepStrictEqual(c.codes, ["unmatched_result", "duplicate_call", "unknown_task", "unplaced_text"])
    assert.deepStrictEqual(c.metas.get("legacy:4:0"), { call_id: "early", session: "s1" })
  })

  it("what waits for its call is lost by a rebuild in between", () => {
    // A result that came before its call is held in memory: rebuilt from the store in between, it never finds its call.
    const writes = [
      results(1, null, [{ type: "tool_result", tool_use_id: "early", content: "first" }]),
      assistant(2, null, [{ type: "tool_use", id: "early", name: "Read", input: {} }]),
    ]
    assert.strictEqual(call(run(writes), "early").result?.content, "first")
    assert.isUndefined(call(run(writes, 1), "early").result)
  })

  it("Codex's file changes are edits", () => {
    const input = {
      changes: [
        { path: "/a.rs", kind: "add", diff: "+x" },
        { path: "/b.rs", kind: "update", move_path: "/c.rs", diff: "@@" },
      ],
    }
    const c = convert([assistant(1, null, [{ type: "tool_use", id: "p", name: "ApplyPatch", input }])])
    assert.deepStrictEqual(call(c, "p").changes, [
      { path: "/a.rs", op: "add", diff: "+x" },
      { path: "/b.rs", op: "update", diff: "@@", move_to: "/c.rs" },
    ])
  })

  it("a prompt before a call with a reused id is for that call", () => {
    const c = convert(
      [
        assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } }]),
        results(2, null, [{ type: "tool_result", tool_use_id: "c", content: "a" }]),
        prompt({ id: "r1", tool_name: "Bash", input: { command: "rm x" }, tool_use_id: "c" }, { outcome: "deny" }),
        assistant(4, "ag", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "rm x" } }]),
        results(5, "ag", [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }]),
        // A prompt after both have their results can't be told apart.
        prompt({ id: "r2", tool_name: "Bash", input: {}, tool_use_id: "c" }, { outcome: "allow" }),
      ],
      { rebuilds: false },
    )
    const first = call(c, "c")
    const second = call(c, "legacy:4:0")
    assert.deepStrictEqual([first.status, first.result?.content], ["completed", "a"])
    assert.deepStrictEqual([second.status, second.result?.content], ["denied", "Denied"])
    const [r1, r2] = c.requests
    // Its parent is the second call's, which isn't in the thread.
    assert.deepStrictEqual([r1?.tool_call_id, r1?.parent_id], ["legacy:4:0", "ag"])
    assert.isUndefined(r2?.tool_call_id)
    assert.deepStrictEqual(c.codes, ["duplicate_call"])
  })

  it("a subagent's compaction and its summary stay in it", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "ag", name: "Agent", input: {} }]),
      task(2, { subtype: "compact_boundary", parent_tool_use_id: "ag", compact_metadata: { trigger: "auto" } }),
      assistant(3, null, [{ type: "text", text: "Meanwhile" }]),
      msg(4, { type: "user", isSynthetic: true, parent_tool_use_id: "ag", message: { content: "Child summary" } }),
      results(5, null, [{ type: "tool_result", tool_use_id: "ag", content: "done" }]),
    ])
    const compaction = byId(c)["legacy:2"]
    assert.deepStrictEqual(compaction?.type === "compaction" ? [compaction.parent_id, compaction.summary] : [], ["ag", "Child summary"])
    assert.deepStrictEqual(c.codes, [])
  })

  it("calls with one id in two subagents get their own results", () => {
    const c = convert([
      assistant(1, null, [
        { type: "tool_use", id: "a", name: "Agent", input: {} },
        { type: "tool_use", id: "b", name: "Agent", input: {} },
      ]),
      assistant(2, "a", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls a" } }]),
      assistant(3, "b", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls b" } }]),
      results(4, "a", [{ type: "tool_result", tool_use_id: "c", content: "out a" }]),
      results(5, "b", [{ type: "tool_result", tool_use_id: "c", content: "out b" }]),
    ])
    assert.deepStrictEqual([call(c, "c").parent_id, call(c, "c").result?.content], ["a", "out a"])
    assert.deepStrictEqual([call(c, "legacy:3:0").parent_id, call(c, "legacy:3:0").result?.content], ["b", "out b"])
  })

  it("a result two calls with its id wait for goes to neither", () => {
    const c = convert([
      assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "one" } }]),
      assistant(2, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "two" } }]),
      results(3, null, [{ type: "tool_result", tool_use_id: "c", content: "which?" }]),
    ])
    assert.deepStrictEqual([call(c, "c").status, call(c, "legacy:2:0").status], ["running", "running"])
    assert.isTrue(c.items.every((i) => i.type !== "tool_call" || i.result === undefined))
    assert.deepStrictEqual(c.made[2], [])
    assert.deepStrictEqual(c.codes, ["duplicate_call", "ambiguous_call"])
  })

  it("a prompt before a reused id whose first call never returned", () => {
    // Its input tells the calls apart.
    let c = convert([bash(1, "s1", "ls"), denied("rm x"), bash(3, "s2", "rm x"), bashDenied(4, "s2")], { rebuilds: false })
    assert.strictEqual(c.requests[0]?.tool_call_id, "legacy:3:0")
    assert.deepStrictEqual([call(c, "legacy:3:0").status, call(c, "c").status], ["denied", "running"])
    // The same input: the first call, waiting in the same session, asked; the result is the new session's call's.
    c = convert([bash(1, "s1", "rm x"), denied("rm x"), bash(3, "s2", "rm x"), bashDenied(4, "s2")])
    assert.strictEqual(c.requests[0]?.tool_call_id, "c")
    assert.deepStrictEqual([call(c, "legacy:3:0").status, call(c, "c").status], ["failed", "running"])
  })

  it("a subagent's compaction and summary before its call", () => {
    const c = convert(
      [
        task(1, { subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }),
        task(2, { subtype: "compact_boundary", parent_tool_use_id: "ag", compact_metadata: { trigger: "auto" } }),
        msg(3, { type: "user", isSynthetic: true, parent_tool_use_id: "ag", message: { content: "Child summary" } }),
        assistant(4, null, [{ type: "tool_use", id: "ag", name: "Agent", input: {} }]),
        results(5, null, [{ type: "tool_result", tool_use_id: "ag", content: "done" }]),
      ],
      { rebuilds: false },
    )
    const [main, child] = [byId(c)["legacy:1"], byId(c)["legacy:2"]]
    assert.deepStrictEqual(child?.type === "compaction" ? [child.parent_id, child.summary] : [], ["ag", "Child summary"])
    assert.isUndefined(main?.type === "compaction" ? main.summary : "not one")
    assert.deepStrictEqual(c.codes, [])
  })

  it("a result before its Agent call keeps what the board kept of it", () => {
    const agent = assistant(2, null, [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Away" } }])
    const meta = { agentId: "x", resolvedModel: "haiku", agentType: "Explore", totalToolUseCount: 3, isAsync: true, status: "async_launched" }
    const launched = (id: number) =>
      msg(id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Launched" }] }, tool_use_result: meta })
    const early = call(convert([launched(1), agent], { rebuilds: false }), "ag")
    const inOrder = call(convert([agent, launched(3)]), "ag")
    assert.deepStrictEqual(early.subagent, { status: "running", background: true, model: "haiku", agent_type: "Explore", tool_uses: 3 })
    assert.deepStrictEqual([early.status, early.subagent], [inOrder.status, inOrder.subagent])
  })

  it("a prompt before two calls with its id is for the one with its input", () => {
    const c = convert(
      [
        assistant(1, null, [
          { type: "tool_use", id: "a", name: "Agent", input: {} },
          { type: "tool_use", id: "b", name: "Agent", input: {} },
        ]),
        assistant(3, "a", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls a" } }]),
        prompt({ id: "r", tool_name: "Bash", input: { command: "ls b" }, tool_use_id: "c" }, { outcome: "deny" }),
        assistant(5, "b", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls b" } }]),
        results(6, "a", [{ type: "tool_result", tool_use_id: "c", content: "out a" }]),
        results(7, "b", [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }]),
        // Neither call has this input: no telling.
        prompt({ id: "r2", tool_name: "Bash", input: { command: "ls c" }, tool_use_id: "c" }, { outcome: "allow" }),
      ],
      { rebuilds: false },
    )
    const [r, r2] = c.requests
    assert.deepStrictEqual([r?.tool_call_id, r?.parent_id], ["legacy:5:0", "b"])
    assert.deepStrictEqual([call(c, "c").status, call(c, "legacy:5:0").status], ["completed", "denied"])
    assert.isUndefined(r2?.tool_call_id)
    assert.deepStrictEqual(c.codes, ["duplicate_call"])
  })

  it("a prompt matching no call with its reused id is for none", () => {
    const c = convert(
      [
        bash(1, "s1", "ls a"),
        msg(2, { type: "user", session_id: "s1", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "a" }] } }),
        prompt({ id: "r", tool_name: "Bash", input: { command: "rm c" }, tool_use_id: "c" }, { outcome: "deny" }),
        bash(4, "s2", "ls b"),
        bashDenied(5, "s2"),
      ],
      { rebuilds: false },
    )
    assert.isUndefined(c.requests[0]?.tool_call_id)
    assert.deepStrictEqual([call(c, "c").status, call(c, "legacy:4:0").status], ["completed", "failed"])
    assert.deepStrictEqual(c.codes, ["duplicate_call"])
    assert.strictEqual(c.state.session, "s2")
  })

  it("what a turn ended by saying, and what the board knows of items", () => {
    const c = convert([
      userMessage(1, "Go"),
      assistant(2, null, [{ type: "text", text: "Done." }]),
      result(3, { subtype: "success", result: "Done.", num_turns: 1 }),
      // A turn a background subagent's report started: its result is all it said.
      result(4, { subtype: "success", result: "The report is in.", num_turns: 1 }),
      result(5, { subtype: "error_during_execution", is_error: true, result: "Boom" }),
      assistant(6, null, [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "d" } }]),
      task(7, {
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "a1",
        task_type: "local_agent",
        session_id: "s1",
        description: "Look",
        prompt: "Look at it",
      }),
      userMessage(8, "Start working on this task."),
    ])
    assert.deepStrictEqual(
      c.items.map((i) => i.id),
      ["legacy:1", "legacy:2:0", "legacy:3", "legacy:4:result", "legacy:4", "legacy:5", "a1", "legacy:8"],
    )
    assert.deepStrictEqual(byId(c)["legacy:4:result"], {
      id: "legacy:4:result",
      type: "assistant_message",
      text: "The report is in.",
      created_at: atOf(4),
      metadata: { from_result: true },
    })
    const failed = byId(c)["legacy:5"]
    assert.strictEqual(failed?.type === "turn_result" ? failed.error : undefined, "Boom")
    assert.deepStrictEqual(call(c, "a1").metadata, { description: "Look", prompt: "Look at it" })
    assert.deepStrictEqual(Object.fromEntries(c.metas), {
      "legacy:3": { result_text: "Done." },
      "legacy:4:result": { from_result: true },
      "legacy:4": { result_text: "The report is in." },
      "legacy:5": { result_text: "Boom" },
      a1: { session: "s1", subagent_task: "t1" },
    })
  })

  it("a rebuild mid-turn knows what the turn said", () => {
    // Two text blocks of one message around a call: the result says both again, so it adds nothing.
    const c = convert([
      userMessage(1, "Go"),
      assistant(2, null, [
        { type: "text", text: "One" },
        { type: "tool_use", id: "x", name: "Read", input: {} },
        { type: "text", text: "Two" },
      ]),
      results(3, null, [{ type: "tool_result", tool_use_id: "x", content: "" }]),
      result(4, { subtype: "success", result: "One\nTwo", num_turns: 1 }),
    ])
    assert.isUndefined(byId(c)["legacy:4:result"])
  })

  it("an API error is a notice with a code, in its conversation", () => {
    const c = convert([
      msg(1, {
        type: "assistant",
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
        message: { content: [{ type: "text", text: "You've hit your limit" }] },
        is_api_error_message: true,
        error: "rate_limit",
        api_error: "usage_limit_reached",
        api_error_params: { rate_limit_info: { status: "rejected", resetsAt: 1 } },
      }),
    ])
    assert.deepStrictEqual(c.items, [
      { id: "legacy:1", type: "notice", level: "error", text: "You've hit your limit", code: "usage_limit_reached", created_at: atOf(1) },
    ])
    assert.deepStrictEqual(c.effects[0], [
      { _tag: "RateLimit", info: { rate_limit_info: { status: "rejected", resetsAt: 1 } } },
      { _tag: "TurnStarted", from: "assistant" },
      { _tag: "AgentAt", uuid: "u1" },
    ])
  })

  it("tool results as the old `slim` kept them: images as [image], each text part cut short, an Agent's meta only", () => {
    const big = "y".repeat(RESULT_MAX_BYTES + 1)
    const c = convert([
      assistant(1, null, [
        { type: "tool_use", id: "r", name: "Read", input: { file_path: "/p.png" } },
        { type: "tool_use", id: "b", name: "Bash", input: { command: "cat" } },
      ]),
      msg(2, {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "r",
              content: [
                { type: "image", source: {} },
                { type: "text", text: "a picture" },
              ],
            },
            { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: big }] },
          ],
        },
        // Not an Agent's: dropped, as it never named a status.
        tool_use_result: { status: "failed" },
      }),
    ])
    assert.deepStrictEqual(call(c, "r").result, { content: "[image]\na picture" })
    assert.deepStrictEqual(call(c, "b").result, { content: truncate(big, RESULT_MAX_BYTES), truncated: true })
    assert.strictEqual(call(c, "b").status, "completed")
  })
})

const effectsOf = (raw: unknown, turn?: TurnFacts) => run([msg(1, raw, turn)]).effects[0]
const stream = (event: unknown, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "s1" })
const resultLine = (fields: Readonly<Record<string, unknown>>) => {
  const decoded = decodeLine(jsonText({ type: "result", ...fields }))
  return Result.isSuccess(decoded) && decoded.success.type === "result" ? decoded.success : assert.fail("not a result line")
}

describe("what a line tells the run", () => {
  it("init: the session, and a turn starting", () => {
    assert.deepStrictEqual(effectsOf({ type: "system", subtype: "init", session_id: "s1", tools: ["Bash"] }), [
      { _tag: "SessionStarted", sessionId: "s1" },
      { _tag: "TurnStarted", from: "init" },
    ])
  })

  it("the stream: the reply being written, never stored, and only the main conversation's", () => {
    const c = run([
      msg(1, stream({ type: "message_start", message: {} })),
      msg(2, stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })),
      msg(3, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } })),
      msg(4, stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } })),
      msg(5, stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }, "ag")),
      msg(6, stream({ type: "message_stop" })),
    ])
    assert.deepStrictEqual(c.effects, [
      [{ _tag: "TurnStarted", from: "message_start" }, { _tag: "PreviewReset" }],
      [{ _tag: "PreviewReset" }],
      [{ _tag: "PreviewText", text: "Hel" }],
      [],
      [],
      [],
    ])
    assert.deepStrictEqual(c.items, [])
  })

  it("an echoed message: its uuid, and the background task it told of", () => {
    const echo = {
      type: "user",
      isReplay: true,
      uuid: "u9",
      parent_tool_use_id: null,
      origin: { kind: "task-notification" },
      message: { content: [{ type: "text", text: "<task-notification><task-id> b1 </task-id></task-notification>" }] },
    }
    assert.deepStrictEqual(effectsOf(echo), [{ _tag: "Echoed", uuid: "u9", taskNotification: "b1" }])
    assert.deepStrictEqual(run([msg(1, echo)]).items, [])
    assert.deepStrictEqual(effectsOf({ type: "user", isReplay: true, uuid: "u8", message: { content: "Go on" } }), [
      { _tag: "Echoed", uuid: "u8", taskNotification: null },
    ])
  })

  it("rate limits", () => {
    assert.deepStrictEqual(effectsOf({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), [
      { _tag: "RateLimit", info: { status: "allowed" } },
    ])
  })

  it("a result: how the turn ended", () => {
    const refused = { type: "result", subtype: "success", is_error: true, result: "You've hit your limit", api_error: "usage_limit_reached" }
    assert.deepStrictEqual(effectsOf(refused), [{ _tag: "TurnEnded", error: "You've hit your limit", interrupted: false, usageLimit: true }])
    assert.deepStrictEqual(effectsOf({ type: "result", subtype: "success", result: "ok" }), [
      { _tag: "TurnEnded", error: null, interrupted: false, usageLimit: false },
    ])
  })

  it("the run's result_error", () => {
    const error = (fields: Readonly<Record<string, unknown>>) => resultError(resultLine(fields))
    assert.strictEqual(error({ subtype: "success", result: "fine" }), null)
    assert.strictEqual(error({ subtype: "success", is_error: true, result: "Nope" }), "Nope")
    assert.strictEqual(error({ subtype: "error_during_execution", errors: ["a", 1, "b"] }), "a\nb")
    assert.strictEqual(error({ subtype: "error_max_turns" }), 'run ended with "error_max_turns"')
    const leftover = resultLine({ subtype: "success", num_turns: 0, origin: { kind: "task-notification" } })
    const own = resultLine({ subtype: "success", num_turns: 1, origin: { kind: "task-notification" } })
    const other = resultLine({ subtype: "success", num_turns: 1, user_message_uuids: ["x"] })
    const plain = resultLine({ subtype: "success", num_turns: 1 })
    // A leftover notification's result before the run's first ends no turn of the run's (HA-404).
    assert.isTrue(isForeignResult(leftover, { sawResult: false, awaiting: false }))
    assert.isFalse(isForeignResult(leftover, { sawResult: true, awaiting: false }))
    // Before Claude Code takes the prompt in, a turn it took on its own or on other messages isn't the run's (HA-405).
    assert.isTrue(isForeignResult(own, { sawResult: true, awaiting: true }))
    assert.isTrue(isForeignResult(other, { sawResult: true, awaiting: true }))
    assert.isFalse(isForeignResult(plain, { sawResult: false, awaiting: true }))
    assert.isFalse(isForeignResult(own, { sawResult: true, awaiting: false }))
  })
})
