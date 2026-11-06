// Port of server/src/agent/tokens/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import { run_dir } from "../runs.ts";
import { count_claude, count_codex, count_pending, type Before, type Counted, type Earlier } from "../tokens.ts";

function result(session: string, models: any): string {
  return JSON.stringify({ type: "result", subtype: "success", session_id: session, modelUsage: models });
}

function opus(input: number, output: number, read: number, cost: number): any {
  return { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: 10, costUSD: cost, thinkingTokens: 1 };
}

function usage(thread: string, total: [number, number, number], last: [number, number, number]): string {
  const u = ([input, cached, output]: [number, number, number]) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: input + output });
  return JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: u(total), last: u(last) } } });
}

const none: Earlier = () => null;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const clone = (b: Before): Before => structuredClone(b);

function new_task(state: Shared, model: string | null): string {
  const p = db.insert_profile(state.db(), "p", [], null);
  const t = { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "in_progress", use_worktree: false, model, effort: null, claude_config_id: null };
  return db.insert_task(state.db(), t).id;
}

test("a_claude_run_uses_what_its_sessions_totals_went_up_by", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    `{"type":"assistant","message":{"usage":{"output_tokens":3}}}`,
    result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) }),
    // A turn that failed before the model answered: no modelUsage, so no count.
    JSON.stringify({ type: "result", subtype: "error_during_execution", session_id: "s1", modelUsage: {} }),
    result("s1", { "claude-opus-5-5": opus(7, 150, 3000, 1.5), "claude-haiku-5-5": opus(1, 2, 0, 0.01) }),
  ];
  const c = count_claude(lines, none);
  assert.deepEqual(c.models["claude-opus-5-5"], { input: 7, output: 150, cache_read: 3000, cache_write: 10, reasoning: 1, cost: 1.5 });
  assert.equal(c.models["claude-haiku-5-5"].output, 2);
  assert.equal(c.session, "s1");
  assert.equal(c.snapshot["claude-opus-5-5"].output, 150);

  // A later run that resumes the session goes on from those totals.
  const snapshot = structuredClone(c.snapshot);
  const earlier: Earlier = (s) => (s === "s1" ? { totals: structuredClone(snapshot), tail: {} } : null);
  const next = count_claude([result("s1", { "claude-opus-5-5": opus(9, 200, 4000, 2.0), "claude-haiku-5-5": opus(1, 2, 0, 0.01) })], earlier);
  assert.equal(next.models["claude-opus-5-5"].output, 50);
  assert.equal(next.models["claude-opus-5-5"].cache_read, 1000);
  assert.ok(near(next.models["claude-opus-5-5"].cost, 0.5));
  // Haiku did nothing more in it.
  assert.ok(!("claude-haiku-5-5" in next.models));

  // A new session (a review round's) starts from nothing.
  const fresh = count_claude([result("s2", { "claude-opus-5-5": opus(1, 10, 100, 0.1) })], earlier);
  assert.equal(fresh.models["claude-opus-5-5"].output, 10);

  // Totals that went down: Claude Code started counting again.
  const again = count_claude([result("s1", { "claude-opus-5-5": opus(1, 20, 100, 0.2) })], earlier);
  assert.equal(again.models["claude-opus-5-5"].output, 20);
});

test("a_codex_run_counts_each_threads_increase", () => {
  const lines = [
    JSON.stringify({ method: "thread/started", params: { thread: { id: "main" } } }),
    JSON.stringify({ method: "huntaway/model", params: { threadId: "main", model: "gpt-6.1-sol" } }),
    usage("main", [100, 40, 10], [100, 40, 10]),
    usage("main", [300, 200, 30], [200, 160, 20]),
    // A subagent's thread, new in this run.
    usage("child", [50, 0, 5], [50, 0, 5]),
  ];
  const c = count_codex(lines, "codex", none);
  const m = c.models["gpt-6.1-sol"];
  // Cached input isn't counted as input.
  assert.deepEqual([m.input, m.cache_read, m.output], [150, 200, 35]);
  assert.equal(c.snapshot.main.output, 30);

  // Resumed: the thread says its old totals again first, then goes on.
  const snapshot = structuredClone(c.snapshot);
  const earlier: Earlier = (t) => (t in snapshot ? { totals: structuredClone(snapshot), tail: {} } : null);
  const next = count_codex([usage("main", [300, 200, 30], [200, 160, 20]), usage("main", [400, 250, 40], [100, 50, 10])], "gpt-6.1-sol", earlier);
  assert.equal(next.models["gpt-6.1-sol"].output, 10);

  // Its totals went down (rolled back), or a resumed thread's earlier totals aren't known: just
  // the latest request.
  const rolled = [usage("main", [120, 0, 12], [20, 0, 2])];
  assert.equal(count_codex(rolled, "m", earlier).models.m.output, 2);
  assert.equal(count_codex(rolled, "m", none).models.m.output, 2);
});

