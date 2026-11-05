// A task's thread as items, requests and numbered events: the model the server keeps (threads/store.ts) and the app
// draws, shared by both. The app imports this file by relative path, so it must stay plain TypeScript that both
// packages' settings accept: no imports, no Node APIs, only erasable syntax, and nothing unused.
//
// It's agent-threads' protocol (~/personal/agent-threads, spec/PROTOCOL.md and ts/packages/protocol at main 5ad670a),
// with its names and shapes, trimmed to what Huntaway uses. Ours is Huntaway's now: nothing depends on matching it,
// and the commit is noted so later ideas can be compared. What it leaves out of the spec: the thread's run,
// standing answers, rate limits, `resume_at` and `turn_at` (Huntaway keeps runs, approvals, usage limits and rewinds in
// its own tables), questions kept open after their turn (`user_messages`), and `raw` payloads (messages are the source,
// and thread_item_origins says which ones an item came from). `docs/threads.md` describes how Huntaway uses it.
//
// Names follow the server's convention (snake_case functions, as in the Rust it was ported from): agent-threads'
// applyEvent is apply_event here, snapshotWindow snapshot_window, and so on.

// ---------- threads ----------

/** idle: no turn is running. running: a turn is running. waiting: a turn is waiting on an open request. error: the last turn failed. */
export type ThreadStatus = "idle" | "running" | "waiting" | "error";

/**
 * default: ask through the permission policy. accept_edits: file edits in cwd are allowed without asking. auto: Claude
 * Code's classifier decides (Huntaway's addition). plan: the agent plans and changes nothing. bypass: nothing is asked,
 * and what would be is allowed. dont_ask: nothing is asked, and what would be is denied.
 */
export type PermissionMode = "default" | "accept_edits" | "auto" | "plan" | "bypass" | "dont_ask";

/** Token counts. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

/** A thread's own state, sent whole in `thread.updated` and in snapshots. A task has one thread, whose id is the task's. */
export interface Thread {
  id: string;
  /** The agent runtime: "claude" or "codex". */
  harness: string;
  status: ThreadStatus;
  title?: string;
  /** The model the next turn uses, as the harness names it. */
  model?: string;
  effort?: string;
  permission_mode?: PermissionMode;
  /** The working directory the harness runs in. */
  cwd?: string;
  /** The harness's own session or thread id, used to resume it. */
  session_id?: string;
  usage?: Usage;
  /** What went wrong, when status is error. */
  error?: string;
  /** The app's own data. */
  metadata?: { [k: string]: unknown };
  created_at: string;
  updated_at?: string;
}

// ---------- items ----------

/** A file sent with a message: inline as base64 data, or by path on the server's machine. */
export interface Attachment {
  kind: "image" | "file";
  name?: string;
  media_type?: string;
  data?: string;
  path?: string;
}

/** What every item has besides its id and type. */
interface ItemBase {
  id: string;
  /** The id of the subagent tool_call this item belongs to. Absent for the main conversation. */
  parent_id?: string;
  /** The turn the item was made in. */
  turn_id?: string;
  created_at?: string;
}

/** A message to the agent. */
export interface UserMessage extends ItemBase {
  type: "user_message";
  text: string;
  attachments?: Attachment[];
  /** Sent while a turn was running, so it joined that turn. */
  steered?: boolean;
  /** Sent, but the harness hasn't taken it in yet. An item.updated clears it. */
  queued?: boolean;
  /** The client_id of the send command that made it. */
  client_id?: string;
}

/** Text from the agent, as Markdown. While it streams, deltas append to text, and an item.updated sets the final text. */
export interface AssistantMessage extends ItemBase {
  type: "assistant_message";
  text: string;
}

/** The agent's thinking, or a summary of it. Streams like assistant_message. */
export interface Reasoning extends ItemBase {
  type: "reasoning";
  text: string;
}

/** What a tool does, for permission policies and for picking a renderer (see PROTOCOL.md, "Tool calls"). */
export type ToolKind = "shell" | "read" | "edit" | "search" | "web" | "mcp" | "app" | "subagent" | "todo" | "other";

/** pending: called, not started. running: no result yet. completed, failed (result.content is the error), denied, cancelled (its turn ended first). */
export type ToolStatus = "pending" | "running" | "completed" | "failed" | "denied" | "cancelled";

