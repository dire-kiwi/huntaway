// The thread API and live thread events (threads/live.ts, docs/threads-api.md), on the spec's example thread: the port
// of HA-145's server/src/threads/live/tests.rs, for items kept in place in the board's own tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import { sleep } from "../util.ts";
import { dispatch, makeReq, router } from "../api.ts";
import * as runs from "../agent/runs.ts";
import { read_json, read_jsonl } from "./examples.ts";
import { apply_event, apply_events, initial_state, type NewEvent, type SavedEvent, type Snapshot, type ThreadEvent } from "./protocol.ts";
import * as store from "./store.ts";
import * as live from "./live.ts";
import { Translator } from "./translate.ts";

// No agent runs here: a run's launch fails rather than starting a real `claude`.
process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

const EVENTS = read_jsonl("thread.events.jsonl") as ThreadEvent[];
const SNAPSHOT = read_json("thread.snapshot.json") as Snapshot;
const WINDOW = read_json("thread.window.json") as Snapshot;
const PAGE = read_json("thread.page.json");

/** Status and body (JSON, or the text if it isn't) of a request to the API. */
async function call(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const headers: Record<string, string> = { authorization: "Bearer " };
  if (body !== undefined) headers["content-type"] = "application/json";
  const a = await dispatch(s, makeReq(method, path, headers, body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

function new_task(s: AppState, profile_id: string, title = "t"): Task {
  return db.insert_task(s.db(), { profile_id, project_id: null, kind: "task", title, description: "", status: "in_progress", use_worktree: false });
}

/** Until the launch of `id`'s run is over: it fails, as there's no agent here. */
async function idle(s: AppState, id: string) {
  const deadline = Date.now() + 30_000;
  while (s.is_running(id)) {
    assert.ok(Date.now() < deadline, `${id} is still running`);
    await sleep(10);
  }
}

/** A state with a task in one profile, and another profile with a task of its own. */
function setup() {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const other = db.insert_profile(s.db(), "work", [], null);
  return { s, task: new_task(s, p.id), others: new_task(s, other.id, "theirs") };
}

/** An example event as task `task`'s thread's, unnumbered, as the store is given it. */
function for_task(e: ThreadEvent, task: string): NewEvent {
  const { thread_id: _t, seq: _s, ...rest } = (e.type === "thread.updated" ? { ...e, thread: { ...e.thread, id: task } } : e) as SavedEvent;
  return rest as NewEvent;
}

const saved_events = () => EVENTS.filter((e) => e.type !== "delta");

/**
 * Saves the example thread's events for `task`, as writing its messages would (step 3): the first user message's
 * items from message `message_id` (when given), the rest from no message.
 */
function save_example(s: AppState, task: string, message_id?: number) {
  const events = saved_events();
  store.append(s.db(), task, events.slice(0, 2).map((e) => for_task(e, task)), { message_id });
  store.append(s.db(), task, events.slice(2).map((e) => for_task(e, task)));
}

/** The example `v` (a snapshot or window) as task `task`'s: its thread is the task's own state. */
const as_task = (s: AppState, task: Task, v: Snapshot): Snapshot => ({ ...v, thread: live.thread_of(s, db.get_task(s.db(), task.id)!) });

const seqs = (events: SavedEvent[]) => events.map((e) => e.seq);

/** What `s` sends its clients from now on (thread events only). */
function listen(s: AppState): any[] {
  const got: any[] = [];
  s.events.subscribe((v) => {
    if (v?.type === "thread_event" || v?.type === "thread_resync") got.push(v);
  });
  return got;
}

test("a thread is read whole, in windows and in pages, from this host and through the hub's path", async () => {
  const { s, task } = setup();
  save_example(s, task.id);
  for (const base of ["/api", "/api/h/h"]) {
    const at = (p: string) => `${base}/tasks/${task.id}/thread${p}`;
    assert.deepEqual(await call(s, "GET", at("")), [200, as_task(s, task, SNAPSHOT)], base);
    assert.deepEqual(await call(s, "GET", at("?limit=8")), [200, as_task(s, task, WINDOW)], base);
    // A limit it's within is the whole thread.
    assert.deepEqual(await call(s, "GET", at("?limit=13")), [200, as_task(s, task, SNAPSHOT)], base);
    assert.deepEqual(await call(s, "GET", at("/items?before=5&limit=3")), [200, { ...PAGE, thread_id: task.id }], base);
    const [status, page] = await call(s, "GET", at("/items?before=5"));
    assert.deepEqual([status, page.start, page.items.length], [200, 0, 5]);
    assert.equal((await call(s, "GET", at("/items")))[0], 400);
    assert.equal((await call(s, "GET", at("?limit=x")))[0], 400);
  }
});

test("the thread's own state is its task's", async () => {
  const { s, task } = setup();
  save_example(s, task.id);
  s.update_task(task.id, [["model", "sonnet"], ["permission_mode", "acceptEdits"], ["session_id", "sess_9"]]);
  const [, state] = await call(s, "GET", `/api/tasks/${task.id}/thread`);
  assert.deepEqual(
    [state.thread.id, state.thread.harness, state.thread.status, state.thread.model, state.thread.permission_mode, state.thread.session_id, state.thread.title],
    [task.id, "claude", "idle", "sonnet", "accept_edits", "sess_9", "t"],
  );
  // Running, and waiting on a request.
  s.runs.set(task.id, { run_id: "r", cancel: null });
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread`))[1].thread.status, "running");
  store.append(s.db(), task.id, [{ type: "request.opened", request: { id: "p9", type: "permission", name: "Bash", kind: "shell", input: {} } }]);
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread`))[1].thread.status, "waiting");
  s.runs.delete(task.id);
});

