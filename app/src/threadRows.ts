// How an agent-threads task's thread (agent-threads' items, drawn by its React package) is put
// together with what the board keeps of the task in its own messages: its permission prompts, the
// questions asked with request_user_input, and its events, which an agent-threads run still records
// there (threads/engine.rs). Pure functions, so they're tested without a browser.
import type { Item, Snapshot, ThreadRequest, UserMessage } from "@dire-kiwi/agent-threads-protocol";
import type { Row } from "@dire-kiwi/agent-threads-react";
import type { Message } from "./api";

/** A row of the thread: one of the package's, or one of the board's own messages. */
export type MergedRow = { kind: "row"; row: Row } | { kind: "board"; message: Message };

/** Milliseconds since the epoch of a timestamp in RFC 3339 or SQLite's `YYYY-MM-DD HH:MM:SS` (UTC), or null. */
export function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.includes("T") ? s : s.replace(" ", "T");
  // SQLite's have no zone, and are UTC.
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(t)) t += "Z";
  const n = Date.parse(t);
  return Number.isNaN(n) ? null : n;
}

/** When a row was made: its item's (a group's first call's), or its request's. */
export function rowTime(row: Row): number | null {
  if (row.type === "tool_group") return parseTime(row.calls[0]?.created_at);
  if (row.type === "request") return parseTime(row.request.created_at);
  return parseTime(row.created_at);
}

/** The board's messages that are drawn in an agent-threads task's thread. */
const BOARD_KINDS = new Set<Message["kind"]>(["permission", "question", "event"]);

/**
 * The board's messages to draw with the thread: its prompts, questions and events, but not those an
 * import of the task's history has in the thread already (as `legacy:<id>` items or requests, or a
 * request with the prompt's id). An imported thread has the messages up to the latest it names.
 */
export function boardMessages(messages: readonly Message[] | undefined, snapshot: Pick<Snapshot, "items" | "requests">): Message[] {
  if (!messages?.length) return NO_MESSAGES;
  let imported = 0;
  const requests = new Set<string>();
  const legacy = (id: string) => {
    const m = /^legacy:(\d+)$/.exec(id);
    if (m) imported = Math.max(imported, Number(m[1]));
  };
  for (const it of snapshot.items) legacy(it.id);
  for (const r of snapshot.requests) {
    legacy(r.id);
    requests.add(r.id);
  }
  const out = messages.filter(
    (m) => BOARD_KINDS.has(m.kind) && m.id > imported && !(m.kind === "permission" && typeof m.data?.request_id === "string" && requests.has(m.data.request_id)),
  );
  return out.length ? out : NO_MESSAGES;
}

const NO_MESSAGES: Message[] = [];

/**
 * The thread's rows with the board's messages among them, each before the first row made after it.
 * While there are earlier items to load (`hasEarlier`), messages from before the first row loaded
 * wait for them. Rows with no time go where the row before them is.
 */
export function mergeRows(rows: readonly Row[], board: readonly Message[], hasEarlier: boolean): MergedRow[] {
  const out: MergedRow[] = [];
  const times = board.map((m) => parseTime(m.created_at) ?? Infinity);
  let b = 0;
  let first = true;
  for (const row of rows) {
    const t = rowTime(row);
    if (t !== null) {
      if (first && hasEarlier) while (b < board.length && times[b] < t) b++;
      while (b < board.length && times[b] < t) out.push({ kind: "board", message: board[b++] });
      first = false;
    }
    out.push({ kind: "row", row });
  }
  // Those after the last row, unless the thread has none loaded with a time.
  if (!(first && hasEarlier)) while (b < board.length) out.push({ kind: "board", message: board[b++] });
  return out;
}

/** The board's message ids of the user messages in the thread, by item id: for marking where the task can be rewound to. */
export function userMessageIds(items: readonly Item[], board: readonly Message[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  // The board's user messages not yet matched to an item, oldest first.
  const sent = (board ?? []).filter((m) => m.kind === "user");
  let at = 0;
  for (const it of items) {
    if (it.type !== "user_message" || it.parent_id) continue;
    // An import's user messages are the board's own.
    const legacy = /^legacy:(\d+)$/.exec(it.id);
    if (legacy) {
      out.set(it.id, Number(legacy[1]));
      continue;
    }
    // Otherwise the board's message with the same text, in the same order (the engine records each
    // message it sends to the thread on the board too).
    const text = (it as UserMessage).text.trim();
    for (let i = at; i < sent.length; i++) {
      if ((sent[i].data?.text ?? "").trim() !== text) continue;
      out.set(it.id, sent[i].id);
      at = i + 1;
      break;
    }
  }
  return out;
}

/** When the user last sent the agent a message in the main thread, or null: requests opened before it are ones it moved on from. */
export function lastSentAt(items: readonly Item[]): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "user_message" && !it.parent_id) return parseTime(it.created_at);
  }
  return null;
}

/** Whether the conversation has moved on since `request` was opened: the user sent a message after it. */
export function movedOn(request: ThreadRequest, sentAt: number | null): boolean {
  const t = parseTime(request.created_at);
  return sentAt !== null && t !== null && sentAt > t;
}
