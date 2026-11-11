import { assert, describe, it } from "@effect/vitest"
import { Option, Result, Schema } from "effect"
import { AgentConfigId, ProfileId, ProjectId, RunId, TaskId, TaskPatch, Timestamp } from "@huntaway/contracts"
import type { Conflict, ExternalLink, Invalid, NewTask, Task } from "@huntaway/contracts"
import type { Actor } from "../platform/Changes.ts"
import { checkStartFrom, indexTasks, placeholderTitle, rfc3339Utc, validBranchName } from "./checks.ts"
import type { ProjectFacts } from "./checks.ts"
import { decideCreate, decideDeleted, decideUpdate, deriveColumns, heldReason } from "./decide.ts"
import type { CreateFacts, Decision, NewRow, Place, TaskColumns, UpdateFacts } from "./decide.ts"

// The cases of huntaway's api/tasks.test.ts, api/new_task.test.ts, api/incoming.test.ts, db/tasks.test.ts and the
// reminder cases of mcp/tools/tasks.test.ts, as tables over the pure rules. What needs git, GitHub or a run comes in as
// a fact.

const NOW = Timestamp.make("2026-11-12T10:00:00.000Z")
const EARLIER = Timestamp.make("2026-11-01T10:00:00.000Z")
const profile = ProfileId.make("p")
const projectId = ProjectId.make("pr")
const id = (s: string) => TaskId.make(s)

const project: ProjectFacts = {
  id: projectId,
  profile_id: profile,
  name: "Shop",
  key: "X",
  former_keys: ["OLD"],
  archived: false,
  base_branch: "main",
  use_worktrees: true,
  is_git: true,
  pr_preview_url: null,
}

const task = (over: Partial<Task> = {}): Task => ({
  id: id("t1"),
  profile_id: profile,
  project_id: projectId,
  kind: "task",
  parent_id: null,
  task_type: null,
  labels: [],
  group_name: null,
  number: 1,
  key: "X-1",
  pen_id: null,
  fanout_id: null,
  created_by: null,
  position: 1,
  work_dir: null,
  title: "Fix it",
  title_pinned: false,
  description: "How",
  status: "todo",
  resolution: null,
  done_at: null,
  attention_reason: null,
  starred: false,
  remind_at: null,
  reminder: null,
  preview_url: null,
  pr_url: null,
  pr_checks: null,
  external_links: [],
  todos: [],
  tracked: [],
  context: null,
  document_at: null,
  cost_usd: 0,
  last_activity_at: EARLIER,
  created_at: EARLIER,
  updated_at: EARLIER,
  use_worktree: true,
  worktree_path: null,
  worktree_state: "none",
  worktree_error: null,
  branch: null,
  base_branch: null,
  start_from: null,
  merges_into: null,
  carries: null,
  restack: null,
  github_stack: null,
  stack_title: null,
  stack_description: null,
  stack_pinned: false,
  stack_run: null,
  merging: false,
  remerge: false,
  merge_approval: null,
  depends_on: [],
  waiting: false,
  session_id: null,
  running: false,
  run_started_at: null,
  steerable: false,
  limit_reset_at: null,
  agent_wait: null,
  background_work: null,
  servers: [],
  queued_message: null,
  steering: [],
  model: null,
  effort: null,
  permission_mode: null,
  claude_config_id: null,
  auto_allow: [],
  review: null,
  summaries: [],
  rewind: null,
  ...over,
})

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({
  project,
  running: false,
  configs: [AgentConfigId.make("c1"), AgentConfigId.make("c2")],
  tasks: [],
  gitWork: false,
  worktreeFolderExists: false,
  startCommit: null,
  prApproval: { _tag: "NotRequired" },
  endOfMergeQueue: 7,
  ...over,
})

const user: Actor = { _tag: "User" }
const board: Actor = { _tag: "Board" }
const agent: Actor = { _tag: "Agent", task_id: id("other") }

const update = (before: Task, patch: TaskPatch, f: Partial<UpdateFacts> = {}, actor: Actor = user) => decideUpdate(before, patch, facts(f), actor, NOW)

const ok = (r: Result.Result<Decision, Invalid | Conflict>): TaskColumns => {
  if (Result.isFailure(r)) return assert.fail(`refused: ${r.failure._tag} ${r.failure.message}`)
  return r.success.columns
}
const refused = <A>(r: Result.Result<A, Invalid | Conflict>): Invalid | Conflict => {
  if (Result.isSuccess(r)) return assert.fail("expected a refusal")
  return r.failure
}
/** Refused as `Invalid` on `field`, with a reason containing `text`. */
const invalid = <A>(r: Result.Result<A, Invalid | Conflict>, field: string, text = "") => {
  const e = refused(r)
  assert.strictEqual(e._tag, "Invalid", e.message)
  if (e._tag === "Invalid") {
    assert.strictEqual(e.field, field)
    assert.include(e.reason, text)
  }
}
/** Refused as `Conflict` for `reason`, with a detail containing `text`. */
const conflict = <A>(r: Result.Result<A, Invalid | Conflict>, reason: string, text = "") => {
  const e = refused(r)
  assert.strictEqual(e._tag, "Conflict", e.message)
  if (e._tag === "Conflict") {
    assert.strictEqual(e.reason, reason)
    assert.include(e.detail, text)
  }
}
/** `t` with `over` written over it. */
const like = (t: Task, over: Partial<Task>): Task => Object.assign({}, t, over)
const link = (lid: string, title: string): ExternalLink => ({ provider: "asana", id: lid, url: `https://app.asana.com/0/1/${lid}`, title })
const setLinks = (links: ReadonlyArray<ExternalLink> | null) => update(task(), { external_links: links })
const required = (url: string | null, approved: boolean, error: string | null = null): Partial<UpdateFacts> => ({
  gitWork: true,
  prApproval: { _tag: "Required", url, approved, error },
})
const pr = (n: number) => `https://github.com/o/web/pull/${n}`
const inProject = (over: Partial<ProjectFacts> = {}): Place => ({ _tag: "Project", project: Object.assign({}, project, over) })
const held = (stacked: boolean): TaskColumns => ({
  status: "needs_attention",
  attention_reason: heldReason("X-1", true, stacked),
  merging: false,
  remerge: false,
  merge_approval: null,
})

