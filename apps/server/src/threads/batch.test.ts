// Every task gets items (threads/batch.ts, step 7 of docs/threads.md): the batch rebuild of the tasks that aren't done,
// on the server and from the command line, and a done task's items when it's opened or read.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import { sleep } from "../util.ts";
import { dispatch, makeReq, router } from "../api.ts";
import * as batch from "./batch.ts";
import * as history from "./history.ts";
import * as rebuild_cli from "./rebuild.ts";
import * as store from "./store.ts";
import * as write from "./write.ts";
import { CONVERTER_VERSION } from "./translate.ts";

process.env.IA_SHIM_BIN = "/nonexistent/ia-shim";
process.env.IA_CLAUDE_BIN = "/nonexistent/claude";
process.env.IA_CODEX_BIN = "/nonexistent/codex";

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

const flagged = (s: AppState, id: string) => db.get_task(s.db(), id)!.thread_items;
const count = (s: AppState, table: string, id: string) => db.value<number>(s.db(), `SELECT COUNT(*) FROM ${table} WHERE task_id=?1`, id)!;

/** Everything a thread is in the store: its rows, its seq and its writes, to compare before and after. */
function dump(s: AppState, id: string): string {
  const c = s.db();
  return JSON.stringify([
    ["thread_items", "thread_requests", "thread_item_origins"].map((t) => db.all(c, `SELECT * FROM ${t} WHERE task_id=?1 ORDER BY 1, 2, 3`, id)),
    db.one(c, "SELECT seq, converter, writes, error FROM threads WHERE task_id=?1", id) ?? null,
    flagged(s, id),
  ]);
}

/**
 * A board from before the setting: the setting off while tasks get their messages (a user message, a call and its
 * result, a question), then on, as it is by default since step 7. `statuses` are the tasks'.
 */
function board(statuses: string[]): { s: AppState; events: any[]; tasks: Task[] } {
  const s = testing.on_items(testing.state(), false);
  db.set_setting(s.db(), write.SETTING, "false");
  const p = db.insert_profile(s.db(), "p", [], null);
  const tasks = statuses.map((status, i) => {
    const t = db.insert_task(s.db(), { profile_id: p.id, project_id: null, kind: "task", title: `t${i}`, description: "", status, use_worktree: false });
    s.add_message(t.id, "user", { text: `task ${i}` });
    s.add_message(t.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: "ls" } }] } });
    s.add_message(t.id, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "a\nb" }] } });
    s.add_message(t.id, "claude", { type: "assistant", message: { content: [{ type: "text", text: `done ${i}` }] } });
    return db.get_task(s.db(), t.id)!;
  });
  db.set_setting(s.db(), write.SETTING, null);
  const events: any[] = [];
  s.events.subscribe((e) => events.push(e));
  return { s, events, tasks };
}

async function finished(s: AppState): Promise<batch.Progress> {
  const deadline = Date.now() + 10_000;
  while (batch.progress(s)?.running) {
    assert.ok(Date.now() < deadline, "the batch is still running");
    await sleep(5);
  }
  return batch.progress(s)!;
}

test("the setting is on by default, and new tasks are flagged", () => {
  const s = testing.on_items(testing.state(), false);
  assert.equal(write.setting_on(s.db()), true);
  const p = db.insert_profile(s.db(), "p", [], null);
  const t = db.insert_task(s.db(), {
    profile_id: p.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "in_progress",
    use_worktree: false,
  });
  s.add_message(t.id, "user", { text: "hi" });
  assert.equal(flagged(s, t.id), true);
  db.set_setting(s.db(), write.SETTING, "false");
  assert.equal(write.setting_on(s.db()), false);
});

