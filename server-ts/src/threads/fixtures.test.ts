// agent-threads' recorded Claude sessions (spec/fixtures/claude at main 5ad670a, copied into fixtures/claude), each as
// the board would store it and then translated: every raw line Claude wrote goes through agent/runner/output.ts's
// handle_line (its slimming, into `messages`), the board's own rows are written as it writes them (the user's messages,
// and the permission prompts, which it asks through its MCP tool rather than can_use_tool), and the translator's items
// must be the ones the fixture's expected.jsonl folds into, but for what `messages` doesn't keep (see `normalize`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import { handle_line } from "../agent/runner/output.ts";
import { apply_events, initial_state, type Item, type ThreadEvent, type ThreadRequest } from "./protocol.ts";
import { ASK_USER, EXIT_PLAN, convert, type Conversion } from "./translate.ts";

const DIR = join(import.meta.dirname, "fixtures", "claude");

const jsonl = (path: string): any[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** The fixture's session as the board stores it: its task's messages. */
function stored(scenario: string): db.Message[] {
  const s = testing.state();
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
  let run = db.insert_run(s.db(), task.id, "prompt");
  // The board asks about a call only when its policy says to (the fixture's `ask`), and always about questions and plans.
  const policy = JSON.parse(readFileSync(join(DIR, scenario, "fixture.json"), "utf8")).permissions;
  const asks = (tool: string) => policy === "ask" || tool === ASK_USER || tool === EXIT_PLAN;
  let turn = false;
  // can_use_tool requests waiting for their answer: the board's permission message for each.
  const asked = new Map<string, db.Message>();
  for (const line of jsonl(join(DIR, scenario, "session.jsonl"))) {
    const m = line.msg;
    if (line.dir === "spawn") {
      if (line.run > 1) run = db.insert_run(s.db(), task.id, "prompt");
      continue;
    }
    if (line.dir === "in" && m?.type === "user") {
      const text = (m.message?.content ?? []).map((b: any) => b.text ?? "").join("");
      // A compaction is a run of its own on the board, with no message of the user's.
      if (text !== "/compact") s.add_message(task.id, "user", turn ? { text, steered: true } : { text });
      turn = true;
    } else if (line.dir === "in" && m?.type === "control_request" && m.request?.subtype === "interrupt") {
      // Stopping a run: its turn's result is then an interrupted one (see output.ts's record_turn_end).
      db.run(s.db(), "UPDATE runs SET stop_requested=1 WHERE id=?1", run.id);
    } else if (line.dir === "out" && m?.type === "control_request" && m.request?.subtype === "can_use_tool" && asks(m.request.tool_name)) {
      const r = m.request;
      const data = { tool_name: r.tool_name, input: r.input, tool_use_id: r.tool_use_id ?? null, request_id: m.request_id, status: "pending" };
      asked.set(m.request_id, s.add_message(task.id, "permission", data));
    } else if (line.dir === "in" && m.type === "control_response" && asked.has(m.response?.request_id)) {
      const message = asked.get(m.response.request_id)!;
      const answer = m.response.response ?? {};
      const data = { ...message.data, status: answer.behavior === "allow" ? "allowed" : "denied" };
      if (answer.behavior !== "allow" && answer.message) data.note = answer.message;
      if (answer.updatedInput?.answers) data.answers = answer.updatedInput.answers;
      // A plan approved into a mode: the board keeps the mode picked.
      const mode = (answer.updatedPermissions ?? []).find((u: any) => u?.type === "setMode")?.mode;
      if (mode) data.mode = mode;
      db.update_message_data(s.db(), message.id, data);
    } else if (line.dir === "out") {
      if (m?.type === "result") turn = false;
      handle_line(s, db.get_run(s.db(), run.id)!, line.line ?? JSON.stringify(m));
    }
  }
  return db.list_messages(s.db(), task.id);
}

/** The items and requests the fixture's expected events fold into. */
function expected(scenario: string): { items: Item[]; requests: ThreadRequest[] } {
  const events = jsonl(join(DIR, scenario, "expected.jsonl")) as ThreadEvent[];
  const first = events.find((e) => e.type === "thread.updated") as any;
  // A rewind removes the turns it goes back before: the board keeps them (and says where it rewound to with a notice).
  const kept = events.filter((e) => e.type !== "items.removed" && e.type !== "delta");
  return apply_events(initial_state(first.thread), kept);
}

/** Notices agent-threads makes that the board doesn't: for its own commands, and for hooks and API retries (output.ts doesn't keep those lines). */
const BOARD_NOTICES = ["session.new", "rewind", "hook", "retry"];

/**
 * An item as compared: without its id (but a tool call's, which is Claude's for both), turn and time, and without what
 * `messages` doesn't keep of it: a turn's usage and session (the stored result has neither), an edit's diff (from its
 * result's structuredPatch, which the slimming drops), a user_message's client_id and queued (the board's queue says
 * those), and the notices agent-threads' backend makes for its own commands (the board makes its own).
 */
function normalize(item: any): any {
  const out: any = { ...item };
  if (out.type !== "tool_call") delete out.id;
  delete out.turn_id;
  delete out.created_at;
  if (out.type === "turn_result") {
    delete out.usage;
    delete out.session;
  }
  if (out.type === "user_message") {
    delete out.client_id;
    delete out.queued;
  }
  if (out.changes) out.changes = out.changes.map((c: any) => ({ path: c.path }));
  return out;
}

/**
 * The expected items, without what the board does otherwise: the notices agent-threads' backend makes for its own
 * commands, and `/compact` as the user's message (the board runs it as a compaction, with an event of its own).
 */
const expected_items = (list: Item[]) =>
  list.filter((i: any) => !(i.type === "notice" && BOARD_NOTICES.includes(i.code)) && !(i.type === "user_message" && i.text === "/compact")).map(normalize);

/**
 * The translator's items, without what the board keeps that agent-threads leaves out: Claude Code's "[Request
 * interrupted…]" message, and its API errors (the turn's result has the error too), which the readers take as the agent's.
 */
const our_items = (list: Item[]) => list.filter((i: any) => !(i.type === "notice" && i.code && i.level !== "warning")).map(normalize);

/** A request as compared: without its id and time, which the board picks, and the user_messages our protocol leaves out. */
function request(r: any): any {
  const { id: _, created_at: _c, turn_id: _t, user_messages: _u, ...rest } = r;
  return rest;
}

const scenarios = readdirSync(DIR).sort();

test("there_are_22_claude_fixtures", () => {
  assert.equal(scenarios.length, 22);
});

for (const scenario of scenarios) {
  test(`claude_fixture_${scenario}`, () => {
    const messages = stored(scenario);
    const c: Conversion = convert(messages, { finished: false });
    const want = expected(scenario);
    assert.deepEqual(our_items(c.items), expected_items(want.items));
    assert.deepEqual(c.requests.map(request), want.requests.map(request));
    assert.deepEqual(c.warnings, []);
    assert.equal(c.rows.filter((r) => r.disposition === "retained").length, 0);
  });
}