/** `before` as the change leaves it. */
const after = (before: Task, columns: TaskColumns): Task => Object.assign({}, before, columns)
const moved = (before: Task, patch: TaskPatch, f: Partial<UpdateFacts> = {}, actor: Actor = user) => after(before, ok(update(before, patch, f, actor)))

describe("decideUpdate: fields", () => {
  it("checks a task's fields for type before they're stored", () => {
    // What the contract's schema turns away before a decision sees it.
    for (const [i, bad] of [
      { title: null },
      { title: { a: 1 } },
      { title: 7 },
      { description: 42 },
      { description: ["x"] },
      { position: "top" },
      { position: null },
      { use_worktree: "yes" },
      { use_worktree: 1 },
      { model: 3 },
      { base_branch: ["main"] },
      { done_at: null },
      { effort: "" },
      { external_links: "x" },
      { external_links: [{ provider: "jira", id: "1", url: "https://x", title: "" }] },
      { labels: "plan" },
      { labels: ["poem"] },
    ].entries()) {
      assert.isTrue(Option.isNone(Schema.decodeUnknownOption(TaskPatch)(bad)), `case ${i}`)
    }
    for (const title of ["", "  "]) invalid(update(task(), { title }), "title", "non-empty")
    const set = ok(update(task(), { position: 2.5, use_worktree: false, model: "haiku", base_branch: null }))
    assert.deepStrictEqual(set, { position: 2.5, use_worktree: false, model: "haiku", base_branch: null })
    const fixed = ok(update(task(), { title: " Fixed ", description: null }))
    assert.deepStrictEqual([fixed.title, fixed.description], ["Fixed", ""])
  })

  it("pins a title renamed by hand, unless the change says otherwise", () => {
    assert.strictEqual(ok(update(task(), { title: "New" })).title_pinned, true)
    assert.strictEqual(ok(update(task(), { title: "New", title_pinned: false })).title_pinned, false)
    assert.isUndefined(ok(update(task(), { title: "Fix it" })).title_pinned)
  })

  it("links tasks to Asana tasks: each once, with an id and a web link, at most 20", () => {
    const set = setLinks
    assert.deepStrictEqual(ok(set([link("1002", " Fix signup ")])).external_links, [link("1002", "Fix signup")])
    assert.deepStrictEqual(
      ok(set([link("1002", "Fix signup"), link("2001", "Write docs"), link("1002", "again")])).external_links?.map((l) => l.id),
      ["1002", "2001"],
    )
    invalid(set([{ provider: "asana", id: "", url: "https://x", title: "" }]), "external_links", "need an id")
    invalid(set([{ provider: "asana", id: "1", url: "javascript:x", title: "" }]), "external_links", "http(s) url")
    invalid(set(Array.from({ length: 21 }, (_, i) => link(String(i), "t"))), "external_links", "at most 20")
    assert.deepStrictEqual(ok(set(null)).external_links, [])
  })

  it("takes preview and pull request URLs as http(s), blank clearing them", () => {
    invalid(update(task(), { preview_url: "ftp://x" }), "preview_url", "http(s) URL")
    invalid(update(task(), { pr_url: "github.com/o/r/pull/1" }), "pr_url", "http(s) URL")
    assert.strictEqual(ok(update(task(), { preview_url: " https://x.example.com/ " })).preview_url, "https://x.example.com/")
    assert.strictEqual(ok(update(task({ preview_url: "https://x" }), { preview_url: "" })).preview_url, null)
  })

  it("keeps reminders in UTC, a note needing a time and clearing with it", () => {
    const r = ok(update(task(), { remind_at: "2030-01-02T09:00:00+13:00", reminder: " Check CI ", starred: true }))
    assert.deepStrictEqual([r.remind_at, r.reminder, r.starred], ["2030-01-01T20:00:00.000Z", "Check CI", true])
    const reminded = task({ remind_at: Timestamp.make("2030-01-01T20:00:00.000Z"), reminder: "Check CI" })
    assert.deepStrictEqual(ok(update(reminded, { remind_at: "" })), { remind_at: null, reminder: null })
    assert.deepStrictEqual(ok(update(reminded, { reminder: "Look again" })), { reminder: "Look again" })
    for (const remind_at of ["soon", "2030-02-30T00:00:00Z", "whenever"]) invalid(update(task(), { remind_at }), "remind_at", "remind_at must be")
    invalid(update(task(), { reminder: "No time" }), "reminder", "needs remind_at")
    invalid(update(task(), { remind_at: "2030-01-01T00:00:00Z", reminder: "x".repeat(501) }), "reminder", "at most 500")
  })

  it("gives labels in the board's order, only to tasks", () => {
    assert.deepStrictEqual(ok(update(task(), { labels: ["diagram", "plan"] })).labels, ["plan", "diagram"])
    assert.deepStrictEqual(ok(update(task(), { labels: ["artifact", "plan", "plan"] })).labels, ["plan", "artifact"])
    assert.deepStrictEqual(ok(update(task(), { labels: [] })).labels, [])
    invalid(update(task({ kind: "review" }), { labels: ["plan"] }), "labels", "only a task")
  })

  it("moves a thread to another config only before its agent has a session, and only to one it may use", () => {
    const c2 = AgentConfigId.make("c2")
    assert.strictEqual(ok(update(task(), { claude_config_id: c2 })).claude_config_id, c2)
    conflict(update(task({ session_id: "s" }), { claude_config_id: c2 }), "has_session")
    conflict(update(task(), { claude_config_id: c2 }, { running: true }), "has_session")
    invalid(update(task(), { claude_config_id: AgentConfigId.make("elsewhere") }), "claude_config_id", "one of the project's")
  })

  it("keeps dependencies in the project, without loops", () => {
    const one = task({ id: id("one"), number: 1 })
    const two = task({ id: id("two"), number: 2, depends_on: [id("one")] })
    const three = task({ id: id("three"), number: 3, depends_on: [id("two")] })
    const other = task({ id: id("other"), project_id: ProjectId.make("elsewhere") })
    const tasks = [one, two, three, other]
    const deps = (t: Task, ids: ReadonlyArray<string>) => update(t, { depends_on: ids.map(id) }, { tasks })
    assert.deepStrictEqual(ok(deps(two, ["one", "one"])).depends_on, [id("one")])
    invalid(deps(two, ["two"]), "depends_on", "itself")
    invalid(deps(two, ["other"]), "depends_on", "isn't a task in the same project")
    invalid(deps(two, ["nope"]), "depends_on", "no task nope")
    // one → two → three, so one can't depend on three.
    invalid(deps(one, ["three"]), "depends_on", "already depends on this task")
    invalid(update(task({ kind: "review" }), { depends_on: [] }), "depends_on", "only tasks")
    invalid(update(task({ project_id: null }), { depends_on: [id("one")] }, { project: null, tasks }), "depends_on", "only tasks in a project")
  })
})

