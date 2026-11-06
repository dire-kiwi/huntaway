// Items as the source (threads/source.ts, step 10 of docs/threads.md): a task's move onto items when it's quiet, the
// messages of an items task written as items only through every write point, the ids they keep, what reads and
// changes them in place, crashes around the move, and moving back.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import * as runs from "../agent/runs.ts";
import * as runner from "../agent/runner.ts";
import * as questions from "../mcp/questions.ts";
import * as permissions from "../mcp/permissions.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as routines from "../integrations/automations/routines.ts";
import * as attachments from "../attachments.ts";
import * as analytics from "../analytics.ts";
import * as store from "./store.ts";
import * as write from "./write.ts";
import * as source from "./source.ts";
import * as history from "./history.ts";
import * as batch from "./batch.ts";
import * as rebuild_cli from "./rebuild.ts";
import { CONVERTER_VERSION } from "./translate.ts";

// A run's launch fails rather than starting a real agent (with TEST_CAN_RUN, its messages are still written).
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

function setup(): { s: AppState; events: any[]; task: (title?: string, status?: string) => Task; profile: string } {
  const s = testing.on_items(testing.state(), true);
  const events: any[] = [];
  s.events.subscribe((e) => events.push(e));
  const profile = db.insert_profile(s.db(), "p", [], null).id;
  const task = (title = "t", status = "in_progress") =>
    db.insert_task(s.db(), { profile_id: profile, project_id: null, kind: "task", title, description: "", status, use_worktree: false });
  return { s, events, task, profile };
}

/** Runs `f` with tasks staying on their messages, as a board before this step did. */
function on_messages<T>(s: AppState, f: () => T): T {
  source.set_flips(s.db(), false);
  try {
    return f();
  } finally {
    source.set_flips(s.db(), true);
  }
}

const rows = (s: AppState, id: string) => db.value<number>(s.db(), "SELECT COUNT(*) FROM messages WHERE task_id=?1", id)!;
const on = (s: AppState, id: string) => source.of(s.db(), id);
const texts = (s: AppState, id: string) => store.items(s.db(), id).flatMap((i: any) => (i.type === "user_message" || i.type === "notice" ? [i.text] : []));

/** A pending permission prompt in `task_id`'s thread, as mcp/permissions.ts asks one. */
function prompt(s: AppState, task_id: string, rid: string, kind = "tool", tool = "Bash", input: any = { command: "ls" }) {
  const m = s.add_message(task_id, "permission", { kind, tool_name: tool, input, request_id: rid, status: "pending", tool_use_id: `tu-${rid}` });
  db.run(
    s.db(),
    `INSERT INTO permission_requests (id, task_id, message_id, tool_name, input, status, created_at, call_id, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)`,
    rid,
    task_id,
    m.id,
    tool,
    JSON.stringify(input),
    new Date().toISOString(),
    `call-${rid}`,
    kind,
  );
  return m;
}

async function idle(s: AppState, id: string) {
  for (let i = 0; i < 200 && s.is_running(id); i++) await new Promise((r) => setTimeout(r, 10));
}

test("a new task's thread starts on items: no messages rows, and its ids go on from the messages' sequence", () => {
  const { s, task } = setup();
  const old = task("old");
  const [a, b] = on_messages(s, () => [s.add_message(old.id, "user", { text: "one" }), s.add_message(old.id, "user", { text: "two" })]);
  assert.equal(on(s, old.id), "messages");
  const t = task();
  const m = s.add_message(t.id, "user", { text: "hi" });
  s.add_event(t.id, "info", "set up");
  assert.equal(on(s, t.id), "items");
  assert.equal(rows(s, t.id), 0);
  assert.ok(m.id > b.id, `${m.id} after ${b.id}`);
  assert.deepEqual(texts(s, t.id), ["hi", "set up"]);
  assert.deepEqual(store.item_origins(s.db(), t.id, `legacy:${m.id}`), [m.id]);
  // A row written later (a task on messages, on another board's connection, say) takes the next id, not one of these.
  const c = on_messages(s, () => s.add_message(task("other").id, "user", { text: "row" }));
  const last = Number(store.items(s.db(), t.id).at(-1)!.id.split(":")[1]);
  assert.ok(c.id > last && a.id < b.id, `${c.id} after ${last}`);
  // The task says so, for the app (API 122).
  assert.equal(db.get_task(s.db(), t.id)!.thread_source, "items");
  assert.equal(db.get_task(s.db(), old.id)!.thread_source, "messages");
});

