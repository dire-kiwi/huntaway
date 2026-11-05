// agent-threads' recorded Codex sessions (spec/fixtures/codex at main 5ad670a, copied into fixtures/codex), replayed as
// the board would see them: the app-server's notifications and requests as the adapter writes them to the run's output
// (agent/codex/adapter.ts), through agent/codex/output.ts's handle_line, and the board's own rows as it writes them (the
// user's messages, its prompts and their answers). Each is replayed twice:
//
// - on a task whose items are its source, which agent/codex/driver.ts writes straight from the notifications: its items
//   must be the ones the fixture's expected.jsonl folds into, but for what the board does otherwise (`ours`, `theirs`);
// - and on a task still on its messages, where they're made into messages shaped like Claude Code's and translated:
//   every difference between the two is listed in `DIFFERENCES` (and in docs/threads.md), so none goes unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Run } from "../db.ts";
import * as testing from "../testing.ts";
import { handle_line } from "../agent/codex/output.ts";
import { display_command, file_changes } from "../agent/codex/adapter.ts";
import { apply_events, initial_state, type Item, type ThreadEvent, type ThreadRequest } from "./protocol.ts";
import * as source from "./source.ts";
import * as store from "./store.ts";
import * as write from "./write.ts";

const DIR = join(import.meta.dirname, "fixtures", "codex");

