// Port of the tests in server/src/agent/prompts.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import { DEFAULT_MERGE, DEFAULT_REVIEW, DEFAULT_START, defaults, merge, review, review_by, start } from "./prompts.ts";

test("a_reviewers_own_instructions_win_over_the_projects", () => {
  const own = db.Reviewer_default();
  assert.equal(review_by(null, own), DEFAULT_REVIEW);
  own.prompt = "  Look at the SQL only.  ";
  assert.equal(review_by(null, own), "Look at the SQL only.");
  own.prompt = "   ";
  assert.equal(review_by(null, own), DEFAULT_REVIEW);
});

test("a_project_without_its_own_uses_the_default", () => {
  const c = db.open(":memory:");
  const profile = db.insert_profile(c, "me", [], null);
  const p = db.insert_project(c, {
    id: "p",
    profile_id: profile.id,
    name: "p",
    key: "P",
    repo_path: "/x",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: false,
  });
  assert.deepEqual([start(p), review(p), merge(p)], [DEFAULT_START, DEFAULT_REVIEW, DEFAULT_MERGE]);
  assert.equal(start(null), DEFAULT_START);
  p.start_prompt = "  Plan first.\n";
  p.merge_prompt = "   ";
  assert.deepEqual([start(p), merge(p)], ["Plan first.", DEFAULT_MERGE]);
  assert.equal(defaults()["review_prompt"], DEFAULT_REVIEW);
});
