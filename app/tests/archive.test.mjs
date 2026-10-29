import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// The app's modules import each other without extensions, as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { ARCHIVE_AFTER_MS, isArchived } = await import("../src/api.ts");

const now = Date.parse("2026-10-26T12:00:00Z");
const ago = (ms) => new Date(now - ms).toISOString();
const task = (fields) => ({ status: "done", updated_at: ago(0), ...fields });

test("a task is archived once it's been done for two days", () => {
  assert.equal(isArchived(task({ done_at: ago(ARCHIVE_AFTER_MS - 60_000) }), now), false);
  assert.equal(isArchived(task({ done_at: ago(ARCHIVE_AFTER_MS) }), now), true);
  // However long ago it last changed otherwise.
  assert.equal(isArchived(task({ done_at: ago(0), updated_at: ago(10 * ARCHIVE_AFTER_MS) }), now), false);
  assert.equal(isArchived(task({ done_at: ago(3 * ARCHIVE_AFTER_MS), updated_at: ago(0) }), now), true);
});

test("only done tasks are archived", () => {
  for (const status of ["todo", "in_progress", "in_review", "ready_for_merge", "backlog"]) {
    assert.equal(isArchived(task({ status, done_at: ago(3 * ARCHIVE_AFTER_MS), updated_at: ago(3 * ARCHIVE_AFTER_MS) }), now), false, status);
  }
});

test("a host from before done_at goes by when the task last changed", () => {
  // It doesn't send done_at at all; a newer host sends null only for a task that isn't done.
  assert.equal(isArchived(task({ updated_at: ago(3 * ARCHIVE_AFTER_MS) }), now), true);
  assert.equal(isArchived(task({ updated_at: ago(60_000) }), now), false);
  assert.equal(isArchived(task({ done_at: null, updated_at: ago(3 * ARCHIVE_AFTER_MS) }), now), false);
});
