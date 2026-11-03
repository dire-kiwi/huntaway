// A task's agent-threads thread for the browser checks, served from the page's end as a host serves
// one (docs/agent-threads-api.md): its window, pages of earlier items, its saved events and its
// commands, with its events sent on /api/ws as `thread_event`s. The thread's state is folded with
// the protocol's own reducer and windows, so it's what a host would send. Agent-threads runs aren't
// on the test servers' builds yet (HA-143), so checks drive the thread from here.
import { applyEvent, initialState, itemPage, snapshotWindow } from "../../vendor/agent-threads/protocol/dist/index.js";

/**
 * Serves task `task`'s thread on `page`, starting from `items` and `requests` (made with seqs of
 * their own). `onCommand(command, thread)` is called with each command POSTed, after it's recorded
 * in `thread.commands`; it can emit events in answer. Call `connect(socket)` with the page's routed
 * /api/ws (see routeWebSocket) before emitting, and `switchOn()` to tell the page the task runs on
 * agent-threads (a `task` event with its run_engine).
 */
export async function fakeThread(page, task, { items = [], requests = [], thread: extra = {}, onCommand } = {}) {
  const id = task.id;
  let state = initialState({ id, harness: "claude", status: "idle", title: task.title, permission_mode: "default", created_at: "2026-11-01T00:00:00Z", ...extra });
  const saved = [];
  let socket = null;
  const asked = { windows: [], pages: [], events: [] };
  const t = {
    asked,
    commands: [],
    get state() {
      return state;
    },
    connect(s) {
      socket = s;
    },
    /** Applies `event` (its thread_id and seq filled in: a delta's is the latest saved one's) and sends it to the page, unless `quiet`. */
    emit(event, { quiet = false } = {}) {
      const e = { thread_id: id, ...event, seq: event.type === "delta" ? state.seq : state.seq + 1 };
      state = applyEvent(state, e);
      if (e.type !== "delta") saved.push(e);
      if (!quiet) socket?.send(JSON.stringify({ type: "thread_event", task_id: id, event: e }));
      return e;
    },
    /** The task's board fields as they'd come in a `task` event. */
    sendTask(fields) {
      socket?.send(JSON.stringify({ type: "task", task: { ...task, ...fields } }));
    },
    switchOn(fields = {}) {
      t.sendTask({ run_engine: "agent_threads", ...fields });
    },
  };
  for (const item of items) t.emit({ type: "item.added", item }, { quiet: true });
  for (const request of requests) t.emit({ type: "request.opened", request }, { quiet: true });

  await page.route(new RegExp(`/tasks/${id}/thread(/[a-z]+)?(\\?.*)?$`), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const q = url.searchParams;
    const tail = /\/thread\/([a-z]+)/.exec(url.pathname)?.[1];
    if (req.method() === "POST" && tail === "commands") {
      const command = { thread_id: id, ...req.postDataJSON() };
      t.commands.push(command);
      const error = await onCommand?.(command, t);
      if (error) return route.fulfill({ status: error.status ?? 400, json: { error: error.message } });
      return route.fulfill({ json: { ok: true } });
    }
    if (req.method() !== "GET") return route.continue();
    if (!tail) {
      const limit = q.has("limit") ? Number(q.get("limit")) : undefined;
      asked.windows.push(limit);
      return route.fulfill({ json: limit ? snapshotWindow(state, limit) : state });
    }
    if (tail === "items") {
      const before = Number(q.get("before"));
      const limit = Number(q.get("limit") ?? 100);
      asked.pages.push(before);
      return route.fulfill({ json: itemPage(state, before, limit) });
    }
    if (tail === "events") {
      const after = Number(q.get("after") ?? 0);
      asked.events.push(after);
      return route.fulfill({ json: { events: saved.filter((e) => e.seq > after), more: false, seq: state.seq } });
    }
    return route.fulfill({ status: 404, json: { error: "no such route" } });
  });
  return t;
}

/** Times a minute apart from 2026-11-01 10:00 UTC, the n-th one: for items and board messages to sort by. */
export const at = (n) => new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + n * 60_000).toISOString();
