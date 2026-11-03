// How an agent-threads task's thread (agent-threads' items, drawn by its React package) is put
// together with what the board keeps of the task in its own messages: its permission prompts, the
// questions asked with request_user_input, and its events, which an agent-threads run still records
// there (threads/engine.rs). Pure functions, so they're tested without a browser.
import type { Item, ThreadRequest, UserMessage } from "@dire-kiwi/agent-threads-protocol";
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

/** Rows' times (see rowTime): rows unchanged by an event are the same objects, so they're worked out once. */
const times = new WeakMap<Row, number | null>();

/** When a row was made: its item's (a group's first call's), or its request's. */
export function rowTime(row: Row): number | null {
  let t = times.get(row);
  if (t !== undefined) return t;
  if (row.type === "tool_group") t = parseTime(row.calls[0]?.created_at);
  else if (row.type === "request") t = parseTime(row.request.created_at);
  else t = parseTime(row.created_at);
  times.set(row, t);
  return t;
}

/** The board's messages that are drawn in an agent-threads task's thread. */
const BOARD_KINDS = new Set<Message["kind"]>(["permission", "question", "event"]);

/** The latest of the board's message ids an import of the task's history has in the thread (as `legacy:<id>` items or requests), or 0. */
export function importedUpTo(items: readonly Item[], requests: readonly ThreadRequest[]): number {
  let n = 0;
  const legacy = (id: string) => {
    if (!id.startsWith("legacy:")) return;
    const m = Number(id.slice(7));
    if (m > n) n = m;
  };
  for (const it of items) legacy(it.id);
  for (const r of requests) legacy(r.id);
  return n;
}

/**
 * The board's messages to draw with the thread: its prompts, questions and events, but not those an
 * import of the task's history has in the thread already (up to message `imported`, see
 * importedUpTo), nor a prompt the thread has as a request with its id.
 */
export function boardMessages(messages: readonly Message[] | undefined, imported: number, requests: readonly ThreadRequest[]): Message[] {
  if (!messages?.length) return NO_MESSAGES;
  const ids = new Set(requests.map((r) => r.id));
  const out = messages.filter(
    (m) => BOARD_KINDS.has(m.kind) && m.id > imported && !(m.kind === "permission" && typeof m.data?.request_id === "string" && ids.has(m.data.request_id)),
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
  if (!board.length) return rows.map((row) => ({ kind: "row", row }));
  const out: MergedRow[] = [];
  const at = board.map((m) => parseTime(m.created_at) ?? Infinity);
  let b = 0;
  let first = true;
  for (const row of rows) {
    const t = rowTime(row);
    if (t !== null) {
      if (first && hasEarlier) while (b < board.length && at[b] < t) b++;
      while (b < board.length && at[b] < t) out.push({ kind: "board", message: board[b++] });
      first = false;
    }
    out.push({ kind: "row", row });
  }
  // Those after the last row, unless the thread has none loaded with a time.
  if (!(first && hasEarlier)) while (b < board.length) out.push({ kind: "board", message: board[b++] });
  return out;
}

/** The main thread's user messages among `items` (the same list as `prev` if they're the same ones, so it can be memoized on). */
export function mainUserMessages(items: readonly Item[], prev?: readonly UserMessage[]): readonly UserMessage[] {
  const out: UserMessage[] = [];
  for (const it of items) if (it.type === "user_message" && !it.parent_id) out.push(it);
  return prev && prev.length === out.length && prev.every((x, i) => x === out[i]) ? prev : out;
}

/** The board's message ids of the user messages in the thread (see mainUserMessages), by item id: for marking where the task can be rewound to. */
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
