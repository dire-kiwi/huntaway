// What a thread shows, built from its items (a thread kept as items, docs/threads.md): the adapter from the shared model
// (threads.ts, server-ts/src/threads/protocol.ts) onto the ThreadModel that threadModel.ts builds from messages, which
// the thread's components draw. The same task looks the same either way (tests/ui/itemThread.test.mjs compares them).
//
// What the items don't say, the board's `metadata` on them does (converter 3 on the server): an auto message, a turn's
// cost and turns, a compaction's tokens after, a request's stored prompt or question, and its message's id. Keys are
// the message path's where an item came from one message (`legacy:<id>[:<block>]` is `<id>[.<block>]`), so the rows
// that take a message id from them (rewinding, a prompt's "moved on") work as they do there.
//
// Like buildModel, a new snapshot rebuilds the model, but what it leaves as it was stays the same objects: apply_event
// keeps the identity of the items an event doesn't change, and what's made of each is kept by item (`made`).

import type { Message } from "./api";
import type { Subagent, SubagentStatus } from "./subagents";
import { reuseItems, shallowEqual, type Call, type Item, type ThreadModel, type ToolResult } from "./threadModel";
import type { Item as ThreadItem, Snapshot, ThreadRequest, ToolCall } from "./threads";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** `legacy:<message id>[:<block>]`: the message an item came from, and the key the message path gives what it made of it. */
const LEGACY = /^legacy:(\d+)(?::(.+))?$/;

/** The id of the message an item (or a board question's request) came from, if its id says. */
export function messageIdOf(id: string): number | undefined {
  const m = LEGACY.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** The key the message path gives what it made of the message an item came from: `<id>` or `<id>.<block>`. */
export function keyOf(id: string): string {
  const m = LEGACY.exec(id);
  return m ? (m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]) : id;
}

/** A tool call's tool's name as the harness gave it (an MCP tool's item has its server's name apart). */
export function toolName(t: { name: string; kind: string; server?: string }): string {
  if (t.kind === "mcp" && t.server) return `mcp__${t.server}__${t.name}`;
  if (t.kind === "app") return `mcp__app__${t.name}`;
  return t.name;
}

/** What's made of each item and request, while it stays the same object. */
const made = new WeakMap<object, unknown>();
function once<T>(of: object, make: () => T): T {
  if (made.has(of)) return made.get(of) as T;
  const v = make();
  made.set(of, v);
  return v;
}

const callOf = (it: ToolCall): Call =>
  once(it, () => {
    const call: Call = { id: it.id, name: toolName(it), input: it.input };
    const result = resultOf(it);
    if (result) call.result = result;
    return call;
  });

const resultOf = (it: ToolCall): ToolResult | undefined =>
  it.result ? once(it.result, () => ({ content: it.result!.content, isError: it.status !== "completed" })) : undefined;

/** A turn's end as the message path's result row reads it (Claude's result message). */
const resultData = (it: Extract<ThreadItem, { type: "turn_result" }>) =>
  once(it, () => {
    const md: Any = it.metadata ?? {};
    const d: Any = { subtype: md.subtype ?? (it.ok ? "success" : "error"), is_error: !it.ok };
    if (it.interrupted) d.interrupted = true;
    if (it.duration_ms != null) d.duration_ms = it.duration_ms;
    if (md.num_turns != null) d.num_turns = md.num_turns;
    if (md.total_cost_usd != null) d.total_cost_usd = md.total_cost_usd;
    return d;
  });

const compactMeta = (it: Extract<ThreadItem, { type: "compaction" }>) =>
  once(it, () => {
    const meta: Any = {};
    if (it.trigger) meta.trigger = it.trigger;
    if (it.tokens_before != null) meta.pre_tokens = it.tokens_before;
    const after = (it.metadata as Any)?.post_tokens;
    if (after != null) meta.post_tokens = after;
    return meta;
  });