/** What a tool returned. For a failed call, content is the error. */
export interface ToolResult {
  /** The result as text. Images become [image]. */
  content: string;
  structured?: unknown;
  /** content was cut short. */
  truncated?: boolean;
  /** shell: the command's exit code. */
  exit_code?: number;
}

export interface FileChange {
  path: string;
  op: "add" | "update" | "delete";
  /** A unified diff of the change, or the content of an added file. */
  diff?: string;
  move_to?: string;
}

export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/** A subagent as its call shows it. */
export interface SubagentState {
  status: SubagentStatus;
  /** Its call returned as soon as it started, and it carries on (after its turn has ended too) until it ends. */
  background?: boolean;
  agent_type?: string;
  model?: string;
  /** What it's doing, as of its latest progress report. */
  activity?: string;
  tool_uses?: number;
  /** A background subagent's final report, once it has ended. */
  summary?: string;
}

/**
 * A tool the agent called, with its result once it has one. A subagent is a tool_call of kind subagent, and the items
 * it makes have its id as their parent_id. The fields after `result` are the same facts for every harness.
 */
export interface ToolCall extends ItemBase {
  type: "tool_call";
  /** The tool's name as the harness gave it. For an MCP tool, the tool's own name, with the server's in `server`. */
  name: string;
  kind: ToolKind;
  input: unknown;
  status: ToolStatus;
  result?: ToolResult;
  /** A short summary of the call, e.g. a subagent's description. */
  title?: string;
  /** shell: the command line. */
  command?: string;
  /** read, search: the file or directory. */
  path?: string;
  /** edit: the files it changes. */
  changes?: FileChange[];
  /** search: the pattern. web: the search query. */
  query?: string;
  /** web: the URL fetched. */
  url?: string;
  /** mcp: the MCP server's name. */
  server?: string;
  /** todo: the whole list after the call. */
  todos?: Todo[];
  subagent?: SubagentState;
}

/** The harness compacted the conversation's context. */
export interface Compaction extends ItemBase {
  type: "compaction";
  trigger?: "auto" | "manual";
  summary?: string;
  tokens_before?: number;
}

/** Something to tell the user that isn't the agent talking. `code` says what kind (e.g. retry, hook, stderr, rewind). */
export interface Notice extends ItemBase {
  type: "notice";
  level: "info" | "warning" | "error";
  text: string;
  code?: string;
  detail?: string;
}

/** Where a turn left the harness's session: its id, the harness's mark for the turn (`at`), and whether it started it. */
export interface TurnSession {
  id: string;
  at?: string;
  started?: boolean;
  /** The turn was lost before the harness gave its mark. */
  lost?: boolean;
}

/** How a turn ended: the last item of each turn. */
export interface TurnResult extends ItemBase {
  type: "turn_result";
  /** It finished without an error. An interrupted turn isn't ok. */
  ok: boolean;
  interrupted?: boolean;
  error?: string;
  usage?: Usage;
  duration_ms?: number;
  session?: TurnSession;
}

/** One entry in a thread, told apart by type. */
export type Item = UserMessage | AssistantMessage | Reasoning | ToolCall | Compaction | Notice | TurnResult;
export type ItemType = Item["type"];

// ---------- requests ----------

/** How a request was answered: sent in `respond`, and repeated in `request.resolved`. */
export interface Resolution {
  /** allow, deny: a permission or a plan. answer: a question. cancel: any, dismissed or its turn ended first. */
  outcome: "allow" | "deny" | "answer" | "cancel";
  /** allow, deny: the same for matching calls from now on. */
  always?: boolean;
  /** deny: why, which the agent is told. answer: a note with the answers. */
  message?: string;
  /** A plan's allow: the mode to carry on in. */
  permission_mode?: PermissionMode;
  /** answer: for each question id, the chosen option labels or the free text. */
  answers?: { [k: string]: string[] };
}

interface RequestBase {
  id: string;
  /** The tool_call item it's for, when there is one. */
  tool_call_id?: string;
  /** The subagent tool_call that's asking, if one is. */
  parent_id?: string;
  /** Absent while it's open. */
  resolution?: Resolution;
  turn_id?: string;
  created_at?: string;
}