describe("decideUpdate: done and resolution", () => {
  it("gives a done task, and only a done task, a resolution and the time it was done", () => {
    const done = task({ status: "done", resolution: "done", done_at: EARLIER })
    const cases: ReadonlyArray<readonly [string, Task, TaskPatch, Task["resolution"], Task["done_at"]]> = [
      ["done without saying how is done", task(), { status: "done" }, "done", NOW],
      ["a done task's resolution can change, and keeps its time", done, { resolution: "wont_fix" }, "wont_fix", EARLIER],
      ["staying done through other changes keeps it", like(done, { resolution: "wont_fix" }), { status: "done", title: "x" }, "wont_fix", EARLIER],
      ["clearing it falls back to done", like(done, { resolution: "wont_fix" }), { resolution: null }, "done", EARLIER],
      ["out of done clears both", like(done, { resolution: "not_done" }), { status: "todo" }, null, null],
      ["moved to done as not done", task(), { status: "done", resolution: "not_done" }, "not_done", NOW],
      ["done again starts over", task({ status: "in_review" }), { status: "done" }, "done", NOW],
    ]
    for (const [what, before, patch, resolution, doneAt] of cases) {
      const t = moved(before, patch, {}, board)
      assert.deepStrictEqual([t.resolution, t.done_at], [resolution, doneAt], what)
    }
    invalid(update(task(), { status: "in_review", resolution: "done" }), "resolution", "only be set on a done task")
    invalid(update(task(), { resolution: "wont_fix" }), "resolution", "only be set on a done task")
  })

  it("takes when a done task was done, in UTC, only for a done task", () => {
    invalid(update(task(), { done_at: "2026-01-01T00:00:00Z" }), "done_at", "only be set on a done task")
    invalid(update(task(), { status: "done", done_at: "yesterday" }), "done_at", "RFC 3339")
    assert.strictEqual(moved(task(), { status: "todo" }).done_at, null)
    const done = moved(task(), { status: "done", done_at: "2026-01-01T13:00:00+13:00" })
    assert.strictEqual(done.done_at, "2026-01-01T00:00:00.000Z")
    assert.strictEqual(moved(done, { done_at: "2026-02-01T00:00:00Z" }).done_at, "2026-02-01T00:00:00.000Z")
    invalid(update(done, { status: "in_review", done_at: "2026-02-01T00:00:00Z" }), "done_at", "only be set on a done task")
    assert.strictEqual(moved(done, { status: "in_review" }).done_at, null)
  })
})