test("the batch covers the tasks that aren't done without this build's items, and running it twice changes nothing", async () => {
  const { s, events, tasks } = board(["backlog", "in_progress", "in_review", "done", "in_progress", "in_progress"]);
  const [backlog, running, review, done, old, broken] = tasks.map((t) => t.id);
  const c = s.db();
  // One with items an older converter wrote, and one whose live writes stopped on an error.
  write.rebuild(c, old!);
  db.run(c, "UPDATE threads SET converter=?2 WHERE task_id=?1", old, CONVERTER_VERSION - 1);
  write.rebuild(c, broken!);
  db.run(c, "UPDATE threads SET error='message 3: boom' WHERE task_id=?1", broken);
  // And one up to date, which it leaves alone.
  const p = db.get_task(c, backlog!)!.profile_id;
  const fresh = db.insert_task(c, { profile_id: p, project_id: null, kind: "task", title: "new", description: "", status: "in_progress", use_worktree: false });
  s.add_message(fresh.id, "user", { text: "hi" });
  assert.deepEqual(batch.pending(c).sort(), [backlog, running, review, old, broken].sort());
  const [st, before] = await call(s, "GET", "/api/admin/threads");
  assert.deepEqual([st, before], [200, { pending: 5, batch: null }]);
  const untouched = dump(s, fresh.id);

  const [code, started] = await call(s, "POST", "/api/admin/threads/batch", {});
  assert.equal(code, 200);
  assert.equal(started.batch.running, true);
  assert.equal(db.get_setting(c, batch.SETTING), started.batch.started_at);
  const p1 = await finished(s);
  assert.deepEqual([p1.total, p1.done, p1.rebuilt, p1.messages, p1.failed], [5, 5, 5, 20, []]);
  assert.equal(db.get_setting(c, batch.SETTING), null);
  assert.deepEqual(batch.pending(c), []);
  for (const id of [backlog, running, review, old, broken]) {
    assert.equal(flagged(s, id!), true);
    assert.equal(history.reads_items(c, id!), true, id);
    assert.deepEqual(write.compare(c, id!), [], id);
    // Clients are told: the task, flagged, and a resync for its thread.
    assert.ok(events.some((e) => e.type === "task" && e.task.id === id && e.task.thread_items));
    assert.ok(events.some((e) => e.type === "thread_resync" && e.task_id === id));
  }
  assert.equal(count(s, "thread_items", running!), 3);
  // Its readers read the items, which say what the messages do.
  assert.equal(history.last_assistant_text(c, running!), "done 1");
  // The done task isn't in it, and the one already up to date isn't touched.
  assert.equal(flagged(s, done!), false);
  assert.equal(count(s, "threads", done!), 0);
  assert.equal(dump(s, fresh.id), untouched);

  // Again: nothing's pending, and nothing changes.
  const all = tasks.map((t) => dump(s, t.id));
  const [, again] = await call(s, "POST", "/api/admin/threads/batch", {});
  const p2 = await finished(s);
  assert.deepEqual([again.pending, p2.total, p2.rebuilt], [0, 0, 0]);
  assert.deepEqual(
    tasks.map((t) => dump(s, t.id)),
    all,
  );
  // So does the command line's.
  const out: string[] = [];
  assert.deepEqual(
    rebuild_cli.run(rebuild_cli.parse_args(["--batch"]), c, (x) => void out.push(x)),
    [],
  );
  assert.match(out.join(""), /^0 tasks rebuilt/);
  assert.deepEqual(
    tasks.map((t) => dump(s, t.id)),
    all,
  );
});

test("the batch stops after the task it's on, goes on with the rest, and goes on after a restart", async () => {
  const { s, tasks } = board(["in_progress", "in_progress", "in_progress", "in_progress"]);
  const c = s.db();
  batch.start(s);
  // It's let go of the event loop before the first, and after each.
  await sleep(0);
  while (batch.progress(s)!.done < 1) await sleep(1);
  batch.stop(s);
  const p1 = await finished(s);
  assert.ok(p1.stopping && p1.rebuilt >= 1 && p1.rebuilt < 4, JSON.stringify(p1));
  assert.equal(batch.pending(c).length, 4 - p1.rebuilt);
  // Stopped, a restart doesn't start it again.
  assert.equal(db.get_setting(c, batch.SETTING), null);
  batch.resume(s);
  assert.equal(batch.progress(s), p1);
  // Started again, it goes on with the rest.
  batch.start(s);
  const p2 = await finished(s);
  assert.deepEqual([p2.total, p2.rebuilt, p2.stopping], [4 - p1.rebuilt, 4 - p1.rebuilt, false]);
  assert.deepEqual(batch.pending(c), []);

  // A server that stopped mid-batch (its setting still set) goes on with it when it starts.
  const { s: again, tasks: more } = board(["todo", "in_progress"]);
  db.set_setting(again.db(), batch.SETTING, "2026-11-06T00:00:00.000Z");
  batch.resume(again);
  const p3 = await finished(again);
  assert.deepEqual([p3.started_at, p3.rebuilt], ["2026-11-06T00:00:00.000Z", 2]);
  for (const t of [...tasks, ...more]) assert.equal(flagged(t.id === more[0]!.id || t.id === more[1]!.id ? again : s, t.id), true);
});