/** A permission request's status as the board keeps it, for a request from before its metadata (converter 2). */
function statusOf(r: ThreadRequest): string {
  const res = r.resolution;
  if (!res) return "pending";
  if (res.outcome === "allow" || res.outcome === "answer") return r.type === "question" && r.id.startsWith("legacy:") ? "answered" : "allowed";
  if (res.outcome === "deny") return "denied";
  return "expired";
}

/** A permission prompt's message data (what the board stored, in its metadata), which its card reads. */
const promptData = (r: ThreadRequest) =>
  once(r, (): Any => {
    if (r.metadata) {
      // Its message's id is the board's, not the message's.
      const { message_id: _, ...md } = r.metadata as Any;
      return r.type === "permission" ? { ...md, input: r.input } : md;
    }
    // Kept before the board's record was (converter 2): what the request says.
    const d: Any = { request_id: r.id, status: statusOf(r) };
    if (r.tool_call_id) d.tool_use_id = r.tool_call_id;
    // (The board's own approvals are `app` requests named by their tool alone.)
    if (r.type === "permission") Object.assign(d, { tool_name: r.kind === "app" ? r.name : toolName(r), input: r.input });
    else if (r.type === "plan") Object.assign(d, { tool_name: "ExitPlanMode", input: { plan: r.plan } });
    else {
      const qs = r.questions.map((q) => ({ question: q.question, header: q.header, options: q.options ?? [], multiSelect: !!q.multi_select }));
      Object.assign(d, { tool_name: "AskUserQuestion", input: { questions: qs } });
    }
    return d;
  });

/** A question asked with the board's request_user_input: its message data. */
const questionData = (r: Extract<ThreadRequest, { type: "question" }>) =>
  once(r, (): Any => {
    if (r.metadata) {
      const { message_id: _, ...md } = r.metadata as Any;
      return md;
    }
    const q = r.questions[0];
    return { question: q.question, options: q.options ?? [], multi_select: !!q.multi_select, allow_other: q.allow_other !== false, status: statusOf(r) };
  });

/** Whether a request is one of the board's own questions (request_user_input, a merge approval), not a permission prompt. */
const boardQuestion = (r: ThreadRequest): r is Extract<ThreadRequest, { type: "question" }> =>
  r.type === "question" && messageIdOf(r.id) !== undefined && !(r.metadata as Any)?.tool_name;

/** A request's message id, which orders it among the items and keys its row. */
const requestMessage = (r: ThreadRequest): number | undefined => {
  const n = (r.metadata as Any)?.message_id;
  return typeof n === "number" ? n : messageIdOf(r.id);
};

/** The view's rows of one conversation (the main one, or a subagent's), as threadModel.ts's ItemBuilder makes them. */
class Rows {
  items: Item[] = [];

  private push(it: Item) {
    this.items.push(it);
  }

  private tool(call: Call) {
    const last = this.items[this.items.length - 1];
    // A group of calls is a new object (its calls are copied), so the one before stays as it was.
    if (last?.type === "tools") this.items[this.items.length - 1] = { ...last, calls: [...last.calls, call] };
    else this.push({ type: "tools", key: keyOf(call.id), calls: [call] });
  }