describe("decideUpdate: moving between columns", () => {
  const work = { gitWork: true }

  it("clears what only the column it leaves holds", () => {
    const asking = task({ status: "needs_attention", attention_reason: "Approve Bash?" })
    assert.strictEqual(ok(update(asking, { status: "in_progress" })).attention_reason, null)
    assert.isUndefined(ok(update(asking, { title: "x" })).attention_reason)
    const queued = task({ status: "in_progress", waiting: true })
    assert.strictEqual(ok(update(queued, { status: "todo" })).waiting, false)
    assert.isUndefined(ok(update(queued, { status: "in_progress" })).waiting)
  })

  it("queues a merge on Ready for merge, at the back of the queue unless given a place (HA-42)", () => {
    const t = moved(task({ status: "in_review", merge_approval: "pending", stack_run: "run" }), { status: "ready_for_merge" }, work)
    assert.deepStrictEqual([t.status, t.merging, t.merge_approval, t.stack_run, t.position], ["ready_for_merge", true, null, null, 7])
    assert.strictEqual(moved(task(), { status: "ready_for_merge", position: 0.5 }, work).position, 0.5)
    // An approved merge stays approved (stepping out to make changes keeps it).
    assert.strictEqual(moved(task({ merge_approval: "approved" }), { status: "ready_for_merge" }, work).merge_approval, "approved")
    // Moved there again, nothing is queued again (HA-37); a review thread is never merged.
    const again = ok(update(task({ status: "ready_for_merge", merging: true }), { status: "ready_for_merge" }, work))
    assert.isUndefined(again.merging)
    assert.isUndefined(ok(update(task({ kind: "review" }), { status: "ready_for_merge" }, work)).merging)
  })

  it("refuses Ready for merge while the agent runs", () => {
    conflict(update(task(), { status: "ready_for_merge" }, { ...work, running: true }), "agent_running", "still running")
    conflict(update(task({ running: true }), { status: "ready_for_merge" }, work), "agent_running")
  })

  it("marks a task with nothing to merge done instead", () => {
    const cases: ReadonlyArray<readonly [string, Task, Partial<UpdateFacts>, string]> = [
      ["no changes", task(), {}, "the task has no changes"],
      ["not a git repository", task(), { gitWork: true, project: { ...project, is_git: false } }, "the task has no changes"],
      ["a scratch task", task({ task_type: "scratch", use_worktree: false }), work, "a scratch task has no repository"],
      ["documents only", task({ work_dir: "documents/t1", labels: ["plan"], use_worktree: false }), work, "the board keeps the task's documents"],
      ["a group task", task({ project_id: null, group_name: "Shop", use_worktree: false }), { ...work, project: null }, "the task has no changes"],
    ]
    for (const [what, before, f, why] of cases) {
      const r = update(before, { status: "ready_for_merge", position: 3 }, f)
      const t = after(before, ok(r))
      assert.deepStrictEqual([t.status, t.merging, t.resolution, t.position], ["done", false, "done", before.position], what)
      assert.deepStrictEqual(Result.isSuccess(r) ? r.success.notes : [], [`Nothing to merge (${why}), so it's done`], what)
    }
    // A target with no commits of its own gathers its incoming tasks' work.
    const incoming = task({ id: id("a"), number: 2, merges_into: id("t1") })
    assert.strictEqual(moved(task(), { status: "ready_for_merge" }, { tasks: [incoming] }).status, "ready_for_merge")
    const scratchIncoming = like(incoming, { task_type: "scratch" })
    assert.strictEqual(moved(task(), { status: "ready_for_merge" }, { tasks: [scratchIncoming] }).status, "done")
  })

  it("ends a merge anywhere but Ready for merge or Needs attention", () => {
    const merging = task({ status: "ready_for_merge", merging: true, merge_approval: "approved", stack_run: "run" })
    const waiting = moved(merging, { status: "needs_attention" })
    assert.deepStrictEqual([waiting.merging, waiting.merge_approval, waiting.stack_run], [true, "approved", "run"])
    const back = moved(merging, { status: "in_review" })
    assert.deepStrictEqual([back.merging, back.merge_approval, back.stack_run], [false, null, null])
  })

  it("ends its agent's wait as it moves", () => {
    const wait = { reason: null, since: EARLIER, until: NOW, tasks: [], call_id: "c", run_id: RunId.make("r") }
    assert.deepStrictEqual(ok(update(task({ agent_wait: wait }), { status: "in_review" })).agent_wait, { ...wait, moved_to: "in_review" })
    assert.isUndefined(ok(update(task({ agent_wait: wait }), { status: "todo" })).agent_wait)
  })

  it("lets a merging agent step out of the queue to make changes, and rejoin it", () => {
    const merging = task({ status: "ready_for_merge", merging: true, merge_approval: "approved" })
    const out = moved(merging, { status: "in_progress", remerge: true }, { running: true }, agent)
    assert.deepStrictEqual([out.status, out.merging, out.remerge, out.merge_approval], ["in_progress", false, true, "approved"])
    // Moved on to review without rejoining, it loses its place, and the approval with it.
    const reviewed = moved(out, { status: "in_review" })
    assert.deepStrictEqual([reviewed.remerge, reviewed.merge_approval], [false, null])
    invalid(update(task(), { status: "in_progress", remerge: true }, { running: true }), "remerge", "while its agent is merging it")
    invalid(update(merging, { status: "in_progress", remerge: true }), "remerge", "while its agent is merging it")
    invalid(update(merging, { status: "needs_attention", remerge: true }, { running: true }), "remerge", "with status in_progress")
    // Waiting for the user's approval, it isn't in the queue to step out of (HA-86).
    invalid(update(like(merging, { merge_approval: "pending" }), { status: "in_progress", remerge: true }, { running: true }), "remerge", "approved yet")
  })

  it("needs an approving review on GitHub where required (HA-113)", () => {
    const url = "https://github.com/o/r/pull/1"
    const t = task({ pr_url: url })
    conflict(update(t, { status: "ready_for_merge" }, required(url, false)), "pr_not_approved", "no approving review")
    assert.strictEqual(moved(t, { status: "ready_for_merge" }, required(url, true)).status, "ready_for_merge")
    // The pull request set or cleared by the same change is the one checked.
    conflict(
      update(t, { status: "ready_for_merge", pr_url: null }, required(null, false, "the task has no pull request")),
      "pr_not_approved",
      "no pull request",
    )
    // Read for another pull request than the task has now: try again.
    conflict(update(task({ pr_url: "https://github.com/o/r/pull/2" }), { status: "ready_for_merge" }, required(url, true)), "changed_meanwhile")
    // Nothing to merge is done without asking GitHub.
    assert.strictEqual(moved(t, { status: "ready_for_merge" }, { ...required(url, false), gitWork: false }).status, "done")
  })

  it("holds a task in In progress while its agent's todo list is unfinished (HA-330)", () => {
    const busy = task({
      status: "in_progress",
      todos: [
        { text: "Write it", status: "completed" },
        { text: "Test it", status: "in_progress" },
      ],
    })
    conflict(update(busy, { status: "in_review" }), "todos_unfinished", "1 unfinished item")
    conflict(update(busy, { status: "in_review" }), "todos_unfinished", "- [in progress] Test it")
    assert.strictEqual(moved(busy, { status: "in_review", todos_override: true }).status, "in_review")
    assert.strictEqual(moved(busy, { status: "needs_attention" }).status, "needs_attention")
    // An agent's move is held whatever it says, and is told to ask; the board's own moves aren't held.
    conflict(update(busy, { status: "in_review", todos_override: true }, {}, agent), "todos_unfinished", "send_to_task")
    assert.strictEqual(moved(busy, { status: "in_review" }, {}, board).status, "in_review")
    const finished = like(busy, { todos: [{ text: "Write it", status: "completed" }] })
    assert.strictEqual(moved(finished, { status: "in_review" }).status, "in_review")
  })

  it("never reviews, merges, closes or parks the lasting threads", () => {
    const cases: ReadonlyArray<readonly [Task, string]> = [
      [task({ project_id: null, task_type: "assistant", use_worktree: false }), "the assistant can't go to review"],
      [task({ project_id: null, task_type: "pens", use_worktree: false }), "the pens thread can't go to review"],
      [task({ project_id: null, task_type: "pen", use_worktree: false }), "a pen's thread can't go to review"],
    ]
    for (const [thread, text] of cases) {
      for (const status of ["in_review", "ready_for_merge", "done", "backlog"] as const) invalid(update(thread, { status }, { project: null }), "status", text)
      assert.strictEqual(moved(thread, { status: "in_progress" }, { project: null }).status, "in_progress")
    }
    // A routine's run of the assistant ends as any task does.
    assert.strictEqual(moved(task({ project_id: null, task_type: "routine" }), { status: "done" }, { project: null }).status, "done")
  })
})