/** The agent wants to call a tool, and the permission policy said ask. */
export interface PermissionRequest extends RequestBase {
  type: "permission";
  name: string;
  kind: ToolKind;
  server?: string;
  input: unknown;
  title?: string;
  /** Why the harness asks, when it says. */
  reason?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  /** Unique within the request: the key for its answer. */
  id: string;
  question: string;
  header?: string;
  /** With none, the answer is free text. */
  options?: QuestionOption[];
  multi_select?: boolean;
  /** Free text as well as the options. */
  allow_other?: boolean;
  /** Don't show or log the answer. */
  secret?: boolean;
}

/** The agent asks the user questions (Claude's AskUserQuestion, Codex's requestUserInput). */
export interface QuestionRequest extends RequestBase {
  type: "question";
  questions: [Question, ...Question[]];
}

/** The agent has a plan and asks to start on it (Claude's ExitPlanMode, which Huntaway asks about as a permission prompt). */
export interface PlanRequest extends RequestBase {
  type: "plan";
  /** Markdown. */
  plan: string;
}

export type ThreadRequest = PermissionRequest | QuestionRequest | PlanRequest;

// ---------- events ----------

interface EventBase {
  thread_id: string;
  /**
   * Saved events are numbered 1, 2, 3... in their thread with no gaps (but for one a rebuild leaves, so that clients from
   * before it see a gap and take a fresh window). A delta has the seq of the last saved event before it.
   */
  seq: number;
}

/** The thread's own state changed. It carries all of it. */
export interface ThreadUpdatedEvent extends EventBase {
  type: "thread.updated";
  thread: Thread;
}
export interface TurnStartedEvent extends EventBase {
  type: "turn.started";
  turn_id: string;
}
/** A turn ended. Its turn_result item comes just before. */
export interface TurnCompletedEvent extends EventBase {
  type: "turn.completed";
  turn_id: string;
}
/** An item was added at the end, or replaces the one with its id in place. */
export interface ItemAddedEvent extends EventBase {
  type: "item.added";
  item: Item;
}
/** Each of the patch's fields replaces the item's, and one set to null is removed. id and type never change. */
export interface ItemUpdatedEvent extends EventBase {
  type: "item.updated";
  item_id: string;
  patch: { [k: string]: unknown };
}
/** Items were removed (a rewind took the conversation back to before them). `indices` are where they were, ascending. */
export interface ItemsRemovedEvent extends EventBase {
  type: "items.removed";
  item_ids: string[];
  indices: number[];
}
/**
 * Streamed text for an assistant_message (text) or reasoning item, which was `offset` long (UTF-16 code units) before it.
 * Not saved. Huntaway streams into a message before it's saved, so its deltas name an item the thread doesn't have
 * (`stream:<server>:<n>`, see threads/write.ts): a preview of the agent's next message, which apply_event leaves out. A
 * client shows it after the thread's items until an item is added to the main conversation (the message saved), or a
 * delta for another id comes.
 */
export interface DeltaEvent extends EventBase {
  type: "delta";
  item_id: string;
  kind: "text" | "reasoning";
  offset: number;
  text: string;
}
export interface RequestOpenedEvent extends EventBase {
  type: "request.opened";
  request: ThreadRequest;
}
/** A request was answered or cancelled. It stays, with its resolution. */
export interface RequestResolvedEvent extends EventBase {
  type: "request.resolved";
  request_id: string;
  resolution: Resolution;
}

export type ThreadEvent =
  | ThreadUpdatedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ItemAddedEvent
  | ItemUpdatedEvent
  | ItemsRemovedEvent
  | DeltaEvent
  | RequestOpenedEvent
  | RequestResolvedEvent;
/** Every event but a delta is saved. */
export type SavedEvent = Exclude<ThreadEvent, DeltaEvent>;
/** An event before it's numbered: what the store is given to save. */
export type NewEvent = Unnumbered<SavedEvent>;
type Unnumbered<E> = E extends unknown ? Omit<E, "seq" | "thread_id"> : never;

// ---------- commands ----------