test("a client catches up on the saved events after its seq", async () => {
  const { s, task } = setup();
  save_example(s, task.id);
  const at = (q: string) => `/api/tasks/${task.id}/thread/events${q}`;
  // From the start, without deltas: they aren't saved.
  const [, all] = await call(s, "GET", at(""));
  assert.deepEqual([seqs(all.events), all.more, all.seq], [[...Array(34).keys()].map((i) => i + 1), false, 34]);
  // A page at a time.
  const [, first] = await call(s, "GET", at("?after=29&limit=3"));
  assert.deepEqual([seqs(first.events), first.more, first.seq], [[30, 31, 32], true, 32]);
  const [, rest] = await call(s, "GET", at("?after=32&limit=3"));
  assert.deepEqual([seqs(rest.events), rest.more, rest.seq], [[33, 34], false, 34]);
  assert.deepEqual((await call(s, "GET", at("?after=34")))[1], { events: [], more: false, seq: 34 });
  assert.equal((await call(s, "GET", at("?after=-1")))[0], 400);

  // A client that saw a gap (an event more than one past its seq) fetches what it missed, and has the whole state.
  const whole = as_task(s, task, SNAPSHOT);
  const [, seen] = await call(s, "GET", at("?limit=20"));
  let client = apply_events(initial_state(whole.thread), seen.events);
  assert.equal(client.seq, 20);
  const [, missed] = await call(s, "GET", at(`?after=${client.seq}`));
  client = apply_events(client, missed.events);
  assert.deepEqual({ ...client, thread: whole.thread }, whole);
});

