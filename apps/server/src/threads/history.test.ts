// The board's readers of a thread (threads/history.ts): on a legacy history (its messages) and on its translation (the
// items a rebuild makes of them), each gives the same answer, and the callers read items only for tasks whose readers
// should. Then `huntaway threads-readers` (threads/readers.ts) on such histories, and the attachment scan.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import * as analytics from "../analytics.ts";
import * as attachments from "../attachments.ts";
import * as changes from "../git/changes.ts";
import * as permissions from "../mcp/permissions.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as history from "./history.ts";
import * as readers from "./readers.ts";
import * as write from "./write.ts";
import { CONVERTER_VERSION } from "./translate.ts";

type Row = [kind: string, data: any];

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
/** The time of a history's `i`th message: a second apart. */
const at = (i: number) => new Date(BASE + i * 1000).toISOString();

function board(): { s: AppState; c: db.Conn; profile: string; task: (rows: Row[], o?: { translate?: boolean; kind?: string; parent?: string }) => string } {
  const s = testing.on_items(testing.state(), false);
  const c = s.db();
  const profile = db.insert_profile(c, "p", [], null).id;
  /** A task with the history `rows` (its messages, made a second apart), translated into items unless `translate` is false. */
  const task = (rows: Row[], o: { translate?: boolean; kind?: string; parent?: string } = {}) => {
    const t = db.insert_task(c, {
      profile_id: profile,
      project_id: null,
      kind: "task",
      title: "t",
      description: "",
      status: "in_progress",
      use_worktree: false,
    });
    if (o.kind) db.run(c, "UPDATE tasks SET kind=?2, parent_id=?3 WHERE id=?1", t.id, o.kind, o.parent ?? null);
    rows.forEach(([kind, data], i) =>
      db.run(c, "INSERT INTO messages (task_id, kind, data, created_at) VALUES (?1, ?2, ?3, ?4)", t.id, kind, JSON.stringify(data), at(i)),
    );
    if (o.translate !== false) write.rebuild(c, t.id);
    return t.id;
  };
  return { s, c, profile, task };
}

/** `f` gives the same from messages as from items, and that's returned. */
function same<T>(f: (from: history.Source) => T): T {
  const m = f("messages");
  assert.deepEqual(f("items"), m);
  return m;
}

const user = (text: string, more: object = {}): Row => ["user", { text, ...more }];
const assistant = (blocks: any[], more: object = {}): Row => ["claude", { type: "assistant", message: { content: blocks }, session_id: "s1", ...more }];
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const results = (blocks: any[], more: object = {}): Row => ["claude", { type: "user", message: { content: blocks }, session_id: "s1", ...more }];
const result = (id: string, content: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content, is_error });
const done = (text?: string, more: object = {}): Row => [
  "claude",
  { type: "result", subtype: "success", is_error: false, ...(text !== undefined ? { result: text } : {}), session_id: "s1", ...more },
];

test("readers read items only for a flagged task whose thread this converter wrote, with no error", () => {
  const { c, task } = board();
  const legacy = task([user("hi")], { translate: false });
  assert.equal(history.source(c, legacy), "messages");
  const id = task([user("hi")]);
  assert.equal(history.source(c, id), "items");
  // Its live writes stopped on an error: its items have a gap.
  db.run(c, "UPDATE threads SET error='boom' WHERE task_id=?1", id);
  assert.equal(history.source(c, id), "messages");
  db.run(c, "UPDATE threads SET error=NULL WHERE task_id=?1", id);
  // An older translator's items may lack the metas the readers read.
  db.run(c, "UPDATE threads SET converter=?2 WHERE task_id=?1", id, CONVERTER_VERSION - 1);
  assert.equal(history.source(c, id), "messages");
  db.run(c, "UPDATE threads SET converter=?2 WHERE task_id=?1", id, CONVERTER_VERSION);
  // Flagged, with no thread yet.
  db.run(c, "UPDATE tasks SET thread_items=1 WHERE id=?1", legacy);
  assert.equal(history.source(c, legacy), "messages");
  // The callers read items when it says so: a task whose items differ from its messages (by hand) shows which.
  db.run(c, "UPDATE thread_items SET data=json_set(data, '$.text', 'from items') WHERE task_id=?1", id);
  db.run(
    c,
    "INSERT INTO messages (task_id, kind, data, created_at) VALUES (?1, 'claude', ?2, ?3)",
    id,
    JSON.stringify({ type: "assistant", message: { content: [text("from messages")] } }),
    at(1),
  );
  assert.equal(history.user_replies(c, id, null).replies[0]?.[1], "from items");
  assert.equal(history.last_assistant_text(c, id), null);
  db.run(c, "UPDATE threads SET error='boom' WHERE task_id=?1", id);
  assert.equal(history.user_replies(c, id, null).replies[0]?.[1], "hi");
  assert.equal(history.last_assistant_text(c, id), "from messages");
});

