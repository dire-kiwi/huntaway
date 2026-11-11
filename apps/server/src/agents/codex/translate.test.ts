import { assert, describe, it } from "@effect/vitest"
import { applyEvents, initialState, type Item, type NewEvent, type SavedEvent, type Snapshot, TaskId, type ThreadRequest, Timestamp } from "@huntaway/contracts"
import { HashMap, Result } from "effect"
import { requestForPrompt } from "../claude/requests.ts"
import { stateFromItems as claudeState } from "../claude/state.ts"
import type { CodexLine } from "./lines.ts"
import { decodeValue } from "./lines.ts"
import { type CodexEffect, type CodexState, emptyState, numbered, observe, stateFromItems, translate } from "./translate.ts"

// The Codex translator case by case (huntaway's agent/codex/driver.test.ts): a run's notifications made into a thread's
// items, with the board's own writes (the user's messages, its prompts) taken in as `Threads` and `Permissions` write
// them. What the old cases checked of the database and the run (the wait a subagent's end ends, a turn's end recorded
// when its items can't be written) is the line handler's (runs/codex/output.ts).

const thread = TaskId.make("thread")
const at = Timestamp.make("2026-11-06T00:00:00.000Z")

/** A task with a Codex run going, its session `main`: what a case feeds it, and what it made. */
class Harness {
  state: CodexState = emptyState
  snapshot: Snapshot = initialState({ id: thread, harness: "codex", status: "running", created_at: at })
  session: string | null = null
  writeNo = 0
  stopping = false
  readonly effects: Array<CodexEffect> = []

  constructor() {
    this.line({ method: "thread/started", params: { thread: { id: "main" } } })
  }

  private append(events: ReadonlyArray<NewEvent>): void {
    for (const e of events) this.snapshot = applyEvents(this.snapshot, [{ ...e, thread_id: thread, seq: this.snapshot.seq + 1 } satisfies SavedEvent])
  }

  board(events: ReadonlyArray<NewEvent>): void {
    this.append(events)
    this.state = observe(this.state, events)
  }

  line(v: unknown): void {
    const decoded = decodeValue(v)
    if (Result.isFailure(decoded)) assert.fail(`not a line: ${decoded.failure._tag}`)
    const line: CodexLine = decoded.success
    const t = translate(this.state, line, {
      session: this.session,
      compact: false,
      at,
      writeNo: numbered(line) ? ++this.writeNo : 0,
      stopping: this.stopping,
      sawResult: false,
    })
    this.state = t.state
    this.append(t.events)
    this.effects.push(...t.effects)
    for (const e of t.effects) if (e._tag === "SessionStarted") this.session = e.sessionId
  }

  event(method: string, threadId: string, extra: Readonly<Record<string, unknown>>): void {
    this.line({ method, params: { ...extra, threadId } })
  }

  item(threadId: string, item: Readonly<Record<string, unknown>>): void {
    this.event("item/started", threadId, { item })
    this.event("item/completed", threadId, { item })
  }

  user(text: string): void {
    this.board([{ type: "item.added", item: { id: `legacy:${++this.writeNo}`, type: "user_message", text, created_at: at } }])
  }

  /** The board's prompt for call `id` (as `Permissions` opens it), settled as `status` says. */
  ask(id: string, tool: string, input: unknown, status: "pending" | "allowed" | "denied"): void {
    const made = requestForPrompt(
      claudeState(this.snapshot.items, this.snapshot.requests, () => undefined),
      {
        id: `r-${id}`,
        tool_name: tool,
        input,
        tool_use_id: id,
        created_at: at,
      },
    )
    const request = made.request ?? assert.fail("no request")
    this.board([{ type: "request.opened", request }])
    if (status !== "pending") {
      this.board([{ type: "request.resolved", request_id: `r-${id}`, resolution: { outcome: status === "allowed" ? "allow" : "deny" } }])
    }
  }

  get items(): ReadonlyArray<Item> {
    return this.snapshot.items
  }

  get requests(): ReadonlyArray<ThreadRequest> {
    return this.snapshot.requests
  }
}

/** A notification, decoded. */
const lineOf = (v: unknown): CodexLine => {
  const decoded = decodeValue(v)
  return Result.isSuccess(decoded) ? decoded.success : assert.fail(`not a line: ${decoded.failure._tag}`)
}

const run = (feed: (h: Harness) => void): Harness => {
  const h = new Harness()
  feed(h)
  return h
}

