// Items become the source (step 10 of docs/threads.md, plan decision D6): where each task's thread is written,
// `tasks.thread_source`.
//
// A task on `messages` is as before: each message is a `messages` row, and its items (if `thread_items`) are made from
// it in the same transaction (threads/write.ts's `written`). A task on `items` gets no `messages` rows: each message
// goes through the translator into its items only (write.ts's `wrote_items`), from every write point, since they all go
// through db/messages.ts's insert_message and update_message_data (plan decision D3).
//
// A message of an items task still has an id, the one its row would have had: `next_id` takes it from the messages
// table's own AUTOINCREMENT sequence without writing a row, so ids stay unique across the board and in order within a
// task across its move onto items. Everything that names a message by its id goes on naming the same thing: the items
// the translator makes from it are `legacy:<id>[:<block>]` with it as their origin (thread_item_origins), a prompt's or
// question's request has it as its metadata's `message_id`, and `permission_requests.message_id`, `checkpoints.message_id`
// and `runs.turn_message_id` hold it, so they name an item or a request. Those of an items task are read from items
// (threads/history.ts), never from a row. The messages updated in place (a prompt's, a question's, a routine's report)
// are read back from what their request or item keeps of them (`kept`), which is the message's data as it was written.
//
// Tasks move onto items one at a time (`flip`), when they're quiet: no run going (a task mid-turn waits for its run to
// end) and no prompt waiting for an answer (a question may be). Their items must be complete and this build's, so one that
// isn't (never rebuilt, an older converter's, live writes stopped on an error) is rebuilt from its messages first, in
// the same transaction. It happens at the server's start (`flip_all`), when a run ends (`settled`), and before any
// message is written to a quiet task that's still on messages (insert_message, start_run): a new task moves with its
// first message, so its thread starts on items. Moving back (`flip_back`) is safe until the thread's first write since
// it moved, while its messages are still whole.
//
// Only on a board whose database is huntaway-2.db (plan decision D7, see db/file.ts): an older build, rolled back to,
// opens the older file as it was before the update, with every thread whole. On the older file (IA_NEW_DB_FILE=0)
// tasks stay on messages (`set_flips`).
import * as db from "../db.ts";
import type { Conn, Message } from "../db.ts";
import type { AppState } from "../state.ts";
import { err_str, now, reached } from "../util.ts";
import * as live from "./live.ts";
import type { ThreadRequest } from "./protocol.ts";
import * as store from "./store.ts";
import { CONVERTER_VERSION } from "./translate.ts";
import { rebuild_rows, wrote_items } from "./write.ts";

export type Source = "messages" | "items";

const flipping = new WeakMap<Conn, boolean>();

/** Whether tasks on this connection's board move onto items (serve.ts turns it on with huntaway-2.db). Off by default. */
export function set_flips(c: Conn, on: boolean): void {
  flipping.set(c, on);
}

export function flips(c: Conn): boolean {
  return flipping.get(c) ?? false;
}

/** Where task `task_id`'s thread is written. */
export function of(c: Conn, task_id: string): Source {
  return db.value<string>(c, "SELECT thread_source FROM tasks WHERE id=?1", task_id) === "items" ? "items" : "messages";
}

/**
 * The id a message would have had as a row (see the top of the file): the next of the messages table's AUTOINCREMENT
 * sequence, which a row inserted later also goes on from.
 */
export function next_id(c: Conn): number {
  const r = db.one<{ seq: number }>(c, "UPDATE sqlite_sequence SET seq=seq+1 WHERE name='messages' RETURNING seq");
  if (r) return Number(r.seq);
  // No message has ever been written: the sequence starts.
  const id = (db.value<number>(c, "SELECT COALESCE(MAX(id), 0) FROM messages") ?? 0) + 1;
  db.run(c, "INSERT INTO sqlite_sequence (name, seq) VALUES ('messages', ?1)", id);
  return id;
}

// ---------- moving onto items ----------