test("a board that never wrote a message starts the sequence", () => {
  const { s, task } = setup();
  assert.equal(db.value(s.db(), "SELECT seq FROM sqlite_sequence WHERE name='messages'"), undefined);
  const m = s.add_message(task().id, "user", { text: "first" });
  const row = on_messages(s, () => s.add_message(task().id, "user", { text: "second" }));
  assert.deepEqual([m.id, row.id], [1, 2]);
});

test("a task moves onto items once it's quiet: a run going or a prompt waiting holds it back, a question doesn't", () => {
  const { s, task } = setup();
  const t = task();
  on_messages(s, () => s.add_message(t.id, "user", { text: "go" }));
  // Mid-turn: a run that hasn't exited, which asks for a permission and a question.
  const run = db.insert_run(s.db(), t.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.add_message(t.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  prompt(s, t.id, "p1");
  const q = s.add_message(t.id, "question", { question: "Which?", options: [], status: "pending" });
  assert.deepEqual([on(s, t.id), rows(s, t.id)], ["messages", 4]);
  assert.equal(source.busy(s.db(), t.id), "its agent is running");
  // Its run ended, but the prompt waits still (one asked by an approval between runs, say).
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  source.settled(s, t.id);
  assert.equal(source.busy(s.db(), t.id), "a prompt is waiting for an answer");
  s.add_event(t.id, "info", "an event");
  assert.deepEqual([on(s, t.id), rows(s, t.id)], ["messages", 5]);
  // The prompt expired: quiet, so it moves, with its question still open (it stays answerable after its run).
  permissions.expire_for_task(s, t.id);
  assert.equal(source.busy(s.db(), t.id), null);
  source.settled(s, t.id);
  assert.deepEqual([on(s, t.id), rows(s, t.id)], ["items", 5]);
  assert.deepEqual(
    history.open_questions(s.db(), t.id).map((o) => o.id),
    [q.id],
  );
  assert.equal(store.get_request(s.db(), t.id, `legacy:${q.id}`)?.resolution, undefined);
  // Settled on items: its request, and the message as it's kept, say so, and its row is as it was.
  assert.equal(db.update_pending_message(s.db(), q.id, { ...q.data, status: "replied" }, t.id)?.data.status, "replied");
  assert.equal(db.get_message(s.db(), q.id, t.id)?.data.status, "replied");
  assert.equal(store.get_request(s.db(), t.id, `legacy:${q.id}`)?.resolution?.outcome, "cancel");
  assert.deepEqual(history.open_questions(s.db(), t.id), []);
  assert.equal(db.value(s.db(), "SELECT json_extract(data, '$.status') FROM messages WHERE id=?1", q.id), "pending");
  // The next message is written as items only.
  const m = s.add_message(t.id, "user", { text: "carry on" });
  assert.deepEqual([on(s, t.id), rows(s, t.id)], ["items", 5]);
  assert.deepEqual(texts(s, t.id), ["go", "an event", "carry on"]);
  assert.equal(store.get_item(s.db(), t.id, `legacy:${m.id}`)?.type, "user_message");
  // Its items were kept live, so moving didn't rebuild them: the messages it had are as they were.
  assert.equal(db.value(s.db(), "SELECT rebuilt_at FROM threads WHERE task_id=?1", t.id), null);
});

test("a task whose items aren't this build's is rebuilt from its messages as it moves, and clients are told", () => {
  const { s, events, task } = setup();
  const a = task("not kept");
  const b = task("stopped on an error");
  on_messages(s, () => {
    db.set_setting(s.db(), write.SETTING, "false");
    s.add_message(a.id, "user", { text: "from before the setting" });
    db.set_setting(s.db(), write.SETTING, null);
    s.add_message(b.id, "user", { text: "kept" });
  });
  db.run(s.db(), "UPDATE threads SET error='a bug' WHERE task_id=?1", b.id);
  assert.equal(store.items(s.db(), a.id).length, 0);
  for (const t of [a, b]) {
    events.length = 0;
    s.add_message(t.id, "user", { text: "after" });
    assert.equal(on(s, t.id), "items");
    assert.equal(texts(s, t.id).at(-1), "after");
    assert.equal(texts(s, t.id).length, 2);
    assert.equal(db.value(s.db(), "SELECT error FROM threads WHERE task_id=?1", t.id), null);
    // The task with its new source, a resync (the rebuild moved its seq on), then the message.
    const kinds = events.filter((e) => e.task_id === t.id || e.task?.id === t.id).map((e) => e.type);
    assert.deepEqual(kinds.slice(0, 3), ["task", "thread_resync", "message"], kinds.join(" "));
  }
});

test("start_run moves a task onto items before its run, and its turn_message_id names its prompt's item", async (t) => {
  runs.TEST_CAN_RUN.set(true);
  t.onTestFinished(() => runs.TEST_CAN_RUN.set(false));
  const { s, task } = setup();
  const x = task();
  const first = on_messages(s, () => s.add_message(x.id, "user", { text: "before" }));
  runner.send(s, x.id, "hello");
  assert.equal(on(s, x.id), "items");
  const turn = db.value<number>(s.db(), "SELECT turn_message_id FROM runs WHERE task_id=?1", x.id)!;
  assert.ok(turn > first.id);
  assert.equal(store.get_item(s.db(), x.id, `legacy:${turn}`)?.type, "user_message");
  assert.equal(history.user_message(s.db(), x.id, turn)?.text, "hello");
  // The launch fails (there's no agent): its events go to the items too.
  await idle(s, x.id);
  assert.equal(rows(s, x.id), 1);
  assert.ok(store.items(s.db(), x.id).length > 2);
  // A new task's start message is its first, written as an item.
  const y = task("new");
  runner.send(s, y.id, "");
  await idle(s, y.id);
  assert.equal(rows(s, y.id), 0);
  const start = store.items(s.db(), y.id)[0]!;
  assert.deepEqual(store.item_meta(s.db(), y.id, start.id), { auto: true, start: true });
  assert.equal(db.value(s.db(), "SELECT turn_message_id FROM runs WHERE task_id=?1", y.id), history.message_of(start.id));
  // Checkpoints and rewinds: the first user message, from before the move, and one after.
  assert.equal(history.first_user_message(s.db(), x.id), first.id);
  assert.equal(history.user_message(s.db(), x.id, first.id)?.text, "before");
  assert.equal(history.first_user_message(s.db(), y.id), history.message_of(start.id));
});

test("an items task's prompts, questions and reports change in place in its items, with no rows", async (t) => {
  const { s, task } = setup();
  const c = s.db();
  const x = task();
  s.add_message(x.id, "user", { text: "go" });
  // A prompt answered: its request resolves, and its message as it's kept says so.
  const p = prompt(s, x.id, "p1");
  assert.equal(db.get_message(c, p.id)?.data.status, "pending");
  permissions.answer(s, "p1", true, false, null, {});
  assert.equal(store.get_request(c, x.id, "p1")?.resolution?.outcome, "allow");
  assert.deepEqual(
    [db.get_message(c, p.id)?.kind, db.get_message(c, p.id)?.data.status, db.get_message(c, p.id)?.data.input],
    ["permission", "allowed", { command: "ls" }],
  );
  // A question asked once per call, even when it's asked again (a restart cut its call short).
  const card = questions.card({ question: "Which?", options: ["A", "B"] });
  questions.ask(s, x, "call-1", card);
  questions.ask(s, x, "call-1", card);
  const open = history.open_questions(c, x.id);
  assert.equal(open.length, 1);
  const qid = open[0]!.id;
  assert.equal(JSON.parse(open[0]!.data).call_id, "call-1");
  // Its answer can't be sent here (this host can't run agents): it's answerable again, and its request open again.
  assert.throws(() => questions.answer(s, x.id, qid, { choices: ["A"] }), /can't run agents/);
  assert.equal(db.get_message(c, qid, x.id)?.data.status, "pending");
  assert.equal(store.get_request(c, x.id, `legacy:${qid}`)?.resolution, undefined);
  // A reply in the thread settles it.
  s.add_message(x.id, "user", { text: "B, then" });
  questions.replied(s, x.id);
  assert.equal(db.get_message(c, qid, x.id)?.data.status, "replied");
  assert.deepEqual(history.open_questions(c, x.id), []);
  // The merge gate's card, settled.
  db.run(c, "UPDATE tasks SET status='needs_attention', merging=1, merge_approval='pending' WHERE id=?1", x.id);
  merge_gate.ask(s, x.id);
  const gate = history.open_questions(c, x.id)[0]!;
  merge_gate.settle(s, x.id, "replaced");
  assert.equal(db.get_message(c, gate.id, x.id)?.data.status, "replaced");
  assert.equal(store.get_request(c, x.id, `legacy:${gate.id}`)?.resolution?.outcome, "cancel");
  // A routine's report, read by the assistant.
  const r = s.add_message(x.id, "report", { automation: "Inbox", key: "A-1", outcome: "reported", text: "Two mails" });
  const [unread, ids] = routines.unread_reports(s, x.id)!;
  assert.ok(unread.includes("Two mails"));
  assert.deepEqual(ids, [r.id]);
  routines.mark_read(s, x.id, ids);
  assert.equal(routines.unread_reports(s, x.id), null);
  assert.equal(db.get_message(c, r.id, x.id)?.data.read, true);
  assert.equal(rows(s, x.id), 0);
  // The thread was written live all along: nothing stopped it.
  assert.equal(store.has_thread(c, x.id), true);
});

test("an items task's project, deletion and automation approvals are pending approvals", () => {
  const { s, task } = setup();
  const x = task();
  s.add_message(x.id, "user", { text: "go" });
  prompt(s, x.id, "a1", "project", "create_project", { name: "New" });
  prompt(s, x.id, "a2", "delete_task", "delete_task", { task: "X-1" });
  prompt(s, x.id, "a3", "automation", "create_automation", { name: "nightly", workflow: { nodes: [] } });
  prompt(s, x.id, "a4", "tool", "Bash", { command: "ls" });
  assert.deepEqual([on(s, x.id), rows(s, x.id)], ["items", 0]);
  const all = permissions.pending_approvals(s, true, true, true);
  assert.deepEqual(
    all.map((v) => [v.request_id, v.kind, v.input, v.task_id]),
    [
      ["a1", "project", { name: "New" }, x.id],
      ["a2", "delete_task", { task: "X-1" }, x.id],
      ["a3", "automation", { name: "nightly", workflow: { nodes: [] } }, x.id],
    ],
  );
  // An older UI's list (project changes only).
  assert.deepEqual(
    permissions.pending_approvals(s, false, false).map((v) => v.request_id),
    ["a1"],
  );
});

test("a late answer to an items task's question goes to its agent as a message, until the conversation moves on", async (t) => {
  runs.TEST_CAN_RUN.set(true);
  t.onTestFinished(() => runs.TEST_CAN_RUN.set(false));
  const { s, task } = setup();
  const x = task();
  s.add_message(x.id, "user", { text: "go" });
  const asked = { questions: [{ question: "Which runner?", header: "Runner", options: [{ label: "vitest" }, { label: "jest" }], multiSelect: false }] };
  const q = prompt(s, x.id, "q1", "tool", "AskUserQuestion", asked);
  // Its run ended before it was answered.
  permissions.expire_for_task(s, x.id);
  assert.equal(db.get_message(s.db(), q.id)?.data.status, "expired");
  assert.equal(permissions.moved_on(s, x.id, q.id), false);
  permissions.answer(s, "q1", true, false, null, { answers: [["vitest"]] });
  const reply = testing
    .messages(s.db(), x.id)
    .filter((m) => m.kind === "user")
    .at(-1)!;
  assert.match(reply.data.text, /vitest/);
  assert.ok(reply.id > q.id);
  assert.equal(store.get_item(s.db(), x.id, `legacy:${reply.id}`)?.type, "user_message");
  assert.equal(db.get_message(s.db(), q.id)?.data.late, true);
  await idle(s, x.id);
  // A second prompt, expired, after which the user wrote: answering it late is refused.
  const q2 = prompt(s, x.id, "q2", "tool", "AskUserQuestion", asked);
  permissions.expire_for_task(s, x.id);
  s.add_message(x.id, "user", { text: "never mind" });
  assert.equal(permissions.moved_on(s, x.id, q2.id), true);
  assert.throws(() => permissions.answer(s, "q2", true, false, null, { answers: [["jest"]] }), /moved on/);
  assert.equal(rows(s, x.id), 0);
});

test("an items task's attachments survive the pruner a week on", () => {
  const { s, task } = setup();
  const x = task();
  const [kept, gone] = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
  for (const id of [kept, gone]) {
    mkdirSync(join(attachments.dir(s), id), { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(join(attachments.dir(s), id), old, old);
  }
  s.add_message(x.id, "user", { text: `Look at this\n\nAttached files:\n- ${join(attachments.dir(s), kept, "x.png")}` });
  assert.equal(rows(s, x.id), 0);
  assert.ok(attachments.of_task(s.db(), x.id).has(kept));
  assert.equal(attachments.prune(s), 1);
  assert.deepEqual([existsSync(join(attachments.dir(s), kept)), existsSync(join(attachments.dir(s), gone))], [true, false]);
});

test("an items task's readers: what it said since it was asked (workflows, summaries), and prompt analytics", () => {
  const { s, task, profile } = setup();
  const x = task();
  const from = new Date(Date.now() - 1000).toISOString();
  s.add_message(x.id, "user", { text: "Start", auto: true, start: true });
  s.add_message(x.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: "Done it" }] } });
  s.add_message(x.id, "user", { text: "Summarise it" });
  assert.equal(history.said_since_asked(s.db(), x.id), null);
  s.add_message(x.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: "A summary" }] } });
  assert.equal(history.said_since_asked(s.db(), x.id), "A summary");
  assert.equal(history.last_assistant_text(s.db(), x.id), "A summary");
  const r = analytics.report(s.db(), profile, from, "9999");
  assert.deepEqual(
    r.events.map((e) => [e.kind, e.task_id, e.text]),
    [
      ["start", x.id, ""],
      ["prompt", x.id, "Summarise it"],
    ],
  );
  assert.equal(rows(s, x.id), 0);
});