test("counts_runs_once_from_their_output_or_their_cost", () => {
  const state = testing.state();
  const task = new_task(state, "opus");
  const runs: string[] = [];
  for (let i = 0; i < 3; i++) runs.push(db.insert_run(state.db(), task, "prompt").id);
  const write = (id: string, lines: string[]) => {
    const dir = run_dir(state, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.jsonl"), lines.join("\n"));
  };
  write(runs[0], [result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })]);
  write(runs[1], [result("s1", { "claude-opus-5-5": opus(6, 160, 1500, 1.25) })]);
  // The third's folder is gone: it has its cost.
  const c = state.db();
  db.run(c, "UPDATE runs SET cost_usd=0.25 WHERE id=?1", runs[1]);
  db.run(c, "UPDATE runs SET cost_usd=0.75 WHERE id=?1", runs[2]);
  db.run(c, "UPDATE runs SET status='exited' WHERE id IN (?1, ?2)", runs[0], runs[2]);

  // The second hasn't ended: the others are counted, and it waits.
  assert.equal(count_pending(state, null), 2);
  db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", runs[1]);
  assert.equal(count_pending(state, task), 1);
  assert.equal(count_pending(state, null), 0);

  const rows = (id: string) =>
    db.all(state.db(), "SELECT model, output_tokens, cost_usd, estimated FROM token_usage WHERE run_id=?1", id).map((r: any) => [r.model, r.output_tokens, r.cost_usd, !!r.estimated]);
  assert.deepEqual(rows(runs[0]), [["claude-opus-5-5", 100, 1.0, false]]);
  // It went on from the first, though counted after the third.
  assert.deepEqual(rows(runs[1]), [["claude-opus-5-5", 60, 0.25, false]]);
  assert.deepEqual(rows(runs[2]), [["opus", 0, 0.75, true]]);
});

test("a_run_counted_from_nothing_is_scaled_to_its_cost", () => {
  const state = testing.state();
  const task = new_task(state, null);
  // It resumed a session whose earlier runs' output is gone: its totals are all of them.
  const run = db.insert_run(state.db(), task, "prompt");
  const dir = run_dir(state, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.jsonl"), result("s1", { "claude-opus-5-5": opus(10, 400, 4000, 4.0) }));
  db.run(state.db(), "UPDATE runs SET status='exited', cost_usd=1.0 WHERE id=?1", run.id);
  count_pending(state, null);
  const r: any = db.one(state.db(), "SELECT output_tokens, cost_usd, estimated FROM token_usage WHERE run_id=?1", run.id);
  assert.deepEqual([r.output_tokens, !!r.estimated], [100, true]);
  assert.ok(near(r.cost_usd, 1.0));
});

test("a_codex_subagents_tokens_go_to_its_own_model", () => {
  const lines = [
    JSON.stringify({ method: "huntaway/model", params: { threadId: "main", model: "gpt-6.1-sol" } }),
    JSON.stringify({
      method: "item/started",
      params: { threadId: "main", item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], model: "gpt-6-luna" } },
    }),
    JSON.stringify({ method: "item/started", params: { threadId: "main", item: { type: "subAgentActivity", kind: "started", agentThreadId: "hosted", model: "gpt-6-astra" } } }),
    usage("main", [100, 0, 10], [100, 0, 10]),
    usage("child", [1000, 0, 200], [1000, 0, 200]),
    usage("hosted", [50, 0, 7], [50, 0, 7]),
    // Spawned without a model: the run's.
    usage("other", [20, 0, 3], [20, 0, 3]),
  ];
  const c = count_codex(lines, "codex", none);
  const out = Object.entries(c.models).map(([m, n]) => [m, n.output]);
  assert.deepEqual(out, [["gpt-6-astra", 7], ["gpt-6-luna", 200], ["gpt-6.1-sol", 13]]);
});

/** An `assistant` message of request `id`, as Claude Code prints one for each of its content blocks. */
function reply(id: string, model: string, input: number, output: number, parent: string | null): string {
  return JSON.stringify({
    type: "assistant",
    parent_tool_use_id: parent,
    message: {
      id,
      model,
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  });
}

const init = () => JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });

