// What a thread shows, built from its stored messages. A new message rebuilds the model, but the
// parts it leaves as they were (items, tool calls and results, subagents, a subagent's messages)
// stay the same objects, so the rows that show them don't redraw.

import type { Message } from "./api";
import { buildSubagents, isAgentTool, type Subagent } from "./subagents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type Call = { id: string; name: string; input: Any; result?: ToolResult };

export type Item =
  | { type: "user"; key: string; text: string; auto?: boolean; steered?: boolean }
  | { type: "event"; key: string; level: string; text: string; detail?: string | null }
  | { type: "permission"; key: string; data: Any }
  | { type: "text"; key: string; text: string }
  | { type: "thinking"; key: string; text: string }
  | { type: "tools"; key: string; calls: Call[] }
  | { type: "result"; key: string; data: Any }
  | { type: "compact"; key: string; meta: Any; summary?: string; result?: Any };

export interface ThreadModel {
  items: Item[];
  results: Map<string, ToolResult>;
  /** A subagent's own assistant messages and permission prompts, by the tool_use_id that started it. */
  children: Map<string, Message[]>;
  subagents: Map<string, Subagent>;
  /** tool_use_id → the subagent that made the call, for calls made inside a subagent. */
  callParent: Map<string, string>;
}

function resultText(content: Any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n");
  return content == null ? "" : JSON.stringify(content, null, 2);
}

/** Each tool_result block's result, made once: an unchanged message keeps its blocks. */
const toolResults = new WeakMap<object, ToolResult>();

function toolResult(b: Any): ToolResult {
  let r = toolResults.get(b);
  if (!r) toolResults.set(b, (r = { content: resultText(b.content), isError: !!b.is_error }));
  return r;
}

/** What a model was built from, for the next one to carry on from (see buildModel). */
interface Built {
  messages: Message[];
  running: boolean;
  /** What lists the subagents started before `messages`, in a thread loaded in pages (ThreadPages.subagents in the store). */
  earlier: Message[];
  /** The tool_use_ids of the permission prompts. */
  prompted: Set<string>;
  /** Which items have each tool call. */
  callAt: Map<string, number[]>;
}

const built = new WeakMap<ThreadModel, Built>();

/**
 * The model of a thread, reusing what's unchanged from `prev` (the model of an earlier version of it).
 * When the messages are `prev`'s with more after them, as they are for new messages, only those are
 * looked at (see extend). `earlier`: what lists the subagents started before `messages`, in a thread
 * loaded in pages.
 */
export function buildModel(messages: Message[], running: boolean, prev?: ThreadModel, earlier: Message[] = NO_EARLIER): ThreadModel {
  const was = prev && built.get(prev);
  if (prev && was && was.earlier === earlier && messages.length > was.messages.length && was.messages.every((m, i) => messages[i] === m)) {
    const next = extend(prev, was, messages, running);
    if (next) return next;
  }
  const results = new Map<string, ToolResult>();
  const children = new Map<string, Message[]>();
  const callParent = new Map<string, string>();
  const prompted = new Set<string>();
  const top: Message[] = [];
  const addChild = (parent: string, m: Message) => {
    const list = children.get(parent);
    if (list) list.push(m);
    else children.set(parent, [m]);
  };
  // A permission prompt can be stored before the message with its call.
  for (const m of messages) {
    const d = m.kind === "claude" && m.data?.type === "assistant" ? m.data : null;
    if (d?.parent_tool_use_id) for (const b of d.message?.content ?? []) if (b.type === "tool_use") callParent.set(b.id, d.parent_tool_use_id);
  }
  for (const m of messages) {
    const d = m.kind === "claude" ? m.data : null;
    if (d?.type === "user" && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if (b.type === "tool_result") results.set(b.tool_use_id, toolResult(b));
    }
    if (m.kind === "permission" && m.data?.tool_use_id) prompted.add(m.data.tool_use_id);
    const parent: string | undefined = d?.parent_tool_use_id ?? undefined;
    if (parent) addChild(parent, m);
    else {
      top.push(m);
      // A subagent's prompts stay in the main conversation too, where they're answered.
      const from = m.kind === "permission" && m.data?.tool_use_id ? callParent.get(m.data.tool_use_id) : undefined;
      if (from) addChild(from, m);
    }
  }
  const subagents = new Map(buildSubagents(withEarlier(earlier, messages), running).map((s) => [s.id, s]));
  if (prev) {
    for (const [id, list] of children) {
      const old = prev.children.get(id);
      if (old && sameList(old, list)) children.set(id, old);
    }
    for (const [id, s] of subagents) {
      const old = prev.subagents.get(id);
      if (old && shallowEqual(old, s)) subagents.set(id, old);
    }
  }
  const items = new ItemBuilder();
  for (const m of top) items.add(m, results);
  const model = {
    items: prev ? reuseItems(items.items, prev.items) : items.items,
    results: prev && sameMap(prev.results, results) ? prev.results : results,
    children,
    subagents,
    callParent,
  };
  built.set(model, { messages, running, earlier, prompted, callAt: items.callAt });
  return model;
}

