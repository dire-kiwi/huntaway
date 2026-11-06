// HA-128's server/src/threads/import/tests.rs, ported to the translator, and what being a fold adds: translating a
// history one message at a time, rebuilt from its items at any point, gives what translating it at once does.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import * as permissions from "../mcp/permissions.ts";
import { handle_line as codex_line } from "../agent/codex/output.ts";
import { apply_events, initial_state, type Item, type NewEvent, type SavedEvent, type ThreadRequest } from "./protocol.ts";
import * as store from "./store.ts";
import { ASK_USER, CODEX_QUESTIONS, EXIT_PLAN, Translator, convert, fold, type Conversion, type Disposition, type Message } from "./translate.ts";

const msg = (id: number, kind: string, data: any): Message => ({ id, kind, data, created_at: `2026-11-01T00:00:${String(id % 60).padStart(2, "0")}.000Z` });
const assistant = (id: number, parent: string | null, blocks: any[]) =>
  msg(id, "claude", { type: "assistant", message: { content: blocks }, parent_tool_use_id: parent, session_id: "s1" });
const results = (id: number, parent: string | null, blocks: any[]) =>
  msg(id, "claude", { type: "user", message: { content: blocks }, parent_tool_use_id: parent, session_id: "s1" });

const by_id = (c: { items: Item[] }): Record<string, any> => Object.fromEntries(c.items.map((i) => [i.id, i]));
const requests = (c: { requests: ThreadRequest[] }): Record<string, any> => Object.fromEntries(c.requests.map((r) => [r.id, r]));
const codes = (c: Conversion) => c.warnings.map((w) => w.code);
const disposition = (c: Conversion, id: number): Disposition => c.rows.find((r) => r.message_id === id)!.disposition;
const count = (c: Conversion, d: Disposition) => c.rows.filter((r) => r.disposition === d).length;

/**
 * `messages` translated one at a time, with the translator rebuilt from what the store would hold (the items, requests
 * and metas) after each message, and then finished.
 */
function rebuilt_at_every_step(messages: Message[]): Conversion {
  let state = { items: [] as Item[], requests: [] as ThreadRequest[] };
  const meta = new Map<string, any>();
  const events: NewEvent[] = [];
  const rows: Conversion["rows"] = [];
  const warnings: Conversion["warnings"] = [];
  let t = new Translator();
  for (const m of messages) {
    t = Translator.from(state.items, state.requests, (id) => meta.get(id));
    const s = t.message(m);
    events.push(...s.events);
    state = fold(s.events, state);
    for (const [k, v] of s.meta) meta.set(k, v);
    rows.push({ message_id: m.id, disposition: s.disposition, ids: s.ids });
    warnings.push(...s.warnings);
  }
  const f = t.finish();
  events.push(...f.events);
  for (const [k, v] of f.meta) meta.set(k, v);
  state = fold(f.events, state);
  return { events, ...state, rows, meta, warnings: [...warnings, ...f.warnings], last_session: t.session };
}

/** `convert`, checked against folding the events with protocol.ts's reducer, and against rebuilding at every step. */
function convert_all(messages: Message[], o: { rebuilds?: boolean } = {}): Conversion {
  const c = convert(messages);
  const thread = { id: "t", harness: "claude", status: "idle" as const, created_at: "2026-11-01T00:00:00Z" };
  const saved = c.events.map((e, i) => ({ ...e, thread_id: "t", seq: i + 1 }) as SavedEvent);
  const reduced = apply_events(initial_state(thread), saved);
  assert.deepEqual(reduced.items, c.items);
  assert.deepEqual(reduced.requests, c.requests);
  if (o.rebuilds !== false) {
    const r = rebuilt_at_every_step(messages);
    assert.deepEqual(r.items, c.items, "rebuilding at every step gives the same items");
    assert.deepEqual(r.requests, c.requests, "and requests");
    assert.deepEqual(r.rows, c.rows, "and dispositions");
    assert.deepEqual(Object.fromEntries(r.meta), Object.fromEntries(c.meta), "and metas");
  }
  return c;
}

test("converts_a_turn", () => {
  const c = convert_all([
    msg(1, "user", { text: "Fix the test", auto: true }),
    assistant(2, null, [{ type: "thinking", thinking: "Hmm" }, { type: "text", text: "Looking" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "cargo test" } }]),
    results(3, null, [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }]),
    assistant(4, null, [{ type: "text", text: "  " }]),
    msg(5, "user", { text: "and the docs", steered: true }),
    msg(6, "claude", { type: "result", subtype: "success", is_error: false, duration_ms: 1200, num_turns: 3, total_cost_usd: 0.5 }),
    msg(7, "event", { level: "warn", text: "Slow", detail: null }),
  ]);
  assert.deepEqual(c.items.map((i) => i.id), ["legacy:1", "legacy:2:0", "legacy:2:1", "tu1", "legacy:5", "legacy:6", "legacy:7"]);
  const items = by_id(c);
  assert.deepEqual(items["legacy:1"], { id: "legacy:1", type: "user_message", text: "Fix the test", created_at: "2026-11-01T00:00:01.000Z", metadata: { auto: true } });
  assert.equal(items["legacy:5"].metadata, undefined);
  assert.equal(items["legacy:5"].steered, true);
  assert.equal(items["legacy:2:0"].type, "reasoning");
  assert.equal(items.tu1.status, "completed");
  assert.equal(items.tu1.kind, "shell");
  assert.equal(items.tu1.command, "cargo test");
  assert.deepEqual(items.tu1.result, { content: "ok" });
  assert.equal(items["legacy:6"].ok, true);
  assert.equal(items["legacy:6"].duration_ms, 1200);
  // What the board shows of a turn's end that the item doesn't say (converter 4).
  assert.deepEqual(items["legacy:6"].metadata, { subtype: "success", num_turns: 3, total_cost_usd: 0.5 });
  assert.equal(items["legacy:7"].level, "warning");
  assert.equal(disposition(c, 4), "redundant");
  assert.equal(count(c, "retained"), 0);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.meta.get("legacy:1"), { auto: true });
  assert.deepEqual(c.meta.get("tu1"), { session: "s1" });
  assert.equal(c.last_session, "s1");
});

