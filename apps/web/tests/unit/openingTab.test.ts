import { describe, expect, it } from "@effect/vitest"
import { type ChangeSummary, type Review, TaskId, Timestamp } from "@huntaway/contracts"
import { openingTab } from "../../src/components/task/openingTab"

// The old tests/openingTab.test.ts. Dropped: a plan, artifact or diagram as the task's type (hosts before API 71 had
// them so; on this server they are labels), and a task's single `summary` (it has `summaries`).

const AT = Timestamp.make("2026-10-26T09:00:00.000Z")

type Opened = Parameters<typeof openingTab>[0] & object

const task = (fields: Partial<Opened> = {}): Opened => ({
  kind: "task",
  task_type: null,
  labels: [],
  work_dir: null,
  status: "in_review",
  running: false,
  document_at: null,
  review: null,
  summaries: [],
  ...fields,
})

const review = (more: Partial<Review> = {}): Review => ({
  thread_id: TaskId.make("r"),
  state: "passed",
  head: "abc",
  summary: null,
  issues: [],
  fixes: 0,
  extra_rounds: 0,
  updated_at: AT,
  reviewers: [],
  ...more,
})

const summary = (more: Partial<ChangeSummary> = {}): ChangeSummary => ({
  thread_id: TaskId.make("s"),
  label: "",
  state: "done",
  head: "abc",
  text: "Did it.",
  updated_at: AT,
  ...more,
})

/** A task with two labels, as given. */
const labelled = (more: Partial<Opened>) => task({ labels: ["diagram", "plan"], ...more })

describe("openingTab", () => {
  // IA-147: a task that makes only its documents opens on its document only when it's ready, otherwise on the thread.
  it("a task that makes only documents opens on the thread until its document is ready", () => {
    for (const label of ["plan", "artifact", "diagram"] as const) {
      const t = (more: Partial<Opened>) => task({ labels: [label], work_dir: "documents/t", ...more })
      for (const status of ["todo", "backlog"] as const) expect(openingTab(t({ status })), `${label} in ${status} with no document`).toBe("thread")
      expect(openingTab(t({})), `${label} in review with no document`).toBe("thread")
      expect(openingTab(t({ status: "in_progress", running: true, document_at: AT })), `${label} being written`).toBe("thread")
      expect(openingTab(t({ status: "in_progress", document_at: AT })), `${label} queued`).toBe("thread")
      expect(openingTab(t({ status: "needs_attention", document_at: AT })), `${label} waiting on the user`).toBe("thread")
      for (const status of ["in_review", "done", "todo", "backlog"] as const)
        expect(openingTab(t({ status, document_at: AT })), `${label} ready in ${status}`).toBe(label)
    }
  })

  // HA-27: any task can have labels.
  it("a labelled task opens on its first label's document once it's ready, else as other tasks", () => {
    const t = labelled
    expect(openingTab(t({ status: "todo" }))).toBe("details")
    expect(openingTab(t({}))).toBe("thread")
    expect(openingTab(t({ status: "in_progress", running: true, document_at: AT }))).toBe("thread")
    expect(openingTab(t({ document_at: AT }))).toBe("plan")
    expect(openingTab(t({ labels: [], document_at: AT }))).toBe("thread")
    expect(openingTab(t({ task_type: "scratch", labels: ["artifact"], document_at: AT, status: "done" }))).toBe("artifact")
  })

  it("other tasks open on their details until started, then on the thread", () => {
    for (const task_type of [null, "scratch"] as const) {
      expect(openingTab(task({ task_type, status: "todo" }))).toBe("details")
      expect(openingTab(task({ task_type, status: "backlog" }))).toBe("details")
      expect(openingTab(task({ task_type, status: "in_progress", running: true }))).toBe("thread")
      expect(openingTab(task({ task_type }))).toBe("thread")
    }
    // A scratch task from a scratch chat works in the chat's folder.
    expect(openingTab(task({ task_type: "scratch", work_dir: "/chat", status: "todo" }))).toBe("details")
    expect(openingTab(undefined)).toBe("thread")
  })

  // HA-60: once its review passes, a task in review opens on the summary of the changes it passed.
  it("a task whose review passed opens on the summary of its changes", () => {
    const t = (more: Partial<Opened>) => task({ review: review(), summaries: [summary()], ...more })
    expect(openingTab(t({}))).toBe("summary")
    expect(openingTab(t({ summaries: [summary({ state: "running", text: null })] })), "being written").toBe("summary")
    for (const state of ["failed", "stopped"] as const) expect(openingTab(t({ summaries: [summary({ state })] })), `summary ${state}`).toBe("thread")
    expect(openingTab(t({ summaries: [summary({ head: "old" })] })), "a summary of an earlier commit").toBe("thread")
    expect(openingTab(t({ summaries: [] })), "no summary").toBe("thread")
    for (const state of ["running", "issues", "failed"] as const) expect(openingTab(t({ review: review({ state }) })), `review ${state}`).toBe("thread")
    expect(openingTab(t({ running: true })), "the agent is working again").toBe("thread")
    for (const status of ["in_progress", "ready_for_merge", "done"] as const) expect(openingTab(t({ status })), status).toBe("thread")
    // A labelled task's document comes first.
    expect(openingTab(t({ labels: ["plan"], document_at: AT }))).toBe("plan")
  })

  // HA-202: the profile's assistant is back in To do after each reply, and on a phone a task in To do opens on its details.
  it("the profile's assistant opens on its thread, in To do too", () => {
    for (const status of ["todo", "needs_attention", "in_progress"] as const)
      expect(openingTab(task({ task_type: "assistant", status })), status).toBe("thread")
    expect(openingTab(task({ task_type: "scratch", status: "todo" }))).toBe("details")
  })
})
