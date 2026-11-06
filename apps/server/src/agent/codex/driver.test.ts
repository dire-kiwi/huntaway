// The Codex driver (driver.ts): a run's notifications written straight into a task's items, compared with what the
// messages path (output.ts's messages shaped like Claude Code's, translated) makes of the same run, case by case: every
// difference is named here, and in docs/threads.md ("Codex writes items directly").
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../../db.ts";
import type { Run } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import type { Item, ThreadRequest } from "../../threads/protocol.ts";
import * as history from "../../threads/history.ts";
import * as source from "../../threads/source.ts";
import * as store from "../../threads/store.ts";
import * as write from "../../threads/write.ts";
import { handle_line } from "./output.ts";
import { map, type View } from "./driver.ts";

/** A task with a Codex run going, its thread on `on`, and its session `main`. */
function running(on: "items" | "messages"): [Shared, Run] {
  const state = testing.on_items(testing.state(), on === "items");
  db.set_setting(state.db(), write.SETTING, "true");
  const profile = db.insert_profile(state.db(), "p", [], null);
  const task = db.insert_task(state.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "scratch",
    title: "Codex",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  if (on === "items") source.flip(state.db(), task.id);
  const run = db.insert_run(state.db(), task.id, "prompt");
  handle_line(state, run, { method: "thread/started", params: { thread: { id: "main" } } });
  return [state, run];
}

/** What a case does: notifications, the board's messages and its prompts, in order. */
interface Feed {
  line(v: any): void;
  event(method: string, thread: string, extra: any): void;
  item(thread: string, it: any): void;
  user(text: string): void;
  ask(id: string, tool: string, input: any, status: string): void;
}

function feed(state: Shared, run: Run): Feed {
  const r = () => db.get_run(state.db(), run.id)!;
  const f: Feed = {
    line: (v) => handle_line(state, r(), v),
    event: (method, thread, extra) => f.line({ method, params: { ...extra, threadId: thread } }),
    item: (thread, it) => {
      f.event("item/started", thread, { item: it });
      f.event("item/completed", thread, { item: it });
    },
    user: (text) => void state.add_message(run.task_id, "user", { text }),
    ask: (id, tool, input, status) =>
      void state.add_message(run.task_id, "permission", { tool_name: tool, input, tool_use_id: id, request_id: `r-${id}`, status, agent: "codex" }),
  };
  return f;
}

interface Both {
  native: { items: Item[]; requests: ThreadRequest[]; state: Shared; run: Run };
  legacy: { items: Item[]; requests: ThreadRequest[] };
  differences: string[];
}

/** An item in detail: all of it but its id (not a tool call's: those are Codex's either way) and times. */
function detail(i: any): any {
  const { created_at: _c, ...out } = i;
  if (out.type !== "tool_call") delete out.id;
  if (out.subagent?.ended_at) out.subagent = { ...out.subagent, ended_at: "(when)" };
  return out;
}

/** Case `run` on both paths, and how the driver's items differ from the messages path's (beyond ids and times). */
function both(run_case: (f: Feed) => void): Both {
  const [ns, nr] = running("items");
  run_case(feed(ns, nr));
  const [ls, lr] = running("messages");
  run_case(feed(ls, lr));
  assert.equal(source.of(ns.db(), nr.task_id), "items");
  assert.equal(source.of(ls.db(), lr.task_id), "messages");
  const native = { items: store.items(ns.db(), nr.task_id), requests: store.requests(ns.db(), nr.task_id), state: ns, run: nr };
  const legacy = { items: store.items(ls.db(), lr.task_id), requests: store.requests(ls.db(), lr.task_id) };
  const differences: string[] = [];
  const [a, b] = [native.items.map(detail), legacy.items.map(detail)];
  for (let n = 0; n < Math.max(a.length, b.length); n++) {
    if (JSON.stringify(a[n]) !== JSON.stringify(b[n])) differences.push(`${n}: native ${JSON.stringify(a[n])}, messages ${JSON.stringify(b[n])}`);
  }
  return { native, legacy, differences };
}

const by_id = (items: Item[]): Record<string, any> => Object.fromEntries(items.map((i) => [i.id, i]));

test("each_kind_of_item_as_the_messages_path_makes_it", () => {
  const { native, differences } = both((f) => {
    f.user("Go");
    f.item("main", { type: "reasoning", id: "r", summary: ["Thinking it over"] });
    f.item("main", {
      type: "commandExecution",
      id: "sh",
      command: "/usr/bin/bash -lc 'ls'",
      cwd: "/w",
      status: "completed",
      aggregatedOutput: "a\n",
      exitCode: 0,
    });
    f.item("main", { type: "commandExecution", id: "bad", command: "false", status: "failed", aggregatedOutput: "", exitCode: 1 });
    f.item("main", {
      type: "fileChange",
      id: "fc",
      status: "completed",
      changes: [
        { path: "/w/a.rs", kind: { type: "add" }, diff: "+x" },
        { path: "/w/b.rs", kind: { type: "update", move_path: "/w/c.rs" }, diff: "@@" },
      ],
    });
    f.item("main", {
      type: "mcpToolCall",
      id: "mcp",
      server: "gh",
      tool: "pr_view",
      arguments: { pr: 1 },
      status: "completed",
      result: { content: [{ type: "text", text: "PR" }] },
    });
    f.item("main", {
      type: "dynamicToolCall",
      id: "dyn",
      tool: "lookup",
      arguments: {},
      status: "completed",
      contentItems: [{ type: "inputText", text: "found" }],
    });
    f.item("main", {
      type: "dynamicToolCall",
      id: "board",
      namespace: "huntaway",
      tool: "get_task",
      arguments: { task_id: "X-1" },
      status: "completed",
      contentItems: [],
    });
    f.item("main", { type: "webSearch", id: "web", query: "huntaway", results: [1, 2] });
    f.item("main", { type: "webSearch", id: "fetch", action: { url: "https://example.com" } });
    f.item("main", { type: "imageView", id: "img", path: "/w/a.png" });
    f.event("error", "main", { willRetry: true, error: { message: "overloaded" } });
    f.event("warning", "main", { message: "slow" });
    f.item("main", { type: "agentMessage", id: "msg", text: "Done." });
    f.item("main", { type: "contextCompaction", id: "squash" });
    f.event("turn/completed", "main", { turn: { id: "t1", status: "completed", durationMs: 1500 } });
  });
  // Shell commands' results have their exit codes; nothing else differs.
  assert.deepEqual(differences.length, 2);
  for (const d of differences) assert.match(d, /"exit_code":[01]/);
  const items = by_id(native.items);
  assert.deepEqual(
    [items.sh.result, items.bad.result],
    [
      { content: "a\n", exit_code: 0 },
      { content: "(exit code 1)", exit_code: 1 },
    ],
  );
  // The board's tools, as its MCP server's.
  assert.deepEqual([items.board.name, items.board.kind, items.board.server], ["get_task", "mcp", "huntaway"]);
  assert.deepEqual([items.dyn.name, items.dyn.kind], ["lookup", "other"]);
  // Codex's ids for its messages, reasoning and compactions.
  assert.deepEqual([items.msg.type, items.r.type, items.squash.type], ["assistant_message", "reasoning", "compaction"]);
  assert.equal(native.items.at(-1)!.type, "turn_result");
});

test("a_plan_is_one_call_a_turn_updated_as_it_goes", () => {
  const { native, differences } = both((f) => {
    f.event("turn/plan/updated", "main", {
      turnId: "t1",
      plan: [
        { step: "Read", status: "inProgress" },
        { step: "Write", status: "pending" },
      ],
    });
    f.event("turn/plan/updated", "main", {
      turnId: "t1",
      plan: [
        { step: "Read", status: "completed" },
        { step: "Write", status: "inProgress" },
      ],
    });
  });
  const plans = native.items.filter((i: any) => i.kind === "todo") as any[];
  assert.deepEqual(
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
  );
  // The messages path made a call of each update.
  assert.equal(differences.length, 2);
  assert.match(differences[1], /^1: native undefined, messages .*"TodoWrite"/);
});

test("approvals_are_for_their_calls_and_a_declined_call_is_denied", () => {
  const { native, legacy, differences } = both((f) => {
    f.event("item/started", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", cwd: "/w" } });
    f.ask("rm", "Bash", { command: "rm -rf x", cwd: "/w", description: "Clean up" }, "denied");
    f.event("item/completed", "main", { item: { type: "commandExecution", id: "rm", command: "rm -rf x", status: "declined" } });
    const change = { type: "fileChange", id: "fc", changes: [{ path: "/w/a", kind: { type: "add" }, diff: "+" }] };
    f.event("item/started", "main", { item: change });
    f.ask("fc", "ApplyPatch", { changes: [{ path: "/w/a", kind: "add", move_path: null, diff: "+" }], reason: "Needed" }, "allowed");
    f.event("item/completed", "main", { item: { ...change, status: "completed" } });
    // Declined by Codex's own reviewer, with no prompt of the board's.
    f.item("main", { type: "commandExecution", id: "auto", command: "curl x", status: "declined" });
  });
  const r = Object.fromEntries(native.requests.map((x) => [x.id, x as any]));
  assert.deepEqual([r["r-rm"].tool_call_id, r["r-rm"].kind, r["r-rm"].resolution.outcome], ["rm", "shell", "deny"]);
  assert.deepEqual([r["r-fc"].tool_call_id, r["r-fc"].title], ["fc", "/w/a"]);
  const items = by_id(native.items);
  assert.deepEqual([items.rm.status, items.fc.status, items.auto.status], ["denied", "completed", "denied"]);
  // The messages path took a declined call the board hadn't asked about as failed.
  assert.equal(differences.length, 1);
  assert.match(differences[0], /"id":"auto".*"status":"denied".*messages .*"status":"failed"/);
  assert.deepEqual(
    native.requests.map((x: any) => x.resolution),
    legacy.requests.map((x: any) => x.resolution),
  );
});

test("subagents_keep_the_main_session_turn_and_stream_separate", () => {
  const { native, differences } = both((f) => {
    for (const thread of [
      { id: "child", parentThreadId: "main", preview: "Inspect config", agentRole: "explorer" },
      { id: "nested", source: { subAgent: { thread_spawn: { parent_thread_id: "child" } } }, preview: "Check env" },
    ]) {
      f.line({ method: "thread/started", params: { thread } });
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
    });
    f.event("turn/started", "child", { turn: { id: "child-turn" } });
    f.item("child", { type: "agentMessage", id: "text", text: "Config report" });
    f.item("child", { type: "commandExecution", id: "bash", command: "ls", status: "completed", aggregatedOutput: "config.rs" });
    f.item("nested", { type: "reasoning", id: "think", summary: ["Check environment"] });
    f.event("turn/completed", "child", { turn: { id: "child-turn", status: "completed" } });
  });
  assert.deepEqual(differences, []);
  const items = by_id(native.items);
  const child = items["codex-agent-child"];
  assert.deepEqual([child.name, child.kind, child.title, child.status], ["Agent", "subagent", "Inspect config", "completed"]);
  const { ended_at, ...s } = child.subagent;
  assert.equal(typeof ended_at, "string");
  assert.deepEqual(s, { status: "completed", background: true, agent_type: "explorer", model: "gpt-6.1-sol" });
  assert.deepEqual(
    [items["codex-agent-nested"].parent_id, items.bash.parent_id, items.text.parent_id, items.think.parent_id],
    ["codex-agent-child", "codex-agent-child", "codex-agent-child", "codex-agent-nested"],
  );
});

test("collab_actions_hosted_activity_and_failures_as_the_messages_path_has_them", () => {
  const collab = both((f) => {
    const steps: Array<[number, string, string]> = [
      [1, "spawnAgent", "running"],
      [2, "wait", "completed"],
      [3, "followupTask", "running"],
      [4, "sendMessage", "running"],
      [5, "wait", "errored"],
      [6, "resumeAgent", "running"],
      [7, "closeAgent", "shutdown"],
    ];
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
      });
    }
  });
  assert.deepEqual(collab.differences, []);
  const { ended_at: _e, ...s } = by_id(collab.native.items)["codex-agent-child"].subagent;
  assert.deepEqual(s, { status: "stopped", background: true, model: "gpt-6.1-sol", summary: "Child report" });

  const hosted = both((f) => {
    f.item("main", { type: "subAgentActivity", id: "hosted1", kind: "started", agentThreadId: "hosted", model: "gpt-6.1-sol" });
    f.line({ method: "thread/started", params: { thread: { id: "hosted", parentThreadId: "main", preview: "Find tests" } } });
    f.item("hosted", { type: "subAgentActivity", id: "hosted2", kind: "started", agentThreadId: "nested" });
    f.item("main", { type: "subAgentActivity", id: "hosted3", kind: "completed", agentThreadId: "hosted" });
    f.item("hosted", { type: "subAgentActivity", id: "hosted4", kind: "interrupted", agentThreadId: "nested" });
  });
  assert.deepEqual(hosted.differences, []);

  const failed = both((f) => {
    f.item("main", {
      type: "collabAgentToolCall",
      id: "bad-spawn",
      tool: "spawnAgent",
      status: "failed",
      receiverThreadIds: [],
      agentsStates: { missing: { status: "notFound" } },
    });
    f.line({ method: "thread/started", params: { thread: { id: "review", source: { subAgent: "review" } } } });
    f.event("turn/completed", "child", { turn: { id: "child-turn", status: "failed", error: { message: "Child failed" } } });
    f.event("turn/completed", "main", { turn: { id: "main-turn", status: "completed" } });
  });
  assert.deepEqual(failed.differences, []);
});