test("the_same_messages_convert_the_same", () => {
  const messages = [msg(1, "user", { text: "hi" }), assistant(2, null, [{ type: "text", text: "hello" }])];
  assert.deepEqual(convert(messages).events, convert(messages).events);
});

test("subagents_and_their_messages", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Look around", prompt: "Look", model: "haiku" } }]),
    msg(2, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "ag", subagent_type: "Explore" }),
    results(3, "ag", [{ type: "text", text: "Look" }]),
    assistant(4, "ag", [{ type: "tool_use", id: "rd", name: "Read", input: { file_path: "/a" } }]),
    results(5, "ag", [{ type: "tool_result", tool_use_id: "rd", content: "text" }]),
    msg(6, "claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Reading /a", usage: { tool_uses: 1 } }),
    msg(7, "claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed" }),
    msg(8, "claude", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Found it" }] },
      tool_use_result: { agentType: "Explore", totalToolUseCount: 1, status: "completed" },
    }),
    // A Bash command's run: its call shows it.
    assistant(9, null, [{ type: "tool_use", id: "sh", name: "Bash", input: { command: "ls" } }]),
    msg(10, "claude", { type: "system", subtype: "task_started", task_type: "local_bash", task_id: "k2", tool_use_id: "sh" }),
    msg(11, "claude", { type: "system", subtype: "task_notification", task_id: "k2", status: "completed" }),
    results(12, null, [{ type: "tool_result", tool_use_id: "sh", content: "a" }]),
    // Not the subagent's prompt.
    results(13, "ag", [{ type: "text", text: "[Request interrupted by user]" }]),
  ]);
  const items = by_id(c);
  assert.equal(items.ag.kind, "subagent");
  assert.equal(items.ag.title, "Look around");
  // It ended with its task_notification (message 7), not its call's result after it.
  assert.deepEqual(items.ag.subagent, { status: "completed", agent_type: "Explore", model: "haiku", activity: "Reading /a", tool_uses: 1, ended_at: "2026-11-01T00:00:07.000Z" });
  assert.equal(items.rd.parent_id, "ag");
  assert.equal(items.rd.path, "/a");
  assert.deepEqual([items["legacy:13"].code, items["legacy:13"].parent_id], ["interrupted", "ag"]);
  // The subagent's prompt is its call's input.
  assert.equal(disposition(c, 3), "redundant");
  for (const id of [10, 11]) assert.equal(disposition(c, id), "redundant");
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.meta.get("ag"), { session: "s1", subagent_task: "k1" });
  assert.deepEqual(c.meta.get("sh"), { session: "s1", shown_tasks: ["k2"] });
});

test("a_background_subagent_and_one_that_never_ends", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Away", run_in_background: true } }]),
    msg(2, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "bg", is_backgrounded: true }),
    results(3, null, [{ type: "tool_result", tool_use_id: "bg", content: "Async agent launched successfully" }]),
    msg(4, "claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed", summary: "Done away" }),
    assistant(5, null, [{ type: "tool_use", id: "bg2", name: "Agent", input: { description: "Lost" } }]),
    msg(6, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k2", tool_use_id: "bg2", is_backgrounded: true }),
    results(7, null, [{ type: "tool_result", tool_use_id: "bg2", content: "Async agent launched successfully" }]),
  ]);
  const items = by_id(c);
  assert.equal(items.bg.status, "completed");
  assert.deepEqual(items.bg.subagent, { status: "completed", background: true, summary: "Done away", ended_at: "2026-11-01T00:00:04.000Z" });
  assert.equal(items.bg.result.content, "Async agent launched successfully");
  assert.equal(items.bg2.subagent.status, "stopped");
  assert.deepEqual(codes(c), ["subagent_running"]);
});

test("a_forked_skill_becomes_a_subagent", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "sk", name: "Skill", input: { skill: "review" } }]),
    msg(2, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "sk" }),
    assistant(3, "sk", [{ type: "text", text: "Reviewing" }]),
    results(4, null, [{ type: "tool_result", tool_use_id: "sk", content: "Reviewed" }]),
  ]);
  const items = by_id(c);
  assert.equal(items.sk.kind, "subagent");
  assert.equal(items.sk.subagent.status, "completed");
  assert.equal(items["legacy:3:0"].parent_id, "sk");
  assert.deepEqual(c.warnings, []);
});