test("what the agent said: its messages' text, results' and API errors", () => {
  const { c, task } = board();
  const id = task([
    user("start", { auto: true, start: true }),
    assistant([text("Looking."), call("t1", "Bash", { command: "ls" }), text("Found it.")]),
    results([result("t1", "a\nb")]),
    // A thinking block and a whitespace text block say nothing.
    assistant([{ type: "thinking", thinking: "hmm" }, text("Done: two files.")]),
    done("Done: two files."),
    user("And now?"),
    assistant([text("Working on it.")]),
    // A result that says what no message did.
    done("All finished."),
  ]);
  assert.equal(
    same((from) => history.last_assistant_text(c, id, from)),
    "All finished.",
  );
  assert.equal(
    same((from) => history.said_since_asked(c, id, from)),
    "All finished.",
  );
  const replies = same((from) => history.user_replies(c, id, null, from));
  assert.deepEqual(replies, { replies: [["Done: two files.", "And now?"]], since: "All finished.".length ? "Working on it." : null, earlier: 0 });

  // A message's text blocks, joined; a subagent's message counts as the agent's too, as it always has.
  const joined = task([user("go"), assistant([text("one"), call("t1", "Read", { file_path: "/x" }), text("two")])]);
  assert.equal(
    same((from) => history.last_assistant_text(c, joined, from)),
    "one\ntwo",
  );
  // An API error in the agent's place.
  const limited = task([
    user("go"),
    assistant([text("Before.")]),
    assistant([text("You've hit your limit.")], { is_api_error_message: true, error: "rate_limit" }),
  ]);
  assert.equal(
    same((from) => history.last_assistant_text(c, limited, from)),
    "You've hit your limit.",
  );
  assert.deepEqual(
    same((from) => history.user_replies(c, limited, null, from)),
    { replies: [[null, "go"]], since: "You've hit your limit.", earlier: 0 },
  );
  // Nothing since it was asked.
  const asked = task([assistant([text("Earlier.")]), user("Summarize?", { auto: true })]);
  assert.equal(
    same((from) => history.said_since_asked(c, asked, from)),
    null,
  );
  assert.equal(
    same((from) => history.last_assistant_text(c, asked, from)),
    "Earlier.",
  );
  // An empty thread, and an error result with no text.
  const empty = task([]);
  assert.equal(
    same((from) => history.last_assistant_text(c, empty, from)),
    null,
  );
  const failed = task([user("go"), assistant([text("Trying.")]), ["claude", { type: "result", subtype: "error_during_execution", is_error: true }]]);
  assert.equal(
    same((from) => history.said_since_asked(c, failed, from)),
    "Trying.",
  );
  // HA-218: a routine's report, a notice in items (an error one for a failed run), is the board's, not the agent's.
  const reported = task([
    user("go"),
    assistant([text("Mine.")]),
    ["report", { automation: "Brief", task_id: "t2", key: "HA-2", outcome: "failed", text: "It broke" }],
  ]);
  assert.equal(
    same((from) => history.last_assistant_text(c, reported, from)),
    "Mine.",
  );
});

