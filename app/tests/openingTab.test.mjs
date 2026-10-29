import assert from "node:assert/strict";
import { test } from "node:test";
import { openingTab } from "../src/openingTab.ts";

const task = (fields) => ({ status: "in_review", running: false, document_at: null, task_type: null, ...fields });
const at = "2026-10-26T09:00:00Z";

// IA-147: a plan, artifact or diagram task opens on its document only when it's ready, otherwise on the thread.
test("a plan, artifact or diagram task opens on the thread until its document is ready", () => {
  for (const type of ["plan", "artifact", "diagram"]) {
    for (const status of ["todo", "backlog"]) assert.equal(openingTab(task({ task_type: type, status })), "thread", `${type} in ${status} with no document`);
    assert.equal(openingTab(task({ task_type: type })), "thread", `${type} in review with no document`);
    assert.equal(openingTab(task({ task_type: type, status: "in_progress", running: true, document_at: at })), "thread", `${type} being written`);
    assert.equal(openingTab(task({ task_type: type, status: "in_progress", document_at: at })), "thread", `${type} queued`);
    assert.equal(openingTab(task({ task_type: type, status: "needs_attention", document_at: at })), "thread", `${type} waiting on the user`);
    for (const status of ["in_review", "done", "todo", "backlog"]) assert.equal(openingTab(task({ task_type: type, status, document_at: at })), type, `${type} ready in ${status}`);
  }
});

test("other tasks open on their details until started, then on the thread", () => {
  for (const task_type of [null, "scratch"]) {
    assert.equal(openingTab(task({ task_type, status: "todo" })), "details");
    assert.equal(openingTab(task({ task_type, status: "backlog" })), "details");
    assert.equal(openingTab(task({ task_type, status: "in_progress", running: true })), "thread");
    assert.equal(openingTab(task({ task_type })), "thread");
  }
  assert.equal(openingTab(undefined), "thread");
});
