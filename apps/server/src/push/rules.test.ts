import { assert, describe, it } from "@effect/vitest"
import { TaskId, Timestamp } from "@huntaway/contracts"
import type { Task } from "@huntaway/contracts"
import { storedEvents } from "./PushRepo.ts"
import { DEFAULT_EVENTS, endpointProblem, mergedEvents, notificationText, promptText, reportText, STOPPED, taskEvent, wants, wantsPrompt } from "./rules.ts"

// The old push tests' plain cases: task_changes_notify_as_the_ui_does, a_reports_notification_says_its_first_line, the
// prompts' texts (from questions_and_plans_are_pushed_without_allow_and_deny…), and events_left_out_keep_what_they_were's
// merging and stored values.

type Seen = Pick<Task, "kind" | "status" | "running" | "review" | "attention_reason" | "key" | "title" | "resolution">
const task = (status: Task["status"], fields: Partial<Seen> = {}): Seen => ({
  kind: "task",
  key: "WEB-3",
  title: "Fix the login",
  status,
  running: false,
  review: null,
  attention_reason: null,
  resolution: null,
  ...fields,
})
const review = (state: "running" | "issues" | "passed"): Task["review"] => ({
  thread_id: TaskId.make("review"),
  state,
  head: null,
  summary: null,
  issues: [],
  fixes: 0,
  extra_rounds: 0,
  updated_at: Timestamp.make("2026-11-12T00:00:00.000Z"),
  reviewers: [],
})
const withf = (t: Seen, fields: Partial<Seen>): Seen => Object.assign({}, t, fields)

const d = (outcome: string, text: string, automation = "Inbox") => ({ automation, outcome, text })
const p = (tool_name: string, kind = "tool", input: unknown = {}) => promptText({ kind, tool_name, input })

