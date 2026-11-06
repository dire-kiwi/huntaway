// Port of server/src/git/worktree/approval_tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { approved_by_reviews } from "../worktree.ts";

function pr(decision: any, reviews: Array<[string, string]>): any {
  return { reviewDecision: decision, reviews: reviews.map(([a, s]) => ({ author: { login: a }, state: s, authorAssociation: "MEMBER" })) };
}

// HA-113: a comment after an approval (or a change request) doesn't replace the reviewer's verdict.
test("a_reviewers_standing_verdict_survives_their_comments", () => {
  assert.ok(approved_by_reviews(pr("APPROVED", [])));
  assert.ok(!approved_by_reviews(pr("CHANGES_REQUESTED", [["a", "APPROVED"]])));
  assert.ok(
    approved_by_reviews(
      pr("", [
        ["a", "APPROVED"],
        ["a", "COMMENTED"],
      ]),
    ),
  );
  assert.ok(
    !approved_by_reviews(
      pr(null, [
        ["a", "CHANGES_REQUESTED"],
        ["a", "COMMENTED"],
        ["b", "APPROVED"],
      ]),
    ),
  );
  assert.ok(
    approved_by_reviews(
      pr(null, [
        ["a", "CHANGES_REQUESTED"],
        ["a", "APPROVED"],
      ]),
    ),
  );
  assert.ok(
    !approved_by_reviews(
      pr(null, [
        ["a", "APPROVED"],
        ["a", "DISMISSED"],
      ]),
    ),
  );
  assert.ok(!approved_by_reviews(pr(null, [["a", "COMMENTED"]])));
  // Required reviews not met: an approval GitHub doesn't count is no approval.
  assert.ok(!approved_by_reviews(pr("REVIEW_REQUIRED", [["a", "APPROVED"]])));
  // Without required reviews, an outside account's approval doesn't count.
  const outsider = { reviewDecision: "", reviews: [{ author: { login: "x" }, state: "APPROVED", authorAssociation: "NONE" }] };
  assert.ok(!approved_by_reviews(outsider));
});