test("prompts_become_requests", () => {
  const c = convert_all([
    // Stored before the call it's for, made in a subagent.
    assistant(1, null, [{ type: "tool_use", id: "ag", name: "Task", input: {} }]),
    msg(2, "permission", { tool_name: "Bash", input: { command: "rm -rf x" }, tool_use_id: "rm", request_id: "r1", status: "denied", note: "No" }),
    assistant(3, "ag", [{ type: "tool_use", id: "rm", name: "Bash", input: { command: "rm -rf x" } }]),
    results(4, "ag", [{ type: "tool_result", tool_use_id: "rm", content: "No", is_error: true }]),
    msg(5, "permission", { tool_name: EXIT_PLAN, input: { plan: "# Plan" }, tool_use_id: "pl", request_id: "r2", status: "allowed" }),
    msg(6, "permission", {
      tool_name: ASK_USER,
      input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multiSelect: true }] },
      request_id: "r3",
      status: "allowed",
      answers: { "Which?": "A, B" },
    }),
    msg(7, "permission", { tool_name: "Write", input: { file_path: "/f" }, request_id: "r4", status: "expired" }),
    msg(8, "permission", { tool_name: "delete_task", kind: "delete_task", input: { task: "X-1" }, request_id: "r5", status: "pending" }),
    msg(9, "permission", { tool_name: "mcp__gh__pr_merge", input: {}, request_id: "r6", status: "allowed" }),
  ]);
  const r = requests(c);
  assert.deepEqual([r.r1.type, r.r1.kind, r.r1.title, r.r1.tool_call_id, r.r1.parent_id], ["permission", "shell", "rm -rf x", "rm", "ag"]);
  assert.deepEqual(r.r1.resolution, { outcome: "deny", message: "No" });
  assert.equal(by_id(c).rm.status, "denied");
  assert.deepEqual([r.r2.type, r.r2.plan, r.r2.resolution.outcome], ["plan", "# Plan", "allow"]);
  // Claude's questions go by their text, and always offer an answer of one's own (as agent-threads has them).
  assert.deepEqual(r.r3.questions, [
    { id: "Which?", question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "b" }], multi_select: true, allow_other: true },
  ]);
  assert.deepEqual(r.r3.resolution, { outcome: "answer", answers: { "Which?": ["A, B"] } });
  assert.deepEqual([r.r4.kind, r.r4.resolution.outcome], ["edit", "cancel"]);
  // Not answered: cancelled once the history has ended, not made an approval.
  assert.deepEqual([r.r5.kind, r.r5.resolution.outcome], ["app", "cancel"]);
  assert.deepEqual([r.r6.kind, r.r6.server, r.r6.name], ["mcp", "gh", "pr_merge"]);
  assert.ok(c.requests.every((x) => x.resolution));
  // The Task call never got a result.
  assert.deepEqual(codes(c), ["no_result", "open_prompt"]);
  // A history that goes on keeps it open.
  const open = convert(
    [msg(8, "permission", { tool_name: "delete_task", kind: "delete_task", input: { task: "X-1" }, request_id: "r5", status: "pending" })],
    { finished: false },
  );
  assert.equal(open.requests[0]!.resolution, undefined);
  assert.deepEqual(open.warnings, []);
});

test("a_prompt_answered_later_resolves_its_request", () => {
  // As the live path sees it: the message as it's written, then as it's updated.
  const pending = { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "c", request_id: "r", status: "pending" };
  const t = new Translator();
  t.message(assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } }]));
  const asked = t.message(msg(2, "permission", pending));
  assert.deepEqual(asked.events.map((e) => e.type), ["request.opened"]);
  const again = t.message(msg(2, "permission", pending));
  assert.deepEqual([again.disposition, again.events], ["redundant", []]);
  const allowed = t.message(msg(2, "permission", { ...pending, status: "allowed" }));
  // The board's record of it (its status) is replaced in place, keeping the resolution it had, and then it's resolved.
  const { input: _, ...stored } = pending;
  assert.deepEqual(allowed.events, [
    {
      type: "request.opened",
      request: { id: "r", created_at: "2026-11-01T00:00:02.000Z", tool_call_id: "c", metadata: { ...stored, status: "allowed", message_id: 2 }, type: "permission", kind: "shell", name: "Bash", input: { command: "ls" }, title: "ls" },
    },
    { type: "request.resolved", request_id: "r", resolution: { outcome: "allow" } },
  ]);
  assert.equal(t.message(msg(2, "permission", { ...pending, status: "allowed" })).disposition, "redundant");
});

test("a_late_answer_after_its_run_ended_resolves_its_request_again", () => {
  // mcp/permissions.ts: a question or plan whose run ended is expired (set_message_status), and can still be answered
  // late, which updates its message again (with `late`, and the answers or the mode). Fed as each write happens, the live
  // path must end where translating the final rows does.
  const plan = { tool_name: EXIT_PLAN, input: { plan: "# Plan" }, tool_use_id: "pl", request_id: "rp", status: "pending" };
  const ask = {
    tool_name: ASK_USER,
    input: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
    tool_use_id: "q",
    request_id: "rq",
    status: "pending",
  };
  const card = { question: "Merge?", options: [{ label: "Yes" }], status: "pending" };
  const writes = [
    assistant(1, null, [{ type: "tool_use", id: "pl", name: EXIT_PLAN, input: { plan: "# Plan" } }]),
    msg(2, "permission", plan),
    assistant(3, null, [{ type: "tool_use", id: "q", name: ASK_USER, input: ask.input }]),
    msg(4, "permission", ask),
    msg(5, "question", card),
    msg(2, "permission", { ...plan, status: "expired" }),
    msg(4, "permission", { ...ask, status: "expired" }),
    msg(5, "question", { ...card, status: "expired" }),
    msg(2, "permission", { ...plan, status: "allowed", late: true, mode: "acceptEdits" }),
    msg(4, "permission", { ...ask, status: "allowed", late: true, answers: [["B"]] }),
    msg(5, "question", { ...card, status: "answered", answer: { choices: ["Yes"] } }),
  ];
  const t = new Translator();
  const live = writes.map((m) => t.message(m));
  // The expiries cancel, and the late answers resolve them again (each replacing the board's record of it first).
  assert.deepEqual(live.slice(5).map((s) => s.events.map((e) => e.type)), Array(6).fill(["request.opened", "request.resolved"]));
  const final = new Map(writes.map((m) => [m.id, m]));
  const whole = convert([...final.values()], { finished: false });
  assert.deepEqual(fold(live.flatMap((s) => s.events)), { items: whole.items, requests: whole.requests });
  const r = requests(whole);
  assert.deepEqual(r.rp.resolution, { outcome: "allow", permission_mode: "accept_edits" });
  assert.deepEqual(r.rq.resolution, { outcome: "answer", answers: { "Which?": ["B"] } });
  assert.deepEqual(r["legacy:5"].resolution, { outcome: "answer", answers: { q: ["Yes"] } });
  // And the board's records are the final rows', a permission's without its input (the request's own).
  assert.deepEqual(r.rp.metadata, { ...plan, status: "allowed", late: true, mode: "acceptEdits", message_id: 2 });
  assert.deepEqual(r.rq.metadata, { ...ask, status: "allowed", late: true, answers: [["B"]], message_id: 4 });
  assert.deepEqual(r["legacy:5"].metadata, { ...card, status: "answered", answer: { choices: ["Yes"] }, message_id: 5 });
  // The same status again changes nothing.
  assert.equal(t.message(writes.at(-1)!).disposition, "redundant");
});