describe("decideUpdate: worktrees", () => {
  it("changes worktree settings only while the worktree is unmade", () => {
    const made = task({ worktree_state: "ready", worktree_path: "/w", branch: "ia/x-1" })
    for (const patch of [{ use_worktree: false }, { base_branch: "dev" }, { start_from: "branch:dev" }]) {
      conflict(update(made, patch), "worktree_made")
    }
    // A setup that failed before making the branch left nothing to tear down: it's set up again from scratch.
    const failed = task({ worktree_state: "error", worktree_error: "no such branch", worktree_path: "/w" })
    assert.deepStrictEqual(ok(update(failed, { base_branch: "dev" })), { base_branch: "dev", worktree_state: "none", worktree_error: null })
    conflict(update(failed, { base_branch: "dev" }, { worktreeFolderExists: true }), "worktree_made")
    conflict(update(like(failed, { branch: "ia/x-1" }), { base_branch: "dev" }), "worktree_made")
  })

  it("starts from a base branch or something else, not both", () => {
    invalid(update(task(), { base_branch: "bad..name" }), "base_branch", "valid branch name")
    assert.strictEqual(ok(update(task(), { base_branch: " dev " })).base_branch, "dev")
    assert.strictEqual(ok(update(task(), { base_branch: "" })).base_branch, null)
    invalid(update(task(), { start_from: "branch:dev", base_branch: "main" }), "start_from", "not both")
    assert.deepStrictEqual(ok(update(task(), { start_from: "branch:dev" })), { start_from: { type: "branch", branch: "dev" }, base_branch: null })
    const started = task({ start_from: { type: "branch", branch: "dev" } })
    assert.deepStrictEqual(ok(update(started, { base_branch: "main" })), { base_branch: "main", start_from: null })
    invalid(update(task({ use_worktree: false }), { start_from: "branch:dev" }), "start_from", "with a worktree")
    invalid(update(task({ project_id: null }), { start_from: "branch:dev" }, { project: null }), "start_from", "in a project")
    // Its branch exists: it starts from where it did.
    const branched = like(started, { branch: "ia/x-1", worktree_state: "error" })
    conflict(update(branched, { start_from: "branch:main" }), "worktree_made", "exists already")
  })

  it("gives no worktree to a task without a project or one that works in its own folder", () => {
    invalid(update(task({ project_id: null, use_worktree: false }), { use_worktree: true }, { project: null }), "use_worktree", "without a project")
    invalid(update(task({ task_type: "scratch", use_worktree: false }), { use_worktree: true }), "use_worktree", "scratch")
    invalid(update(task({ work_dir: "documents/t1", use_worktree: false }), { use_worktree: true }), "use_worktree", "documents")
  })
})

describe("start_from", () => {
  const target = task({ id: id("target"), number: 2, key: "X-2" })
  const me = task()
  const tasks = indexTasks([
    me,
    target,
    task({ id: id("scratch"), number: 3, task_type: "scratch", use_worktree: false }),
    task({ id: id("far"), project_id: ProjectId.make("elsewhere") }),
    task({ id: id("above"), number: 4, start_from: { type: "task", task_id: id("t1") } }),
  ])
  const start = (given: Parameters<typeof checkStartFrom>[3], taskId: TaskId | null = me.id) => checkStartFrom(tasks, project, taskId, given)

  it("reads what a worktree starts from", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["task:X-2", { type: "task", task_id: "target" }],
      ["X-2", { type: "task", task_id: "target" }],
      ["old-2", { type: "task", task_id: "target" }],
      ["target", { type: "task", task_id: "target" }],
      ["branch:feature", { type: "branch", branch: "feature" }],
      ["feature", { type: "branch", branch: "feature" }],
      ["origin/feature", { type: "branch", branch: "origin/feature" }],
      ["pr:12", { type: "pull_request", number: 12 }],
      ["#12", { type: "pull_request", number: 12 }],
      ["https://github.com/o/r/pull/12/files", { type: "pull_request", number: 12, repo: "o/r" }],
      ["commit:ABCDEF1", { type: "commit", commit: "abcdef1" }],
      ["abcdef1234", { type: "commit", commit: "abcdef1234" }],
      ["  ", null],
    ]
    for (const [given, want] of cases) {
      const r = start(given)
      assert.deepStrictEqual(Result.isSuccess(r) ? r.success : r.failure.reason, want, given)
    }
    assert.deepStrictEqual(start(null), Result.succeed(null))
  })

  it("refuses what it can't start from", () => {
    const cases: ReadonlyArray<readonly [Parameters<typeof checkStartFrom>[3], string]> = [
      ["bad..branch", "isn't a valid branch name"],
      ["task:X-99", "no task X-99 in Shop"],
      ["pr:x", "isn't a pull request's number"],
      ["commit:xyz", "isn't a commit's SHA"],
      [{ type: "pull_request", number: 0 }, "starts at 1"],
      ["t1", "can't start from itself"],
      ["X-3", "no branch of its own"],
      [{ type: "task", task_id: id("far") }, "isn't a task in the same project"],
      [{ type: "task", task_id: id("gone") }, "no task gone"],
      // X-4 starts from this task: starting from it would need each worktree before the other.
      [{ type: "task", task_id: id("above") }, "needs this task's worktree first"],
    ]
    for (const [given, text] of cases) invalid(start(given), "start_from", text)
    // A new task has nothing to loop back to.
    assert.isTrue(Result.isSuccess(start({ type: "task", task_id: id("above") }, null)))
  })
})

