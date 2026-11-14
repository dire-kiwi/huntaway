import { Option, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { NewTask, Task, TaskFilter, TaskPatch } from "../src/task.ts"

/** A task as the old board sent it, less what the port drops, plus `key`. */
const wire = {
  id: "8f0c7a52-1d5e-4a8e-9a43-0c1f5d2b7e01",
  profile_id: "c3d6b0f2-5e1a-4c47-8d2e-7f1a9b3c4d5e",
  project_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  kind: "task",
  parent_id: null,
  task_type: null,
  labels: ["plan"],
  group_name: null,
  number: 2,
  key: "HE-2",
  pen_id: null,
  fanout_id: null,
  created_by: null,
  position: 3.5,
  work_dir: null,
  title: "Port the board",
  title_pinned: true,
  description: "",
  status: "in_review",
  resolution: null,
  done_at: null,
  attention_reason: null,
  starred: false,
  remind_at: null,
  reminder: null,
  preview_url: null,
  pr_url: "https://github.com/dire-kiwi/huntaway/pull/3",
  pr_checks: {
    url: "https://github.com/dire-kiwi/huntaway/pull/3",
    head: "abc123",
    outcome: "failed",
    failed: [{ name: "CI / check", conclusion: "failure", url: null }],
    more_failed: 0,
    pending: 1,
    passed: 4,
    since: "2026-11-11T06:16:59.131Z",
  },
  external_links: [],
  todos: [{ text: "Write the schemas", status: "completed" }],
  tracked: [],
  context: { tokens: 51234, max_tokens: 200000, compact_at: null, model: "opus", updated_at: "2026-11-11T06:16:59.131Z", detail_at: null },
  document_at: null,
  cost_usd: 1.25,
  last_activity_at: "2026-11-11T06:16:59.131Z",
  created_at: "2026-11-10T21:00:00.000Z",
  updated_at: "2026-11-11T06:16:59.131Z",
  use_worktree: true,
  worktree_path: "/home/me/.local/share/huntaway/projects/p/worktrees/HE-2",
  worktree_state: "ready",
  worktree_error: null,
  branch: "ia/he-2-port-the-board",
  base_branch: "main",
  start_from: { type: "pull_request", number: 12 },
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
  session_id: "sess-1",
  running: true,
  run_started_at: "2026-11-11T06:00:00.000Z",
  steerable: true,
  limit_reset_at: null,
  agent_wait: {
    reason: "CI",
    since: "2026-11-11T06:10:00.000Z",
    until: "2026-11-11T07:10:00.000Z",
    tasks: [{ id: "8f0c7a52-1d5e-4a8e-9a43-0c1f5d2b7e02", key: "HE-3", status: "in_progress" }],
    call_id: "toolu_1",
    run_id: "run-1",
    pull_request: { url: "https://github.com/o/r/pull/3", repo: "o/r", number: 3, events: ["checks_failed"] },
  },
  background_work: null,
  servers: [{ port: 5173, address: "127.0.0.1", pid: 100, pgid: 100, command: "vite", since: "2026-11-11T06:01:00.000Z", detached: false }],
  queued_message: null,
  steering: [{ id: "s-1", text: "also the tests", from_agent: false, run_id: "run-1", written: true }],
  model: "opus",
  effort: "xhigh",
  permission_mode: "acceptEdits",
  claude_config_id: null,
  auto_allow: ["Bash(pnpm check)"],
  review: {
    thread_id: "8f0c7a52-1d5e-4a8e-9a43-0c1f5d2b7e09",
    state: "running",
    head: "abc123",
    summary: null,
    issues: [],
    fixes: 0,
    extra_rounds: 0,
    updated_at: "2026-11-11T06:16:59.131Z",
    reviewers: [{ thread_id: "8f0c7a52-1d5e-4a8e-9a43-0c1f5d2b7e09", label: "Claude · opus", state: "running", summary: null, issues: [], after_run: "" }],
  },
  summaries: [],
  rewind: null,
}

const refused = (schema: Schema.Codec<unknown, unknown>, input: unknown) => Option.isNone(Schema.decodeUnknownOption(schema)(input))

describe("Task", () => {
  it("decodes the wire form and encodes it back unchanged", () => {
    const task = Schema.decodeUnknownOption(Task)(wire)
    expect(Option.map(task, (t) => t.key)).toEqual(Option.some("HE-2"))
    expect(Option.getOrNull(Option.flatMap(task, Schema.encodeOption(Task)))).toEqual(wire)
  })

  it("refuses a task without a field that is always sent", () => {
    const { rewind: _, ...without } = wire
    expect(refused(Task, without)).toBe(true)
  })

  it("refuses a status, effort, start_from or number the board does not have", () => {
    for (const bad of [{ status: "archived" }, { effort: "huge" }, { start_from: { type: "tag", tag: "v1" } }, { number: 1.5 }]) {
      expect(refused(Task, { ...wire, ...bad })).toBe(true)
    }
  })
})

describe("requests", () => {
  it("a patch takes start_from as text or as a value, and the old request-only fields", () => {
    const patch = Schema.decodeOption(TaskPatch)({ start_from: "pr:12", pen: "Launch", todos_override: true, remerge: true, status: "in_progress" })
    expect(Option.map(patch, (p) => p.start_from)).toEqual(Option.some("pr:12"))
    const again = Schema.decodeOption(TaskPatch)({ start_from: { type: "branch", branch: "main" }, merges_into: "HE-1" })
    expect(Option.map(again, (p) => p.start_from)).toEqual(Option.some({ type: "branch", branch: "main" }))
  })

  it("a new task starts its agent with true or with a prompt, and is never one of the board's own threads", () => {
    const scratch = Schema.decodeOption(NewTask)({ profile_id: "pr-1", description: "look into it", start: true })
    expect(Option.map(scratch, (t) => t.start)).toEqual(Option.some(true))
    const group = Schema.decodeOption(NewTask)({ profile_id: "pr-1", group: "Web", title: "Plan", start: "go" })
    expect(Option.map(group, (t) => t.start)).toEqual(Option.some("go"))
    expect(refused(NewTask, { project_id: "p-1", task_type: "assistant" })).toBe(true)
  })

  it("a filter is one of three, by its tag", () => {
    const filter = Schema.decodeOption(TaskFilter)({ _tag: "Projectless", profile_id: "pr-1", include_pens: true })
    expect(Option.map(filter, (f) => f._tag)).toEqual(Option.some("Projectless"))
    expect(refused(TaskFilter, { _tag: "ByGroup", profile_id: "pr-1" })).toBe(true)
  })
})