test("moving back onto messages is safe until the thread's next write", () => {
  const { s, task } = setup();
  const x = task();
  on_messages(s, () => s.add_message(x.id, "user", { text: "go" }));
  assert.equal(source.flip(s.db(), x.id), "moved");
  source.flip_back(s.db(), x.id);
  assert.equal(on(s, x.id), "messages");
  // Through the command line too.
  assert.equal(source.flip(s.db(), x.id), "moved");
  const back = rebuild_cli.run(rebuild_cli.parse_args(["--back", x.id]), s.db(), () => {});
  assert.deepEqual(back, [{ task_id: x.id, back: true }]);
  s.add_message(x.id, "user", { text: "after" });
  assert.equal(on(s, x.id), "items");
  assert.throws(() => source.flip_back(s.db(), x.id), /has been written since it moved/);
  // A task that started on items has no messages to go back to.
  const y = task("new");
  s.add_message(y.id, "user", { text: "hi" });
  assert.throws(() => source.flip_back(s.db(), y.id), /written since it moved|started on items/);
});

test("a crash as a task moves onto items leaves it on its messages, and nothing of the message", () => {
  const { s, task } = setup();
  const x = task();
  on_messages(s, () => s.add_message(x.id, "user", { text: "go" }));
  const before = { items: store.items(s.db(), x.id), seq: store.last_seq(s.db(), x.id) };
  for (const point of ["threads:flipped", "threads:write", "threads:translated"]) {
    testing.when(point, () => {
      throw new Error("crash");
    });
    if (point === "threads:translated") {
      // On items, a translator failure keeps the message as a row with its id, rather than lose it.
      const m = s.add_message(x.id, "user", { text: "kept" });
      assert.equal(on(s, x.id), "items");
      assert.equal(db.value(s.db(), "SELECT json_extract(data, '$.text') FROM messages WHERE id=?1", m.id), "kept");
      assert.equal(store.get_item(s.db(), x.id, `legacy:${m.id}`), null);
      continue;
    }
    assert.throws(() => s.add_message(x.id, "user", { text: "lost" }), /crash/, point);
    assert.deepEqual([on(s, x.id), rows(s, x.id)], ["messages", 1], point);
    assert.deepEqual({ items: store.items(s.db(), x.id), seq: store.last_seq(s.db(), x.id) }, before, point);
  }
  s.add_message(x.id, "user", { text: "then" });
  assert.equal(texts(s, x.id).at(-1), "then");
});