describe("merges_into", () => {
  const target = task({ id: id("target"), number: 1, key: "X-1", branch: "ia/x-1-target" })
  const a = task({ id: id("a"), number: 2, key: "X-2" })
  const scratch = task({ id: id("scratch"), number: 3, task_type: "scratch", use_worktree: false })
  const done = task({ id: id("done"), number: 4, status: "done", resolution: "done" })
  const tasks = [target, a, scratch, done]

  it("is checked, and starts the worktree from the target unless told otherwise", () => {
    const create = (input: Partial<NewTask>) => decideCreate({ title: "A", ...input }, { place: { _tag: "Project", project }, configs: [], tasks }, NOW)
    const made = (input: Partial<NewTask>) => {
      const r = create(input)
      return Result.isSuccess(r) ? r.success.columns : assert.fail(`refused: ${r.failure.message}`)
    }
    assert.deepStrictEqual(
      [made({ merges_into: "X-1" }).merges_into, made({ merges_into: "X-1" }).start_from],
      [target.id, { type: "task", task_id: target.id }],
    )
    assert.deepStrictEqual(made({ merges_into: "target", start_from: "master" }).start_from, { type: "branch", branch: "master" })
    invalid(create({ merges_into: "scratch" }), "merges_into", "no branch of its own")
    invalid(create({ task_type: "scratch", merges_into: "X-1" }), "merges_into", "with a worktree")
    invalid(create({ merges_into: "X-99" }), "merges_into", "no task X-99")
    invalid(create({ merges_into: "done" }), "merges_into", "done already")
    invalid(update(a, { merges_into: "a" }, { tasks }), "merges_into", "can't merge into itself")
    const into = like(a, { merges_into: target.id, start_from: { type: "task", task_id: target.id } })
    invalid(update(target, { merges_into: "X-2" }, { tasks: [target, into] }), "merges_into", "merges into this task already")
  })

  it("follows its target until its branch is made", () => {
    const into = like(a, { merges_into: target.id, start_from: { type: "task", task_id: target.id } })
    // Cleared before its branch is made, it starts from the base branch again; set again, from the target.
    assert.deepStrictEqual(ok(update(into, { merges_into: null }, { tasks })), { merges_into: null, start_from: null, base_branch: null })
    assert.deepStrictEqual(ok(update(a, { merges_into: "X-1" }, { tasks })), {
      merges_into: target.id,
      start_from: { type: "task", task_id: target.id },
      base_branch: null,
    })
    // Where it merges already: nothing changes.
    assert.deepStrictEqual(ok(update(into, { merges_into: "X-1" }, { tasks })), {})
  })

  it("keeps where its own work starts once its branch is made, and changes until it's merging", () => {
    const two = task({ id: id("two"), number: 5, key: "X-5", branch: "ia/x-5-two" })
    const branched = like(a, {
      merges_into: target.id,
      start_from: { type: "task", task_id: target.id },
      branch: "ia/x-2-a",
      base_branch: target.branch,
      worktree_state: "ready",
    })
    const moved_ = ok(update(branched, { merges_into: "X-5" }, { tasks: [...tasks, two], startCommit: "abc1234" }))
    assert.deepStrictEqual(moved_, { merges_into: two.id, start_from: { type: "commit", commit: "abc1234" }, base_branch: two.branch })
    assert.deepStrictEqual(ok(update(branched, { merges_into: "" }, { tasks })).base_branch, null)
    conflict(update(like(branched, { merging: true }), { merges_into: "X-5" }, { tasks: [...tasks, two] }), "merging", "is merging")
    invalid(update(like(a, { status: "done" }), { merges_into: "X-1" }, { tasks }), "merges_into", "the task is done")
    invalid(update(a, { merges_into: "X-1" }, { tasks, project: null }), "merges_into", "for a task in a project")
    invalid(update(like(a, { use_worktree: false }), { merges_into: "X-1" }, { tasks }), "merges_into", "with a worktree")
  })
})

describe("deriveColumns", () => {
  it("follows a change with what goes with it (db/tasks/write.ts)", () => {
    const merging = task({ status: "ready_for_merge", merging: true, stack_run: "run", merge_approval: "approved", restack: "due" })
    const cases: ReadonlyArray<readonly [string, Task, TaskColumns, TaskColumns]> = [
      [
        "merged: done, kept in its stack's run, not restacked",
        merging,
        { status: "done", merging: false },
        { status: "done", merging: false, resolution: "done", done_at: NOW, restack: null, merge_approval: null },
      ],
      [
        "closed: out of its stack's run",
        merging,
        { status: "done", resolution: "wont_fix", merging: false },
        { status: "done", resolution: "wont_fix", merging: false, done_at: NOW, restack: null, stack_run: null, merge_approval: null },
      ],
      [
        "waiting on the user while merging keeps the run",
        merging,
        { status: "needs_attention" },
        { status: "needs_attention", resolution: null, done_at: null },
      ],
      [
        "stepped out: keeps its place while in progress",
        like(merging, { remerge: true, merging: false, status: "in_progress" }),
        { status: "needs_attention" },
        { status: "needs_attention", resolution: null, done_at: null, stack_run: null },
      ],
      [
        "moved on: loses its place and the approval",
        like(merging, { remerge: true, merging: false, status: "in_progress" }),
        { status: "in_review" },
        { status: "in_review", resolution: null, done_at: null, stack_run: null, remerge: false, merge_approval: null },
      ],
      ["other columns change nothing else", task(), { title: "x" }, { title: "x" }],
    ]
    for (const [what, before, columns, want] of cases) assert.deepStrictEqual(deriveColumns(before, columns, NOW), want, what)
  })

  it("has the preview follow the pull request where the project gives each one a preview", () => {
    const template = "https://pr{pr}.example.com/b"
    const follow = (before: Task, columns: TaskColumns) => after(before, deriveColumns(before, columns, NOW, template)).preview_url
    assert.strictEqual(follow(task(), { pr_url: pr(7) }), "https://pr7.example.com/b")
    assert.strictEqual(follow(task({ pr_url: pr(7), preview_url: "https://pr7.example.com/b" }), { pr_url: pr(8) }), "https://pr8.example.com/b")
    assert.strictEqual(follow(task({ pr_url: pr(8), preview_url: "https://pr8.example.com/b" }), { pr_url: null }), null)
    // One set otherwise stays; one given with it wins; without a template nothing follows.
    assert.strictEqual(follow(task({ pr_url: pr(5), preview_url: "https://staging.example.com/" }), { pr_url: pr(10) }), "https://staging.example.com/")
    assert.strictEqual(follow(task(), { pr_url: pr(11), preview_url: "https://mine.example.com/" }), "https://mine.example.com/")
    assert.strictEqual(after(task(), deriveColumns(task(), { pr_url: pr(7) }, NOW)).preview_url, null)
  })
})