const byId = (items: ReadonlyArray<Item>): Readonly<Record<string, Item>> => Object.fromEntries(items.map((i) => [i.id, i]))
const callOf = (items: Readonly<Record<string, Item>>, id: string) => {
  const found = items[id]
  return found?.type === "tool_call" ? found : assert.fail(`${id} is not a call`)
}

/** A run that a restart (`restart`) may cut in two, which reads a call's start again. */
const restarted = (f: Harness, restart: () => void) => {
  f.user("Go")
  f.event("item/started", "main", { item: { type: "commandExecution", id: "sh", command: "make", cwd: "/w" } })
  restart()
  // Read again (its offset wasn't saved): nothing more.
  f.event("item/started", "main", { item: { type: "commandExecution", id: "sh", command: "make", cwd: "/w" } })
  f.ask("sh", "Bash", { command: "make", cwd: "/w" }, "allowed")
  f.event("item/completed", "main", {
    item: { type: "commandExecution", id: "sh", command: "make", status: "completed", aggregatedOutput: "ok", exitCode: 0 },
  })
  f.item("main", { type: "agentMessage", id: "m", text: "Built." })
  f.event("item/completed", "main", { item: { type: "agentMessage", id: "m", text: "Built." } })
  f.event("turn/completed", "main", { turn: { id: "t1", status: "completed" } })
}

