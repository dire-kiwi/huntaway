// Items written straight into a thread rather than made from a message (step 11 of docs/threads.md): a Codex run's
// notifications, which agent/codex/driver.ts maps onto the model's events itself. The board's own messages in the same
// thread (the user's, its events, prompts and questions, a turn's result) still go through the translator
// (threads/write.ts), which is told of what was written here (`Translator.observe`), so a prompt for one of these calls,
// or a subagent's, finds it.
import { run, tx, value, type Conn } from "../db.ts";
import { now, reached } from "../util.ts";
import type { NewEvent, SavedEvent } from "./protocol.ts";
import * as source from "./source.ts";
import * as store from "./store.ts";
import { CONVERTER_VERSION, type ItemMeta } from "./translate.ts";
import { forget, translator } from "./write.ts";

/**
 * Appends `events` (and the items' metas, `meta`, each whole) to task `task_id`'s thread, in one transaction (the
 * caller's, if it has one). Each write is given a message id of its own (`source.next_id`), the origin of the items it
 * touches, so items keep their order with the board's messages by origin as they do by position. Returns the saved
 * events, to send once committed (threads/live.ts's send_events). Throws if they can't be written: nothing of them is.
 */
export function append(c: Conn, task_id: string, events: NewEvent[], meta: Map<string, ItemMeta> = new Map()): SavedEvent[] {
  if (!events.length && !meta.size) return [];
  try {
    return tx(c, () => {
      reached("threads:native");
      const writes = value<number>(c, "SELECT writes FROM threads WHERE task_id=?1", task_id);
      if (writes === undefined) run(c, "INSERT INTO threads (task_id, converter, created_at) VALUES (?1, ?2, ?3)", task_id, CONVERTER_VERSION, now());
      const l = translator(c, task_id, writes ?? 0);
      const saved = store.append(c, task_id, events, { message_id: source.next_id(c) });
      for (const [id, m] of meta) store.set_item_meta(c, task_id, id, m);
      const touched = new Set<string>(meta.keys());
      for (const e of events) {
        if (e.type === "item.added") touched.add(e.item.id);
        else if (e.type === "item.updated") touched.add(e.item_id);
      }
      for (const id of touched) {
        const item = store.get_item(c, task_id, id);
        if (item) l.t.observe(item, store.item_meta(c, task_id, id));
      }
      run(c, "UPDATE threads SET writes=?2 WHERE task_id=?1", task_id, (writes ?? 0) + 1);
      l.writes = (writes ?? 0) + 1;
      return saved;
    });
  } catch (e) {
    // Its translator may have taken in what was rolled back.
    forget(c, task_id);
    throw e;
  }
}
