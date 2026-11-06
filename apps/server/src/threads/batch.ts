// Carrying existing tasks over to threads kept as items (step 7 of docs/threads.md): the batch rebuild, and the
// rebuild of a task that's opened without items.
//
// The batch covers every task that isn't done whose thread this build doesn't keep as items yet (`pending`): one from
// before the setting was on, one an older converter wrote, or one whose live writes stopped on an error. Not a task
// with no messages, which its first message flags (with the setting on), as for a new task. Each is
// rebuilt from its messages by threads/write.ts's `rebuild`, one task per transaction. In the server that transaction
// is synchronous, so no message of the task can be written in the middle of it (it's the task's write lock): a task
// that's running, streaming even, goes on writing its items live from the rebuilt thread (whose translator the rebuild
// leaves in memory), and its clients take a fresh window (`thread_resync`). Between tasks it yields to the event loop.
// From the command line (`huntaway threads-rebuild --batch`, threads/rebuild.ts), each transaction takes the database's
// write lock as it starts, and the server's translators notice the rebuild through `threads.writes`.
//
// It can be stopped and resumed: what it has rebuilt is committed, and isn't pending any more, so starting it again goes
// on with the rest. A batch the server was running when it stopped (`SETTING` says so) goes on when it starts again.
//
// Done tasks aren't in it (the plan's `backfill` question): a done task gets its items when it's first opened (`opened`,
// from the task's routes) or when a reader reads it (threads/history.ts's `source`), so the database doesn't grow by
// the size of the whole board at once.
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import type { AppState } from "../state.ts";
import { background, err_str, now } from "../util.ts";
import { on_items } from "./history.ts";
import * as live from "./live.ts";
import { ensure, rebuild } from "./write.ts";

/** Set (to when it started) while the server's batch is unfinished, so a restart goes on with it. */
export const SETTING = "thread_batch";

/**
 * What the batch covers, on tasks aliased `t`: tasks that aren't done, have messages, and whose readers don't read
 * items yet. One with no messages needs no rebuild: its first message flags it (with the setting on), with no gap.
 */
const PENDING = `t.status <> 'done' AND EXISTS(SELECT 1 FROM messages m WHERE m.task_id = t.id) AND NOT ${on_items()}`;

/** The tasks the batch covers, oldest first. */
export function pending(c: Conn): string[] {
  return db.all<{ id: string }>(c, `SELECT t.id FROM tasks t WHERE ${PENDING} ORDER BY t.created_at, t.id`).map((r) => r.id);
}

/** Whether task `task_id` is still one the batch covers. */
function is_pending(c: Conn, task_id: string): boolean {
  return !!db.one(c, `SELECT 1 FROM tasks t WHERE t.id=?1 AND ${PENDING}`, task_id);
}

/** A batch's progress, as `GET /admin/threads` shows it. */
export interface Progress {
  started_at: string;
  /** The tasks pending when it started (or went on, after a restart or a stop). */
  total: number;
  /** How many of them it's been through: rebuilt, failed, or skipped (rebuilt meanwhile, or deleted). */
  done: number;
  rebuilt: number;
  messages: number;
  failed: Array<{ task_id: string; error: string }>;
  /** The task it's rebuilding now. */
  current: string | null;
  /** Until it's finished (or stopped). */
  running: boolean;
  /** Asked to stop: it stops after the task it's on. */
  stopping: boolean;
  finished_at: string | null;
  /** The time it's taken, rebuilding (not counting what it yielded to). */
  ms: number;
}

const batches = new WeakMap<object, Progress>();

/** The batch the server is running, or ran last since it started; null if none. */
export function progress(s: AppState): Progress | null {
  return batches.get(s) ?? null;
}

/** What `GET /admin/threads` returns: how many tasks the batch would rebuild now, and the batch's progress. */
export function status(s: AppState): { pending: number; batch: Progress | null } {
  return { pending: pending(s.db()).length, batch: progress(s) };
}

/** Starts the batch (or goes on with it), unless it's running. Returns its progress. */
export function start(s: AppState): Progress {
  const running = batches.get(s);
  if (running?.running) {
    running.stopping = false;
    return running;
  }
  const c = s.db();
  const started_at = db.get_setting(c, SETTING) ?? now();
  db.set_setting(c, SETTING, started_at);
  const p: Progress = { started_at, total: 0, done: 0, rebuilt: 0, messages: 0, failed: [], current: null, running: true, stopping: false, finished_at: null, ms: 0 };
  batches.set(s, p);
  background("the threads' batch rebuild", go(s, p));
  return p;
}

/** Asks the batch to stop after the task it's on. It can be started again, and goes on with the rest. */
export function stop(s: AppState): Progress | null {
  const p = batches.get(s);
  if (p?.running) p.stopping = true;
  return p ?? null;
}

/** At the server's start: goes on with a batch it was running when it stopped. */
export function resume(s: AppState): void {
  if (db.get_setting(s.db(), SETTING) !== null) start(s);
}

/** Yields to the event loop, so requests and agents' output go on between tasks. */
const pause = () => new Promise<void>((r) => setImmediate(r));

async function go(s: AppState, p: Progress): Promise<void> {
  try {
    await pause();
    const ids = pending(s.db());
    p.total = ids.length;
    console.log(`${now()} huntaway: rebuilding the threads of ${ids.length} tasks as items`);
    for (const id of ids) {
      if (p.stopping) break;
      const c = s.db();
      p.current = id;
      const t0 = performance.now();
      try {
        // Rebuilt meanwhile (opened, or by the command line), done or deleted since: skipped.
        if (is_pending(c, id)) {
          const r = rebuild(c, id);
          p.rebuilt++;
          p.messages += r.messages;
          announce(s, id);
        }
      } catch (e: any) {
        p.failed.push({ task_id: id, error: err_str(e) });
        console.error(`${now()} ERROR huntaway: task ${id}'s thread couldn't be rebuilt as items: ${err_str(e)}`);
      }
      p.ms += performance.now() - t0;
      p.done++;
      await pause();
    }
  } catch (e) {
    console.error(`${now()} ERROR huntaway: the threads' batch rebuild stopped: ${err_str(e)}`);
  } finally {
    p.current = null;
    p.running = false;
    p.finished_at = now();
    // Stopped, it's left to go on with when started again (not at a restart, though: stopping is for good until then).
    try {
      db.set_setting(s.db(), SETTING, null);
    } catch {}
    console.log(`${now()} huntaway: the threads' batch rebuild ${p.stopping ? "stopped" : "finished"}: ${p.rebuilt} of ${p.total} tasks rebuilt in ${Math.round(p.ms)} ms, ${p.failed.length} failed`);
  }
}

/** Tells clients task `task_id` was rebuilt: the task (now with `thread_items`), and `thread_resync` for its thread. */
function announce(s: AppState, task_id: string): void {
  const t = db.get_task(s.db(), task_id);
  if (t) s.emit_task(t);
  live.send_resync(s, task_id);
}

/**
 * Task `task_id` is being opened (its messages' latest page, its thread, the task itself): if it has no items this build
 * wrote and the setting is on, it gets them now (write.ts's `ensure`), and clients are told. A done task's items come
 * this way, or from a reader (history.ts's `source`).
 */
export function opened(s: AppState, task_id: string): void {
  if (ensure(s.db(), task_id)) announce(s, task_id);
}