const NO_EARLIER: Message[] = [];

const withEarlier = (earlier: Message[], messages: Message[]) => (earlier.length ? [...earlier, ...messages] : messages);

/**
 * `prev`'s model carried on with the messages after `was.messages`: what they leave as it was is
 * `prev`'s. Null if one is the call a prompt from before it was for (that prompt goes in the
 * subagent's messages, before ones already there), for a full build.
 */
function extend(prev: ThreadModel, was: Built, messages: Message[], running: boolean): ThreadModel | null {
  const added = messages.slice(was.messages.length);
  let callParent = prev.callParent;
  for (const m of added) {
    const d = m.kind === "claude" && m.data?.type === "assistant" ? m.data : null;
    if (!d?.parent_tool_use_id) continue;
    for (const b of d.message?.content ?? []) {
      if (b.type !== "tool_use") continue;
      if (was.prompted.has(b.id)) return null;
      if (callParent === prev.callParent) callParent = new Map(callParent);
      callParent.set(b.id, d.parent_tool_use_id);
    }
  }
  let results = prev.results;
  let children = prev.children;
  let prompted = was.prompted;
  const grown = new Set<string>();
  const addChild = (parent: string, m: Message) => {
    if (children === prev.children) children = new Map(children);
    const list = children.get(parent);
    if (!list) children.set(parent, [m]);
    else if (grown.has(parent)) list.push(m);
    else children.set(parent, [...list, m]);
    grown.add(parent);
  };
  const items = new ItemBuilder(prev.items, was.callAt);
  for (const m of added) {
    const d = m.kind === "claude" ? m.data : null;
    if (d?.type === "user" && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b.type !== "tool_result") continue;
        if (results === prev.results) results = new Map(results);
        const r = toolResult(b);
        results.set(b.tool_use_id, r);
        items.setResult(b.tool_use_id, r);
      }
    }
    if (m.kind === "permission" && m.data?.tool_use_id) {
      if (prompted === was.prompted) prompted = new Set(prompted);
      prompted.add(m.data.tool_use_id);
    }
    const parent: string | undefined = d?.parent_tool_use_id ?? undefined;
    if (parent) addChild(parent, m);
    else {
      items.add(m, results);
      const from = m.kind === "permission" && m.data?.tool_use_id ? callParent.get(m.data.tool_use_id) : undefined;
      if (from) addChild(from, m);
    }
  }
  let subagents = prev.subagents;
  if (running !== was.running || added.some((m) => affectsSubagents(m, prev.subagents))) {
    subagents = new Map(buildSubagents(withEarlier(was.earlier, messages), running).map((s) => [s.id, s]));
    for (const [id, s] of subagents) {
      const old = prev.subagents.get(id);
      if (old && shallowEqual(old, s)) subagents.set(id, old);
    }
  }
  const changed = items.items.length !== prev.items.length || items.items.some((it, i) => it !== prev.items[i]);
  const model = { items: changed ? items.items : prev.items, results, children, subagents, callParent };
  built.set(model, { messages, running, earlier: was.earlier, prompted, callAt: items.callAt });
  return model;
}

/** Whether a message could change what buildSubagents makes of a thread, given its subagents so far. */
function affectsSubagents(m: Message, subagents: Map<string, Subagent>): boolean {
  if (m.kind === "permission") return true;
  if (m.kind !== "claude") return false;
  const d = m.data;
  const content = Array.isArray(d?.message?.content) ? d.message.content : [];
  switch (d?.type) {
    case "system":
      return true;
    case "assistant":
      // A subagent's calls matter to it through its prompts, which count on their own (or, stored before, make extend give up).
      return content.some((b: Any) => b.type === "tool_use" && isAgentTool(b.name));
    case "user":
      return content.some((b: Any) => b.type === "tool_result" && subagents.has(b.tool_use_id));
  }
  return false;
}

const NO_META = {};

/** The items to show for messages, reusing the ones that are unchanged from `prev` (and `prev` itself if they all are). */
export function buildItems(messages: Message[], results: Map<string, ToolResult>, prev?: Item[]): Item[] {
  const items = new ItemBuilder();
  for (const m of messages) items.add(m, results);
  return prev ? reuseItems(items.items, prev) : items.items;
}

/** Makes a thread's items, after an earlier model's (which it leaves as they were). */
class ItemBuilder {
  items: Item[];
  callAt: Map<string, number[]>;
  /** The items this one made, which it can change. The others are an earlier model's. */
  private own = new WeakSet<Item>();

  constructor(items: Item[] = [], callAt?: Map<string, number[]>) {
    this.items = items.slice();
    this.callAt = new Map(callAt);
  }

  private push(it: Item) {
    this.own.add(it);
    this.items.push(it);
  }

