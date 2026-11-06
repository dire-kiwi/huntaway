// Port of the tests in server/src/agent/tokens/calls.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as db from "../../db.ts";
import * as analytics from "../../analytics.ts";
import * as testing from "../../testing.ts";
import { Counts_default } from "../tokens.ts";
import { Spent_claude, Spent_claude_stream, Spent_codex, record, type Spent } from "./calls.ts";

test("reads_what_a_call_used", () => {
  // What `claude -p --output-format json` prints (cut down).
  const r = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Fix login button",
    total_cost_usd: 0.0001565,
    modelUsage: {
      "claude-haiku-5-5": {
        inputTokens: 2,
        outputTokens: 67,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 614,
        costUSD: 0.0001565,
        thinkingTokens: 56,
        contextWindow: 1000000,
      },
    },
  };
  const c = Counts_default({ input: 2, output: 67, cache_write: 614, reasoning: 56, cost: 0.0001565 });
  assert.deepEqual(Spent_claude(r), { runtime: "claude", models: { "claude-haiku-5-5": c } });
  // stream-json's last result, after the rest.
  const stream = `${JSON.stringify({ type: "rate_limit_event" })}\n${JSON.stringify({ type: "assistant", message: { content: "result" } })}\n${JSON.stringify(r)}\n`;
  assert.deepEqual(Spent_claude_stream(stream), Spent_claude(r));
  assert.equal(Spent_claude_stream('{"type":"rate_limit_event"}\n'), null);
  // Codex counts cached input in the input.
  const u = { total: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 20, reasoningOutputTokens: 12 }, last: {} };
  const cx = Counts_default({ input: 100, output: 20, cache_read: 800, reasoning: 12 });
  assert.deepEqual(Spent_codex("gpt-6.1-mini", u), { runtime: "codex", models: { "gpt-6.1-mini": cx } });
});

test("calls_are_in_the_token_report_of_their_tasks_or_their_configs_profile", () => {
  const s = testing.state();
  const c = s.db();
  const dir = testing.temp_dir();
  const cfg_of = (n: string) => db.insert_claude_config(c, n, join(dir, n), "claude").id;
  const [cfg, other_cfg, unused] = [cfg_of("a"), cfg_of("b"), cfg_of("c")];
  const first = db.insert_profile(c, "first", [other_cfg], null);
  const second = db.insert_profile(c, "second", [cfg, other_cfg], null);
  // Created later, though the first profile's row sorts after it by id.
  db.run(c, "UPDATE profiles SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?1", first.id);
  const task = db.insert_task(c, {
    profile_id: second.id,
    project_id: null,
    kind: "task",
    title: "t",
    description: "",
    status: "todo",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const spent = (output: number): Spent => ({ runtime: "claude", models: { haiku: Counts_default({ output, cost: 0.01 }) } });
  record(s, "title", task.id, cfg, spent(1));
  record(s, "window", null, cfg, spent(2));
  // Used by both profiles: the first one's.
  record(s, "window", null, other_cfg, spent(4));
  // Used by none: the first profile's.
  record(s, "window", null, unused, spent(8));
  // Nothing used: no row.
  record(s, "window", null, cfg, { runtime: "claude", models: { haiku: Counts_default() } });
  // A task deleted while its title was written: no row.
  record(s, "title", "gone", null, spent(16));
  // A call on two models, and another just like it (in the same millisecond, maybe): a
  // row for each model, which share their call's id.
  const two: Spent = { runtime: "claude", models: { haiku: Counts_default({ output: 32 }), opus: Counts_default({ output: 64 }) } };
  record(s, "window", null, unused, two);
  record(s, "window", null, unused, two);
  const from = "2000-01-01T00:00:00.000Z";
  const to = "2999-01-01T00:00:00.000Z";
  const calls = analytics
    .token_report(s.db(), first.id, from, to)
    .usage.filter((u: any) => u.output_tokens >= 32)
    .map((u: any) => u.call_id);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 2, JSON.stringify(calls));
  db.run(s.db(), "DELETE FROM call_usage WHERE output_tokens >= 32");
  const report = (p: string) => analytics.token_report(s.db(), p, from, to).usage.map((u: any) => [u.kind, u.task_id, u.run_id, u.output_tokens]);
  assert.deepEqual(report(first.id), [
    ["window", null, null, 4],
    ["window", null, null, 8],
  ]);
  assert.deepEqual(report(second.id), [
    ["title", task.id, null, 1],
    ["window", null, null, 2],
  ]);
  // Deleting the task takes its titles' rows.
  db.run(s.db(), "DELETE FROM tasks WHERE id=?1", task.id);
  assert.deepEqual(report(second.id), [["window", null, null, 2]]);
});
