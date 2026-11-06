// Port of the tests in server/src/agent/window.rs.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as db from "../db.ts";
import type { ClaudeConfig } from "../db.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import * as usage from "./usage.ts";
import type { Limit } from "./usage.ts";
import { Watch_default, check, test_hooks, window } from "./window.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  // Each test starts with no prompts made, as Rust's thread-locals do.
  test_hooks.output = [];
  test_hooks.pings = 0;
  usage.TEST_CODEX.set(null);
});

/** A time as chrono's `to_rfc3339()` writes it. */
function at(t: number): string {
  return new Date(t).toISOString().replace("Z", "+00:00");
}

/** A config with the setting on and no login (so fetching its usage fails without the network). */
function config(s: Shared): ClaudeConfig {
  const dir = join(testing.temp_dir(), "claude");
  const c = s.db();
  const cfg = db.insert_claude_config(c, "work", dir, "claude");
  return db.update_claude_config(c, cfg.id, [["restart_window", true]])!;
}

function session(s: Shared, id: string, resets_at: number | null) {
  const l: Limit = { id: "session", label: "Session", percent: 40.0, resets_at: resets_at !== null ? at(resets_at) : null };
  usage.set_limits(s, id, [l], null);
}

function event(windows: any): string {
  return JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows } });
}

const secs = (t: number) => Math.floor(t / 1000);

function five_hour(resets: number): string {
  const r = secs(resets);
  return event({ five_hour: { utilization: 0.01, resetsAt: r }, seven_day: { utilization: 0.3, resetsAt: r + 86400 } });
}

const pings = () => test_hooks.pings;
const push = (o: { ok: string } | { err: string }) => test_hooks.output!.push(o);

test("a_window_that_ended_is_started_again_once", async () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  const w = Watch_default();
  session(s, c.id, now + HOUR);
  await check(s, c, w, now);
  assert.equal(pings(), 0, "still running");
  // Not until GRACE after the reset.
  await check(s, c, w, now + HOUR + 30_000);
  assert.equal(pings(), 0);
  const later = now + HOUR + 2 * MIN;
  const next = later + 5 * HOUR;
  const result = {
    type: "result",
    modelUsage: { "claude-haiku-5-5": { inputTokens: 3, outputTokens: 2, cacheCreationInputTokens: 600, costUSD: 0.0002 } },
  };
  push({ ok: `${five_hour(next)}\n${JSON.stringify(result)}\n` });
  await check(s, c, w, later);
  assert.equal(pings(), 1);
  // Its tokens are kept, as the config's.
  const kept: any = db.one(s.db(), "SELECT purpose, config_id, task_id, model, output_tokens, cache_write_tokens FROM call_usage");
  assert.deepEqual(
    [kept.purpose, kept.config_id, kept.task_id, kept.model, kept.output_tokens, kept.cache_write_tokens],
    ["window", c.id, null, "claude-haiku-5-5", 2, 600],
  );
  assert.equal(usage.session_reset(s, c.id), secs(next) * 1000);
  await check(s, c, w, later + MIN);
  assert.equal(pings(), 1, "the next window is running");
});

test("a_plan_without_the_window_is_sent_nothing", async () => {
  const s = testing.state();
  const c = config(s);
  const weekly: Limit = { id: "weekly", label: "Weekly", percent: 30.0, resets_at: at(Date.now() + 3 * 24 * HOUR) };
  usage.set_limits(s, c.id, [weekly], null);
  const w = Watch_default();
  await check(s, c, w, Date.now());
  // Nor is a config whose usage isn't known at all.
  const other = config(s);
  await check(s, other, Watch_default(), Date.now());
  assert.equal(pings(), 0);
});

test("a_window_seen_once_counts_while_its_usage_leaves_it_out", () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  const w = Watch_default();
  session(s, c.id, now - HOUR);
  assert.equal(window(s, c, w, now), "Ended");
  s.usage.get(c.id).limits = [];
  assert.equal(window(s, c, w, now), "Ended");
  assert.equal(window(s, c, Watch_default(), now), "None");
  // Nor one with no reset time.
  session(s, c.id, null);
  assert.equal(window(s, c, Watch_default(), now), "Ended");
});