/** Send the agent a message: it starts a turn, or steers the running one. */
export interface SendCommand {
  type: "send";
  thread_id: string;
  text: string;
  attachments?: Attachment[];
  client_id?: string;
}
export interface InterruptCommand {
  type: "interrupt";
  thread_id: string;
}
/** Answer an open request. */
export interface RespondCommand {
  type: "respond";
  thread_id: string;
  request_id: string;
  resolution: Resolution;
}
/** Change the thread's options. Ones left out stay as they are. */
export interface SetOptionsCommand {
  type: "set_options";
  thread_id: string;
  model?: string;
  effort?: string;
  permission_mode?: PermissionMode;
}
/** Take the conversation back to before a turn. */
export interface RewindCommand {
  type: "rewind";
  thread_id: string;
  turn_id: string;
}
/** The next turn starts a new conversation with the harness; the items stay. */
export interface NewSessionCommand {
  type: "new_session";
  thread_id: string;
}
/** Compact the harness's context now, in a turn of its own. */
export interface CompactCommand {
  type: "compact";
  thread_id: string;
}
export type Command = SendCommand | InterruptCommand | RespondCommand | SetOptionsCommand | RewindCommand | NewSessionCommand | CompactCommand;

// ---------- snapshots and windows ----------

/**
 * A thread's state as of `seq`: what applying its saved events in order to the empty state gives. A window (taken with
 * a limit) has only its last items, from `start`, and the items from before it that they need, whose indices are
 * `context`: they're the first `context.length` of `items`.
 */
export interface Snapshot {
  thread: Thread;
  items: Item[];
  /** Oldest first: the open ones, and the resolved ones with their resolution (a window's: see snapshot_window). */
  requests: ThreadRequest[];
  /** The seq of the last saved event it includes; 0 for none. */
  seq: number;
  start?: number;
  context?: number[];
}

/** The thread's items before an index (a window's start), a page at a time. */
export interface ItemPage {
  thread_id: string;
  /** The items of `context`, then the thread's items from `start` up to the index asked for. */
  items: Item[];
  /** The requests anchored in its items (after the context ones). */
  requests: ThreadRequest[];
  /** 0: there's nothing before it. */
  start: number;
  context: number[];
  seq: number;
}

// ---------- the reducer ----------
//
// It never changes the state it's given. What an event leaves as it was keeps its identity: an event about one item
// makes a new items array holding a new object for that item, and every other item is the same object, so a UI row
// showing it needn't redraw. An event that changes nothing returns the state itself.

/** A thread's state before any of its events. */
export function initial_state(thread: Thread): Snapshot {
  return { thread, items: [], requests: [], seq: 0 };
}

/**
 * The state after `event`. Events for another thread, and saved events the state already has (seq at or below
 * state.seq, e.g. replayed after a reconnect), change nothing.
 */
export function apply_event(state: Snapshot, event: ThreadEvent): Snapshot {
  if (event.thread_id !== state.thread.id) return state;
  if (event.type === "delta") return apply_delta(state, event);
  if (event.seq <= state.seq) return state;
  return { ...apply_saved(state, event), seq: event.seq };
}

/** The state after each of `events` in turn. */
export function apply_events(state: Snapshot, events: Iterable<ThreadEvent>): Snapshot {
  for (const event of events) state = apply_event(state, event);
  return state;
}

/** The requests that are open: those not resolved yet. */
export function open_requests(state: Pick<Snapshot, "requests">): ThreadRequest[] {
  return state.requests.filter((r) => !r.resolution);
}

/**
 * Whether `event` shows that saved events before it were missed: it's saved, and its seq is more than one past the
 * state's. A client that sees one catches up from state.seq, or takes a fresh snapshot, rather than apply it.
 */
export function is_gap(state: Snapshot, event: ThreadEvent): boolean {
  return event.type !== "delta" && event.thread_id === state.thread.id && event.seq > state.seq + 1;
}

/** The item with `patch`'s fields set, and those set to null removed (`id` and `type` stay); the item itself if that changes nothing. */
export function patched<T extends Item>(item: T, patch: { [k: string]: unknown }): T {
  const fields = item as unknown as Record<string, unknown>;
  const changes = Object.entries(patch).filter(([k, v]) => k !== "id" && k !== "type" && (v === null ? k in fields : fields[k] !== v));
  if (!changes.length) return item;
  const next = { ...fields };
  for (const [k, v] of changes) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as unknown as T;
}

/**
 * A delta from before the last saved event the state has is already in it. Its text goes at `offset`: what the item
 * already has from there (a snapshot taken after the delta was sent) is skipped, and the rest appended. An offset past
 * the end of the text means deltas were missed: it's skipped, and the item's final text puts it right.
 */