test("a_long_result_is_cut_short_as_the_messages_path_stores_it", () => {
  const out = `${"x".repeat(40_000)}\n`;
  const { native, differences } = both((f) =>
    f.item("main", { type: "commandExecution", id: "big", command: "cat big", status: "completed", aggregatedOutput: out, exitCode: 0 }),
  );
  const big = by_id(native.items).big;
  assert.equal(big.result.truncated, true);
  assert.match(big.result.content, /\n… \[truncated \d+ bytes\]$/);
  assert.deepEqual(differences.length, 1);
  assert.match(differences[0], /"exit_code":0/);
});

test("a_restarted_server_and_a_notification_read_again_go_on_from_the_store", () => {
  const case_ = (f: Feed, restart: () => void) => {
    f.user("Go");
    f.event("item/started", "main", { item: { type: "commandExecution", id: "sh", command: "make", cwd: "/w" } });
    restart();
    // Read again (its offset wasn't saved): nothing more.
    f.event("item/started", "main", { item: { type: "commandExecution", id: "sh", command: "make", cwd: "/w" } });
    f.ask("sh", "Bash", { command: "make", cwd: "/w" }, "allowed");
    f.event("item/completed", "main", {
      item: { type: "commandExecution", id: "sh", command: "make", status: "completed", aggregatedOutput: "ok", exitCode: 0 },
    });
    f.item("main", { type: "agentMessage", id: "m", text: "Built." });
    f.event("item/completed", "main", { item: { type: "agentMessage", id: "m", text: "Built." } });
    f.event("turn/completed", "main", { turn: { id: "t1", status: "completed" } });
  };
  const [a, ar] = running("items");
  case_(feed(a, ar), () => {});
  const [b, br] = running("items");
  // What the server had in memory (its translators) is gone.
  case_(feed(b, br), () => write.forget(b.db(), br.task_id));
  const strip = (items: Item[]) => items.map(detail);
  assert.deepEqual(strip(store.items(b.db(), br.task_id)), strip(store.items(a.db(), ar.task_id)));
  const items = store.items(b.db(), br.task_id);
  assert.deepEqual(
    items.map((i) => i.type),
    ["user_message", "tool_call", "assistant_message", "turn_result"],
  );
  // The prompt found its call, though the translator was rebuilt from the store in between.
  assert.equal(store.requests(b.db(), br.task_id)[0].tool_call_id, "sh");
  // The readers read the driver's items.
  assert.equal(history.last_assistant_text(b.db(), br.task_id), "Built.");
  // Every write has an origin, in order with the board's messages.
  const origins = items.map((i) => store.item_origins(b.db(), br.task_id, i.id)[0]);
  assert.deepEqual(
    [...origins].sort((x, y) => x - y),
    origins,
  );
});