test("event types a newer build saved are left out of a catch-up, and gone past", async () => {
  const { s, task } = setup();
  save_example(s, task.id);
  // 35-36 unknown, 37-38 known, 39 unknown, 40 known, 41-43 unknown: as a newer build would have saved them, before a rollback.
  const unknown = [35, 36, 39, 41, 42, 43];
  const events = [...Array(9).keys()].map((i) => i + 35).map((seq) =>
    unknown.includes(seq) ? ({ type: "thread.renamed" } as any) : ({ type: "turn.started", turn_id: `t${seq}` } as NewEvent),
  );
  store.append(s.db(), task.id, events);
  const at = (q: string) => `/api/tasks/${task.id}/thread/events?${q}`;
  const [, first] = await call(s, "GET", at("after=34&limit=1"));
  assert.deepEqual([seqs(first.events), first.more, first.seq], [[37], true, 37]);
  const [, second] = await call(s, "GET", at("after=37&limit=1"));
  assert.deepEqual([seqs(second.events), second.more, second.seq], [[38], true, 38]);
  const [, third] = await call(s, "GET", at("after=38&limit=1"));
  assert.deepEqual([seqs(third.events), third.more, third.seq], [[40], false, 43]);
  assert.deepEqual((await call(s, "GET", at("after=40")))[1], { events: [], more: false, seq: 43 });
  for (const limit of [1, 2, 3, 7]) {
    let after = 30;
    const got: number[] = [];
    for (let i = 0; ; i++) {
      assert.ok(i < 100, "never ended");
      const [, page] = await call(s, "GET", at(`after=${after}&limit=${limit}`));
      got.push(...seqs(page.events));
      after = page.seq;
      if (!page.more) break;
    }
    assert.deepEqual([got, after], [[31, 32, 33, 34, 37, 38, 40], 43], `limit ${limit}`);
  }
  // A window's seq covers them too.
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread?limit=3`))[1].seq, 43);
});

test("a client further behind than the log, or ahead of the thread, is told to resync", async () => {
  const { s, task } = setup();
  // Events from two days ago, past the log's day but for its last KEEP_EVENTS.
  const old = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
  const turns = (n: number, from: number): NewEvent[] => [...Array(n).keys()].map((i) => ({ type: "turn.started", turn_id: `t${from + i}` }));
  store.append(s.db(), task.id, turns(store.KEEP_EVENTS + 50, 0), { at: old });
  store.append(s.db(), task.id, turns(1, store.KEEP_EVENTS + 50));
  const last = store.KEEP_EVENTS + 51;
  const at = (q: string) => `/api/tasks/${task.id}/thread/events?${q}`;
  // The log keeps the last KEEP_EVENTS: from seq 52 on.
  assert.deepEqual((await call(s, "GET", at("after=10")))[1], { events: [], more: false, seq: last, resync: true });
  assert.deepEqual((await call(s, "GET", at("after=50")))[1], { events: [], more: false, seq: last, resync: true });
  const [, kept] = await call(s, "GET", at("after=51&limit=2"));
  assert.deepEqual([seqs(kept.events), kept.more], [[52, 53], true]);
  assert.deepEqual((await call(s, "GET", at(`after=${last + 5}`)))[1], { events: [], more: false, seq: last, resync: true });
  // Its window is whole, at the thread's seq.
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread?limit=5`))[1].seq, last);
});

test("live events reach clients, with the text streamed so far in snapshots", async () => {
  const { s, task } = setup();
  const got = listen(s);
  // The example's events, as the writer sends them: saved ones once committed, deltas as they stream.
  for (const e of EVENTS) {
    if (e.type === "delta") {
      const sent = live.send_delta(s, task.id, e.item_id, e.kind, e.text);
      assert.deepEqual(sent, { ...e, thread_id: task.id });
      // A snapshot taken now has the text so far, which the next delta's offset follows on from.
      const [, now] = await call(s, "GET", `/api/tasks/${task.id}/thread`);
      const item = now.items.find((i: any) => i.id === e.item_id);
      assert.equal(item.text.length, e.offset + e.text.length, JSON.stringify(item));
    } else {
      live.send_events(s, task.id, store.append(s.db(), task.id, [for_task(e, task.id)]));
    }
  }
  assert.deepEqual(
    got.map((v) => [v.type, v.task_id]),
    EVENTS.map(() => ["thread_event", task.id]),
  );
  assert.deepEqual(
    got.map((v) => v.event),
    EVENTS.map((e) => (e.type === "thread.updated" ? { ...e, thread_id: task.id, thread: { ...e.thread, id: task.id } } : { ...e, thread_id: task.id })),
  );
  // The saved text ended what was streamed: the snapshot is the saved thread's.
  assert.deepEqual((await call(s, "GET", `/api/tasks/${task.id}/thread`))[1], as_task(s, task, SNAPSHOT));
  // A client applying them all, from a snapshot taken before any, ends up there too.
  const client = apply_events(initial_state(live.thread_of(s, task)), got.map((v) => v.event));
  assert.deepEqual(client.items, SNAPSHOT.items);
  // A delta for an item the thread doesn't have isn't sent.
  assert.equal(live.send_delta(s, task.id, "nope", "text", "x"), null);
  assert.equal(got.length, EVENTS.length);
});