function apply_delta(state: Snapshot, event: DeltaEvent): Snapshot {
  if (event.seq < state.seq || !event.text) return state;
  return with_item(state, event.item_id, (item) => {
    if (item.type !== (event.kind === "text" ? "assistant_message" : "reasoning")) return item;
    const have = item.text.length - event.offset;
    if (have < 0 || have >= event.text.length) return item;
    return { ...item, text: item.text + event.text.slice(have) };
  });
}

function apply_saved(state: Snapshot, event: SavedEvent): Snapshot {
  switch (event.type) {
    case "thread.updated":
      return { ...state, thread: event.thread };
    case "turn.started":
    case "turn.completed":
      return state;
    case "item.added": {
      const at = index_of(state.items, event.item.id);
      return { ...state, items: at < 0 ? [...state.items, event.item] : replace(state.items, at, event.item) };
    }
    case "item.updated":
      return with_item(state, event.item_id, (item) => patched(item, event.patch));
    case "items.removed": {
      const gone = new Set(event.item_ids);
      const items = state.items.filter((i) => !gone.has(i.id));
      if (!state.start) return items.length === state.items.length ? state : { ...state, items };
      // A window: its start, and the indices of its context items left, go down by the removed items before them.
      const removed = new Set(event.indices);
      const below = (at: number) => event.indices.filter((i) => i < at).length;
      const context = (state.context ?? []).filter((i) => !removed.has(i)).map((i) => i - below(i));
      const next: Snapshot = { ...state, items, start: state.start - below(state.start) };
      if (context.length) next.context = context;
      else delete next.context;
      return next;
    }
    case "request.opened": {
      const at = index_of(state.requests, event.request.id);
      return { ...state, requests: at < 0 ? [...state.requests, event.request] : replace(state.requests, at, event.request) };
    }
    case "request.resolved": {
      const at = index_of(state.requests, event.request_id);
      if (at < 0) return state;
      return { ...state, requests: replace(state.requests, at, { ...state.requests[at]!, resolution: event.resolution }) };
    }
    default:
      // A newer server's event type: there's nothing to do with it but count it.
      return state;
  }
}

/** The state with the item `id` changed by `change`; the state itself if there's none, or `change` returns it as it was. */
function with_item(state: Snapshot, id: string, change: (item: Item) => Item): Snapshot {
  const at = index_of(state.items, id);
  if (at < 0) return state;
  const item = state.items[at]!;
  const next = change(item);
  return next === item ? state : { ...state, items: replace(state.items, at, next) };
}

// Updates are nearly always to recent items and requests, so look from the end.
function index_of(list: readonly { id: string }[], id: string): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === id) return i;
  return -1;
}

function replace<T>(list: readonly T[], at: number, value: T): T[] {
  const next = list.slice();
  next[at] = value;
  return next;
}

// ---------- windows ----------
//
// A thread can run to thousands of items, so a client starts from its last ones and loads earlier ones a page at a
// time. Items are only added at the end (an item.added for an id the thread has replaces it in place), and only
// items.removed takes any out, saying where they were: so windows and pages say where they are by index.

/**
 * The window of `state` with its last `limit` items, and what they need from before them: the subagent calls they and
 * the open requests belong to, the open requests' tool calls, and the subagents still running (which may go on adding
 * items to the window), with their own. Without a limit, or with one it's within, it's the state itself. `state` must
 * be whole (not a window).
 */
export function snapshot_window(state: Snapshot, limit?: number): Snapshot {
  const items = state.items;
  if (limit === undefined || items.length <= limit) return state;
  const start = items.length - Math.max(0, Math.floor(limit));
  const at = indices(items);
  const need = new Set<string>();
  for (let i = start; i < items.length; i++) need.add(items[i]!.parent_id ?? "");
  for (const r of state.requests) {
    if (r.resolution) continue;
    need.add(r.parent_id ?? "");
    need.add(r.tool_call_id ?? "");
  }
  for (let i = 0; i < start; i++) if (is_running_subagent(items[i]!)) need.add(items[i]!.id);
  const context = context_of(items, at, need, start);
  const window: Snapshot = {
    thread: state.thread,
    items: [...context.map((i) => items[i]!), ...items.slice(start)],
    requests: state.requests.filter((r) => {
      if (!r.resolution) return true;
      const a = anchor(items, at, r);
      return a < 0 || a >= start;
    }),
    seq: state.seq,
  };
  if (start) window.start = start;
  if (context.length) window.context = context;
  return window;
}