test("board_questions", () => {
  const card = (status: string) => ({ question: "Merge?", options: [{ label: "Yes" }, { label: "No" }], multi_select: false, allow_other: true, call_id: "c", status });
  const c = convert_all([
    msg(1, "question", { ...card("answered"), answer: { choices: ["Yes"], text: "now" } }),
    msg(2, "question", card("replied")),
    msg(3, "question", card("pending")),
  ]);
  const r = c.requests as any[];
  assert.deepEqual(r[0].questions, [{ id: "q", question: "Merge?", options: [{ label: "Yes" }, { label: "No" }], allow_other: true }]);
  assert.deepEqual(r[0].resolution, { outcome: "answer", answers: { q: ["Yes", "now"] } });
  assert.equal(r[1].resolution.outcome, "cancel");
  assert.equal(r[2].resolution.outcome, "cancel");
  assert.deepEqual(codes(c), ["open_prompt"]);
});

test("compaction_and_its_summary", () => {
  const c = convert_all([
    msg(1, "claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1234 } }),
    msg(2, "claude", { type: "user", isSynthetic: true, message: { content: "Summary so far" } }),
    msg(3, "claude", { type: "result", subtype: "success", is_error: false, num_turns: 0 }),
    msg(4, "claude", { type: "result", subtype: "error_during_execution", is_error: true, interrupted: true }),
  ]);
  const items = by_id(c);
  assert.deepEqual(items["legacy:1"], {
    id: "legacy:1",
    type: "compaction",
    trigger: "manual",
    tokens_before: 1234,
    summary: "Summary so far",
    created_at: "2026-11-01T00:00:01.000Z",
  });
  // A `/compact` run's turn ends with a turn_result too (HA-128 left it out; agent-threads has it).
  assert.deepEqual([disposition(c, 3), items["legacy:3"].type], ["converted", "turn_result"]);
  // An interrupted turn's result says nothing more than that.
  assert.deepEqual([items["legacy:4"].ok, items["legacy:4"].interrupted, items["legacy:4"].error], [false, true, undefined]);
});

test("what_the_board_draws_that_the_protocol_doesnt_say", () => {
  // Converter 3 (HA-218): the thread view on items draws these as it did from messages.
  const c = convert_all([
    msg(1, "claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 9000, post_tokens: 1200 } }),
    msg(2, "claude", { type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 50, total_cost_usd: 0.01 }),
    msg(3, "report", { automation: "Brief", task_id: "t2", key: "HA-2", outcome: "reported", text: "All fine" }),
    msg(4, "report", { automation: "Brief", task_id: "t3", key: "HA-3", outcome: "failed", text: "It broke" }),
    msg(5, "claude", { type: "result", subtype: "error_max_turns", is_error: true }),
  ]);
  const items = by_id(c);
  assert.deepEqual(items["legacy:1"].metadata, { post_tokens: 1200 });
  // A `/compact` run's turn: the view folds it into the compaction by its num_turns, as it did the result.
  assert.deepEqual(items["legacy:2"].metadata, { subtype: "success", num_turns: 0, total_cost_usd: 0.01 });
  // A routine's report, kept only in messages before: a notice with the whole report.
  assert.deepEqual(items["legacy:3"], {
    id: "legacy:3",
    type: "notice",
    level: "info",
    code: "routine_report",
    text: "All fine",
    created_at: "2026-11-01T00:00:03.000Z",
    metadata: { automation: "Brief", task_id: "t2", key: "HA-2", outcome: "reported", text: "All fine" },
  });
  assert.deepEqual([items["legacy:4"].level, items["legacy:4"].metadata.outcome], ["error", "failed"]);
  assert.equal(disposition(c, 3), "converted");
  assert.deepEqual(items["legacy:5"].metadata, { subtype: "error_max_turns" });
  assert.deepEqual(c.warnings, []);
});

test("a_subagent_that_runs_again_keeps_when_it_first_ended_until_it_does", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Away", run_in_background: true } }]),
    msg(2, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "bg", is_backgrounded: true }),
    results(3, null, [{ type: "tool_result", tool_use_id: "bg", content: "Async agent launched successfully" }]),
    msg(4, "claude", { type: "system", subtype: "task_updated", task_id: "k1", patch: { status: "completed" } }),
    msg(5, "claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed", summary: "Done" }),
    msg(6, "claude", { type: "system", subtype: "task_updated", task_id: "k1", patch: { status: "running" } }),
  ]);
  // Continued after it ended: running again, with no end (finish stops it, as one that never said it ended).
  assert.deepEqual(by_id(c).bg.subagent, { status: "stopped", background: true });
  // Before it ran again: ended at its first end (message 4), not the notification after it.
  const open = convert(
    [
      assistant(1, null, [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Away", run_in_background: true } }]),
      msg(2, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "bg", is_backgrounded: true }),
      msg(4, "claude", { type: "system", subtype: "task_updated", task_id: "k1", patch: { status: "completed" } }),
      msg(5, "claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed", summary: "Done" }),
    ],
    { finished: false },
  );
  assert.deepEqual(by_id(open).bg.subagent, { status: "completed", background: true, ended_at: "2026-11-01T00:00:04.000Z", summary: "Done" });
});