test("Telegram's: what the agent said in a turn, and how the latest turn ended", () => {
  const { c, task } = board();
  const id = task([
    user("go"),
    assistant([text("Looking."), call("t1", "Bash", { command: "ls" }), text("Found it.")]),
    results([result("t1", "a")]),
    // A result with no text: the turn's last message is its reply.
    done(),
    // A turn that said nothing doesn't say the one before's again.
    ["claude", { type: "system", subtype: "init", session_id: "s1" }],
    done(""),
    user("And?"),
    assistant([text("Thinking.")]),
    // A result that says what no message did.
    done("All finished."),
    user("Compact", { auto: true }),
    done("", { compact: true }),
    user("Again"),
    assistant([text("Partly.")]),
    ["claude", { type: "result", subtype: "error_during_execution", is_error: true, result: null, session_id: "s1" }],
    user("Stop?"),
    ["claude", { type: "result", subtype: "success", is_error: false, interrupted: true, session_id: "s1" }],
    user("Late"),
    assistant([text("After the turn.")]),
  ]);
  const ends = db.all<{ id: number; data: string }>(
    c,
    "SELECT id, data FROM messages WHERE task_id=?1 AND json_extract(data, '$.type')='result' ORDER BY id",
    id,
  );
  assert.deepEqual(
    ends.map((e) => same((from) => history.said_in_turn(c, id, e.id, from))),
    ["Looking.\nFound it.", null, "All finished.", null, "Partly.", null],
  );
  // No such turn's end.
  assert.equal(history.said_in_turn(c, id, 99999, "items"), null);
  assert.deepEqual(
    ends.map((e) => history.turn_end(JSON.parse(e.data))),
    ["reply", "reply", "reply", "compact", "failed", "failed"],
  );
  // The latest: an interrupted turn, then each before it as the latest.
  assert.deepEqual(
    same((from) => history.last_turn_end(c, id, from)),
    { id: ends[5]!.id, end: "failed" },
  );
  for (const [n, end] of [
    [4, "failed"],
    [3, "compact"],
    [2, "reply"],
  ] as const) {
    const cut = task(
      db
        .all<{ kind: string; data: string }>(c, "SELECT kind, data FROM messages WHERE task_id=?1 AND id<=?2 ORDER BY id", id, ends[n]!.id)
        .map((m) => [m.kind, JSON.parse(m.data)]),
    );
    const last = same((from) => history.last_turn_end(c, cut, from));
    assert.equal(last?.end, end);
  }
  assert.equal(
    same((from) => history.last_turn_end(c, task([user("go")]), from)),
    null,
  );
});

test("the user's replies: their own words, with what the agent said before each, and limits", () => {
  const { c, task } = board();
  const id = task([
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
  ]);
  for (const limit of [null, 0, 1, 2, 3, 10]) same((from) => history.user_replies(c, id, limit, from));
  assert.deepEqual(history.user_replies(c, id, null), {
    replies: [
      ["Which colour?", "Blue."],
      ["Fixed.", "Large."],
      [null, "Also round corners."],
    ],
    since: "Will do.",
    earlier: 0,
  });
  assert.deepEqual(history.user_replies(c, id, 1), { replies: [[null, "Also round corners."]], since: "Will do.", earlier: 2 });
  assert.deepEqual(history.user_replies(c, id, 2), {
    replies: [
      ["Fixed.", "Large."],
      [null, "Also round corners."],
    ],
    since: "Will do.",
    earlier: 1,
  });
});