test("a_subagents_prompt_is_for_its_call_and_names_its_subagent", () => {
  const { native } = both((f) => {
    f.line({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "main", preview: "Look" } } });
    f.event("item/started", "child", { item: { type: "commandExecution", id: "c1", command: "ls", cwd: "/w" } });
    f.ask("c1", "Bash", { command: "ls", cwd: "/w" }, "pending");
  });
  const r = native.requests[0] as any;
  assert.deepEqual([r.tool_call_id, r.parent_id], ["c1", "codex-agent-child"]);
});

test("a_subagent_that_ends_ends_the_wait_for_it", () => {
  const [state, run] = running("items");
  const f = feed(state, run);
  f.line({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "main", preview: "Look" } } });
  // The agent is waiting (the board's wait tool).
  const wait = { call_id: "w1", run_id: run.id, since: "2026-11-06T00:00:00Z", until: "2099-01-01T00:00:00Z", reason: null, tasks: [] };
  state.update_task(run.task_id, [["agent_wait", wait]]);
  f.event("turn/completed", "child", { turn: { id: "ct", status: "failed", error: { message: "It broke" } } });
  const w = db.get_task(state.db(), run.task_id)!.agent_wait!;
  assert.deepEqual(w.subagent_finished, { status: "failed", summary: "It broke", task_id: null, tool_use_id: "codex-agent-child" });
});