test("the batch runs while a task writes its thread, and the thread stays complete", async () => {
  const { s, tasks } = board(Array(12).fill("in_progress"));
  const c = s.db();
  const live = tasks[6]!.id;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  batch.start(s);
  // The task's agent writes between the batch's tasks, before its own rebuild and after: streamed text, a call, its
  // result, and the reply.
  let n = 0;
  const seen = new Set<boolean>();
  while (batch.progress(s)!.running) {
    seen.add(flagged(s, live));
    s.emit_delta(live, `chunk ${n} `);
    s.add_message(live, "claude", {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: `x${n}`, name: "Read", input: { file_path: `/f${n}` } }] },
    });
    await tick();
    s.add_message(live, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `x${n}`, content: "ok" }] } });
    s.add_message(live, "claude", { type: "assistant", message: { content: [{ type: "text", text: `said ${n}` }] } });
    n++;
  }
  // It wrote before its rebuild (unflagged) and after (flagged).
  assert.deepEqual([...seen].sort(), [false, true], `${n} rounds`);
  const p = batch.progress(s)!;
  assert.deepEqual([p.rebuilt, p.failed], [12, []]);
  // Written live after its rebuild, its items are what a rebuild of all of its messages makes.
  assert.deepEqual(write.compare(c, live), []);
  const messages = db.value<number>(c, "SELECT COUNT(*) FROM messages WHERE task_id=?1", live)!;
  assert.ok(count(s, "thread_item_origins", live) >= messages - 1);
  assert.equal(history.last_assistant_text(c, live), `said ${n - 1}`);
  // It goes on.
  s.add_message(live, "claude", { type: "assistant", message: { content: [{ type: "text", text: "after" }] } });
  assert.deepEqual(write.compare(c, live), []);
  assert.equal(history.last_assistant_text(c, live), "after");
});

test("a done task gets its items when it's opened, or read, with the setting on", async () => {
  const { s, events, tasks } = board(["done", "done", "done", "done", "done"]);
  const c = s.db();
  const [by_task, by_messages, by_thread, by_reader, off] = tasks.map((t) => t.id);
  // The task itself.
  const [, got] = await call(s, "GET", `/api/tasks/${by_task}`);
  assert.equal(got.task.thread_items, true);
  assert.equal(got.last_message, "done 0");
  assert.deepEqual(write.compare(c, by_task!), []);
  assert.ok(events.some((e) => e.type === "task" && e.task.id === by_task && e.task.thread_items));
  assert.ok(events.some((e) => e.type === "thread_resync" && e.task_id === by_task));
  // Its messages' latest page (the thread view on messages, which then switches to items); not an earlier page.
  const first = db.value<number>(c, "SELECT MIN(id) FROM messages WHERE task_id=?1", by_messages)!;
  await call(s, "GET", `/api/tasks/${by_messages}/messages?before=${first + 2}&limit=1`);
  assert.equal(flagged(s, by_messages!), false);
  const [code, page] = await call(s, "GET", `/api/tasks/${by_messages}/messages?limit=100`);
  assert.equal(code, 200);
  assert.equal(page.messages.length, 4);
  assert.equal(flagged(s, by_messages!), true);
  // Its thread, which would be a 404 without items.
  const [tc, thread] = await call(s, "GET", `/api/tasks/${by_thread}/thread?limit=10`);
  assert.equal(tc, 200);
  assert.deepEqual(
    thread.items.map((i: any) => i.type),
    ["user_message", "tool_call", "assistant_message"],
  );
  // A reader.
  assert.equal(history.source(c, by_reader!), "items");
  assert.equal(flagged(s, by_reader!), true);
  // Opening it again changes nothing.
  const once = dump(s, by_task!);
  await call(s, "GET", `/api/tasks/${by_task}`);
  assert.equal(dump(s, by_task!), once);
  // With the setting off, nothing is built: it's read and drawn from its messages, as before.
  db.set_setting(c, write.SETTING, "false");
  await call(s, "GET", `/api/tasks/${off}`);
  await call(s, "GET", `/api/tasks/${off}/messages?limit=100`);
  assert.equal((await call(s, "GET", `/api/tasks/${off}/thread`))[0], 404);
  assert.equal(history.source(c, off!), "messages");
  assert.equal(count(s, "threads", off!), 0);
  assert.equal(flagged(s, off!), false);
});