test("tool calls since a time, and whether they changed code", () => {
  const { c, task } = board();
  const id = task([
    user("go"),
    assistant([call("e1", "Edit", { file_path: "/a", old_string: "x", new_string: "y" })]),
    results([result("e1", "error: no match", true)]),
    assistant([call("b1", "Bash", { command: "echo hi > /repo/file" })]),
    results([result("b1", "The user denied this action.", true)]),
    assistant([call("m1", "mcp__huntaway__list_tasks", {}), call("a1", "mcp__app__thing", {})]),
    results([result("m1", "[]"), result("a1", "ok")]),
    assistant([call("e2", "Write", { file_path: "/b", content: "z" })]),
    results([result("e2", "written")]),
    // A subagent's, and one with no result yet.
    assistant([call("e3", "Edit", { file_path: "/c" })], { parent_tool_use_id: "x1" }),
    assistant([call("b2", "Bash", { command: "git commit -m x" })]),
  ]);
  const calls = same((from) =>
    history.tool_calls_since(c, id, null, from).map(([call, res]) => [call.id, call.name, res?.is_error ?? null, changes.changes_code(call, res)]),
  );
  assert.deepEqual(calls, [
    ["e1", "Edit", true, false],
    ["b1", "Bash", true, false],
    ["m1", "mcp__huntaway__list_tasks", false, false],
    ["a1", "mcp__app__thing", false, false],
    ["e2", "Write", false, true],
    ["e3", "Edit", null, false],
    ["b2", "Bash", null, true],
  ]);
  for (let i = 0; i < 12; i++) same((from) => history.tool_calls_since(c, id, at(i), from).map(([call, res]) => [call.id, changes.changes_code(call, res)]));
  assert.deepEqual(
    history.tool_calls_since(c, id, at(6), "items").map(([call]) => call.id),
    ["e2", "e3", "b2"],
  );
  // A call's name and input, and whether the thread has one.
  for (const call_id of ["e1", "m1", "a1", "b2", "nope"]) same((from) => history.tool_use(c, id, call_id, from));
  assert.deepEqual(history.tool_use(c, id, "m1", "items"), ["mcp__huntaway__list_tasks", {}]);
});

test("who wrote since a time", () => {
  const { c, task } = board();
  const id = task([
    user("start", { auto: true }),
    assistant([text("ok")]),
    user("from an agent", { from_agent: true }),
    user("mine"),
    assistant([text("ok")]),
    user("merge", { auto: true }),
  ]);
  for (let i = -1; i < 7; i++) {
    for (const t of [at(i), new Date(BASE + i * 1000 - 1).toISOString()]) {
      same((from) => history.user_wrote_since(c, id, t, from));
      same((from) => history.user_messaged_since(c, id, t, from));
    }
  }
  assert.equal(history.user_wrote_since(c, id, at(2), "items"), true);
  assert.equal(history.user_wrote_since(c, id, at(3), "items"), false);
  assert.equal(history.user_messaged_since(c, id, at(5), "items"), true);
  assert.equal(history.user_messaged_since(c, id, at(6), "items"), false);
});

test("a subagent's call, from what its lifecycle messages say", () => {
  const { c, task } = board();
  const job = (subtype: string, more: object): Row => ["claude", { type: "system", subtype, session_id: "s1", ...more }];
  const id = task([
    user("go"),
    assistant([
      call("ag1", "Agent", { description: "look", prompt: "look around" }),
      call("sk1", "Skill", { skill: "x" }),
      call("bg1", "Bash", { command: "sleep 9", run_in_background: true }),
    ]),
    job("task_started", { task_id: "T1", tool_use_id: "ag1", task_type: "local_agent", description: "look" }),
    job("task_started", { task_id: "T2", tool_use_id: "sk1", task_type: "local_agent", description: "a skill" }),
    job("task_started", { task_id: "T3", tool_use_id: "bg1", task_type: "local_bash" }),
    results([result("ag1", "found it"), result("sk1", "done"), result("bg1", "started")]),
    job("task_notification", { task_id: "T1", status: "completed" }),
    // A Codex subagent, as the board writes it.
    assistant([call("codex-sub-1", "Agent", { description: "d", prompt: "p", run_in_background: true })]),
    job("task_started", { task_id: "thread-9", tool_use_id: "codex-sub-1" }),
  ]);
  const events = [
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
  ];
  const found = events.map((e) => same((from) => history.subagent_call(c, id, e, from)));
  assert.deepEqual(found, ["ag1", "ag1", "ag1", null, null, null, null, "codex-sub-1", null, null]);
  for (const call_id of ["ag1", "codex-sub-1", "nope"]) same((from) => history.has_call(c, id, call_id, from));
  assert.equal(history.has_call(c, id, "codex-sub-1", "items"), true);
  // The messages reader only looks at a message's first block (where the board writes a Codex subagent's call).
  assert.equal(history.has_call(c, id, "sk1", "messages"), false);
  assert.equal(history.has_call(c, id, "sk1", "items"), true);
  assert.equal(history.has_call(c, id, "nope", "items"), false);
});