test("a client that connects mid-message gets the text so far, and later deltas apply to it", async () => {
  const { s, task } = setup();
  store.append(s.db(), task.id, [{ type: "item.added", item: { id: "a1", type: "assistant_message", text: "" } }]);
  live.send_delta(s, task.id, "a1", "text", "Hello");
  const [, snap] = await call(s, "GET", `/api/tasks/${task.id}/thread`);
  assert.equal(snap.items[0].text, "Hello");
  // A delta sent before the snapshot was read, arriving after it, and the next one.
  const late = { type: "delta", thread_id: task.id, seq: snap.seq, item_id: "a1", kind: "text", offset: 0, text: "Hello" } as ThreadEvent;
  const next = live.send_delta(s, task.id, "a1", "text", ", world")!;
  const after = apply_event(apply_event(snap, late), next);
  assert.equal((after.items[0] as any).text, "Hello, world");
  // A rebuild tells clients to take a fresh window, and forgets what was streamed.
  const got = listen(s);
  live.send_resync(s, task.id);
  assert.deepEqual(got, [{ type: "thread_resync", task_id: task.id }]);
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread`))[1].items[0].text, "");
});

test("tasks without items, and other tasks' threads and requests, aren't reached", async () => {
  const { s, task, others } = setup();
  save_example(s, task.id);
  const none = { error: `task ${others.id} has no thread kept as items` };
  assert.deepEqual(await call(s, "GET", "/api/tasks/nope/thread"), [404, { error: "task not found" }]);
  for (const path of ["", "/items?before=1", "/events"]) {
    assert.deepEqual(await call(s, "GET", `/api/tasks/${others.id}/thread${path}`), [404, none], path);
  }
  const cmd = (t: string) => `/api/tasks/${t}/thread/commands`;
  const respond = { type: "respond", request_id: "q1", resolution: { outcome: "cancel" } };
  assert.deepEqual(await call(s, "POST", cmd(others.id), respond), [404, none]);

  // The other profile's task gets a thread of its own, with a permission prompt.
  store.append(s.db(), others.id, [{ type: "request.opened", request: { id: "theirs", type: "permission", name: "Bash", kind: "shell", input: {} } }]);
  pending_permission(s, others, "theirs");
  // A command can't name its thread, nor answer its request through this task.
  const [status, err] = await call(s, "POST", cmd(task.id), { ...respond, thread_id: others.id });
  assert.equal(status, 400, JSON.stringify(err));
  assert.match(err.error, /isn't this task's/);
  const allow = { type: "respond", request_id: "theirs", resolution: { outcome: "allow" } };
  assert.deepEqual(await call(s, "POST", cmd(task.id), allow), [404, { error: "request not found" }]);
  assert.equal(db.value(s.db(), "SELECT status FROM permission_requests WHERE id='theirs'"), "pending");
  // Its own commands do reach it.
  assert.equal((await call(s, "POST", cmd(others.id), allow))[0], 200);
  assert.equal(db.value(s.db(), "SELECT status FROM permission_requests WHERE id='theirs'"), "allowed");

  for (const [body, says] of [
    [{ type: "nope" }, "type must be one of"],
    [{ type: "respond" }, "request_id is required"],
    [{ type: "respond", request_id: "q1" }, "resolution must be an object"],
    [{ type: "respond", request_id: "q1", resolution: { outcome: "maybe" } }, "resolution.outcome"],
    [{ type: "send" }, "text is required"],
    [{ type: "send", text: "hi", attachments: [{ kind: "file", path: "/etc/passwd" }] }, "attachments aren't taken here"],
    [{ type: "set_options" }, "needs model, effort or permission_mode"],
    [{ type: "set_options", permission_mode: "acceptEdits" }, "permission_mode must be one of"],
    [{ type: "rewind" }, "needs the user message's item_id"],
    [[], "a JSON object"],
  ] as const) {
    const [status, err] = await call(s, "POST", cmd(task.id), body);
    assert.ok(status === 400 && String(err.error).includes(says), `${JSON.stringify(body)}: ${status} ${JSON.stringify(err)}`);
  }
  // A thread goes with its task.
  db.run(s.db(), "DELETE FROM tasks WHERE id=?1", task.id);
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread`))[0], 404);
});