/**
 * Why task `task_id` can't move onto items now (see the top of the file), or null if it's quiet. A question waiting for
 * an answer (the board's request_user_input card, the merge gate's) doesn't hold it back: its rebuilt request is open,
 * with the question as its metadata, and answering it changes that (`update`), as for a question asked on items.
 */
export function busy(c: Conn, task_id: string): string | null {
  if (db.has_active_run(c, task_id)) return "its agent is running";
  if (db.one(c, "SELECT 1 FROM permission_requests WHERE task_id=?1 AND status='pending' LIMIT 1", task_id)) return "a prompt is waiting for an answer";
  return null;
}

/** What `flip` did: the task was on items already, moved onto them (rebuilding them first), or stays on messages. */
export type Flip = "items" | "moved" | "rebuilt" | null;

/** Whether task `task_id`'s items are complete and this build's: what moving onto them needs, short of a rebuild. */
function current(c: Conn, task_id: string): boolean {
  return !!db.one(
    c,
    "SELECT 1 FROM tasks t JOIN threads h ON h.task_id=t.id WHERE t.id=?1 AND t.thread_items=1 AND h.error IS NULL AND h.converter=?2",
    task_id,
    CONVERTER_VERSION,
  );
}

/**
 * The tasks whose rebuild failed as they were to move onto items, with what their thread's `rebuilt_at` was then: one
 * isn't tried again on every write (it stays on messages) until it's rebuilt some other way (`huntaway threads-rebuild`,
 * from another process too, changes `rebuilt_at`) or the server restarts.
 */
const unbuilt = new WeakMap<Conn, Map<string, string>>();

/** The thread's `rebuilt_at`, as `unbuilt` keeps it ("" for none). */
const rebuilt_at = (c: Conn, task_id: string) => db.value<string | null>(c, "SELECT rebuilt_at FROM threads WHERE task_id=?1", task_id) ?? "";

/**
 * Moves task `task_id` onto items if it's quiet (`busy`) and this board moves tasks (`flips`), in one transaction (the
 * caller's, if it has one): its items are rebuilt from its messages first unless they're complete and this build's.
 * A task with no messages yet (a new one) just starts its thread. What it did (see Flip). A rebuild that fails (a
 * translator or store bug on its history) is logged and leaves the task on messages, as it was, so the write it's
 * called from goes on as a row, as before this step; it isn't tried again until the thread is rebuilt (see `unbuilt`).
 */
export function flip(c: Conn, task_id: string): Flip {
  return db.tx(c, (): Flip => {
    const t = db.one<{ thread_source: string }>(c, "SELECT thread_source FROM tasks WHERE id=?1", task_id);
    if (!t) return null;
    if (t.thread_source === "items") return "items";
    if (!flips(c) || busy(c, task_id) !== null) return null;
    reached("threads:flip");
    let rebuilt = false;
    if (!current(c, task_id)) {
      const thread = db.one(c, "SELECT 1 FROM threads WHERE task_id=?1", task_id);
      if (!thread && !db.one(c, "SELECT 1 FROM messages WHERE task_id=?1 LIMIT 1", task_id)) {
        db.run(c, "INSERT INTO threads (task_id, converter, created_at) VALUES (?1, ?2, ?3)", task_id, CONVERTER_VERSION, now());
      } else {
        const failed = unbuilt.get(c);
        if (failed?.get(task_id) === rebuilt_at(c, task_id)) return null;
        try {
          // A savepoint of its own: a rebuild that throws part-way leaves nothing of it.
          db.tx(c, () => rebuild_rows(c, task_id));
        } catch (e) {
          let mine = failed;
          if (!mine) unbuilt.set(c, (mine = new Map()));
          mine.set(task_id, rebuilt_at(c, task_id));
          console.error(
            `${now()} ERROR huntaway: task ${task_id} stays on its messages: its thread couldn't be rebuilt as items to move onto them: ${err_str(e)}`,
          );
          return null;
        }
        unbuilt.get(c)?.delete(task_id);
        rebuilt = true;
      }
    }
    db.run(c, "UPDATE tasks SET thread_source='items', thread_items=1 WHERE id=?1", task_id);
    db.run(c, "UPDATE threads SET flipped_at=?2, flipped_writes=writes WHERE task_id=?1", task_id, now());
    // Moved, but not yet committed: a crash here leaves the task on messages, as it was.
    reached("threads:flipped");
    return rebuilt ? "rebuilt" : "moved";
  });
}