test("a question's conversation moving on, the first user message and turns' messages", () => {
  const { s, c, task } = board();
  const id = task([
    assistant([text("hello")]),
    user("Start", { auto: true, start: true }),
    ["question", { question: "Which?", options: [{ label: "A" }], status: "pending" }],
    assistant([text("waiting")]),
    user("Fix these", { auto: true, review_round: 2 }),
    user("A routine's prompt", { routine: true, auto: true }),
    ["permission", { tool_name: "Bash", input: { command: "ls" }, request_id: "r1", status: "allowed" }],
    user("[from x]\n\nmine", { user_text: "mine" }),
  ]);
  const ids = db.all<{ id: number; kind: string }>(c, "SELECT id, kind FROM messages WHERE task_id=?1 ORDER BY id", id);
  for (const m of ids) same((from) => history.moved_on(c, id, m.id, from));
  assert.equal(permissions.moved_on(s, id, ids[2]!.id), true);
  assert.equal(history.moved_on(c, id, ids[7]!.id, "items"), false);
  assert.equal(
    same((from) => history.first_user_message(c, id, from)),
    ids[1]!.id,
  );
  assert.equal(
    same((from) => history.first_user_message(c, task([assistant([text("x")])]), from)),
    null,
  );
  // What the checkpoints and routine_call read of a turn's message.
  const pick = (d: any) =>
    d === undefined ? "none" : { text: d?.text, user_text: d?.user_text, auto: d?.auto, review_round: d?.review_round, routine: d?.routine, start: d?.start };
  for (const m of ids.filter((m) => m.kind === "user")) same((from) => pick(history.user_message(c, id, m.id, from)));
  assert.deepEqual(pick(history.user_message(c, id, ids[4]!.id, "items")), {
    text: "Fix these",
    user_text: undefined,
    auto: true,
    review_round: 2,
    routine: undefined,
    start: undefined,
  });
  assert.equal(history.user_message(c, id, 99999, "items"), undefined);
  // A routine run's calls: its turn's message says so.
  const run = db.insert_run(c, id, "prompt");
  db.run(c, "UPDATE runs SET turn_message_id=?2 WHERE id=?1", run.id, ids[5]!.id);
  db.run(c, "INSERT INTO mcp_calls (id, run_id, task_id, tool, args, status, created_at) VALUES ('k1', ?1, ?2, 'x', '{}', 'running', ?3)", run.id, id, at(0));
  assert.equal(permissions.routine_call(c, "k1"), true);
  db.run(c, "UPDATE runs SET turn_message_id=?2 WHERE id=?1", run.id, ids[7]!.id);
  assert.equal(permissions.routine_call(c, "k1"), false);
});

test("the questions still waiting for an answer", () => {
  const { s, c, task } = board();
  const q = (question: string, status: string, more: object = {}): Row => ["question", { question, options: [{ label: "A" }], status, ...more }];
  const id = task([
    user("go"),
    q("Answered?", "answered", { answer: { choices: ["A"], text: null } }),
    q("Open?", "pending"),
    q("Replied?", "replied"),
    q("Merge?", "pending", { merge_approval: true, multi_select: false, allow_other: false }),
    q("Expired?", "expired"),
    // A question prompt (AskUserQuestion) is a question request too, but no question message.
    [
      "permission",
      { tool_name: "AskUserQuestion", input: { questions: [{ question: "Pick", options: [{ label: "x" }] }] }, request_id: "r1", status: "pending" },
    ],
  ]);
  const open = same((from) => history.open_questions(c, id, from).map((m) => JSON.parse(m.data).question));
  assert.deepEqual(open, ["Open?", "Merge?"]);
  // Answered since: its message's status says, and so do its items, written live.
  db.set_setting(c, write.SETTING, "true");
  const m = history.open_questions(c, id)[0]!;
  db.update_pending_message(c, m.id, { ...JSON.parse(m.data), status: "replied" });
  assert.deepEqual(
    same((from) => history.open_questions(c, id, from).map((m) => JSON.parse(m.data).question)),
    ["Merge?"],
  );
  // The merge gate settles its card, found from the items.
  merge_gate.settle(s, id, "replaced");
  assert.deepEqual(history.open_questions(c, id), []);
  const card = db.value<string>(c, "SELECT data FROM messages WHERE task_id=?1 AND json_extract(data, '$.merge_approval')=1", id)!;
  assert.equal(JSON.parse(card).status, "replaced");
});