const createTask = (input: NewTask, place: Place = inProject(), f: Partial<CreateFacts> = {}) =>
  decideCreate(input, { place, configs: [AgentConfigId.make("c1"), AgentConfigId.make("c2")], tasks: [], ...f }, NOW)
const createdRow = (input: NewTask, place?: Place, f?: Partial<CreateFacts>): NewRow => {
  const r = createTask(input, place, f)
  return Result.isSuccess(r) ? r.success : assert.fail(`refused: ${r.failure.message}`)
}

describe("decideCreate", () => {
  const scratch: Place = { _tag: "Scratch", profile_id: profile }
  const group = (name: string, projects = 1): Place => ({ _tag: "Group", profile_id: profile, group: name, projects })

  it("starts worktrees once the folder is a git repository", () => {
    assert.strictEqual(createdRow({ title: "before" }, inProject({ is_git: false })).columns.use_worktree, false)
    assert.strictEqual(createdRow({ title: "after" }).columns.use_worktree, true)
    assert.strictEqual(createdRow({ title: "off" }, inProject({ use_worktrees: false })).columns.use_worktree, false)
    assert.strictEqual(createdRow({ title: "asked", use_worktree: false }).columns.use_worktree, false)
  })

  it("needs a title or a description; a description alone gives a placeholder until a title is generated", () => {
    invalid(createTask({}), "title", "title or description is required")
    invalid(createTask({ title: "  ", description: " " }), "title", "required")
    const described = createdRow({ description: "Fix the login page\nIt 500s" })
    assert.deepStrictEqual([described.columns.title, described.generateTitle], ["Fix the login page", true])
    assert.deepStrictEqual(
      [createdRow({ title: " Titled ", description: "x" }).columns.title, createdRow({ title: "Titled" }).generateTitle],
      ["Titled", false],
    )
  })

  it("refuses a task in an archived project", () => {
    conflict(createTask({ title: "x" }, inProject({ archived: true })), "archived", 'the project "Shop" is archived')
  })

  it("is done with a resolution only when made done", () => {
    const done = createdRow({ title: "x", status: "done" }).columns
    assert.deepStrictEqual([done.resolution, done.done_at], ["done", NOW])
    assert.strictEqual(createdRow({ title: "x", status: "done", resolution: "wont_fix" }).columns.resolution, "wont_fix")
    invalid(createTask({ title: "x", resolution: "done" }), "resolution", "only be set on a done task")
    assert.deepStrictEqual([createdRow({ title: "x" }).columns.status, createdRow({ title: "x" }).columns.resolution], ["todo", null])
  })

  it("keeps the config it starts with: the first it may use unless told", () => {
    assert.strictEqual(createdRow({ title: "x" }).columns.claude_config_id, "c1")
    assert.strictEqual(createdRow({ title: "x", claude_config_id: AgentConfigId.make("c2") }).columns.claude_config_id, "c2")
    assert.strictEqual(createdRow({ title: "x" }, inProject(), { configs: [] }).columns.claude_config_id, null)
    invalid(createTask({ title: "x", claude_config_id: AgentConfigId.make("c9") }), "claude_config_id", "one of the project's")
  })

  it("makes scratch tasks in no project, working in their own folder", () => {
    const t = createdRow({}, scratch)
    assert.deepStrictEqual(
      [t.columns.title, t.family, t.project_id, t.columns.task_type, t.columns.use_worktree],
      ["New scratch task", "scratch", null, "scratch", false],
    )
    assert.deepStrictEqual(createdRow({ title: "Notes", labels: ["plan"] }, scratch).columns.labels, ["plan"])
    invalid(createTask({ use_worktree: true }, scratch), "use_worktree", "can't have a worktree")
    invalid(createTask({ depends_on: [id("x")] }, scratch), "use_worktree", "dependencies")
  })

  it("makes scratch tasks in a project, numbered with its tasks and with no worktree", () => {
    const t = createdRow({ title: "Look", task_type: "scratch", use_worktree: true })
    assert.deepStrictEqual([t.family, t.project_id, t.columns.task_type, t.columns.use_worktree], ["project", projectId, "scratch", false])
  })

  it("makes group tasks for a group of the profile's projects", () => {
    const g = createdRow({ title: "Plan", labels: ["diagram"], group: "Shop" }, group(" Shop "))
    assert.deepStrictEqual([g.family, g.columns.group_name, g.columns.labels, g.columns.task_type], ["group", "Shop", ["diagram"], undefined])
    invalid(createTask({ title: "Plan" }, group("Shop", 0)), "group", "a group of the profile's projects")
    invalid(createTask({ title: "Plan" }, group(" ")), "group", "a group of the profile's projects")
    invalid(createTask({ title: "Plan", task_type: "scratch" }, group("Shop")), "task_type", "scratch")
    invalid(createTask({ title: "Plan", depends_on: [id("x")] }, group("Shop")), "depends_on", "dependencies")
    invalid(createTask({}, group("Shop")), "title", "required")
  })

  it("links the tasks made from one prompt with a fan-out id", () => {
    assert.strictEqual(createdRow({ title: "Look", fanout_id: "f-1" }).columns.fanout_id, "f-1")
    assert.strictEqual(createdRow({ title: "Ask", fanout_id: "f_2" }, scratch).columns.fanout_id, "f_2")
    assert.strictEqual(createdRow({ title: "Plan", fanout_id: "f-3" }, group("Shop")).columns.fanout_id, "f-3")
    assert.strictEqual(createdRow({ title: "Alone", fanout_id: " " }).columns.fanout_id, null)
    for (const bad of ["a b", "x/y", "z".repeat(65)]) {
      for (const place of [inProject(), scratch, group("Shop")]) invalid(createTask({ title: "Look", fanout_id: bad }, place), "fanout_id", "up to 64")
    }
  })

  it("links to Asana and depends on tasks of its project", () => {
    assert.deepStrictEqual(createdRow({ title: "Fix it", external_links: [link("1002", " Fix signup ")] }).columns.external_links, [link("1002", "Fix signup")])
    assert.deepStrictEqual(createdRow({ title: "Plain" }).columns.external_links, [])
    const dep = task({ id: id("dep") })
    assert.deepStrictEqual(createdRow({ title: "x", depends_on: [dep.id, dep.id] }, inProject(), { tasks: [dep] }).columns.depends_on, [id("dep")])
    invalid(createTask({ title: "x", depends_on: [id("nope")] }), "depends_on", "no task nope")
  })
})