/** A pending permission prompt `id` on `task` for `tool`, with its message, as mcp/permissions.ts raises one. */
function pending_permission(s: AppState, task: Task, id: string, tool = "Bash", input: any = { command: "ls" }) {
  const m = s.add_message(task.id, "permission", { request_id: id, tool_name: tool, input, status: "pending" });
  db.run(
    s.db(),
    "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id) VALUES (?1,?2,?3,?4,?5,'pending','',?1)",
    id, task.id, m.id, tool, JSON.stringify(input),
  );
  return m;
}

test("respond answers permission prompts, plans and questions through the board's routes", async (t) => {
  const { s, task } = setup();
  // A question's answer is sent to the agent, whose launch fails here.
  runs.TEST_CAN_RUN.set(true);
  t.after(() => runs.TEST_CAN_RUN.set(false));
  const cmd = `/api/tasks/${task.id}/thread/commands`;
  const status = (id: string) => ({ ...db.one<{ status: string; note: string | null }>(s.db(), "SELECT status, note FROM permission_requests WHERE id=?1", id) });
  const open = (request: any) => store.append(s.db(), task.id, [{ type: "request.opened", request }]);

  // A tool's prompt: allowed always, or denied with a reason.
  open({ id: "p1", type: "permission", name: "Bash", kind: "shell", input: {} });
  pending_permission(s, task, "p1");
  const [code, out] = await call(s, "POST", cmd, { type: "respond", request_id: "p1", resolution: { outcome: "allow", always: true } });
  assert.deepEqual([code, out], [200, { ok: true, result: { ok: true, status: "allowed" } }]);
  assert.equal(status("p1")!.status, "allowed");
  // Answered already: the route's own answer.
  assert.equal((await call(s, "POST", cmd, { type: "respond", request_id: "p1", resolution: { outcome: "deny" } }))[0], 409);
  open({ id: "p2", type: "permission", name: "Bash", kind: "shell", input: {} });
  pending_permission(s, task, "p2");
  await call(s, "POST", cmd, { type: "respond", request_id: "p2", resolution: { outcome: "deny", message: "not that" } });
  assert.deepEqual(status("p2"), { status: "denied", note: "not that" });

  // A plan, approved into a mode.
  open({ id: "plan1", type: "plan", plan: "Do it" });
  pending_permission(s, task, "plan1", "ExitPlanMode", { plan: "Do it" });
  s.update_task(task.id, [["permission_mode", "plan"]]);
  const [plan_code, plan_out] = await call(s, "POST", cmd, { type: "respond", request_id: "plan1", resolution: { outcome: "allow", permission_mode: "accept_edits" } });
  assert.equal(plan_code, 200, JSON.stringify(plan_out));
  assert.equal(status("plan1")!.status, "allowed");
  assert.equal(db.get_task(s.db(), task.id)!.permission_mode, "acceptEdits");

  // Claude's questions, answered by question id.
  const asked = { questions: [{ question: "Which runner?", header: "Runner", options: [{ label: "vitest" }, { label: "jest" }], multiSelect: false }] };
  open({ id: "q1", type: "question", questions: [{ id: "Which runner?", question: "Which runner?", options: [{ label: "vitest" }, { label: "jest" }] }] });
  pending_permission(s, task, "q1", "AskUserQuestion", asked);
  const answer = { type: "respond", request_id: "q1", resolution: { outcome: "answer", answers: { "Which runner?": ["vitest"] } } };
  const [q_code, q_out] = await call(s, "POST", cmd, answer);
  assert.equal(q_code, 200, JSON.stringify(q_out));
  const input = JSON.parse(db.value<string>(s.db(), "SELECT input FROM permission_requests WHERE id='q1'")!);
  assert.deepEqual([status("q1")!.status, input.answers], ["allowed", { "Which runner?": "vitest" }]);

  // A question asked with request_user_input: its answer is sent as the user's message.
  const m = s.add_message(task.id, "question", { question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }], status: "pending", call_id: "c1" });
  open({ id: `legacy:${m.id}`, type: "question", questions: [{ id: "q", question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }] }] });
  const reply = { type: "respond", request_id: `legacy:${m.id}`, resolution: { outcome: "answer", answers: { q: ["Yes"] } } };
  const [r_code, r_out] = await call(s, "POST", cmd, reply);
  assert.equal(r_code, 200, JSON.stringify(r_out));
  const now = db.list_messages(s.db(), task.id);
  assert.deepEqual(now.find((x) => x.id === m.id)!.data.answer, { choices: ["Yes"], text: null });
  assert.ok(now.some((x) => x.kind === "user" && x.data.text.includes("Yes")), JSON.stringify(now.map((x) => x.kind)));

  await idle(s, task.id);
  // A request the board isn't waiting on.
  open({ id: "gone", type: "permission", name: "Bash", kind: "shell", input: {} });
  assert.equal((await call(s, "POST", cmd, { type: "respond", request_id: "gone", resolution: { outcome: "allow" } }))[0], 409);
});