// The UI tests: a task opened before its first message got an empty thread and was flagged, so its composer sent
// thread commands, and the batch counted every task that had never started.
test("a task with no messages isn't in the batch or rebuilt when it's opened: its first message flags it", async () => {
  const { s, tasks } = board(["in_progress"]);
  const c = s.db();
  const p = db.get_task(c, tasks[0]!.id)!.profile_id;
  const empty = db.insert_task(c, { profile_id: p, project_id: null, kind: "task", title: "new", description: "", status: "todo", use_worktree: false });
  assert.deepEqual(batch.pending(c), [tasks[0]!.id]);
  await call(s, "GET", `/api/tasks/${empty.id}`);
  await call(s, "GET", `/api/tasks/${empty.id}/messages?limit=100`);
  assert.equal((await call(s, "GET", `/api/tasks/${empty.id}/thread`))[0], 404);
  assert.deepEqual([flagged(s, empty.id), count(s, "threads", empty.id)], [false, 0]);
  s.add_message(empty.id, "user", { text: "first" });
  assert.equal(flagged(s, empty.id), true);
  assert.equal(history.reads_items(c, empty.id), true);
});

test("a task's items written by an older converter are rebuilt when it's opened; a broken one is left alone", async () => {
  const { s, tasks } = board(["done", "done"]);
  const c = s.db();
  const [old, broken] = tasks.map((t) => t.id);
  write.rebuild(c, old!);
  db.run(c, "UPDATE threads SET converter=?2 WHERE task_id=?1", old, CONVERTER_VERSION - 1);
  assert.equal(history.source(c, old!), "items");
  assert.equal(db.value(c, "SELECT converter FROM threads WHERE task_id=?1", old), CONVERTER_VERSION);
  write.rebuild(c, broken!);
  db.run(c, "UPDATE threads SET error='boom' WHERE task_id=?1", broken);
  assert.equal(history.source(c, broken!), "messages");
  assert.equal(db.value(c, "SELECT error FROM threads WHERE task_id=?1", broken), "boom");
});

test("a rebuild that fails when a task's opened changes nothing, and isn't tried again on every read", async () => {
  const { s, tasks } = board(["done"]);
  const c = s.db();
  const id = tasks[0]!.id;
  testing.when("threads:rebuild", () => {
    throw new Error("a translator bug");
  });
  assert.equal(write.ensure(c, id), false);
  assert.equal(count(s, "threads", id), 0);
  assert.equal(flagged(s, id), false);
  // The hook has gone, so another try would work: it isn't made.
  assert.equal(history.source(c, id), "messages");
  assert.equal(history.last_assistant_text(c, id), "done 0");
  assert.equal(flagged(s, id), false);
  // The batch and the command line still rebuild it.
  rebuild_cli.run(rebuild_cli.parse_args([id]), c, () => {});
  assert.equal(history.source(c, id), "items");
});

test("the command line's batch rebuilds the pending tasks beside a server, and shows its progress", () => {
  const dir = testing.temp_dir();
  const file = join(dir, "huntaway.db");
  const a = db.open(file);
  const b = rebuild_cli.open(file);
  try {
    db.set_setting(a, write.SETTING, "false");
    const p = db.insert_profile(a, "p", [], null);
    const ids = ["in_progress", "done", "todo"].map((status) => {
      const t = db.insert_task(a, { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status, use_worktree: false });
      db.insert_message(a, t.id, "user", { text: "go" });
      db.insert_message(a, t.id, "claude", {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] },
      });
      return t.id;
    });
    db.set_setting(a, write.SETTING, null);
    const out: string[] = [];
    const results = rebuild_cli.run(rebuild_cli.parse_args(["--batch"]), b, (x) => void out.push(x));
    assert.deepEqual(
      results.map((r) => [r.task_id, r.rebuilt?.messages]).sort(),
      [
        [ids[0], 2],
        [ids[2], 2],
      ].sort(),
    );
    assert.match(out[0]!, new RegExp(`^\\[1/2\\] ${results[0]!.task_id}: 2 messages, 2 items`));
    assert.match(out[1]!, /^\[2\/2\] /);
    assert.match(out[2]!, /^2 tasks rebuilt, in [\d.]+ s/);
    // The server's connection goes on from the rebuilt thread.
    db.insert_message(a, ids[0]!, "claude", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] } });
    assert.equal((store.get_item(a, ids[0]!, "c1") as any).status, "completed");
    assert.deepEqual(write.compare(a, ids[0]!), []);
    assert.equal(db.get_task(a, ids[1]!)!.thread_items, false);
    assert.throws(() => rebuild_cli.parse_args(["--batch", "--all"]), /name the tasks, or --all, or --batch/);
  } finally {
    a.close();
    b.close();
  }
});