test("pending approvals, from the thread's request and the request's row", () => {
  const { s, c, task } = board();
  const id = task([user("go")]);
  const ask = (rid: string, kind: string, tool: string, input: any, extra: object = {}) => {
    // A workflow's message says `workflow` (see permissions.approve), and its approval `automation`, as its row does.
    const data = { kind: permissions.workflow_kind(kind, input), tool_name: tool, input, request_id: rid, status: "pending", ...extra };
    const m = s.add_message(id, "permission", data);
    db.run(
      c,
      `INSERT INTO permission_requests (id, task_id, message_id, tool_name, input, status, created_at, call_id, kind, expires_at, rule)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10)`,
      rid,
      id,
      m.id,
      tool,
      JSON.stringify(input),
      at(rid.length),
      `call-${rid}`,
      kind,
      (extra as any).expires_at ?? null,
      (extra as any).rule?.tool ?? null,
    );
  };
  ask("p1", "project", "create_project", { name: "New" });
  ask(
    "p22",
    "delete_task",
    "delete_task",
    { task: "X-1" },
    { expires_at: "2026-12-01T00:00:00.000Z", rule: { tool: "mcp__huntaway__delete_task", decision: "ask" } },
  );
  ask("p333", "automation", "create_automation", { name: "nightly", workflow: { nodes: [] } });
  ask("p4444", "tool", "Bash", { command: "ls" });
  assert.equal(history.source(c, id), "items");
  for (const [d, a, w] of [
    [true, true, true],
    [false, false, false],
    [true, true, false],
  ] as const)
    same((from) => permissions.pending_approvals(s, d, a, w, from));
  const all = permissions.pending_approvals(s, true, true, true);
  assert.deepEqual(
    all.map((v) => [v.request_id, v.kind, v.input]),
    [
      ["p1", "project", { name: "New" }],
      ["p22", "delete_task", { task: "X-1" }],
      ["p333", "automation", { name: "nightly", workflow: { nodes: [] } }],
    ],
  );
});

test("prompt analytics and review stats' submissions", () => {
  const { c, profile, task } = board();
  const id = task([
    user("Do the thing, please", { auto: true, start: true }),
    user("A prompt"),
    user("From an agent", { from_agent: true }),
    user('The user moved this task to "Ready for merge": merge it', { auto: true }),
    user("Review issues", { auto: true }),
  ]);
  const legacy = task([user("Start working on this task.", { auto: true }), user("Another prompt")], { translate: false });
  // Each task from where its readers read it, and every one from messages (the legacy one has no items to read).
  // (In time order: events of different tasks made at once may come in either order.)
  const report = (from: history.Source, f = "", t = "9999") =>
    analytics.report(c, profile, f, t, from === "items" ? "auto" : "messages").events.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  same((from) => report(from));
  same((from) => report(from, at(1), at(3)));
  const events = report("items");
  assert.deepEqual(events.map((e) => [e.at, e.task_id === id ? "items" : e.task_id === legacy ? "legacy" : e.task_id, e.kind, e.text]).sort(), [
    [at(0), "items", "start", ""],
    [at(0), "legacy", "start", ""],
    [at(1), "items", "prompt", "A prompt"],
    [at(1), "legacy", "prompt", "Another prompt"],
    [at(3), "items", "merge", ""],
  ]);

  const review = task(
    [
      user("Review it", { auto: true }),
      assistant([call("s1", "mcp__huntaway__submit_review", { verdict: "pass", summary: "Late" })]),
      results([result("s1", "Error: nothing to submit: the round ended", true)]),
      assistant([call("s2", "mcp__huntaway__submit_review", { verdict: "needs_fixes", serious_issues: ["x"], summary: "One" })]),
      results([result("s2", "Submitted.")]),
    ],
    { kind: "review", parent: id },
  );
  const subs = same((from) => history.submissions(c, from));
  assert.deepEqual(
    subs.map((x) => [x.thread_id === review, x.parent_id === id, x.id, x.at]),
    [[true, true, "s2", at(3)]],
  );
});

