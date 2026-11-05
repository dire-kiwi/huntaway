// The thread view on items (itemModel.ts) draws what the view on messages (threadModel.ts) does: the same messages,
// translated into items by the server's translator (server-ts/src/threads/translate.ts, which is pure), give the same
// rows, subagents and results.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { forkedSkillMessages } from "./fixtures/forkedSkill.mjs";
import { threadHistory as history } from "./fixtures/threadHistory.mjs";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { buildModel, buildItems } = await import("../src/threadModel.ts");
const { buildItemModel, keyOf, toolName } = await import("../src/itemModel.ts");
const { convert } = await import("../../server-ts/src/threads/translate.ts");
const { apply_events, initial_state, snapshot_window, item_page, with_page } = await import("../src/threads.ts");

/** What a result line shows (items.tsx's ResultLine), and a compaction's (CompactLine). */
const resultShown = (d) => d && {
  duration_ms: d.duration_ms,
  num_turns: d.num_turns,
  total_cost_usd: d.total_cost_usd,
  interrupted: !!d.interrupted,
  error: !d.interrupted && !!(d.is_error || (d.subtype && d.subtype !== "success")),
  subtype: d.interrupted ? undefined : d.is_error || d.subtype !== "success" ? d.subtype : undefined,
};
const compactShown = (m) => ({ trigger: m.trigger, pre_tokens: m.pre_tokens, post_tokens: m.post_tokens });

/** A row as it's drawn: a group of calls by its calls (its key is only React's), and results by what they show. */
function row(it) {
  switch (it.type) {
    case "tools":
      return { type: "tools", calls: it.calls.map((c) => ({ id: c.id, name: c.name, input: c.input, result: c.result })) };
    case "user":
      return { type: "user", key: it.key, text: it.text, auto: !!it.auto, steered: !!it.steered };
    case "result":
      return { type: "result", key: it.key, shown: resultShown(it.data) };
    case "compact":
      return { type: "compact", key: it.key, meta: compactShown(it.meta), summary: it.summary, result: resultShown(it.result) };
    default:
      return it;
  }
}

/** What the view draws of a model: its rows, each subagent's rows (prompts included), its subagents and results. */
function drawn(model, children) {
  // A foreground subagent's report is its call's result: what its notification said (which items keep only for a
  // background one) shows only until then.
  const subs = [...model.subagents.values()]
    .map(({ messageId: _, ...s }) => JSON.parse(JSON.stringify(s.background || !model.results.has(s.id) ? s : { ...s, summary: undefined })))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    items: model.items.map(row),
    children: Object.fromEntries(subs.map((s) => [s.id, children(s.id).map(row)])),
    subagents: subs,
    results: Object.fromEntries([...model.results].sort()),
    callParent: Object.fromEntries([...model.callParent].sort()),
    lastSent: model.lastSent,
  };
}

const fromMessages = (messages, running) => {
  const m = buildModel(messages, running);
  return drawn(m, (id) => buildItems(m.children.get(id) ?? [], m.results));
};
const fromItems = (messages, running) => {
  const c = convert(messages, { finished: false });
  const m = buildItemModel({ items: c.items, requests: c.requests }, running);
  return drawn(m, (id) => m.childItems.get(id) ?? []);
};

test("a thread's items draw what its messages do", () => {
  for (const running of [true, false]) assert.deepStrictEqual(fromItems(history(), running), fromMessages(history(), running), `running: ${running}`);
});

test("and so do a forked Skill's, its prompt from its task_started", () => {
  const messages = forkedSkillMessages();
  assert.deepStrictEqual(fromItems(messages, true), fromMessages(messages, true));
  const sub = buildItemModel(convert(messages, { finished: false }), true).subagents.get("skill-review");
  assert.deepEqual([sub.prompt, sub.description, sub.endedAt], ["Review PR 139 for correctness bugs.", "/code-review", messages[6].created_at]);
});

test("at every point along the way, as live events bring it", () => {
  const all = history();
  for (let n = 1; n <= all.length; n++) {
    const part = all.slice(0, n);
    assert.deepStrictEqual(fromItems(part, true), fromMessages(part, true), `after ${n} messages`);
  }
});

/** The snapshot `messages` translate to, as the thread API gives it. */
function snapshot(messages) {
  const c = convert(messages, { finished: false });
  const thread = { id: "t", harness: "claude", status: "idle", created_at: "2026-10-26T07:00:00.000Z" };
  return apply_events(initial_state(thread), c.events.map((e, i) => ({ ...e, thread_id: "t", seq: i + 1 })));
}

test("a window shows its last items, and with every earlier page put in, the whole thread", () => {
  const whole = snapshot(history());
  const full = buildItemModel(whole, true);
  let w = snapshot_window(whole, 12);
  assert.ok(w.start > 0);
  const shown = buildItemModel(w, true);
  // The window's own rows are the thread's last ones (a group of calls may have fewer of its calls).
  assert.ok(shown.items.length < full.items.length);
  assert.deepStrictEqual(shown.items.slice(1).map(row), full.items.slice(-(shown.items.length - 1)).map(row));
  // A subagent its items belong to is known, though its call is before the window.
  while (w.start) w = with_page(w, item_page(whole, w.start, 5));
  const paged = buildItemModel(w, true);
  assert.deepStrictEqual(drawn(paged, (id) => paged.childItems.get(id) ?? []), drawn(full, (id) => full.childItems.get(id) ?? []));
});

test("what an event leaves as it was stays the same objects", () => {
  const all = history();
  const before = snapshot(all.slice(0, 30));
  const prev = buildItemModel(before, true);
  const after = snapshot(all.slice(0, 31));
  // The events' reducer keeps the items they don't change; rebuilding from the same objects keeps the rows.
  const same = { items: after.items.map((it, i) => (JSON.stringify(it) === JSON.stringify(before.items[i]) ? before.items[i] : it)), requests: before.requests };
  const next = buildItemModel(same, true, prev);
  const unchanged = prev.items.filter((it, i) => next.items[i] === it).length;
  assert.ok(unchanged >= prev.items.length - 1, `${unchanged} of ${prev.items.length} rows kept`);
  assert.equal(buildItemModel(same, true, next).items, next.items, "nothing new: the same rows");
});

test("keys and tool names come back as the message path has them", () => {
  assert.deepEqual([keyOf("legacy:12"), keyOf("legacy:12:3"), keyOf("legacy:12:result"), keyOf("toolu_1")], ["12", "12.3", "12.result", "toolu_1"]);
  assert.equal(toolName({ name: "pr_view", kind: "mcp", server: "gh" }), "mcp__gh__pr_view");
  assert.equal(toolName({ name: "board", kind: "app" }), "mcp__app__board");
  assert.equal(toolName({ name: "Bash", kind: "shell" }), "Bash");
});

test("requests from before the board's metadata (converter 2) still draw as prompts", () => {
  const m = buildItemModel(
    {
      items: [{ id: "c", type: "tool_call", name: "Bash", kind: "shell", input: { command: "ls" }, status: "running", created_at: "2026-10-26T07:00:00.000Z" }],
      requests: [{ id: "r", type: "permission", name: "Bash", kind: "shell", input: { command: "ls" }, tool_call_id: "c", created_at: "2026-10-26T07:00:01.000Z" }],
    },
    true,
  );
  assert.deepEqual(m.items.map((i) => i.type), ["tools", "permission"]);
  assert.deepEqual(m.items[1].data, { request_id: "r", status: "pending", tool_use_id: "c", tool_name: "Bash", input: { command: "ls" } });
});