test("what_the_history_doesnt_say", () => {
  const long = `${"x".repeat(30_000)}\n… [truncated 5 bytes]`;
  const c = convert_all([
    // A result before its call, a call with no result, and a result with no call.
    results(1, null, [{ type: "tool_result", tool_use_id: "early", content: "first" }]),
    assistant(2, null, [{ type: "tool_use", id: "early", name: "Read", input: {} }, { type: "tool_use", id: "open", name: "Grep", input: { pattern: "x" } }]),
    results(3, null, [{ type: "tool_result", tool_use_id: "nowhere", content: "?" }]),
    // The same call id again.
    assistant(4, null, [{ type: "tool_use", id: "early", name: "Read", input: {} }]),
    results(5, null, [{ type: "tool_result", tool_use_id: "early", content: long }]),
    assistant(6, "missing", [{ type: "text", text: "orphan" }]),
    msg(7, "claude", { type: "system", subtype: "task_updated", task_id: "never" }),
    msg(8, "claude", { type: "system", subtype: "hook_response" }),
    results(9, null, [{ type: "text", text: "[Request interrupted by user]" }]),
    msg(10, "mystery", {}),
  ], { rebuilds: false });
  const items = by_id(c);
  assert.equal(items.early.result.content, "first");
  assert.equal(items.open.status, "cancelled");
  assert.equal(items["legacy:4:0"].result.truncated, true);
  assert.equal(items["legacy:6:0"].parent_id, "missing");
  assert.equal(items["legacy:9"].code, "interrupted");
  assert.deepEqual(codes(c).sort(), ["duplicate_call", "missing_parent", "no_result", "orphan_result", "unknown_claude", "unknown_kind", "unknown_task"]);
  for (const id of [3, 7, 8, 10]) assert.equal(disposition(c, id), "retained", String(id));
  assert.equal(disposition(c, 1), "converted");
  assert.equal(c.rows.length, 10);
});

test("what_waits_for_its_call_is_lost_by_a_rebuild_in_between", () => {
  // A result stored before its call is held in memory: rebuilt from the store in between, it never finds its call.
  const messages = [results(1, null, [{ type: "tool_result", tool_use_id: "early", content: "first" }]), assistant(2, null, [{ type: "tool_use", id: "early", name: "Read", input: {} }])];
  assert.equal(by_id(convert(messages)).early.result.content, "first");
  const r = rebuilt_at_every_step(messages);
  assert.equal(by_id(r).early.result, undefined);
});

test("codex_file_changes_are_edits", () => {
  const input = { changes: [{ path: "/a.rs", kind: "add", diff: "+x" }, { path: "/b.rs", kind: "update", move_path: "/c.rs", diff: "@@" }] };
  const c = convert_all([assistant(1, null, [{ type: "tool_use", id: "p", name: "ApplyPatch", input }])]);
  assert.deepEqual((c.items[0] as any).changes, [
    { path: "/a.rs", op: "add", diff: "+x" },
    { path: "/b.rs", op: "update", diff: "@@", move_to: "/c.rs" },
  ]);
});

test("a_prompt_before_a_call_with_a_reused_id_is_for_that_call", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } }]),
    results(2, null, [{ type: "tool_result", tool_use_id: "c", content: "a" }]),
    msg(3, "permission", { tool_name: "Bash", input: { command: "rm x" }, tool_use_id: "c", request_id: "r1", status: "denied" }),
    assistant(4, "ag", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "rm x" } }]),
    results(5, "ag", [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }]),
    // A prompt after both have their results can't be told apart.
    msg(6, "permission", { tool_name: "Bash", input: {}, tool_use_id: "c", request_id: "r2", status: "allowed" }),
  ], { rebuilds: false });
  const items = by_id(c);
  assert.deepEqual([items.c.status, items.c.result.content], ["completed", "a"]);
  assert.deepEqual([items["legacy:4:0"].status, items["legacy:4:0"].result.content], ["denied", "Denied"]);
  const r = c.requests as any[];
  assert.equal(r[0].tool_call_id, "legacy:4:0");
  // Its parent is the second call's, which isn't in the thread.
  assert.equal(r[0].parent_id, "ag");
  assert.equal(r[1].tool_call_id, undefined);
  assert.deepEqual(codes(c).sort(), ["ambiguous_call", "duplicate_call", "missing_parent"]);
});