test("a_failed_prompt_is_tried_again_later", async () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  const w = Watch_default();
  session(s, c.id, now - 5 * MIN);
  push({ err: "claude exited with 1" });
  await check(s, c, w, now);
  assert.deepEqual([pings(), w.failures], [1, 1]);
  await check(s, c, w, now + 4 * MIN);
  assert.equal(pings(), 1, "backing off");
  // A prompt that leaves no window running counts as failed too, and the wait doubles.
  push({ ok: '{"type":"result"}' });
  await check(s, c, w, now + 5 * MIN);
  assert.deepEqual([pings(), w.failures, w.retry_at], [2, 2, now + 15 * MIN]);
  const next = now + 5 * HOUR;
  push({ ok: five_hour(next) });
  await check(s, c, w, now + 15 * MIN);
  assert.deepEqual([pings(), w.failures, w.retry_at], [3, 0, null]);
});

test("a_prompt_that_shows_no_window_stops_the_restarts", async () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  const w = Watch_default();
  session(s, c.id, now - 5 * MIN);
  push({ ok: event({ seven_day: { utilization: 0.3, resetsAt: secs(now + 3 * 24 * HOUR) } }) });
  await check(s, c, w, now);
  assert.ok(w.no_window);
  await check(s, c, w, now + 2 * HOUR);
  assert.equal(pings(), 1);
});

test("a_prompt_that_reports_the_window_that_just_ended_carries_on", async () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  const w = Watch_default();
  const ended = now - MIN;
  session(s, c.id, ended);
  // What Claude Code prints for the first request after a window ends.
  const stale = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: secs(ended),
      rateLimitType: "five_hour",
      unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: secs(now + 3 * 24 * HOUR) }, seven_day_overage_included: { utilization: 0.1 } },
    },
  };
  push({ ok: JSON.stringify(stale) });
  await check(s, c, w, now);
  assert.ok(!w.no_window);
  assert.deepEqual([pings(), w.failures], [1, 1], "tried again later");
  const next = now + 5 * HOUR;
  push({ ok: five_hour(next) });
  await check(s, c, w, now + 5 * MIN);
  assert.deepEqual([pings(), w.failures, w.no_window], [2, 0, false]);
  assert.deepEqual(window(s, c, w, now + 5 * MIN), { open: secs(next) * 1000 });
});

test("a_codex_plan_whose_only_window_is_weekly_is_sent_nothing", async () => {
  const s = testing.state();
  const cdb = s.db();
  const made = db.insert_claude_config(cdb, "codex", "", "codex");
  const c = db.update_claude_config(cdb, made.id, [["restart_window", true]])!;
  const past = secs(Date.now() - HOUR);
  const weekly = { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: past }, secondary: null };
  usage.TEST_CODEX.set(weekly);
  const w = Watch_default();
  await check(s, c, w, Date.now());
  await check(s, c, w, Date.now() + 2 * HOUR);
  assert.equal(pings(), 0);
  assert.equal(usage.session_reset(s, c.id), undefined);
  // One with a 5-hour window that ended is.
  const both = { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: past }, secondary: { usedPercent: 10, windowDurationMins: 10080 } };
  usage.TEST_CODEX.set(both);
  push({ ok: "" });
  await check(s, c, Watch_default(), Date.now());
  assert.equal(pings(), 1);
});

test("a_config_out_of_usage_waits_for_its_reset", async () => {
  const s = testing.state();
  const c = config(s);
  const now = Date.now();
  session(s, c.id, now - 5 * MIN);
  // Refused for its weekly limit, which resets later.
  const soon = secs(now + 24 * HOUR);
  usage.on_rate_limit_event(s, c.id, { rate_limit_info: { status: "rejected", resetsAt: soon } });
  await check(s, c, Watch_default(), now);
  assert.equal(pings(), 0);
});