test("a_claude_run_that_ends_without_a_result_counts_its_requests", () => {
  const lines = [
    init(),
    reply("m1", "claude-opus-5-5", 1200, 10, null),
    // The same request's next content block, with more of its output.
    reply("m1", "claude-opus-5-5", 1200, 300, null),
    // A subagent's, and a synthetic message (an error) that wasn't sent to the model.
    reply("m2", "claude-haiku-5-5", 50, 5, "toolu_1"),
    reply("m3", "<synthetic>", 0, 0, null),
  ];
  const c = count_claude(lines, none);
  const out = Object.entries(c.models).map(([m, n]) => [m, n.input, n.output]);
  assert.deepEqual(out, [["claude-haiku-5-5", 50, 5], ["claude-opus-5-5", 1200, 300]]);
  assert.ok(c.estimated);
  assert.equal(c.session, "s1");
  assert.equal(c.tail["claude-opus-5-5"].output, 300);
});

test("a_claude_runs_requests_after_its_last_result_count_once", () => {
  const lines = [
    init(),
    reply("m1", "claude-opus-5-5", 5, 100, null),
    result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) }),
    // The next turn was stopped before its result.
    reply("m2", "claude-opus-5-5", 2, 40, null),
  ];
  const c = count_claude(lines, none);
  // m1 is in the result's totals; m2 is counted from its message.
  assert.equal(c.models["claude-opus-5-5"].output, 140);
  assert.equal(c.snapshot["claude-opus-5-5"].output, 140);
  assert.equal(c.tail["claude-opus-5-5"].output, 40);
  const before: Before = { totals: structuredClone(c.snapshot), tail: structuredClone(c.tail) };

  // The next run resumes the session. Claude Code kept the stopped turn in its totals: it goes on from them.
  const earlier: Earlier = () => clone(before);
  const kept = count_claude([reply("m3", "claude-opus-5-5", 802, 30, null), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })], earlier);
  assert.equal(kept.models["claude-opus-5-5"].output, 30);
  assert.ok(!kept.estimated);
  // It didn't: it goes on from the totals before it, not from nothing.
  const lost = count_claude([result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })], earlier);
  assert.equal(lost.models["claude-opus-5-5"].output, 30);
  assert.ok(!lost.estimated);
});

/** Counts runs A, B, … of one session in turn, each going on from the one before, as count_run does. */
function in_turn(runs: string[][]): Counted[] {
  let before: Before | null = null;
  return runs.map((lines) => {
    const prev = before;
    const c = count_claude(lines, () => (prev ? clone(prev) : null));
    // A run that saved no totals leaves its earlier run's (see save).
    if (Object.keys(c.snapshot).length) before = { totals: structuredClone(c.snapshot), tail: structuredClone(c.tail) };
    return c;
  });
}

const outputs = (counted: Counted[]) => counted.map((c) => c.models["claude-opus-5-5"].output);

test("a_resumed_claude_run_with_no_result_goes_on_from_the_sessions_totals", () => {
  const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })];
  // Killed before its result.
  const b = [init(), reply("m1", "claude-opus-5-5", 2, 40, null)];
  // Claude Code kept B's request in its totals.
  let c = [init(), reply("m3", "claude-opus-5-5", 802, 30, null), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })];
  assert.deepEqual(outputs(in_turn([a, b, c])), [100, 40, 30]);
  // It didn't: C goes on from A's totals.
  c = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })];
  const counted = in_turn([a, b, c]);
  assert.deepEqual(outputs(counted), [100, 40, 30]);
  assert.ok(near(counted[2].models["claude-opus-5-5"].cost, 0.5));

  // Two runs in a row with no result: their tails add up, and are taken away together if they
  // weren't kept.
  const b2 = [init(), reply("m2", "claude-opus-5-5", 1, 20, null)];
  const kept = [init(), reply("m3", "claude-opus-5-5", 701, 30, null), result("s1", { "claude-opus-5-5": opus(9, 190, 2000, 1.5) })];
  const lost = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })];
  for (const [last, want] of [[kept, 30], [lost, 30]] as Array<[string[], number]>) {
    const counted = in_turn([a, b, b2, last]);
    assert.deepEqual(outputs(counted), [100, 40, 20, want]);
    assert.equal(counted[2].tail["claude-opus-5-5"].output, 60);
  }
});