test("a_subagents_compaction_and_its_summary_stay_in_it", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "ag", name: "Agent", input: {} }]),
    msg(2, "claude", { type: "system", subtype: "compact_boundary", parent_tool_use_id: "ag", compact_metadata: { trigger: "auto" } }),
    assistant(3, null, [{ type: "text", text: "Meanwhile" }]),
    msg(4, "claude", { type: "user", isSynthetic: true, parent_tool_use_id: "ag", message: { content: "Child summary" } }),
    results(5, null, [{ type: "tool_result", tool_use_id: "ag", content: "done" }]),
  ]);
  const items = by_id(c);
  assert.deepEqual([items["legacy:2"].parent_id, items["legacy:2"].summary], ["ag", "Child summary"]);
  assert.deepEqual(c.warnings, []);
});

test("calls_with_one_id_in_two_subagents_get_their_own_results", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "a", name: "Agent", input: {} }, { type: "tool_use", id: "b", name: "Agent", input: {} }]),
    assistant(2, "a", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls a" } }]),
    assistant(3, "b", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls b" } }]),
    results(4, "a", [{ type: "tool_result", tool_use_id: "c", content: "out a" }]),
    results(5, "b", [{ type: "tool_result", tool_use_id: "c", content: "out b" }]),
  ]);
  const items = by_id(c);
  assert.deepEqual([items.c.parent_id, items.c.result.content], ["a", "out a"]);
  assert.deepEqual([items["legacy:3:0"].parent_id, items["legacy:3:0"].result.content], ["b", "out b"]);
});

test("a_result_two_calls_with_its_id_wait_for_goes_to_neither", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "one" } }]),
    assistant(2, null, [{ type: "tool_use", id: "c", name: "Bash", input: { command: "two" } }]),
    results(3, null, [{ type: "tool_result", tool_use_id: "c", content: "which?" }]),
  ]);
  const items = by_id(c);
  assert.deepEqual([items.c.status, items["legacy:2:0"].status], ["cancelled", "cancelled"]);
  assert.ok(c.items.every((i: any) => i.result === undefined));
  assert.equal(disposition(c, 3), "retained");
  assert.deepEqual(codes(c), ["duplicate_call", "ambiguous_call", "no_result"]);
});

/** A call with id `c` in session `session`, and its denied result. */
const bash = (id: number, session: string, command: string) =>
  msg(id, "claude", { type: "assistant", session_id: session, message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command } }] } });
const bash_denied = (id: number, session: string) =>
  msg(id, "claude", { type: "user", session_id: session, message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }] } });

test("a_prompt_before_a_reused_id_whose_first_call_never_returned", () => {
  const denied = (command: string) => msg(2, "permission", { tool_name: "Bash", input: { command }, tool_use_id: "c", request_id: "r", status: "denied" });
  // Its input tells the calls apart.
  let c = convert_all([bash(1, "s1", "ls"), denied("rm x"), bash(3, "s2", "rm x"), bash_denied(4, "s2")], { rebuilds: false });
  assert.equal(c.requests[0]!.tool_call_id, "legacy:3:0");
  assert.deepEqual([by_id(c)["legacy:3:0"].status, by_id(c).c.status], ["denied", "cancelled"]);
  // The same input: the first call, waiting in the same session, asked; the result is the new session's call's.
  c = convert_all([bash(1, "s1", "rm x"), denied("rm x"), bash(3, "s2", "rm x"), bash_denied(4, "s2")]);
  assert.equal(c.requests[0]!.tool_call_id, "c");
  assert.deepEqual([by_id(c)["legacy:3:0"].status, by_id(c).c.status], ["failed", "cancelled"]);
});

test("a_subagents_compaction_and_summary_before_its_call", () => {
  const c = convert_all([
    msg(1, "claude", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }),
    msg(2, "claude", { type: "system", subtype: "compact_boundary", parent_tool_use_id: "ag", compact_metadata: { trigger: "auto" } }),
    msg(3, "claude", { type: "user", isSynthetic: true, parent_tool_use_id: "ag", message: { content: "Child summary" } }),
    assistant(4, null, [{ type: "tool_use", id: "ag", name: "Agent", input: {} }]),
    results(5, null, [{ type: "tool_result", tool_use_id: "ag", content: "done" }]),
  ], { rebuilds: false });
  const items = by_id(c);
  assert.deepEqual([items["legacy:2"].parent_id, items["legacy:2"].summary], ["ag", "Child summary"]);
  assert.equal(items["legacy:1"].summary, undefined);
  assert.deepEqual(c.warnings, []);
});