  item(it: ThreadItem) {
    const key = keyOf(it.id);
    switch (it.type) {
      case "user_message":
        this.push({ type: "user", key, text: it.text, auto: (it.metadata as Any)?.auto === true ? true : undefined, steered: it.steered });
        return;
      case "assistant_message":
        // A turn's result text that no message said: the message path shows its turn's end instead.
        if ((it.metadata as Any)?.from_result) return;
        this.push({ type: "text", key, text: it.text });
        return;
      case "reasoning":
        this.push({ type: "thinking", key, text: it.text });
        return;
      case "tool_call":
        this.tool(callOf(it));
        return;
      case "notice":
        // Claude Code's "[Request interrupted…]": the message path draws nothing for it.
        if (it.code === "interrupted") return;
        if (it.code === "routine_report") return this.push({ type: "report", key, data: it.metadata ?? { text: it.text } });
        // An API error Claude Code gave as the assistant's text (the board's own events have no code).
        if (it.code) return this.push({ type: "text", key: `${key}.0`, text: it.text });
        this.push({ type: "event", key, level: it.level === "warning" ? "warn" : it.level, text: it.text, detail: it.detail ?? null });
        return;
      case "compaction": {
        const row: Item = { type: "compact", key, meta: compactMeta(it) };
        if (it.summary) row.summary = it.summary;
        this.push(row);
        return;
      }
      case "turn_result": {
        const data = resultData(it);
        const last = this.items[this.items.length - 1];
        // A `/compact` run's turn is just the compaction.
        if (last?.type === "compact" && data.num_turns === 0 && it.ok && data.subtype === "success") this.items[this.items.length - 1] = { ...last, result: data };
        else this.push({ type: "result", key, data });
        return;
      }
    }
  }

  request(r: ThreadRequest) {
    const n = requestMessage(r);
    const key = n !== undefined ? String(n) : r.id;
    if (boardQuestion(r)) this.push({ type: "question", key, id: n!, data: questionData(r) });
    else this.push({ type: "permission", key, data: promptData(r) });
  }
}

/**
 * Whether request `r` goes before item `it` in the thread: its message was stored before the item's. Items made from
 * one message have its id in theirs (`legacy:`); tool calls don't, so they go by when they were stored, and a request
 * stored in the same millisecond as an item goes after it (prompts come after the call they ask about).
 */
function before(r: ThreadRequest, rid: number | undefined, it: ThreadItem): boolean {
  const iid = messageIdOf(it.id);
  if (rid !== undefined && iid !== undefined) return rid < iid;
  return !!r.created_at && !!it.created_at && r.created_at < it.created_at;
}

/** The subagent that a subagent's call shows, as subagents.ts's buildSubagents makes it from messages. */
function subagentOf(it: ToolCall, running: boolean, waiting: Set<string>): Subagent {
  const s = it.subagent;
  const input: Any = it.input ?? {};
  let status: SubagentStatus = s?.status ?? (it.status === "running" || it.status === "pending" ? "running" : it.status === "completed" ? "completed" : "failed");
  // One that never said it ended, in a run that has: stopped with it.
  if (!running && status === "running") status = "stopped";
  // What its task_started said it's doing, over its call's input (a forked Skill's has neither).
  const said: Any = it.metadata ?? {};
  const prompt = said.prompt ?? input.prompt;
  const sub: Subagent = {
    id: it.id,
    description: said.description ?? it.title ?? input.description ?? "",
    prompt: typeof prompt === "string" ? prompt : "",
    background: !!(s?.background ?? input.run_in_background),
    status,
    startedAt: it.created_at ?? "",
    messageId: 0,
    parent: it.parent_id ?? null,
  };
  const type = s?.agent_type ?? input.subagent_type;
  if (type) sub.agentType = type;
  const model = s?.model ?? input.model;
  if (model) sub.model = model;
  if (s?.activity) sub.activity = s.activity;
  if (s?.summary) sub.summary = s.summary;
  if (s?.tool_uses != null) sub.toolUses = s.tool_uses;
  if (s?.ended_at) sub.endedAt = s.ended_at;
  if (waiting.has(it.id)) sub.awaitingApproval = true;
  return sub;
}

type Shown = Pick<Snapshot, "items" | "requests" | "context">;

/**
 * The model of a thread from its items and requests (a snapshot or window), reusing what's unchanged from `prev`. A
 * window's context items (the subagent calls its items belong to, from before it) aren't rows of the main conversation
 * until the page with them is loaded, as a subagent from before the loaded messages isn't: their subagents are known.
 */
