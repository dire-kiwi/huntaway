// The tests of server/src/review/stats.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import { Rounds, backfill, mentions_minor, minor_list, serious_count } from "./stats.ts";

test("tells_summaries_that_mention_minor_issues", () => {
  assert.ok(mentions_minor("One minor issue: the label is cut off."));
  assert.ok(mentions_minor("Nits: rename `x`."));
  assert.ok(mentions_minor("A few suggestions, none blocking."));
  assert.ok(!mentions_minor("No minor issues either."));
  assert.ok(!mentions_minor("I didn't find any minor problems or nits worth raising, nor any suggestions."));
  assert.ok(!mentions_minor("Everything checks out; tests pass."));
  assert.ok(!mentions_minor("Dominoes fell"));
});

test("reviews_are_read_from_their_threads_in_rounds", () => {
  const s = testing.state();
  // From messages: the test dates them after they're written, which their items (with the setting, on by default) don't see.
  db.set_setting(s.db(), "thread_items", "false");
  const p = db.insert_profile(s.db(), "p", [], null);
  const fresh = (kind: string) => ({
    profile_id: p.id,
    project_id: null,
    kind,
    title: "t",
    description: "",
    status: "in_review",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const task = db.insert_task(s.db(), fresh("task"));
  // Two reviewers, each with a thread of its own.
  const threads = [0, 1].map(() => {
    const t = db.insert_task(s.db(), fresh("review"));
    s.update_task(t.id, [["parent_id", task.id]]);
    return t.id;
  });
  const run = (thread: string, at: string) => {
    const r = db.insert_run(s.db(), thread, "review");
    db.run(s.db(), "UPDATE runs SET created_at=?1 WHERE id=?2", at, r.id);
    return r.id;
  };
  const say = (thread: string, at: string, data: any) => {
    const m = s.add_message(thread, "claude", data);
    db.run(s.db(), "UPDATE messages SET created_at=?1 WHERE id=?2", at, m.id);
  };
  const call = (id: string, input: any) => ({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id, name: "mcp__huntaway__submit_review", input },
      ],
    },
  });
  // Round 1: the first reviewer finds issues; the second's call is refused (its round had
  // ended), so it has no submission.
  const a1 = run(threads[0], "2026-10-01T10:00:00.000Z");
  run(threads[1], "2026-10-01T10:00:30.000Z");
  say(threads[0], "2026-10-01T10:05:00.000Z", call("a", { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["x", "y"] }));
  say(threads[1], "2026-10-01T10:06:00.000Z", call("b", { verdict: "pass", summary: "Fine." }));
  say(threads[1], "2026-10-01T10:06:01.000Z", {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "b", is_error: true, content: "the review this run was asked for has ended, so there's nothing to submit" },
      ],
    },
  });
  // Round 2, after the fixes: the first reviewer submits twice (its last counts); the
  // second uses the board's tools' name from before the rename.
  const a2 = run(threads[0], "2026-10-01T11:00:00.000Z");
  const b2 = run(threads[1], "2026-10-01T11:00:10.000Z");
  say(threads[0], "2026-10-01T11:04:00.000Z", call("c", { verdict: "needs_fixes", summary: "Hmm.", serious_issues: ["z"] }));
  say(threads[0], "2026-10-01T11:05:00.000Z", call("d", { verdict: "pass", summary: "Two minor issues remain.", serious_issues: [] }));
  const old = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "e", name: "mcp__issue_agent__submit_review", input: { verdict: "needs_fixes", summary: "Broken.", serious_issues: [] } },
      ],
    },
  };
  say(threads[1], "2026-10-01T11:06:00.000Z", old);

  const c = s.db();
  db.run(c, "DELETE FROM review_stats");
  backfill(c);
  const rows = db
    .all(c, "SELECT run_id, round, verdict, serious, minor, minor_noted FROM review_stats ORDER BY at")
    .map((r: any) => [r.run_id, r.round, r.verdict, r.serious, r.minor, !!r.minor_noted]);
  const [r1, r2] = ["2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"];
  assert.deepEqual(rows, [
    [a1, r1, "issues", 2, null, false],
    [a2, r2, "pass", 0, null, true],
    [b2, r2, "issues", 1, null, false],
  ]);
  // Once only.
  backfill(c);
  assert.equal(db.value(c, "SELECT COUNT(*) FROM review_stats"), 3);
});

test("a_reviewer_runs_once_a_round", () => {
  const r = new Rounds();
  const place = (thread: string, at: string) => r.place_new(thread, at)[1];
  // Two reviewers starting together.
  assert.ok(place("A", "2026-10-01T10:00:00.000Z"));
  assert.ok(!place("B", "2026-10-01T10:00:20.000Z"));
  // A quick fix: the first reviewer runs again within the gap, in a round of its own.
  assert.ok(place("A", "2026-10-01T10:01:30.000Z"));
  assert.ok(!place("B", "2026-10-01T10:01:35.000Z"));
  // A round long after.
  assert.ok(place("B", "2026-10-01T12:00:00.000Z"));
  // Another submission of a round kept with its start (a reviewer run again in it).
  assert.ok(!place("B", "2026-10-01T12:00:00.000Z"));
});

test("counts_issues_as_submit_does", () => {
  assert.equal(serious_count({ verdict: "pass", serious_issues: [] }), 0);
  assert.equal(serious_count({ verdict: "needs_fixes", serious_issues: ["a", " ", "b"] }), 2);
  assert.equal(serious_count({ verdict: "needs_fixes", serious_issues: [] }), 1);
  assert.equal(serious_count({ verdict: "needs_fixes", serious_issues: "one" }), 1);
  assert.deepEqual(minor_list({ minor_issues: ["x", ""] }), ["x"]);
  assert.equal(minor_list({}), null);
});