describe("the Codex translator", () => {
  it("each kind of item as the board shows it", () => {
    const h = run((f) => {
      f.user("Go")
      f.item("main", { type: "reasoning", id: "r", summary: ["Thinking it over"] })
      f.item("main", {
        type: "commandExecution",
        id: "sh",
        command: "/usr/bin/bash -lc 'ls'",
        cwd: "/w",
        status: "completed",
        aggregatedOutput: "a\n",
        exitCode: 0,
      })
      f.item("main", { type: "commandExecution", id: "bad", command: "false", status: "failed", aggregatedOutput: "", exitCode: 1 })
      f.item("main", {
        type: "fileChange",
        id: "fc",
        status: "completed",
        changes: [
          { path: "/w/a.rs", kind: { type: "add" }, diff: "+x" },
          { path: "/w/b.rs", kind: { type: "update", move_path: "/w/c.rs" }, diff: "@@" },
        ],
      })
      f.item("main", {
        type: "mcpToolCall",
        id: "mcp",
        server: "gh",
        tool: "pr_view",
        arguments: { pr: 1 },
        status: "completed",
        result: { content: [{ type: "text", text: "PR" }] },
      })
      f.item("main", {
        type: "dynamicToolCall",
        id: "dyn",
        tool: "lookup",
        arguments: {},
        status: "completed",
        contentItems: [{ type: "inputText", text: "found" }],
      })
      f.item("main", {
        type: "dynamicToolCall",
        id: "board",
        namespace: "huntaway",
        tool: "get_task",
        arguments: { task_id: "X-1" },
        status: "completed",
        contentItems: [],
      })
      f.item("main", { type: "webSearch", id: "web", query: "huntaway", results: [1, 2] })
      f.item("main", { type: "webSearch", id: "fetch", action: { url: "https://example.com" } })
      f.item("main", { type: "imageView", id: "img", path: "/w/a.png" })
      f.event("error", "main", { willRetry: true, error: { message: "overloaded" } })
      f.event("warning", "main", { message: "slow" })
      f.item("main", { type: "agentMessage", id: "msg", text: "Done." })
      f.item("main", { type: "contextCompaction", id: "squash" })
      f.event("turn/completed", "main", { turn: { id: "t1", status: "completed", durationMs: 1500 } })
    })
    const items = byId(h.items)
    // Shell commands' results have their exit codes.
    assert.deepStrictEqual(
      [callOf(items, "sh").result, callOf(items, "bad").result],
      [
        { content: "a\n", exit_code: 0 },
        { content: "(exit code 1)", exit_code: 1 },
      ],
    )
    assert.deepStrictEqual([callOf(items, "sh").name, callOf(items, "sh").command], ["Bash", "ls"])
    assert.deepStrictEqual(callOf(items, "fc").changes, [
      { path: "/w/a.rs", op: "add", diff: "+x" },
      { path: "/w/b.rs", op: "update", diff: "@@", move_to: "/w/c.rs" },
    ])
    // The board's tools, as its MCP server's.
    const board = callOf(items, "board")
    assert.deepStrictEqual([board.name, board.kind, board.server], ["get_task", "mcp", "huntaway"])
    const dyn = callOf(items, "dyn")
    assert.deepStrictEqual([dyn.name, dyn.kind, dyn.result?.content], ["lookup", "other", "found"])
    assert.deepStrictEqual([callOf(items, "mcp").server, callOf(items, "mcp").result?.content], ["gh", "PR"])
    assert.deepStrictEqual(
      [callOf(items, "web").query, callOf(items, "web").result?.content, callOf(items, "fetch").url],
      ["huntaway", "2 results", "https://example.com"],
    )
    assert.deepStrictEqual([callOf(items, "img").name, callOf(items, "img").path], ["Read", "/w/a.png"])
    // Codex's ids for its messages, reasoning and compactions.
    assert.deepStrictEqual([items["msg"]?.type, items["r"]?.type, items["squash"]?.type], ["assistant_message", "reasoning", "compaction"])
    const last = h.items.at(-1)
    assert.deepStrictEqual(last, {
      id: `legacy:${h.writeNo}`,
      type: "turn_result",
      ok: true,
      created_at: at,
      duration_ms: 1500,
      metadata: { subtype: "success", num_turns: 1, total_cost_usd: 0 },
    })
    // A retried error and a warning are the board's notices.
    assert.deepStrictEqual(
      h.effects.flatMap((e) => (e._tag === "Notice" ? [e.text] : [])),
      ["Codex: overloaded (retrying)", "Codex: slow"],
    )
    assert.deepStrictEqual(
      h.effects.filter((e) => e._tag === "Compacted" || e._tag === "TurnEnded"),
      [
        { _tag: "Compacted", trigger: "auto" },
        { _tag: "TurnEnded", error: null, interrupted: false, usageLimit: false },
      ],
    )
  })

  it("a plan is one call a turn, updated as it goes", () => {
    const h = run((f) => {
      f.event("turn/plan/updated", "main", {
        turnId: "t1",
        plan: [
          { step: "Read", status: "inProgress" },
          { step: "Write", status: "pending" },
        ],
      })
      f.event("turn/plan/updated", "main", {
        turnId: "t1",
        plan: [
          { step: "Read", status: "completed" },
          { step: "Write", status: "inProgress" },
        ],
      })
    })
    const plans = h.items.flatMap((i) => (i.type === "tool_call" && i.kind === "todo" ? [i] : []))
    assert.deepStrictEqual(
      plans.map((p) => [p.id, p.status, p.todos]),
      [
        [
          "plan-main-t1",
          "completed",
          [
            { text: "Read", status: "completed" },
            { text: "Write", status: "in_progress" },
          ],
        ],
      ],
    )
  })

  it("approvals are for their calls, and a declined call is denied", () => {
    const h = run((f) => {
      f.event("item/started", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", cwd: "/w" } })
      f.ask("rm", "Bash", { command: "rm -rf x", cwd: "/w", description: "Clean up" }, "denied")
      f.event("item/completed", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", status: "declined" } })
      const change = { type: "fileChange", id: "fc", changes: [{ path: "/w/a", kind: { type: "add" }, diff: "+" }] }
      f.event("item/started", "main", { item: change })
      f.ask("fc", "ApplyPatch", { changes: [{ path: "/w/a", kind: "add", move_path: null, diff: "+" }], reason: "Needed" }, "allowed")
      f.event("item/completed", "main", { item: { ...change, status: "completed" } })
      // Declined by Codex's own reviewer, with no prompt of the board's.
      f.item("main", { type: "commandExecution", id: "auto", command: "curl x", status: "declined" })
    })
    const r = Object.fromEntries(h.requests.map((x) => [x.id, x]))
    const rm = r["r-rm"]
    assert.deepStrictEqual([rm?.tool_call_id, rm?.type === "permission" ? rm.kind : null, rm?.resolution?.outcome], ["rm", "shell", "deny"])
    const fc = r["r-fc"]
    assert.deepStrictEqual([fc?.tool_call_id, fc?.type === "permission" ? fc.title : null], ["fc", "/w/a"])
    const items = byId(h.items)
    assert.deepStrictEqual([callOf(items, "rm").status, callOf(items, "fc").status, callOf(items, "auto").status], ["denied", "completed", "denied"])
    assert.deepStrictEqual(
      h.requests.map((x) => x.resolution?.outcome),
      ["deny", "allow"],
    )
  })

  it("subagents keep the main session's turn and stream separate", () => {
    const h = run((f) => {
      for (const t of [
        { id: "child", parentThreadId: "main", preview: "Inspect config", agentRole: "explorer" },
        { id: "nested", source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } }, preview: "Check env" },
      ]) {
        f.line({ method: "thread/started", params: { thread: t } })
      }
      f.item("main", {
        type: "collabAgentToolCall",
        id: "spawn",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "main",
        receiverThreadIds: ["child"],
        prompt: "Inspect config",
        model: "gpt-6.1-sol",
        agentsStates: { child: { status: "running" } },
      })
      f.event("turn/started", "child", { turn: { id: "child-turn" } })
      f.event("item/agentMessage/delta", "child", { delta: "Config" })
      f.item("child", { type: "agentMessage", id: "text", text: "Config report" })
      f.item("child", { type: "commandExecution", id: "bash", command: "ls", status: "completed", aggregatedOutput: "config.rs" })
      f.item("nested", { type: "reasoning", id: "think", summary: ["Check environment"] })
      f.event("turn/completed", "child", { turn: { id: "child-turn", status: "completed" } })
    })
    const items = byId(h.items)
    const child = callOf(items, "codex-agent-child")
    assert.deepStrictEqual([child.name, child.kind, child.title, child.status], ["Agent", "subagent", "Inspect config", "completed"])
    const { ended_at, ...s } = child.subagent ?? assert.fail("no subagent")
    assert.strictEqual(ended_at, at)
    assert.deepStrictEqual(s, { status: "completed", background: true, agent_type: "explorer", model: "gpt-6.1-sol" })
    assert.deepStrictEqual(
      [items["codex-agent-nested"]?.parent_id, items["bash"]?.parent_id, items["text"]?.parent_id, items["think"]?.parent_id],
      ["codex-agent-child", "codex-agent-child", "codex-agent-child", "codex-agent-nested"],
    )
    // The child's turn and stream are not the run's.
    assert.deepStrictEqual(
      h.effects.filter((e) => e._tag === "TurnStarted" || e._tag === "TurnEnded" || e._tag === "PreviewText" || e._tag === "SessionStarted"),
      [{ _tag: "SessionStarted", sessionId: "main" }],
    )
    assert.deepStrictEqual(
      h.effects.filter((e) => e._tag === "SubagentEnded"),
      [{ _tag: "SubagentEnded", id: "codex-agent-child", status: "completed", summary: null }],
    )
  })

  it("collab actions, hosted activity and failures", () => {
    const collab = run((f) => {
      const steps: ReadonlyArray<readonly [number, string, string]> = [
        [1, "spawnAgent", "running"],
        [2, "wait", "completed"],
        [3, "followupTask", "running"],
        [4, "sendMessage", "running"],
        [5, "wait", "errored"],
        [6, "resumeAgent", "running"],
        [7, "closeAgent", "shutdown"],
      ]
      for (const [n, tool, status] of steps) {
        f.item("main", {
          type: "collabAgentToolCall",
          id: `call${n}`,
          tool,
          status: "completed",
          senderThreadId: "main",
          receiverThreadIds: ["child"],
          prompt: "Inspect config",
          model: "gpt-6.1-sol",
          agentsStates: { child: { status, message: "Child report" } },
        })
      }
    })
    const { ended_at: _e, ...s } = callOf(byId(collab.items), "codex-agent-child").subagent ?? assert.fail("no subagent")
    assert.deepStrictEqual(s, { status: "stopped", background: true, model: "gpt-6.1-sol", summary: "Child report" })

    const hosted = run((f) => {
      f.item("main", { type: "subAgentActivity", id: "hosted1", kind: "started", agentThreadId: "hosted", model: "gpt-6.1-sol" })
      f.line({ method: "thread/started", params: { thread: { id: "hosted", parentThreadId: "main", preview: "Find tests" } } })
      f.item("hosted", { type: "subAgentActivity", id: "hosted2", kind: "started", agentThreadId: "nested" })
      f.item("main", { type: "subAgentActivity", id: "hosted3", kind: "completed", agentThreadId: "hosted" })
      f.item("hosted", { type: "subAgentActivity", id: "hosted4", kind: "interrupted", agentThreadId: "nested" })
    })
    const hs = byId(hosted.items)
    assert.deepStrictEqual(
      [
        callOf(hs, "codex-agent-hosted").subagent?.status,
        callOf(hs, "codex-agent-hosted").metadata,
        callOf(hs, "codex-agent-nested").subagent?.status,
        hs["codex-agent-nested"]?.parent_id,
      ],
      ["completed", { description: "Find tests", prompt: "Find tests" }, "stopped", "codex-agent-hosted"],
    )

    const failed = run((f) => {
      f.item("main", {
        type: "collabAgentToolCall",
        id: "bad-spawn",
        tool: "spawnAgent",
        status: "failed",
        receiverThreadIds: [],
        agentsStates: { missing: { status: "notFound" } },
      })
      f.line({ method: "thread/started", params: { thread: { id: "review", source: { subAgent: "review" } } } })
      f.event("turn/completed", "child", { turn: { id: "child-turn", status: "failed", error: { message: "Child failed" } } })
      f.event("turn/completed", "main", { turn: { id: "main-turn", status: "completed" } })
    })
    // A failed spawn is a call of its own, and no subagent; a review's thread and a child's failed turn make nothing.
    assert.deepStrictEqual(
      failed.items.map((i) => [
        i.type,
        i.type === "tool_call" ? i.name : undefined,
        i.type === "tool_call" ? i.status : i.type === "turn_result" ? i.ok : undefined,
      ]),
      [
        ["tool_call", "spawnAgent", "failed"],
        ["turn_result", undefined, true],
      ],
    )
    // Nor is the review's thread taken for a new session.
    assert.strictEqual(failed.session, "main")
  })

  it("a long result is cut short", () => {
    const out = `${"x".repeat(40_000)}\n`
    const h = run((f) => f.item("main", { type: "commandExecution", id: "big", command: "cat big", status: "completed", aggregatedOutput: out, exitCode: 0 }))
    const big = callOf(byId(h.items), "big")
    assert.strictEqual(big.result?.truncated, true)
    assert.match(big.result?.content ?? "", /\n… \[truncated \d+ bytes\]$/)
    assert.strictEqual(big.result?.exit_code, 0)
  })

  it("a restarted server and a notification read again go on from the store", () => {
    const a = run((f) => restarted(f, () => {}))
    const b = run((f) =>
      restarted(f, () => {
        // What the server had in memory is gone.
        f.state = stateFromItems(f.items)
      }),
    )
    assert.deepStrictEqual(b.items, a.items)
    assert.deepStrictEqual(
      b.items.map((i) => i.type),
      ["user_message", "tool_call", "assistant_message", "turn_result"],
    )
    // The prompt found its call, though the state was rebuilt from the store in between.
    assert.strictEqual(b.requests[0]?.tool_call_id, "sh")
  })

  it("a subagent's prompt is for its call and names its subagent", () => {
    const h = run((f) => {
      f.line({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "main", preview: "Look" } } })
      f.event("item/started", "child", { item: { type: "commandExecution", id: "c1", command: "ls", cwd: "/w" } })
      f.ask("c1", "Bash", { command: "ls", cwd: "/w" }, "pending")
    })
    const r = h.requests[0]
    assert.deepStrictEqual([r?.tool_call_id, r?.parent_id], ["c1", "codex-agent-child"])
  })

  it("a subagent that ends says so, for the wait on it", () => {
    const h = run((f) => {
      f.line({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "main", preview: "Look" } } })
      f.event("turn/completed", "child", { turn: { id: "ct", status: "failed", error: { message: "It broke" } } })
    })
    assert.deepStrictEqual(
      h.effects.filter((e) => e._tag === "SubagentEnded"),
      [{ _tag: "SubagentEnded", id: "codex-agent-child", status: "failed", summary: "It broke" }],
    )
  })

  it("is pure, and reads the thread through its state", () => {
    const ctx = { session: "main", compact: false, at, writeNo: 7, stopping: false, sawResult: false }
    const started = translate(
      emptyState,
      lineOf({ method: "item/started", params: { threadId: "main", item: { type: "commandExecution", id: "sh", command: "ls", cwd: "/w" } } }),
      ctx,
    )
    assert.deepStrictEqual(
      started.events.map((e) => e.type),
      ["item.added"],
    )
    assert.deepStrictEqual(started.effects, [{ _tag: "Working" }])
    // Started again: it's there.
    assert.deepStrictEqual(
      translate(
        started.state,
        lineOf({ method: "item/started", params: { threadId: "main", item: { type: "commandExecution", id: "sh", command: "ls" } } }),
        ctx,
      ).events,
      [],
    )
    // The turn's end cancels what its interruption left running, then says how the turn went; stopped, it was interrupted.
    const ended = translate(started.state, lineOf({ method: "turn/completed", params: { threadId: "main", turn: { id: "t", status: "interrupted" } } }), {
      ...ctx,
      stopping: true,
    })
    assert.deepStrictEqual(ended.events, [
      { type: "item.updated", item_id: "sh", patch: { status: "cancelled" } },
      {
        type: "item.added",
        item: {
          id: "legacy:7",
          type: "turn_result",
          ok: false,
          created_at: at,
          interrupted: true,
          error: "The turn was interrupted",
          metadata: { subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0 },
        },
      },
    ])
    assert.deepStrictEqual([...ended.metas], [["legacy:7", { result_text: "The turn was interrupted" }]])
    assert.deepStrictEqual(ended.effects, [{ _tag: "TurnEnded", error: "The turn was interrupted", interrupted: true, usageLimit: false }])
    // The state it was given is as it was.
    assert.strictEqual(HashMap.size(started.state.calls), 1)
    // A child's notification is its subagent's.
    const child = translate(
      emptyState,
      lineOf({ method: "item/completed", params: { threadId: "kid", item: { type: "agentMessage", id: "m", text: "hi" } } }),
      ctx,
    )
    const added = child.events[0]
    assert.strictEqual(added?.type === "item.added" ? added.item.parent_id : null, "codex-agent-kid")
  })

  it("a turn refused for the usage limit, and a compaction's two ends", () => {
    const ctx = { session: "main", compact: false, at, writeNo: 1, stopping: false, sawResult: false }
    const limited = lineOf({
      method: "turn/completed",
      params: {
        threadId: "main",
        turn: { id: "t", status: "failed", error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" } },
      },
    })
    assert.deepStrictEqual(translate(emptyState, limited, ctx).effects, [
      { _tag: "TurnEnded", error: "You've hit your usage limit", interrupted: false, usageLimit: true },
    ])
    const compacted = lineOf({ method: "thread/compacted", params: { threadId: "main" } })
    const first = translate(emptyState, compacted, { ...ctx, compact: true })
    assert.deepStrictEqual(first.effects, [{ _tag: "TurnEnded", error: null, interrupted: false, usageLimit: false }])
    assert.deepStrictEqual([...first.metas], [["legacy:1", { compact: true }]])
    // Reported again (turn/completed came first): not another end.
    assert.deepStrictEqual(translate(emptyState, compacted, { ...ctx, compact: true, sawResult: true }).events, [])
    // Outside a compaction it is no turn's end.
    assert.deepStrictEqual(translate(emptyState, compacted, ctx).effects, [])
  })

  it("what a line tells the run beside its items", () => {
    const h = run((f) => {
      f.event("turn/started", "main", { turn: { id: "t1" } })
      f.event("item/started", "main", { item: { type: "agentMessage", id: "m" } })
      f.event("item/agentMessage/delta", "main", { delta: "Hel" })
      f.event("item/started", "main", { item: { type: "dynamicToolCall", id: "w", namespace: "huntaway", tool: "wait", arguments: {} } })
      f.event("item/started", "main", { item: { type: "mcpToolCall", id: "x", server: "gh", tool: "pr_view", arguments: {} } })
      f.event("account/rateLimits/updated", "main", { rateLimits: { primary: { usedPercent: 1 } } })
      f.event("thread/tokenUsage/updated", "main", { tokenUsage: { total: {} } })
      f.event("mcpServer/startupStatus/updated", "main", { name: "gh", status: "failed", error: "no gh" })
      f.line({ method: "huntaway/boardTools", params: { dynamic: false } })
      f.line({ type: "user", isReplay: true, uuid: "u1", message: { role: "user", content: "more" } })
    })
    assert.deepStrictEqual(h.effects.slice(1), [
      { _tag: "TurnStarted", turnId: "t1" },
      { _tag: "PreviewReset" },
      { _tag: "PreviewReset" },
      { _tag: "PreviewText", text: "Hel" },
      // The board's wait is no sign of work; another call is.
      { _tag: "Working" },
      { _tag: "RateLimits", rateLimits: { primary: { usedPercent: 1 } } },
      { _tag: "TokenUsage", params: { tokenUsage: { total: {} }, threadId: "main" } },
      { _tag: "Notice", text: "MCP server gh failed to start", detail: "no gh" },
      { _tag: "BoardToolsRefused" },
      { _tag: "Echoed", uuid: "u1" },
    ])
  })
})