export function buildItemModel(snap: Shown, running: boolean, prev?: ThreadModel): ThreadModel {
  const main = new Rows();
  const kids = new Map<string, Rows>();
  const rowsOf = (parent: string | undefined) => {
    if (parent === undefined) return main;
    let r = kids.get(parent);
    if (!r) kids.set(parent, (r = new Rows()));
    return r;
  };
  const results = new Map<string, ToolResult>();
  const callParent = new Map<string, string>();
  const calls: ToolCall[] = [];
  let lastSent = 0;
  // Requests go in among the items, in the order their messages were stored.
  const requests = snap.requests
    .map((r, i) => ({ r, i, id: requestMessage(r) }))
    .sort((a, b) => (a.id !== undefined && b.id !== undefined ? a.id - b.id : (a.r.created_at ?? "").localeCompare(b.r.created_at ?? "")) || a.i - b.i);
  let next = 0;
  const place = (r: ThreadRequest) => {
    // A subagent's prompts are answered in the main conversation, and shown in its own thread too.
    main.request(r);
    if (r.parent_id) rowsOf(r.parent_id).request(r);
  };
  const context = snap.context?.length ?? 0;
  snap.items.forEach((it, i) => {
    const body = i >= context;
    if (body) while (next < requests.length && before(requests[next].r, requests[next].id, it)) place(requests[next++].r);
    if (body || it.parent_id) rowsOf(it.parent_id).item(it);
    if (it.type === "tool_call") {
      calls.push(it);
      const result = resultOf(it);
      if (result) results.set(it.id, result);
      if (it.parent_id) callParent.set(it.id, it.parent_id);
    } else if (it.type === "user_message" && !it.parent_id) {
      const n = messageIdOf(it.id);
      if (n !== undefined && n > lastSent) lastSent = n;
    }
  });
  while (next < requests.length) place(requests[next++].r);

  // The subagents with a prompt waiting.
  const waiting = new Set(snap.requests.filter((r) => !r.resolution && r.parent_id).map((r) => r.parent_id!));
  const subagents = new Map<string, Subagent>();
  for (const it of calls) {
    if (it.kind !== "subagent") continue;
    const s = subagentOf(it, running, waiting);
    const old = prev?.subagents.get(s.id);
    subagents.set(s.id, old && shallowEqual(old, s) ? old : s);
  }
  const childItems = new Map<string, Item[]>();
  for (const [id, rows] of kids) {
    const old = prev?.childItems?.get(id);
    childItems.set(id, old ? reuseItems(rows.items, old) : rows.items);
  }
  const sameResults = prev && prev.results.size === results.size && [...results].every(([k, v]) => prev.results.get(k) === v);
  const sameParents = prev && prev.callParent.size === callParent.size && [...callParent].every(([k, v]) => prev.callParent.get(k) === v);
  return {
    items: prev ? reuseItems(main.items, prev.items) : main.items,
    results: sameResults ? prev.results : results,
    children: NO_CHILDREN,
    subagents: prev && sameMap(prev.subagents, subagents) ? prev.subagents : subagents,
    callParent: sameParents ? prev.callParent : callParent,
    lastSent,
    childItems: prev?.childItems && sameMap(prev.childItems, childItems) ? prev.childItems : childItems,
  };
}

const NO_CHILDREN = new Map<string, Message[]>();

function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** The latest model of each thread drawn from items, and what it was built from, so its views build it once. */
const models = new Map<string, { snap: Shown; running: boolean; model: ThreadModel }>();

/** The model of task `taskId`'s thread, from its items. */
export function itemModel(taskId: string, snap: Shown, running: boolean): ThreadModel {
  const was = models.get(taskId);
  if (was && was.snap.items === snap.items && was.snap.requests === snap.requests && was.running === running) return was.model;
  const model = buildItemModel(snap, running, was?.model);
  models.set(taskId, { snap, running, model });
  return model;
}

/** Drops the models of the threads that aren't shown any more. */
export function forgetItemModels(keep: (taskId: string) => boolean) {
  for (const id of models.keys()) if (!keep(id)) models.delete(id);
}