test("map_is_pure_and_reads_the_thread_through_its_view", () => {
  const items = new Map<string, Item>();
  const view: View = { item: (id) => items.get(id), open_calls: () => ["sh"] };
  const ctx = { session: "main", compact: false, at: "2026-11-06T00:00:00Z" };
  const started = map(view, ctx, {
    method: "item/started",
    params: { threadId: "main", item: { type: "commandExecution", id: "sh", command: "ls", cwd: "/w" } },
  });
  assert.deepEqual(
    started.events.map((e) => e.type),
    ["item.added"],
  );
  items.set("sh", (started.events[0] as any).item);
  // Started again: it's there.
  assert.deepEqual(
    map(view, ctx, { method: "item/started", params: { threadId: "main", item: { type: "commandExecution", id: "sh", command: "ls" } } }).events,
    [],
  );
  // The turn's end cancels what its interruption left running.
  assert.deepEqual(map(view, ctx, { method: "turn/completed", params: { threadId: "main", turn: { id: "t", status: "interrupted" } } }).events, [
    { type: "item.updated", item_id: "sh", patch: { status: "cancelled" } },
  ]);
  // A child's notification is its subagent's.
  const child = map(view, ctx, { method: "item/completed", params: { threadId: "kid", item: { type: "agentMessage", id: "m", text: "hi" } } });
  assert.equal((child.events[0] as any).item.parent_id, "codex-agent-kid");
});