test("a server that dies as a task moves onto items leaves it on its messages", () => {
  const dir = testing.temp_dir();
  const file = join(dir, "huntaway-2.db");
  const script = `
    import * as db from ${JSON.stringify(new URL("../db.ts", import.meta.url).href)};
    import { when } from ${JSON.stringify(new URL("../util.ts", import.meta.url).href)};
    import * as source from ${JSON.stringify(new URL("./source.ts", import.meta.url).href)};
    const c = db.open(${JSON.stringify(file)});
    const p = db.insert_profile(c, "p", [], null);
    const t = db.insert_task(c, { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false });
    console.log(t.id);
    db.insert_message(c, t.id, "user", { text: "kept" });
    source.set_flips(c, true);
    when(process.argv.at(-1), () => process.exit(3));
    db.insert_message(c, t.id, "user", { text: "lost" });
  `;
  for (const point of ["threads:flipped", "threads:write"]) {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, point], { encoding: "utf8" });
    assert.equal(r.status, 3, r.stderr);
    const task_id = r.stdout.trim();
    const c = db.open(file);
    try {
      assert.equal(source.of(c, task_id), "messages", point);
      assert.deepEqual(
        db.list_messages(c, task_id).map((m) => m.data.text),
        ["kept"],
        point,
      );
      assert.deepEqual(
        store.items(c, task_id).map((i: any) => i.text),
        ["kept"],
        point,
      );
      assert.deepEqual(write.compare(c, task_id), [], point);
    } finally {
      c.close();
    }
  }
});