test("send, compact, interrupt, set_options, rewind and new_session go onto the board's handlers", async (t) => {
  const { s, task } = setup();
  save_example(s, task.id, s.add_message(task.id, "user", { text: "Fix the failing test" }).id);
  const cmd = `/api/tasks/${task.id}/thread/commands`;
  // send is POST /messages, which refuses as it does for the board.
  const refused = await call(s, "POST", cmd, { type: "send", text: "Carry on" });
  assert.deepEqual(refused, [400, { error: "This host can't run agents (it has no claude or codex CLI, or no ia-shim)" }]);
  runs.TEST_CAN_RUN.set(true);
  t.after(() => runs.TEST_CAN_RUN.set(false));
  // The message is the user's, whether or not its agent could start (here it can't).
  const [sent_code, sent] = await call(s, "POST", cmd, { type: "send", text: "Carry on" });
  assert.equal(sent_code, 200, JSON.stringify(sent));
  assert.equal(sent.result.id, task.id);
  assert.ok(db.list_messages(s.db(), task.id).some((m) => m.kind === "user" && m.data.text === "Carry on"));
  // interrupt is POST /stop, once the launch has failed.
  await idle(s, task.id);
  assert.deepEqual(await call(s, "POST", cmd, { type: "interrupt", thread_id: task.id }), [200, { ok: true, result: { stopped: false } }]);
  // set_options is PATCH /tasks/{id}, in the board's names.
  const [set_code, set] = await call(s, "POST", cmd, { type: "set_options", model: "opus", permission_mode: "dont_ask" });
  assert.equal(set_code, 200, JSON.stringify(set));
  assert.deepEqual([set.result.model, set.result.permission_mode], ["opus", "dontAsk"]);
  assert.equal((await call(s, "GET", `/api/tasks/${task.id}/thread`))[1].thread.permission_mode, "dont_ask");
  // rewind is POST /rewind, for the message the user_message item came from: this task has no worktree to rewind.
  const [rw_code, rw] = await call(s, "POST", cmd, { type: "rewind", turn_id: "t1", conversation: true });
  assert.deepEqual([rw_code, rw], [400, { error: "the task has no worktree of its own to rewind" }]);
  assert.equal((await call(s, "POST", cmd, { type: "rewind", item_id: "a1" }))[0], 400);
  assert.equal((await call(s, "POST", cmd, { type: "rewind", turn_id: "t9" }))[0], 404);
  // u2 came from no known message.
  assert.equal((await call(s, "POST", cmd, { type: "rewind", item_id: "u2" }))[0], 409);
  // new_session: the next message starts a new conversation.
  s.update_task(task.id, [["session_id", "sess_1"]]);
  const [ns_code, ns] = await call(s, "POST", cmd, { type: "new_session" });
  assert.deepEqual([ns_code, ns.result.session_id], [200, null]);
  s.update_task(task.id, [["session_id", "sess_2"]]);
  s.runs.set(task.id, { run_id: "r", cancel: null });
  assert.equal((await call(s, "POST", cmd, { type: "new_session" }))[0], 409);
  s.runs.delete(task.id);
  // compact is the composer's `/compact`.
  const [c_code, compacted] = await call(s, "POST", cmd, { type: "compact" });
  assert.equal(c_code, 200, JSON.stringify(compacted));
  await idle(s, task.id);
});