describe("decideDeleted", () => {
  const gone = task({ id: id("gone"), key: "X-1", branch: "ia/x-1" })

  it("takes the task off its dependants' lists", () => {
    const dependant = task({ id: id("d"), depends_on: [id("gone"), id("other")] })
    assert.deepStrictEqual(decideDeleted(gone, [gone, dependant]), [{ id: id("d"), columns: { depends_on: [id("other")] } }])
  })

  it("flags the open tasks whose work went to it, and the stack levels on it, for the user to say where they go", () => {
    const into = task({ id: id("a"), merges_into: gone.id, status: "in_review", merging: true, merge_approval: "pending" })
    const viaMerged = task({ id: id("m"), merges_into: gone.id, status: "done", resolution: "done" })
    const throughIt = task({ id: id("b"), merges_into: id("m") })
    const running = task({ id: id("r"), merges_into: gone.id, running: true })
    const closed = task({ id: id("c"), merges_into: gone.id, status: "done", resolution: "wont_fix" })
    const level = task({ id: id("l"), start_from: { type: "task", task_id: gone.id } })
    const flagged = new Map(decideDeleted(gone, [gone, into, viaMerged, throughIt, running, closed, level]).map((d) => [d.id, d.columns]))
    assert.deepStrictEqual([...flagged.keys()].toSorted(), ["a", "b", "l"])
    assert.deepStrictEqual(flagged.get(id("a")), held(false))
    assert.deepStrictEqual(flagged.get(id("l")), held(true))
    assert.strictEqual(heldReason("X-1", true, false), "X-1, which this task merges into, was deleted: choose where it merges now")
  })

  it("sends the tasks merging into a merged task where it went", () => {
    const outer = task({ id: id("outer"), branch: "ia/x-9-outer" })
    const merged = like(gone, { status: "done", resolution: "done", merges_into: outer.id, base_branch: outer.branch })
    const a = task({ id: id("a"), merges_into: gone.id, status: "in_review", branch: "ia/x-2-a", base_branch: "ia/x-1" })
    const b = task({ id: id("b"), merges_into: gone.id, status: "in_review", branch: "ia/x-3-b", base_branch: "master" })
    const changed = new Map(decideDeleted(merged, [merged, outer, a, b]).map((d) => [d.id, d.columns]))
    assert.deepStrictEqual(changed.get(id("a")), { merges_into: outer.id, base_branch: outer.branch })
    assert.deepStrictEqual(changed.get(id("b")), { merges_into: outer.id })
  })
})

describe("checks", () => {
  it("reads RFC 3339 times into UTC", () => {
    const cases: ReadonlyArray<readonly [string, string | null]> = [
      ["2026-01-01T13:00:00+13:00", "2026-01-01T00:00:00.000Z"],
      ["2026-02-01T00:00:00Z", "2026-02-01T00:00:00.000Z"],
      ["2024-02-29T12:30:15.5-02:30", "2024-02-29T15:00:15.500Z"],
      ["2026-02-29T00:00:00Z", null],
      ["2026-01-01", null],
      ["yesterday", null],
      ["2026-01-01T24:00:00Z", null],
    ]
    for (const [given, want] of cases) assert.strictEqual(rfc3339Utc(given), want, given)
  })

  it("knows a branch name git takes", () => {
    for (const name of ["main", "feature/x", "ia/he-3-port", "origin/feature", "v1.2"]) assert.isTrue(validBranchName(name), name)
    for (const name of ["", "-x", "a..b", "a b", "a~b", "a:b", "x/", "x.", "x.lock", ".x", "a//b", "@", "a@{b", "a\\b"]) {
      assert.isFalse(validBranchName(name), name)
    }
  })

  it("titles a described task with its first line until a title is generated", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Fix the login page\nIt 500s", "Fix the login page"],
      ["\n\n## Heading\nbody", "Heading"],
      ["Attached files:\n- /tmp/a/shot.png", "Attached shot.png"],
      ["Attached files:\n- /tmp/a/shot.png\n- b.txt\n- c.txt", "Attached shot.png and 2 more"],
      ["word ".repeat(20), `${"word ".repeat(12).trimEnd()}…`],
    ]
    for (const [description, want] of cases) assert.strictEqual(placeholderTitle(description), want)
  })
})