const jsonl = (path: string): any[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** What the adapter writes to the run's output (its KEEP, and the requests): the rest it drops. */
const KEPT = new Set([
  "thread/started", "thread/status/changed", "thread/closed", "turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed",
  "item/agentMessage/delta", "thread/compacted", "thread/tokenUsage/updated", "account/rateLimits/updated", "error", "warning", "model/rerouted",
  "mcpServer/startupStatus/updated",
]);

/**
 * The board's prompt for a request (as mcp/permissions.ts stores one), as agent/codex/requests.ts asks it (the policy
 * and the prompts themselves are its tests', in agent/codex/requests.test.ts).
 */
function prompt_of(m: any, item: any): { tool_name: string; input: any } | null {
  const p = m.params ?? {};
  switch (m.method) {
    case "item/commandExecution/requestApproval":
      return { tool_name: "Bash", input: { command: display_command(p.command), cwd: p.cwd ?? null } };
    case "item/fileChange/requestApproval":
      return { tool_name: "ApplyPatch", input: { changes: file_changes(item) } };
    case "item/tool/requestUserInput": {
      const questions = p.questions.map((q: any) => ({
        id: q.id ?? null,
        header: q.header ?? null,
        question: q.question ?? null,
        multiSelect: false,
        options: q.options ?? [],
        isOther: q.isOther ?? null,
        isSecret: q.isSecret ?? null,
      }));
      return { tool_name: "request_user_input", input: { questions } };
    }
    default:
      return null;
  }
}

interface Replayed {
  items: Item[];
  requests: ThreadRequest[];
}

/** Scenario `scenario` replayed on a task whose thread is on `on` (see the top of the file). */
function replay(scenario: string, on: "items" | "messages"): Replayed {
  const s = testing.on_items(testing.state(), on === "items");
  db.set_setting(s.db(), write.SETTING, "true");
  const profile = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "scratch",
    title: scenario,
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  if (on === "items") assert.equal(source.flip(s.db(), task.id), "moved");
  const fixture = JSON.parse(readFileSync(join(DIR, scenario, "fixture.json"), "utf8"));
  const asks = (tool: string) => fixture.permissions === "ask" || tool === "request_user_input";
  const lines = jsonl(join(DIR, scenario, "session.jsonl"));
  // Each process is a run: a compaction's (its first request is thread/compact/start) or a prompt's.
  let run: Run | null = null;
  let turn = false;
  const items = new Map<string, any>();
  // The board's prompts waiting for their answers, by the request's id.
  const asked = new Map<string, db.Message>();
  const line = (v: any) => handle_line(s, db.get_run(s.db(), run!.id)!, v);
  for (let i = 0; i < lines.length; i++) {
    const { dir, msg: m } = lines[i];
    if (dir === "spawn") {
      const first = lines.slice(i + 1).find((l) => l.dir === "spawn" || (l.dir === "in" && ["turn/start", "thread/compact/start"].includes(l.msg?.method)));
      run = db.insert_run(s.db(), task.id, first?.msg?.method === "thread/compact/start" ? "compact" : "prompt");
      continue;
    }
    if (!m || (dir !== "in" && dir !== "out")) continue;
    if (dir === "in") {
      if (m.method === "turn/start" || m.method === "turn/steer") {
        const text = (m.params?.input ?? []).map((b: any) => b.text ?? "").join("");
        s.add_message(task.id, "user", turn ? { text, steered: true } : { text });
        turn = true;
      } else if (m.method === "turn/interrupt") {
        db.run(s.db(), "UPDATE runs SET stop_requested=1 WHERE id=?1", run!.id);
      } else if (m.method === undefined && asked.has(JSON.stringify(m.id))) {
        // The answer to one of the board's prompts.
        const message = asked.get(JSON.stringify(m.id))!;
        const r = m.result ?? {};
        const ok = r.decision === "accept" || r.answers !== undefined;
        const data: any = { ...message.data, status: ok ? "allowed" : "denied" };
        if (r.answers) data.answers = message.data.input.questions.map((q: any) => r.answers[q.id]?.answers ?? []);
        db.update_message_data(s.db(), message.id, data, task.id);
      }
      continue;
    }
    if (m.method === undefined) {
      // A response to the adapter's request: thread/start's says the thread's id, as the adapter does once it's started.
      const thread = m.result?.thread?.id;
      if (typeof thread === "string" && m.result?.turn === undefined && !db.get_task(s.db(), task.id)!.session_id) line({ method: "thread/started", params: { thread: { id: thread } } });
      continue;
    }
    if (m.method === "item/started" && m.params?.item?.id) items.set(m.params.item.id, m.params.item);
    if ("id" in m) {
      // A request: the board asks the user when its policy says to (and always about questions).
      const prompt = prompt_of(m, items.get(m.params?.itemId));
      if (prompt && asks(prompt.tool_name)) {
        const data = { ...prompt, tool_use_id: m.params?.itemId ?? null, request_id: `r-${m.id}`, status: "pending", agent: "codex" };
        asked.set(JSON.stringify(m.id), s.add_message(task.id, "permission", data));
      }
      continue;
    }
    if (!KEPT.has(m.method)) continue;
    if (m.method === "turn/completed" && m.params?.threadId === db.get_task(s.db(), task.id)!.session_id) turn = false;
    line(m);
  }
  assert.equal(source.of(s.db(), task.id), on);
  if (on === "messages") assert.deepEqual(write.compare(s.db(), task.id), []);
  return { items: store.items(s.db(), task.id), requests: store.requests(s.db(), task.id) };
}

/** The items and requests the fixture's expected events fold into. */
function expected(scenario: string): Replayed {
  const events = jsonl(join(DIR, scenario, "expected.jsonl")) as ThreadEvent[];
  const first = events.find((e) => e.type === "thread.updated") as any;
  // A rewind removes the turns it goes back before: the board keeps them (and says where it rewound to).
  const kept = events.filter((e) => e.type !== "items.removed" && e.type !== "delta");
  return apply_events(initial_state(first.thread), kept);
}

/**
 * An item as the two are compared: what it says, without its id, turn, time and the names and inputs each gives its
 * tools (agent-threads gives Codex's, `commandExecution`; the board its own, `Bash`, which its view and readers know),
 * with its parent as whether it has one (a subagent's call is Codex's spawn call there, the board's Agent call here).
 */
function shape(i: any): any {
  const out: any = { type: i.type };
  if (i.parent_id) out.child = true;
  switch (i.type) {
    case "user_message":
      out.text = i.text;
      if (i.steered) out.steered = true;
      break;
    case "assistant_message":
    case "reasoning":
      out.text = i.text;
      break;
    case "tool_call":
      out.kind = i.kind;
      out.status = i.status;
      for (const k of ["command", "path", "query", "url", "server"]) if (i[k] !== undefined) out[k] = i[k];
      if (i.changes) out.changes = i.changes.map((c: any) => `${c.op} ${c.path}`);
      if (i.todos) out.todos = i.todos;
      // A file change's result is the board's own "Applied.", and a denied call's says it was.
      if (i.result && i.kind !== "edit" && i.status !== "denied") out.result = i.result.content;
      if (i.subagent) out.subagent = i.subagent.status;
      break;
    case "notice":
      out.level = i.level;
      break;
    case "turn_result":
      out.ok = i.ok;
      if (i.interrupted) out.interrupted = true;
      break;
  }
  return out;
}

/**
 * The expected items, without what the board does otherwise: the notices agent-threads makes for its own commands (a
 * new session, a rewind), `/compact` as the user's message (the board runs it as a compaction), and a question's tool
 * call (Codex makes no item for request_user_input; the board shows its question's card). An app tool (a dynamic tool
 * of agent-threads' own) is kind `app` there; the board's dynamic tools are its MCP server's, and another's is `other`.
 */
const theirs = (r: Replayed) =>
  r.items
    .filter((i: any) => !(i.type === "notice" && ["session.new", "rewind"].includes(i.code)))
    .filter((i: any) => !(i.type === "user_message" && i.text === "/compact"))
    .filter((i: any) => !(i.type === "tool_call" && i.name === "request_user_input"))
    .map((i: any) => shape(i.kind === "app" ? { ...i, kind: "other" } : i.command ? { ...i, command: display_command(i.input.command) } : i));

/** Codex's collab tools but spawnAgent, whose calls the board shows as calls of their own (agent-threads doesn't). */
const COLLAB = ["wait", "sendInput", "followupTask", "sendMessage", "resumeAgent", "closeAgent", "interruptAgent"];

/**
 * The board's items, without its calls of Codex's collab tools but spawnAgent (see COLLAB), and the user's replies to a
 * Codex plan (plan mode's feedback, and "Implement the plan.") with the turns they end, which agent-threads takes as
 * the plan request's answer, in one turn, rather than as messages.
 */
const ours = (r: Replayed, scenario: string) =>
  r.items
    .filter((i: any) => !(i.type === "tool_call" && i.kind === "other" && COLLAB.includes(i.name)))
    .filter((i: any, n, all) => !(scenario === "plan" && ((i.type === "user_message" && n > 0) || (i.type === "turn_result" && n < all.length - 1))))
    .map(shape);

/** A request as compared: its type and kind, and how it was resolved (a plan's are agent-threads' own, see `ours`). */
const request = (r: any) => ({ type: r.type, kind: r.kind, outcome: r.resolution?.outcome, answers: r.resolution?.answers });

const scenarios = readdirSync(DIR).sort();

test("there_are_20_codex_fixtures", () => {
  assert.equal(scenarios.length, 20);
});

for (const scenario of scenarios) {
  test(`codex_fixture_${scenario}`, () => {
    const got = replay(scenario, "items");
    const want = expected(scenario);
    assert.deepEqual(ours(got, scenario), theirs(want));
    assert.deepEqual(got.requests.map(request), want.requests.filter((r) => r.type !== "plan").map(request));
  });
}

/**
 * Every way the items the driver writes differ from those the messages path made of the same run, by scenario: what
 * the comparison (`detail`) finds. Each is listed, and explained or closed, in docs/threads.md ("Codex writes items
 * directly").
 */
const EXIT = "exit_code: a command's exit code is in its result";
const DIFFERENCES: Record<string, string[]> = {
  interrupt: ["cancelled: a call its turn's interruption cut short"],
  "permission-allow": [EXIT],
  plan: [EXIT, EXIT],
  "set-options": [EXIT, EXIT],
  steer: [EXIT],
  subagent: [EXIT],
  "tool-calls": [EXIT, EXIT],
};

/** An item in detail, for the comparison with the messages path: all of it but its id (not a tool call's), and times. */
function detail(i: any): any {
  const { created_at: _c, ...out } = i;
  if (out.type !== "tool_call") delete out.id;
  if (out.subagent?.ended_at) out.subagent = { ...out.subagent, ended_at: "(when)" };
  return out;
}

/** What tells the driver's items from the messages path's, as `DIFFERENCES` names it. */
function differences(native: Item[], legacy: Item[]): string[] {
  const out: string[] = [];
  const a = native.map(detail);
  const b = legacy.map(detail);
  const key = (x: any) => JSON.stringify(x);
  for (let n = 0; n < Math.max(a.length, b.length); n++) {
    const [x, y] = [a[n], b[n]];
    if (key(x) === key(y)) continue;
    if (x?.type === "tool_call" && y?.type === "tool_call" && x.id === y.id) {
      const { result: rx, status: sx, ...restx } = x;
      const { result: ry, status: sy, ...resty } = y;
      if (key(restx) === key(resty)) {
        if (sx === "cancelled" && sy === "running" && rx === undefined && ry === undefined) {
          out.push("cancelled: a call its turn's interruption cut short");
          continue;
        }
        if (sx === sy && rx?.content === ry?.content && rx?.exit_code !== undefined && ry?.exit_code === undefined && rx.truncated === ry.truncated) {
          out.push(EXIT);
          continue;
        }
      }
    }
    out.push(`item ${n}: native ${key(x)}, messages ${key(y)}`);
  }
  return out;
}

for (const scenario of scenarios) {
  test(`codex_fixture_${scenario}_against_the_messages_path`, () => {
    const native = replay(scenario, "items");
    const legacy = replay(scenario, "messages");
    assert.deepEqual(differences(native.items, legacy.items), DIFFERENCES[scenario] ?? []);
    // The board's requests are the same either way.
    const req = (r: any) => {
      const { created_at: _c, metadata, ...rest } = r;
      const { message_id: _m, ...md } = metadata ?? {};
      return { ...rest, metadata: md };
    };
    assert.deepEqual(native.requests.map(req), legacy.requests.map(req));
  });
}