describe("push rules", () => {
  it("notifies of task changes as the board's notifications do", () => {
    const working = task("in_progress", { running: true })
    const asks = task("needs_attention", { running: true, attention_reason: "Approve Bash?" })
    assert.strictEqual(taskEvent(working, asks), "attention")
    // Not again while it stays there, nor for a run the user stopped, nor for a review thread.
    assert.strictEqual(taskEvent(asks, withf(asks, { attention_reason: "Approve Write?" })), null)
    assert.strictEqual(taskEvent(working, task("needs_attention", { attention_reason: STOPPED })), null)
    assert.strictEqual(taskEvent(working, withf(asks, { kind: "review" })), null)
    // In review: once its agent stopped and its review passed (or with none).
    const reviewing = task("in_review", { review: review("running") })
    assert.strictEqual(taskEvent(working, reviewing), null)
    assert.strictEqual(taskEvent(reviewing, task("in_review", { review: review("issues") })), null)
    const passed = task("in_review", { review: review("passed") })
    assert.strictEqual(taskEvent(reviewing, passed), "review")
    assert.strictEqual(taskEvent(working, task("in_review")), "review")
    assert.strictEqual(taskEvent(working, task("in_review", { running: true })), null)
    assert.strictEqual(taskEvent(passed, task("ready_for_merge")), "merge")
    assert.strictEqual(taskEvent(task("ready_for_merge"), task("done")), "done")
    assert.strictEqual(taskEvent(task("done"), task("done")), null)

    assert.deepStrictEqual(notificationText("attention", asks), { title: "WEB-3 Fix the login", body: "Needs attention: Approve Bash?" })
    assert.strictEqual(notificationText("review", passed).body, "Ready to review: its review passed")
    assert.strictEqual(notificationText("done", task("done", { resolution: "wont_fix" })).body, "Closed: won't fix")
    assert.strictEqual(notificationText("done", task("done", { resolution: "done" })).body, "Done")
    const long = notificationText("attention", withf(asks, { attention_reason: "x".repeat(300) })).body
    assert.strictEqual(Array.from(long).length, 200)
    assert.isTrue(long.endsWith("…"))
  })

  it("says a report's first line", () => {
    assert.deepStrictEqual(reportText(d("reported", "\n\n- Two mails from the bank\nmore")), { title: "Inbox", body: "Two mails from the bank" })
    assert.strictEqual(reportText(d("reported", "## Today\n\n**Dentist at 9:30**; two mails need you."))?.body, "Today")
    assert.strictEqual(reportText(d("reported", ""))?.body, "Posted a report")
    assert.strictEqual(reportText(d("failed", "Out of usage"))?.body, "Failed: Out of usage")
    assert.strictEqual(Array.from(reportText(d("reported", "x".repeat(300)))?.body ?? "").length, 200)
    assert.strictEqual(reportText(d("asked", "x")), null)
    assert.strictEqual(reportText(d("reported", "x", ""))?.title, "A routine")
  })

  it("names what a prompt asks, never what the tool would do", () => {
    assert.strictEqual(p("Bash", "tool", { command: "rm -rf /tmp/secret-stuff" }), "Approve Bash?")
    assert.strictEqual(p("AskUserQuestion"), "The agent has questions for you")
    assert.strictEqual(p("ExitPlanMode"), "Plan ready for approval")
    assert.strictEqual(p("mcp__huntaway__update_project", "project"), "Approve a project change?")
    assert.strictEqual(p("mcp__huntaway__delete_task", "delete_task"), "Delete a task?")
    assert.strictEqual(p("x", "automation", { automation: {} }), "Approve an automation?")
    assert.strictEqual(p("x", "automation", { workflow: { id: "w" } }), "Approve a workflow?")
  })

  it("keeps the events a change leaves out, and reads a stored value from before reports as without them", () => {
    const merged = mergedEvents(DEFAULT_EVENTS, { merge: true })
    assert.deepStrictEqual(merged, { attention: true, review: true, merge: true, done: false, prompts: "assistant", replies: false, reports: true })
    const on = mergedEvents(merged, { replies: true, reports: false })
    assert.deepStrictEqual([on.replies, on.reports, on.merge], [true, false, true])
    // One stored before (with the four board events only) gets neither replies nor reports; one that doesn't read, the defaults.
    assert.deepStrictEqual(storedEvents('{"attention":true,"review":true,"merge":false,"done":false}'), {
      attention: true,
      review: true,
      merge: false,
      done: false,
      prompts: "assistant",
      replies: false,
      reports: false,
    })
    assert.deepStrictEqual(storedEvents('{"replies":"yes"}'), DEFAULT_EVENTS)
    assert.deepStrictEqual(storedEvents("not json"), DEFAULT_EVENTS)
  })

  it("picks the devices that want an event, and whose prompts", () => {
    const none = Object.assign({}, DEFAULT_EVENTS, { attention: false, review: false, reports: false })
    assert.isFalse(wants(none, "attention"))
    assert.isTrue(wants(Object.assign({}, none, { replies: true }), "reply"))
    assert.isTrue(wants(DEFAULT_EVENTS, "report"))
    assert.isFalse(wants(Object.assign({}, DEFAULT_EVENTS, { prompts: "all" }), "prompt"))
    const mine = { kind: "task", task_type: "assistant" } as const
    const routine = { kind: "task", task_type: "routine" } as const
    const project = { kind: "task", task_type: null } as const
    assert.deepStrictEqual(
      [mine, routine, project].map((t) => wantsPrompt(DEFAULT_EVENTS, t)),
      [true, true, false],
    )
    assert.isTrue(wantsPrompt(Object.assign({}, DEFAULT_EVENTS, { prompts: "all" }), project))
    assert.isFalse(wantsPrompt(Object.assign({}, DEFAULT_EVENTS, { prompts: "all" }), { kind: "review", task_type: null }))
    assert.isFalse(wantsPrompt(Object.assign({}, DEFAULT_EVENTS, { prompts: "off" }), mine))
  })

  it("takes https endpoints, and plain http only on this machine", () => {
    assert.strictEqual(endpointProblem("https://push.example.com/send/abc"), null)
    assert.strictEqual(endpointProblem("http://127.0.0.1:9/push"), null)
    assert.strictEqual(endpointProblem("http://localhost/push"), null)
    assert.strictEqual(endpointProblem("http://push.example.com/x"), "endpoint must be an https: URL")
    assert.strictEqual(endpointProblem("not a url"), "endpoint must be a URL")
  })
})