/**
 * Moves task `task_id` back onto messages, while that's safe: before its thread's first write since it moved, so its
 * messages are still the whole thread. Throws why it can't.
 */
export function flip_back(c: Conn, task_id: string): void {
  db.tx(c, () => {
    const r = db.one<{ thread_source: string; writes: number | null; flipped_writes: number | null }>(
      c,
      "SELECT t.thread_source, h.writes, h.flipped_writes FROM tasks t LEFT JOIN threads h ON h.task_id=t.id WHERE t.id=?1",
      task_id,
    );
    if (!r) throw new Error(`no task ${task_id}`);
    if (r.thread_source !== "items") throw new Error(`task ${task_id}'s thread is on its messages already`);
    if (r.flipped_writes == null) throw new Error(`task ${task_id}'s thread started on items: it has no messages to go back to`);
    if (r.writes !== r.flipped_writes) {
      throw new Error(
        `task ${task_id}'s thread has been written since it moved onto items (${(r.writes ?? 0) - r.flipped_writes} times), and its messages don't have that`,
      );
    }
    db.run(c, "UPDATE tasks SET thread_source='messages' WHERE id=?1", task_id);
    db.run(c, "UPDATE threads SET flipped_at=NULL, flipped_writes=NULL WHERE task_id=?1", task_id);
  });
}

/**
 * For the tests (testing.ts's `messages`): what an items task's messages were written as, which they compare with what
 * a task on messages has in its rows. Off (and nothing kept) unless a test's state turns it on.
 */
const journals = new WeakMap<Conn, Map<number, Message>>();

export function keep_journal(c: Conn): Map<number, Message> {
  let j = journals.get(c);
  if (!j) journals.set(c, (j = new Map()));
  return j;
}

/** Message `m` of an items task was written (inserted, or changed in place): the tests' journal has it, if it's kept. */
export function journal(c: Conn, m: Message): void {
  journals.get(c)?.set(m.id, structuredClone(m));
}

/** The messages whose write moved their task onto items (insert_message), for AppState.emit_message to tell clients. */
const moved_by = new WeakMap<object, Flip>();

export function note_moved(m: object, how: Flip): void {
  if (how === "moved" || how === "rebuilt") moved_by.set(m, how);
}

/** How writing message `m` moved its task onto items, if it did. */
export function moved(m: object): Flip {
  return moved_by.get(m) ?? null;
}

/** Tells clients task `task_id` moved onto items (`how`): the task, and a `thread_resync` if its items were rebuilt. */
export function announce(s: AppState, task_id: string, how: Flip): void {
  if (how !== "moved" && how !== "rebuilt") return;
  const t = db.get_task(s.db(), task_id);
  if (t) s.emit_task(t);
  if (how === "rebuilt") live.send_resync(s, task_id);
}

/** Task `task_id`'s run ended: it moves onto items if it's quiet now. */
export function settled(s: AppState, task_id: string): void {
  try {
    announce(s, task_id, flip(s.db(), task_id));
  } catch (e) {
    console.error(`${now()} ERROR huntaway: task ${task_id} couldn't move onto items: ${err_str(e)}`);
  }
}

/** Yields to the event loop, so requests and agents' output go on between tasks. */
const pause = () => new Promise<void>((r) => setImmediate(r));

/**
 * At the server's start: moves every quiet task that's still on messages onto items, one transaction each, yielding
 * between them. Tasks mid-turn move when their run ends (`settled`). Those that aren't done go first, oldest first; then
 * the done ones, whose items are mostly an older build's or none (the batch leaves them out), so they're rebuilt from
 * their messages as they move. A rebuild that fails leaves its task on messages (see `flip`), and the log says how many
 * are left.
 */