  /** Item `i`, to change: a copy of it if it's an earlier model's. */
  private edit(i: number): Item {
    const it = this.items[i];
    if (this.own.has(it)) return it;
    const copy = it.type === "tools" ? { ...it, calls: it.calls.slice() } : { ...it };
    this.own.add(copy);
    return (this.items[i] = copy);
  }

  private pushTool(call: Call, key: string) {
    const i = this.items.length - 1;
    if (this.items[i]?.type === "tools") (this.edit(i) as Extract<Item, { type: "tools" }>).calls.push(call);
    else this.push({ type: "tools", key, calls: [call] });
    const at = this.callAt.get(call.id);
    const n = this.items.length - 1;
    if (!at?.includes(n)) this.callAt.set(call.id, [...(at ?? []), n]);
  }

  add(m: Message, results: Map<string, ToolResult>) {
    const k = String(m.id);
    if (m.kind === "user") this.push({ type: "user", key: k, text: m.data.text ?? "", auto: m.data.auto, steered: m.data.steered });
    else if (m.kind === "event") this.push({ type: "event", key: k, level: m.data.level, text: m.data.text, detail: m.data.detail });
    else if (m.kind === "permission") this.push({ type: "permission", key: k, data: m.data });
    else if (m.kind === "claude") {
      const d = m.data;
      const last = this.items.length - 1;
      if (d.type === "assistant") {
        (d.message?.content ?? []).forEach((b: Any, i: number) => {
          const key = `${k}.${i}`;
          if (b.type === "text" && b.text?.trim()) this.push({ type: "text", key, text: b.text });
          else if (b.type === "thinking" && b.thinking?.trim()) this.push({ type: "thinking", key, text: b.thinking });
          else if (b.type === "tool_use") this.pushTool({ id: b.id, name: b.name, input: b.input, result: results.get(b.id) }, key);
        });
      } else if (d.type === "system" && d.subtype === "compact_boundary") {
        this.push({ type: "compact", key: k, meta: d.compact_metadata ?? NO_META });
      } else if (d.type === "user" && d.isSynthetic && typeof d.message?.content === "string") {
        // The summary a compacted conversation continues from.
        if (this.items[last]?.type === "compact") (this.edit(last) as Extract<Item, { type: "compact" }>).summary = d.message.content;
      } else if (d.type === "result") {
        // A `/compact` run's turn is just the compaction.
        if (this.items[last]?.type === "compact" && d.num_turns === 0 && !d.is_error && d.subtype === "success")
          (this.edit(last) as Extract<Item, { type: "compact" }>).result = d;
        else this.push({ type: "result", key: k, data: d });
      }
    }
  }

  /** Call `id`'s result came. */
  setResult(id: string, result: ToolResult) {
    for (const i of this.callAt.get(id) ?? []) {
      const it = this.items[i];
      if (it.type !== "tools" || !it.calls.some((c) => c.id === id && c.result !== result)) continue;
      const calls = (this.edit(i) as Extract<Item, { type: "tools" }>).calls;
      calls.forEach((c, j) => c.id === id && (calls[j] = { ...c, result }));
    }
  }
}

/** `next`, with the items (and tool calls) that are the same as in `prev` swapped for those in `prev`. */
function reuseItems(next: Item[], prev: Item[]): Item[] {
  if (!prev.length) return next;
  const old = new Map(prev.map((it) => [it.key, it]));
  let same = next.length === prev.length;
  const out = next.map((it, i) => {
    const was = old.get(it.key);
    if (!was || was.type !== it.type) return (same = false), it;
    if (it.type === "tools" && was.type === "tools") {
      // A group grows, and its calls get their results: keep the calls that didn't change.
      const calls = new Map(was.calls.map((c) => [c.id, c]));
      it.calls = it.calls.map((c) => {
        const o = calls.get(c.id);
        return o && shallowEqual(o, c) ? o : c;
      });
      if (sameList(was.calls, it.calls)) it = was;
    } else if (shallowEqual(was, it)) it = was;
    if (it !== prev[i]) same = false;
    return it;
  });
  return same ? prev : out;
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => (a as Any)[k] === (b as Any)[k]);
}

const sameList = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** The latest model of each thread that's shown, so the views of one thread (its conversation, its Agents pill) build it once. */
const models = new Map<string, ThreadModel>();

/** The model of task `taskId`'s thread, from its messages (and `earlier`, see buildModel). */
export function threadModel(taskId: string, messages: Message[], running: boolean, earlier: Message[] = NO_EARLIER): ThreadModel {
  const prev = models.get(taskId);
  const was = prev && built.get(prev);
  if (prev && was?.messages === messages && was.running === running && was.earlier === earlier) return prev;
  const model = buildModel(messages, running, prev, earlier);
  models.set(taskId, model);
  return model;
}

/** Drops the models of the threads whose messages are gone (see retainThread in the store). */
export function forgetThreadModels(keep: (taskId: string) => boolean) {
  for (const id of models.keys()) if (!keep(id)) models.delete(id);
}