test("a_result_before_its_agent_call_keeps_what_the_board_kept_of_it", () => {
  const call = assistant(2, null, [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Away" } }]);
  const meta = { agentId: "x", resolvedModel: "haiku", agentType: "Explore", totalToolUseCount: 3, isAsync: true, status: "async_launched" };
  const result = (id: number) => msg(id, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag", content: "Launched" }] }, tool_use_result: meta });
  const early = by_id(convert_all([result(1), call], { rebuilds: false })).ag;
  const in_order = by_id(convert_all([call, result(3)])).ag;
  assert.deepEqual(early.subagent, { status: "stopped", background: true, model: "haiku", agent_type: "Explore", tool_uses: 3 });
  assert.deepEqual([early.status, early.subagent], [in_order.status, in_order.subagent]);
});

test("a_prompt_before_two_calls_with_its_id_is_for_the_one_with_its_input", () => {
  const c = convert_all([
    assistant(1, null, [{ type: "tool_use", id: "a", name: "Agent", input: {} }, { type: "tool_use", id: "b", name: "Agent", input: {} }]),
    assistant(3, "a", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls a" } }]),
    msg(4, "permission", { tool_name: "Bash", input: { command: "ls b" }, tool_use_id: "c", request_id: "r", status: "denied" }),
    assistant(5, "b", [{ type: "tool_use", id: "c", name: "Bash", input: { command: "ls b" } }]),
    results(6, "a", [{ type: "tool_result", tool_use_id: "c", content: "out a" }]),
    results(7, "b", [{ type: "tool_result", tool_use_id: "c", content: "Denied", is_error: true }]),
    // Neither call has this input: no telling.
    msg(8, "permission", { tool_name: "Bash", input: { command: "ls c" }, tool_use_id: "c", request_id: "r2", status: "allowed" }),
  ], { rebuilds: false });
  const r = c.requests as any[];
  assert.deepEqual([r[0].tool_call_id, r[0].parent_id], ["legacy:5:0", "b"]);
  const items = by_id(c);
  assert.deepEqual([items.c.status, items["legacy:5:0"].status], ["completed", "denied"]);
  assert.equal(r[1].tool_call_id, undefined);
  // The agents never got results.
  assert.deepEqual(codes(c), ["duplicate_call", "no_result", "ambiguous_call"]);
});

test("a_prompt_matching_no_call_with_its_reused_id_is_for_none", () => {
  const c = convert_all([
    bash(1, "s1", "ls a"),
    msg(2, "claude", { type: "user", session_id: "s1", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "a" }] } }),
    msg(3, "permission", { tool_name: "Bash", input: { command: "rm c" }, tool_use_id: "c", request_id: "r", status: "denied" }),
    bash(4, "s2", "ls b"),
    bash_denied(5, "s2"),
  ], { rebuilds: false });
  assert.equal(c.requests[0]!.tool_call_id, undefined);
  const items = by_id(c);
  assert.deepEqual([items.c.status, items["legacy:4:0"].status], ["completed", "failed"]);
  assert.deepEqual(codes(c), ["duplicate_call", "ambiguous_call"]);
  assert.equal(c.last_session, "s2");
});

test("what_a_turn_ended_by_saying_and_what_the_board_knows_of_items", () => {
  const c = convert_all([
    msg(1, "user", { text: "Go\n\nFrom IA-2", user_text: "Go" }),
    assistant(2, null, [{ type: "text", text: "Done." }]),
    msg(3, "claude", { type: "result", subtype: "success", result: "Done.", num_turns: 1 }),
    // A turn a background subagent's report started: its result is all it said.
    msg(4, "claude", { type: "result", subtype: "success", result: "The report is in.", num_turns: 1 }),
    msg(5, "claude", { type: "result", subtype: "error_during_execution", is_error: true, result: "Boom" }),
    assistant(6, null, [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "d" } }]),
    msg(7, "claude", { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", task_type: "local_agent", session_id: "s1" }),
    msg(8, "user", { text: "Start working on this task.", auto: true }),
    msg(9, "user", { text: "Rebase", from_agent: true }),
  ]);
  assert.deepEqual(c.items.map((i) => i.id), ["legacy:1", "legacy:2:0", "legacy:3", "legacy:4:result", "legacy:4", "legacy:5", "a1", "legacy:8", "legacy:9"]);
  assert.deepEqual(by_id(c)["legacy:4:result"], { id: "legacy:4:result", type: "assistant_message", text: "The report is in.", created_at: "2026-11-01T00:00:04.000Z", metadata: { from_result: true } });
  assert.equal(by_id(c)["legacy:5"].error, "Boom");
  assert.deepEqual(Object.fromEntries(c.meta), {
    "legacy:1": { user_text: "Go" },
    "legacy:3": { result_text: "Done." },
    "legacy:4:result": { from_result: true },
    "legacy:4": { result_text: "The report is in." },
    "legacy:5": { result_text: "Boom" },
    a1: { session: "s1", subagent_task: "t1" },
    "legacy:8": { auto: true },
    "legacy:9": { from_agent: true },
  });
});

test("a_rebuild_mid_turn_knows_what_the_turn_said", () => {
  // Two text blocks of one message around a call: the result says both again, so it adds nothing.
  convert_all([
    msg(1, "user", { text: "Go" }),
    assistant(2, null, [{ type: "text", text: "One" }, { type: "tool_use", id: "x", name: "Read", input: {} }, { type: "text", text: "Two" }]),
    results(3, null, [{ type: "tool_result", tool_use_id: "x", content: "" }]),
    msg(4, "claude", { type: "result", subtype: "success", result: "One\nTwo", num_turns: 1 }),
  ]);
});

// ---------- as the board stores them ----------

/** A task (on Codex with `codex`) with a run that's going, so its agent's prompts are asked. */
function running(s: ReturnType<typeof testing.state>, codex: boolean) {
  const config = codex ? db.insert_claude_config(s.db(), "Codex", "", "codex").id : null;
  const profile = db.insert_profile(s.db(), "p", config ? [config] : [], null);
  const task = db.insert_task(s.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: config,
  });
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task.id, { run_id: run.id, cancel: null } as any);
  return { task, run };
}