export async function flip_all(s: AppState): Promise<{ moved: number; rebuilt: number; deferred: number }> {
  const out = { moved: 0, rebuilt: 0, deferred: 0 };
  if (!flips(s.db())) return out;
  await pause();
  const ids = db.all<{ id: string }>(s.db(), "SELECT id FROM tasks WHERE thread_source <> 'items' ORDER BY status = 'done', created_at, id");
  const t0 = performance.now();
  for (const { id } of ids) {
    try {
      const how = flip(s.db(), id);
      if (how === "moved") out.moved++;
      else if (how === "rebuilt") out.rebuilt++;
      else if (how === null) out.deferred++;
      announce(s, id, how);
    } catch (e) {
      console.error(`${now()} ERROR huntaway: task ${id} couldn't move onto items: ${err_str(e)}`);
    }
    await pause();
  }
  if (ids.length) {
    const ms = Math.round(performance.now() - t0);
    const left = db.value<number>(s.db(), "SELECT COUNT(*) FROM tasks WHERE thread_source <> 'items'") ?? 0;
    console.log(
      `${now()} huntaway: ${out.moved + out.rebuilt} tasks moved onto items (${out.rebuilt} rebuilt first) in ${ms} ms; ${out.deferred} didn't (mid-turn, a prompt waiting, or a failed rebuild); ${left} are on messages`,
    );
  }
  return out;
}

// ---------- the messages an items task keeps in its items ----------

const parse = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * Message `id` of items task `task_id` as its request or item keeps it: a prompt's or question's (its request's
 * metadata is the message's data, with `message_id`; a plain prompt's input is the request's own), or a routine's report
 * (its notice's metadata). These are the messages the board changes in place. Null if neither has it.
 */
export function kept(c: Conn, task_id: string, id: number): Message | null {
  // A question's request is `legacy:<its message's id>`, a prompt's has the board's request id.
  let request: ThreadRequest | null = store.get_request(c, task_id, `legacy:${id}`);
  if (request?.metadata?.message_id !== id) {
    const row = db.one<{ data: string }>(
      c,
      "SELECT data FROM thread_requests WHERE task_id=?1 AND json_extract(data, '$.metadata.message_id')=?2",
      task_id,
      id,
    );
    request = row ? parse(row.data) : null;
  }
  if (request?.metadata) {
    const { message_id: _, ...data } = request.metadata as { [k: string]: any };
    // A question asked with the board's request_user_input (or the merge gate's card) has no tool; a prompt has.
    const kind = request.type === "question" && request.id === `legacy:${id}` && data.tool_name === undefined ? "question" : "permission";
    if (kind === "permission" && request.type === "permission" && !("input" in data)) data.input = request.input;
    return { id, task_id, kind, data, created_at: request.created_at ?? "" };
  }
  const item = store.get_item(c, task_id, `legacy:${id}`);
  if (item?.type === "notice" && item.code === "routine_report")
    return { id, task_id, kind: "report", data: { ...(item.metadata ?? {}) }, created_at: item.created_at ?? "" };
  return null;
}

/**
 * Changes message `id` of items task `task_id` to `data` (if its status is still `pending`, with `pending`), as
 * db/messages.ts's update_message_data does for a row: the message as it's kept (`kept`), fed to the translator again
 * with its new data. Null if there's no such message (or it isn't pending), or its items couldn't be written.
 */
export function update(c: Conn, task_id: string, id: number, data: any, pending: boolean): Message | null {
  return db.tx(c, () => {
    const was = kept(c, task_id, id);
    if (!was || (pending && was.data?.status !== "pending")) return null;
    const m: Message = { ...was, data: JSON.parse(JSON.stringify(data ?? null)) };
    if (!wrote_items(c, m, false)) return null;
    journal(c, m);
    return m;
  });
}