test("a_resumed_claude_run_goes_on_without_an_unkept_tail_on_a_model_the_session_hadnt_used", () => {
  const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })];
  // Killed before its result, after a request on a model A didn't use.
  const b = [init(), reply("m1", "claude-haiku-5-5", 2, 40, null)];
  // Claude Code didn't keep it: C's totals don't have that model.
  const c = [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })];
  const counted = in_turn([a, b, c]);
  assert.equal(counted[1].models["claude-haiku-5-5"].output, 40);
  assert.deepEqual(Object.entries(counted[2].models).map(([m, n]) => [m, n.output]), [["claude-opus-5-5", 30]]);
  assert.ok(near(counted[2].models["claude-opus-5-5"].cost, 0.5));
});

/**
 * Counts runs of one task with these outputs through the database, the last with Claude Code's
 * cost `cost`, and checks each one's output tokens and whether they're estimated.
 */
function assert_counted_in_db(outs: string[][], cost: number, want: Array<[number, boolean]>) {
  const state = testing.state();
  const task = new_task(state, null);
  const runs: string[] = [];
  for (const lines of outs) {
    const run = db.insert_run(state.db(), task, "prompt");
    const dir = run_dir(state, run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.jsonl"), lines.join("\n"));
    db.run(state.db(), "UPDATE runs SET status='exited' WHERE id=?1", run.id);
    runs.push(run.id);
  }
  db.run(state.db(), "UPDATE runs SET cost_usd=?2 WHERE id=?1", runs.at(-1), cost);
  count_pending(state, null);
  const out = runs.map((id) => {
    const r: any = db.one(state.db(), "SELECT SUM(output_tokens) AS o, MAX(estimated) AS e FROM token_usage WHERE run_id=?1", id);
    return [r.o, !!r.e];
  });
  assert.deepEqual(out, want);
}

test("a_run_killed_before_its_result_doesnt_hide_its_sessions_totals", () => {
  let outs = [
    [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })],
    [init(), reply("m1", "claude-opus-5-5", 2, 40, null)],
    [init(), reply("m2", "claude-opus-5-5", 802, 30, null), result("s1", { "claude-opus-5-5": opus(9, 170, 2000, 1.5) })],
  ];
  assert_counted_in_db(outs, 0.5, [[100, false], [40, true], [30, false]]);
  // The killed run used a model the session hadn't, and Claude Code didn't keep it.
  outs = [
    [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })],
    [init(), reply("m1", "claude-haiku-5-5", 2, 40, null)],
    [init(), result("s1", { "claude-opus-5-5": opus(9, 130, 2000, 1.5) })],
  ];
  assert_counted_in_db(outs, 0.5, [[100, false], [40, true], [30, false]]);
});

test("a_resumed_claude_runs_own_requests_say_whether_an_unkept_tail_is_in_totals_that_go_on_from_it", () => {
  // A's totals fed in 1015; B was killed after a request that fed in 102 and put out 40.
  const a = [init(), result("s1", { "claude-opus-5-5": opus(5, 100, 1000, 1.0) })];
  const b = [init(), reply("m1", "claude-opus-5-5", 2, 40, null)];
  // C's request feeds in 1000 and puts out 100. Claude Code didn't keep B's: C's totals are A's and C's, which still
  // go on from A's and B's (200 output tokens, past 140).
  const lost = [init(), reply("m2", "claude-opus-5-5", 900, 100, null), result("s1", { "claude-opus-5-5": opus(905, 200, 1100, 1.5) })];
  // It did: they're all three's.
  const kept = [init(), reply("m2", "claude-opus-5-5", 900, 100, null), result("s1", { "claude-opus-5-5": opus(907, 240, 1200, 1.5) })];
  for (const c of [lost, kept]) {
    const counted = in_turn([a, b, c]);
    assert.deepEqual(outputs(counted), [100, 40, 100]);
    assert.ok(!counted[2].estimated);
    assert.ok(near(counted[2].models["claude-opus-5-5"].cost, 0.5));
  }
  // Saved so, through the database.
  assert_counted_in_db([a, b, lost], 0.5, [[100, false], [40, true], [100, false]]);

  // Requests that don't match either (the totals have some that print no message) go with the closer, estimated.
  const unsure = [init(), reply("m2", "claude-opus-5-5", 600, 100, null), result("s1", { "claude-opus-5-5": opus(905, 200, 1100, 1.5) })];
  const counted = in_turn([a, b, unsure]);
  assert.equal(counted[2].models["claude-opus-5-5"].output, 60);
  assert.ok(counted[2].estimated);
});