test("rebuilds, the batch and threads-rebuild leave items tasks alone", () => {
  const { s, task } = setup();
  const x = task();
  on_messages(s, () => s.add_message(x.id, "user", { text: "before" }));
  s.add_message(x.id, "user", { text: "after" });
  assert.equal(on(s, x.id), "items");
  assert.throws(() => write.rebuild(s.db(), x.id), /written as items only/);
  assert.equal(write.ensure(s.db(), x.id), false);
  // Even with items an older converter wrote (from before it moved): there's nothing newer to rebuild them from.
  db.run(s.db(), "UPDATE threads SET converter=1 WHERE task_id=?1", x.id);
  assert.equal(history.source(s.db(), x.id), "items");
  assert.deepEqual(batch.pending(s.db()), []);
  assert.deepEqual(
    rebuild_cli.run(rebuild_cli.parse_args(["--all"]), s.db(), () => {}),
    [],
  );
  const [named] = rebuild_cli.run(rebuild_cli.parse_args([x.id]), s.db(), () => {});
  assert.match(named!.error!, /written as items only/);
  assert.deepEqual(texts(s, x.id), ["before", "after"]);
});

test("at the start, quiet tasks move onto items; one mid-turn moves when its run ends", async () => {
  const { s, task } = setup();
  const [quiet, busy, done_old, done_new, fresh] = [task("quiet"), task("busy"), task("done", "done"), task("done, opened", "done"), task("fresh")];
  on_messages(s, () => {
    for (const t of [quiet, busy, done_new]) s.add_message(t.id, "user", { text: "go" });
    db.set_setting(s.db(), write.SETTING, "false");
    s.add_message(done_old.id, "user", { text: "from before the setting" });
    db.set_setting(s.db(), write.SETTING, null);
  });
  const run = db.insert_run(s.db(), busy.id, "prompt");
  const moved = await source.flip_all(s);
  // `fresh` has no messages: it moves, with nothing to rebuild. `done_old`'s items were never kept: it's rebuilt.
  assert.deepEqual(moved, { moved: 3, rebuilt: 1, deferred: 1 });
  assert.deepEqual(
    [quiet, busy, done_old, done_new, fresh].map((t) => on(s, t.id)),
    ["items", "messages", "items", "items", "items"],
  );
  assert.deepEqual(texts(s, done_old.id), ["from before the setting"]);
  db.run(s.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
  source.settled(s, busy.id);
  assert.equal(on(s, busy.id), "items");
  // Without flips (the older database file), nothing moves.
  source.set_flips(s.db(), false);
  const other = task("on the older file");
  s.add_message(other.id, "user", { text: "hi" });
  assert.deepEqual(await source.flip_all(s), { moved: 0, rebuilt: 0, deferred: 0 });
  assert.equal(on(s, other.id), "messages");
});

// HA-225's prerequisite: done tasks left on messages by HA-222 (their items an older build's, or never kept), and tasks
// with a question waiting, move at the start, so none is on messages.
test("at the start, done tasks are rebuilt onto items, and a task waiting on a question moves with it still open", async (t) => {
  runs.TEST_CAN_RUN.set(true);
  t.after(() => runs.TEST_CAN_RUN.set(false));
  const { s, events, task } = setup();
  const [old, stale, asking, gate] = [
    task("never kept", "done"),
    task("an older converter's", "done"),
    task("asking", "needs_attention"),
    task("merge gate", "needs_attention"),
  ];
  let q = 0;
  let card = 0;
  on_messages(s, () => {
    db.set_setting(s.db(), write.SETTING, "false");
    s.add_message(old.id, "user", { text: "from before the setting" });
    s.add_message(old.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: "done that" }] } });
    db.set_setting(s.db(), write.SETTING, null);
    s.add_message(stale.id, "user", { text: "kept" });
    s.add_message(asking.id, "user", { text: "go" });
    q = s.add_message(asking.id, "question", { ...questions.card({ question: "Which?", options: ["A", "B"] }), call_id: "call-1", status: "pending" }).id;
    s.add_message(gate.id, "user", { text: "go" });
    db.run(s.db(), "UPDATE tasks SET merging=1, merge_approval='pending' WHERE id=?1", gate.id);
    merge_gate.ask(s, gate.id);
    card = history.open_questions(s.db(), gate.id)[0]!.id;
  });
  db.run(s.db(), "UPDATE threads SET converter=1 WHERE task_id=?1", stale.id);
  db.run(s.db(), "UPDATE tasks SET thread_items=0 WHERE id=?1", asking.id);
  const before = [old, stale, asking, gate].map((x) => rows(s, x.id));
  events.length = 0;
  assert.deepEqual(await source.flip_all(s), { moved: 1, rebuilt: 3, deferred: 0 });
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM tasks WHERE thread_source <> 'items'"), 0);
  assert.deepEqual(texts(s, old.id), ["from before the setting"]);
  assert.equal(store.items(s.db(), old.id).length, 2);
  assert.deepEqual(texts(s, stale.id), ["kept"]);
  assert.equal(db.value(s.db(), "SELECT converter FROM threads WHERE task_id=?1", stale.id), CONVERTER_VERSION);
  // Clients are told each task moved, and to load its rebuilt thread again.
  for (const x of [old, stale, asking])
    assert.ok(
      events.some((e) => e.type === "thread_resync" && e.task_id === x.id),
      x.title,
    );
  // The question is still open, and answering it sends the reply, written as an item.
  assert.deepEqual(
    history.open_questions(s.db(), asking.id).map((o) => o.id),
    [q],
  );
  questions.answer(s, asking.id, q, { choices: ["B"] });
  assert.equal(db.get_message(s.db(), q, asking.id)?.data.status, "answered");
  assert.equal(store.get_request(s.db(), asking.id, `legacy:${q}`)?.resolution?.outcome, "answer");
  const reply = testing
    .messages(s.db(), asking.id)
    .filter((m) => m.kind === "user")
    .at(-1)!;
  assert.match(reply.data.text, /> Which\?\n\nB/);
  assert.equal(store.get_item(s.db(), asking.id, `legacy:${reply.id}`)?.type, "user_message");
  await idle(s, asking.id);
  // The merge gate's card too.
  assert.deepEqual(
    history.open_questions(s.db(), gate.id).map((o) => o.id),
    [card],
  );
  merge_gate.settle(s, gate.id, "replaced");
  assert.equal(db.get_message(s.db(), card, gate.id)?.data.status, "replaced");
  // Their messages are as they were: nothing was written to them since.
  assert.deepEqual(
    [old, stale, asking, gate].map((x) => rows(s, x.id)),
    before,
  );
});