test("a_failed_write_at_a_turns_end_still_records_the_runs_result", () => {
  const [state, run] = running("items");
  const f = feed(state, run);
  f.line({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "main", preview: "Look" } } });
  f.event("item/started", "main", { item: { type: "commandExecution", id: "sh", command: "make", cwd: "/w" } });
  const wait = { call_id: "w1", run_id: run.id, since: "2026-11-06T00:00:00Z", until: "2099-01-01T00:00:00Z", reason: null, tasks: [] };
  state.update_task(run.task_id, [["agent_wait", wait]]);
  const fail = () => {
    throw new Error("disk I/O error");
  };
  const errors: string[] = [];
  const error = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    // A subagent's end: the wait for it still ends.
    testing.when("threads:native", fail);
    f.event("turn/completed", "child", { turn: { id: "ct", status: "completed" } });
    assert.equal(db.get_task(state.db(), run.task_id)!.agent_wait!.subagent_finished?.tool_use_id, "codex-agent-child");
    // The run's own turn's end (which cancels the call it left running): the run still has its result.
    testing.when("threads:native", fail);
    f.event("turn/completed", "main", { turn: { id: "t1", status: "completed", durationMs: 10 } });
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 2);
  assert.match(errors[1], /turn\/completed couldn't be written to task .*'s items: disk I\/O error/);
  const r = db.get_run(state.db(), run.id)!;
  assert.equal(r.saw_result, true);
  assert.equal(r.result_error, null);
  // Nothing of the failed writes was written.
  const sh = store.get_item(state.db(), run.task_id, "sh") as any;
  assert.equal(sh.status, "running");
  assert.equal((store.get_item(state.db(), run.task_id, "codex-agent-child") as any).subagent.status, "running");
});