/**
 * The page of `state`'s items before index `before` (a window's start), at most `limit` of them, with the subagent
 * calls they belong to from before them, and the requests anchored in them. `state` must be whole.
 */
export function item_page(state: Snapshot, before: number, limit: number): ItemPage {
  const items = state.items;
  const end = Math.max(0, Math.min(Math.floor(before), items.length));
  const start = Math.max(0, end - Math.max(0, Math.floor(limit)));
  const at = indices(items);
  const need = new Set<string>();
  for (let i = start; i < end; i++) need.add(items[i]!.parent_id ?? "");
  const context = context_of(items, at, need, start);
  return {
    thread_id: state.thread.id,
    items: [...context.map((i) => items[i]!), ...items.slice(start, end)],
    requests: state.requests.filter((r) => {
      const a = anchor(items, at, r);
      return a >= start && a < end;
    }),
    start,
    context,
    seq: state.seq,
  };
}

/**
 * `state` (a window) with `page`, the page before its start, put in front of its items: the context items of both in
 * order (the page's version of one they share), less those the page's own items have, then the page's items, then its
 * own. The page's requests go in front of its own, the page's version of one it has replacing it in place. A page for
 * another thread, or that doesn't end at its start, changes nothing.
 */
export function with_page(state: Snapshot, page: ItemPage): Snapshot {
  const before = state.start ?? 0;
  const own = state.context ?? [];
  const theirs = page.context ?? [];
  const body = page.items.slice(theirs.length);
  if (page.thread_id !== state.thread.id || !before || page.start + body.length !== before || page.start >= before) return state;
  const fresh = new Set(body.map((i) => i.id));
  const ctx = new Map<number, Item>();
  own.forEach((index, i) => {
    const item = state.items[i];
    if (item && index < page.start && !fresh.has(item.id)) ctx.set(index, item);
  });
  theirs.forEach((index, i) => {
    const item = page.items[i];
    if (item && index < page.start && !fresh.has(item.id)) ctx.set(index, item);
  });
  const context = [...ctx.keys()].sort((a, b) => a - b);
  const kept = state.items.slice(own.length).filter((i) => !fresh.has(i.id));
  const page_requests = new Map<string, ThreadRequest>(page.requests.map((r) => [r.id, r]));
  const requests = [...page.requests.filter((r) => !state.requests.some((s) => s.id === r.id)), ...state.requests.map((r) => page_requests.get(r.id) ?? r)];
  const next: Snapshot = { ...state, items: [...context.map((i) => ctx.get(i)!), ...body, ...kept], requests };
  delete next.start;
  delete next.context;
  if (page.start) {
    next.start = page.start;
    if (context.length) next.context = context;
  }
  return next;
}

/** Where a request is in the thread's items: the index of its tool call, or else of the last item of its turn; -1 if it has neither. */
export function request_anchor(items: readonly Item[], request: ThreadRequest): number {
  return anchor(items, indices(items), request);
}

/**
 * A subagent's call whose subagent hasn't finished: by its subagent's status where it has one (a background
 * subagent's call completes as soon as it has started it), or else by the call's.
 */
export function is_running_subagent(item: Item): boolean {
  return (
    item.type === "tool_call" &&
    item.kind === "subagent" &&
    (item.subagent ? item.subagent.status === "running" : item.status === "pending" || item.status === "running")
  );
}

function anchor(items: readonly Item[], at: Map<string, number>, r: ThreadRequest): number {
  const call = r.tool_call_id ? at.get(r.tool_call_id) : undefined;
  if (call !== undefined) return call;
  if (r.turn_id) for (let i = items.length - 1; i >= 0; i--) if (items[i]!.turn_id === r.turn_id) return i;
  return -1;
}

function indices(items: readonly Item[]): Map<string, number> {
  const at = new Map<string, number>();
  items.forEach((item, i) => at.set(item.id, i));
  return at;
}

/** The indices before `start` of the items with an id in `need`, and of their parents, however nested; ascending. */
function context_of(items: readonly Item[], at: Map<string, number>, need: Set<string>, start: number): number[] {
  const out = new Set<number>();
  const seen = new Set<string>();
  for (const first of need) {
    for (let id: string | undefined = first; id && !seen.has(id); ) {
      seen.add(id);
      const i = at.get(id);
      if (i === undefined) break;
      if (i < start) out.add(i);
      id = items[i]!.parent_id;
    }
  }
  return [...out].sort((a, b) => a - b);
}