test("attachments a thread kept as items links are referenced, after its messages are gone too", () => {
  const { c, task } = board();
  const a = "0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210";
  const id = task([
    user(`Look\n\nAttached files:\n- /data/attachments/${a}/shot.png`),
    assistant([call("r1", "Read", { file_path: `/data/attachments/${b}/notes.txt` })]),
  ]);
  const legacy = task([user(`/data/attachments/${b}/x.txt`)], { translate: false });
  assert.deepEqual([...attachments.referenced(c, "messages")].sort(), [a, b].sort());
  assert.deepEqual([...attachments.referenced(c, "items")].sort(), [a, b].sort());
  // Once step 10 stops writing messages, an items-only thread's are still found.
  db.run(c, "DELETE FROM messages WHERE task_id=?1", id);
  assert.deepEqual([...attachments.referenced(c, "messages")], [b]);
  assert.deepEqual([...attachments.referenced(c)].sort(), [a, b].sort());
  assert.deepEqual([...attachments.of_task(c, id)].sort(), [a, b].sort());
  assert.deepEqual([...attachments.of_task(c, legacy)], [b]);
  // In a request too (a permission prompt's input).
  const asked = task([
    ["permission", { tool_name: "Read", input: { file_path: `/data/attachments/${"a".repeat(32)}/y` }, request_id: "r9", status: "pending" }],
  ]);
  db.run(c, "DELETE FROM messages WHERE task_id=?1", asked);
  assert.deepEqual([...attachments.of_task(c, asked)], ["a".repeat(32)]);
});

test("threads-readers finds no differences on these histories, and writes nothing", () => {
  const { c, task } = board();
  const translated = task([user("go"), assistant([text("hi"), call("b1", "Bash", { command: "touch x" })]), results([result("b1", "")]), done("hi")]);
  const legacy = task(
    [
      user("go", { auto: true, start: true }),
      assistant([call("ag1", "Agent", { description: "d", prompt: "p" })]),
      ["claude", { type: "system", subtype: "task_started", task_id: "T1", tool_use_id: "ag1", task_type: "local_agent", session_id: "s1" }],
      ["question", { question: "Which?", options: [], status: "pending" }],
      user("This one."),
      assistant([text("Thanks.")]),
    ],
    { translate: false },
  );
  const r = readers.compare(c);
  assert.deepEqual(r.differences, []);
  assert.deepEqual(r.failed, []);
  assert.equal(r.tasks, 2);
  assert.equal(r.translated, 1);
  for (const reader of [
    "last_message",
    "user_replies",
    "said_in_turn",
    "last_turn_end",
    "tool_calls_since",
    "subagent_call",
    "moved_on",
    "analytics",
    "attachments.referenced",
  ]) {
    assert.ok(r.readers[reader]?.checked, reader);
  }
  // The translation was rolled back.
  assert.equal(history.source(c, legacy), "messages");
  assert.equal(db.value<number>(c, "SELECT COUNT(*) FROM thread_items WHERE task_id=?1", legacy), 0);
  assert.equal(history.source(c, translated), "items");
  // A difference is found: items changed by hand.
  db.run(c, "UPDATE thread_items SET data=json_set(data, '$.text', 'changed') WHERE task_id=?1 AND type='assistant_message'", translated);
  const changed = readers.compare(c, [translated]);
  assert.ok(
    changed.differences.some((d) => d.reader === "user_replies" && (d.items as any).since === "changed" && (d.messages as any).since === "hi"),
    JSON.stringify(changed.differences),
  );
});