/** The questions in `input` asked by `tool` as the board asks them, answered with `answers` as the board answers them. */
async function answered(codex: boolean, tool: string, input: any, answers: string[][]): Promise<Message[]> {
  const s = testing.state();
  const { task } = running(s, codex);
  const told = permissions.prompt(s, task, "call", tool, input, null);
  let id: string | undefined;
  while (!(id = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id='call'"))) await new Promise((r) => setTimeout(r, 5));
  permissions.answer(s, id, true, false, null, { answers });
  await told;
  return db.list_messages(s.db(), task.id);
}

test("answers_to_claudes_questions_as_the_board_keeps_them", async () => {
  const input = {
    questions: [
      { question: "Which season?", header: "Season", multiSelect: false, options: [{ label: "Summer" }, { label: "Winter" }] },
      { question: "Which pets?", header: "Pets", multiSelect: true, options: [{ label: "Cats" }, { label: "Dogs" }] },
      { question: "Anything else?", options: [{ label: "No" }] },
    ],
  };
  const c = convert_all(await answered(false, ASK_USER, input, [["Summer"], ["Cats", "a lizard"], []]));
  assert.deepEqual(c.requests[0]!.resolution, { outcome: "answer", answers: { "Which season?": ["Summer"], "Which pets?": ["Cats", "a lizard"] } });
  assert.deepEqual(c.warnings, []);
});

test("answers_to_codexs_questions_as_the_board_keeps_them", async () => {
  const input = {
    questions: [
      { id: "name", question: "Which name?", options: [{ label: "a.txt", description: "" }], isOther: true, isSecret: false },
      { id: "token", question: "Your token?", options: [], isOther: true, isSecret: true },
    ],
  };
  const c = convert_all(await answered(true, CODEX_QUESTIONS, input, [["b.txt"], ["s3cret"]]));
  const r = c.requests[0] as any;
  assert.deepEqual(r.questions[1], { id: "token", question: "Your token?", allow_other: true, secret: true });
  // The secret stays hidden, as the board kept it.
  assert.deepEqual(r.resolution, { outcome: "answer", answers: { name: ["b.txt"], token: ["(hidden)"] } });
  assert.deepEqual(c.warnings, []);
});

test("the_tools_whose_prompts_are_questions_and_plans_are_the_boards", () => {
  assert.deepEqual([EXIT_PLAN, ASK_USER, CODEX_QUESTIONS], [permissions.EXIT_PLAN, permissions.ASK_USER, permissions.CODEX_QUESTIONS]);
});

test("written_to_the_store_one_message_at_a_time_and_rebuilt_from_it", () => {
  // What step 3 will do: append each message's events with it as their origin, and go on from the store.
  const s = testing.state();
  const { task } = running(s, false);
  const messages = [
    msg(1, "user", { text: "Go" }),
    assistant(2, null, [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "Look" } }]),
    msg(3, "claude", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "k1", tool_use_id: "ag" }),
    assistant(4, "ag", [{ type: "tool_use", id: "rd", name: "Read", input: { file_path: "/a" } }]),
    msg(5, "permission", { tool_name: "Read", input: { file_path: "/a" }, tool_use_id: "rd", request_id: "r", status: "allowed" }),
    results(6, "ag", [{ type: "tool_result", tool_use_id: "rd", content: "x" }]),
    msg(7, "claude", { type: "system", subtype: "task_notification", task_id: "k1", status: "completed" }),
    results(8, null, [{ type: "tool_result", tool_use_id: "ag", content: "Found" }]),
    msg(9, "claude", { type: "result", subtype: "success", result: "Found", num_turns: 1 }),
  ];
  const c = s.db();
  for (const m of messages) {
    const t = Translator.from(store.items(c, task.id), store.requests(c, task.id), (id) => store.item_meta(c, task.id, id));
    const step = t.message(m);
    db.tx(c, () => {
      store.append(c, task.id, step.events, { message_id: m.id });
      for (const [id, meta] of step.meta) store.set_item_meta(c, task.id, id, meta);
    });
  }
  const whole = convert(messages, { finished: false });
  assert.deepEqual(store.items(c, task.id), whole.items);
  assert.deepEqual(store.requests(c, task.id), whole.requests);
  assert.deepEqual(store.item_meta(c, task.id, "ag"), { session: "s1", subagent_task: "k1" });
  assert.deepEqual(store.item_origins(c, task.id, "ag"), [2, 3, 7, 8]);
});

/** What the board stores for a Codex run whose child agent compacts and completes (agent/codex/output.ts). */
test("codex_children_as_the_board_stores_them", () => {
  const s = testing.state();
  const { task, run } = running(s, true);
  const send = (method: string, thread: string, params: any) => codex_line(s, run, { method, params: { ...params, threadId: thread } });
  const item = (thread: string, it: any) => {
    send("item/started", thread, { item: it });
    send("item/completed", thread, { item: it });
  };
  codex_line(s, run, { method: "thread/started", params: { thread: { id: "main" } } });
  item("main", {
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
  item("child", { type: "agentMessage", id: "text", text: "Reading" });
  item("child", { type: "contextCompaction", id: "squash" });
  item("main", {
    type: "collabAgentToolCall",
    id: "wait",
    tool: "wait",
    status: "completed",
    senderThreadId: "main",
    receiverThreadIds: ["child"],
    agentsStates: { child: { status: "completed", message: "Config is fine" } },
  });
  const c = convert_all(db.list_messages(s.db(), task.id));
  const agent = by_id(c)["codex-agent-child"];
  assert.equal(agent.status, "completed");
  const { ended_at, ...subagent } = agent.subagent;
  assert.deepEqual(subagent, { status: "completed", background: true, model: "gpt-6.1-sol", summary: "Config is fine" });
  assert.equal(typeof ended_at, "string");
  // The child's compaction stays in the child's conversation.
  assert.equal(c.items.find((i) => i.type === "compaction")!.parent_id, "codex-agent-child");
  assert.deepEqual(c.warnings, []);
  assert.equal(count(c, "retained"), 0);
});