test("requests the translator makes from the board's prompts and questions are answered", async (t) => {
  const { s, task } = setup();
  runs.TEST_CAN_RUN.set(true);
  t.after(() => runs.TEST_CAN_RUN.set(false));
  // The board's rows, as mcp/permissions.ts and mcp/questions.ts write them, through the translator into the store.
  pending_permission(s, task, "perm1");
  s.add_message(task.id, "question", { question: "Merge now?", options: [{ label: "Yes" }, { label: "No" }], status: "pending", call_id: "c1" });
  const tr = new Translator();
  for (const m of db.list_messages(s.db(), task.id)) {
    const step = tr.message(m);
    store.append(s.db(), task.id, step.events, { message_id: m.id });
  }
  const reqs = store.open_requests(s.db(), task.id);
  assert.deepEqual(reqs.map((r) => [r.type, r.id.startsWith("legacy:") ? "legacy" : r.id]), [["permission", "perm1"], ["question", "legacy"]]);
  const cmd = `/api/tasks/${task.id}/thread/commands`;
  const allowed = await call(s, "POST", cmd, { type: "respond", request_id: "perm1", resolution: { outcome: "allow" } });
  assert.equal(allowed[0], 200, JSON.stringify(allowed));
  assert.equal(db.value(s.db(), "SELECT status FROM permission_requests WHERE id='perm1'"), "allowed");
  const q = reqs[1]!;
  assert.equal(q.type, "question");
  const qid = (q as any).questions[0].id;
  const respond = (answers: string[]) => call(s, "POST", cmd, { type: "respond", request_id: q.id, resolution: { outcome: "answer", answers: { [qid]: answers } } });
  // The route's own checks: a question that takes one answer.
  assert.deepEqual(await respond(["No", "Not yet"]), [400, { error: "this question takes one answer" }]);
  // Free text, which isn't one of its options.
  const answered = await respond(["Not yet"]);
  assert.equal(answered[0], 200, JSON.stringify(answered));
  const card = db.list_messages(s.db(), task.id).find((m) => m.kind === "question")!;
  assert.deepEqual(card.data.answer, { choices: [], text: "Not yet" });
  await idle(s, task.id);
});