// Review of HA-222: a rebuild that failed as a task was to move onto items threw out of insert_message and start_run,
// so the write was lost, and every later one failed the same way.
test("a rebuild that fails as a task moves onto items leaves it on messages, and its writes go on as rows", async (t) => {
  runs.TEST_CAN_RUN.set(true);
  t.onTestFinished(() => runs.TEST_CAN_RUN.set(false));
  const { s, task } = setup();
  const x = task("stale", "done");
  on_messages(s, () => s.add_message(x.id, "user", { text: "from before" }));
  // Items an older converter wrote: moving needs a rebuild.
  db.run(s.db(), "UPDATE threads SET converter=1 WHERE task_id=?1", x.id);
  let tried = 0;
  let armed = true;
  const bug = () => {
    if (!armed) return;
    tried++;
    throw new Error("translator bug");
  };
  testing.when("threads:rebuild", bug);
  const event = s.add_message(x.id, "event", { level: "info", text: "an event" });
  assert.equal(tried, 1);
  assert.deepEqual([on(s, x.id), rows(s, x.id)], ["messages", 2]);
  assert.equal(db.value(s.db(), "SELECT json_extract(data, '$.text') FROM messages WHERE id=?1", event.id), "an event");
  // Not tried again on the next write (start_run's prompt): it goes in as a row too, and its run names it.
  testing.when("threads:rebuild", bug);
  runner.send(s, x.id, "carry on");
  assert.equal(tried, 1);
  assert.equal(on(s, x.id), "messages");
  const turn = db.value<number>(s.db(), "SELECT turn_message_id FROM runs WHERE task_id=?1", x.id)!;
  assert.equal(db.value(s.db(), "SELECT json_extract(data, '$.text') FROM messages WHERE id=?1", turn), "carry on");
  await idle(s, x.id);
  // Its items, written live beside its messages meanwhile, are still there.
  assert.ok(store.items(s.db(), x.id).length >= 3);
  // Rebuilt (by threads-rebuild, say), it moves at its next write. (The bug's hook, never reached, goes first.)
  armed = false;
  testing.reached("threads:rebuild");
  write.rebuild(s.db(), x.id);
  s.add_message(x.id, "user", { text: "after the fix" });
  assert.equal(on(s, x.id), "items");
});
