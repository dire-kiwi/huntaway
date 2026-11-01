import assert from "node:assert/strict";
import { test } from "node:test";
import { openingTab } from "../src/openingTab.ts";

const task = (fields) => ({ kind: "task", status: "in_review", running: false, document_at: null, task_type: null, ...fields });
const at = "2026-10-26T09:00:00Z";

// IA-147: a plan, artifact or diagram task opens on its document only when it's ready, otherwise on the thread. Hosts
// before API 71 still have them as types; since, they're labels, and a task from before keeps working in its own folder.
test("a plan, artifact or diagram task opens on the thread until its document is ready", () => {
  for (const type of ["plan", "artifact", "diagram"]) {
    for (const fields of [{ task_type: type }, { labels: [type], work_dir: "documents/t" }]) {
      const t = (more) => task({ ...fields, ...more });
      for (const status of ["todo", "backlog"]) assert.equal(openingTab(t({ status })), "thread", `${type} in ${status} with no document`);
      assert.equal(openingTab(t({})), "thread", `${type} in review with no document`);
      assert.equal(openingTab(t({ status: "in_progress", running: true, document_at: at })), "thread", `${type} being written`);
      assert.equal(openingTab(t({ status: "in_progress", document_at: at })), "thread", `${type} queued`);
      assert.equal(openingTab(t({ status: "needs_attention", document_at: at })), "thread", `${type} waiting on the user`);
      for (const status of ["in_review", "done", "todo", "backlog"]) assert.equal(openingTab(t({ status, document_at: at })), type, `${type} ready in ${status}`);
    }
  }
});

// HA-27: any task can have labels.
test("a labelled task opens on its first label's document once it's ready, else as other tasks", () => {
  const t = (more) => task({ labels: ["diagram", "plan"], ...more });
  assert.equal(openingTab(t({ status: "todo" })), "details");
  assert.equal(openingTab(t({})), "thread");
  assert.equal(openingTab(t({ status: "in_progress", running: true, document_at: at })), "thread");
  assert.equal(openingTab(t({ document_at: at })), "plan");
  assert.equal(openingTab(t({ labels: [], document_at: at })), "thread");
  assert.equal(openingTab(t({ task_type: "scratch", labels: ["artifact"], document_at: at, status: "done" })), "artifact");
});

test("other tasks open on their details until started, then on the thread", () => {
  for (const task_type of [null, "scratch"]) {
    assert.equal(openingTab(task({ task_type, status: "todo" })), "details");
    assert.equal(openingTab(task({ task_type, status: "backlog" })), "details");
    assert.equal(openingTab(task({ task_type, status: "in_progress", running: true })), "thread");
    assert.equal(openingTab(task({ task_type })), "thread");
  }
  // A scratch task from a scratch chat works in the chat's folder.
  assert.equal(openingTab(task({ task_type: "scratch", labels: [], work_dir: "/chat", status: "todo" })), "details");
  assert.equal(openingTab(undefined), "thread");
});

// HA-60: once its review passes, a task in review opens on the summary of the changes it passed.
test("a task whose review passed opens on the summary of its changes", () => {
  const review = { state: "passed", head: "abc" };
  const summary = (more) => ({ thread_id: "s", label: "", state: "done", head: "abc", text: "Did it.", updated_at: at, ...more });
  const t = (more) => task({ review, summary: summary(), ...more });
  assert.equal(openingTab(t({})), "summary");
  assert.equal(openingTab(t({ summary: summary({ state: "running", text: null }) })), "summary", "being written");
  for (const state of ["failed", "stopped"]) assert.equal(openingTab(t({ summary: summary({ state }) })), "thread", `summary ${state}`);
  assert.equal(openingTab(t({ summary: summary({ head: "old" }) })), "thread", "a summary of an earlier commit");
  assert.equal(openingTab(t({ summary: null })), "thread", "no summary");
  for (const state of ["running", "issues", "failed"]) assert.equal(openingTab(t({ review: { state, head: "abc" } })), "thread", `review ${state}`);
  assert.equal(openingTab(t({ running: true })), "thread", "the agent is working again");
  for (const status of ["in_progress", "ready_for_merge", "done"]) assert.equal(openingTab(t({ status })), "thread", status);
  // A labelled task's document comes first.
  assert.equal(openingTab(t({ labels: ["plan"], document_at: at })), "plan");
});
