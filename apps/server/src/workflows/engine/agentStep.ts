import { Cause, Effect, Exit, Option, Schema } from "effect"
import { AgentConfigId, RunId, TaskId } from "@huntaway/contracts"
import type { Project, Task } from "@huntaway/contracts"
import { projectReview } from "../../agents/prompts/project.ts"
import { Actor } from "../../platform/Changes.ts"
import { REPLIES } from "../../prompts/review.ts"
import { workflowStep } from "../../prompts/workflowStep.ts"
import type { WorkflowWork } from "../../prompts/workflowStep.ts"
import { label } from "../../review/model.ts"
import { readWork, revParse } from "../../review/work.ts"
import type { Outcome } from "../../runs/Run.ts"
import { inputValue, lastRan, runNode, upstream, withNode, WORKFLOW } from "../graph.ts"
import type { AgentNode, RunState } from "../graph.ts"
import { notice, now, projectOf, record, valueSource, withRun, workflowName } from "./core.ts"
import type { Deps, Done } from "./core.ts"

// An agent step (inventory 06, 2.2; huntaway's integrations/workflows/engine/agent_step.ts): its thread, starting it,
// its verdict (`submit_review`), and its end.

/** Why the engine refused something an agent or the user asked (a step's verdict, a run by hand): what they're told. */
export class WorkflowRefused extends Schema.TaggedError<WorkflowRefused, { readonly brand: unique symbol }>()("WorkflowRefused", {
  reason: Schema.String,
  /** The request itself is wrong (a task of another project), rather than the board's state. */
  invalid: Schema.Boolean,
}) {
  static readonly conflict = (reason: string) => new WorkflowRefused({ reason, invalid: false })
  static readonly invalid = (reason: string) => new WorkflowRefused({ reason, invalid: true })
}

/** Why a step couldn't be done: a string, as the old engine threw them. */
export class StepFailed extends Schema.TaggedError<StepFailed, { readonly brand: unique symbol }>()("StepFailed", { reason: Schema.String }) {}

const fail = (reason: string) => Effect.fail(new StepFailed({ reason }))

/** Whether `thread` is a workflow's agent thread. */
export const isWorkflowThread = (thread: Pick<Task, "kind" | "task_type">): boolean => thread.kind === "review" && thread.task_type === WORKFLOW

/** The first line of why an Effect failed. */
export const why = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.findErrorOption(cause)
  if (Option.isSome(e)) {
    const v: unknown = e.value
    if (typeof v === "object" && v !== null) {
      for (const k of ["reason", "detail", "message"]) {
        const x: unknown = Reflect.get(v, k)
        if (typeof x === "string" && x !== "") return x
      }
    }
  }
  return Cause.pretty(cause).split("\n")[0] ?? "it failed"
}

/**
 * Where the task's work is, and whether its branch has no commits of its own (`elsewhere`). Fails saying why it can't
 * tell.
 */
export const workOf = Effect.fnUntraced(function* (d: Deps, task: Task, project: Project | null) {
  if (project === null) return yield* fail("the task has no project")
  const dir = task.worktree_state === "ready" ? task.worktree_path : null
  if (dir === null || task.branch === null) return yield* fail("the task has no worktree")
  const head = yield* revParse(d.git, dir, "HEAD")
  if (head === null) return yield* fail("couldn't read the worktree's HEAD commit")
  const w = yield* readWork(d.git, d.taskBase, dir, task, project, head)
  const work: WorkflowWork = {
    key: task.key,
    branch: task.branch,
    base: w.base,
    commit: head.slice(0, 10),
    elsewhere: w.elsewhere,
    own_start: w.ownStart,
    last_message: null,
  }
  return { work, dir, branch: task.branch }
})

/** The thread an agent step works in: the one it had in an earlier run on the task, while its agent is the same. */
const threadFor = Effect.fnUntraced(function* (d: Deps, run: RunState, node: string, config: string | null, model: string | null, effort: string | null) {
  for (const r of yield* d.store.earlierRuns(run.workflow_id, run.task_id, run.id)) {
    const id = r.nodes[node]?.thread_id
    if (id === undefined) continue
    const t = yield* d.taskRepo.get(id)
    const same = (t?.claude_config_id ?? null) === config && (t?.model ?? null) === model && (t?.effort ?? null) === effort
    return t !== null && isWorkflowThread(t) && t.parent_id === run.task_id && same ? t : null
  }
  return null
})

/** Starts an agent step's thread on its prompt; it ends in `stepEnded`. Fails saying why it couldn't start. */
export const startAgent = Effect.fnUntraced(function* (d: Deps, run: RunState, node: AgentNode) {
  if (d.config.noAgents) return yield* fail("this host can't run agents")
  const task = yield* d.taskRepo.get(run.task_id)
  if (task === null) return yield* fail("the task is gone")
  const project = yield* projectOf(d, task.project_id)
  if (project === null) return yield* fail("the task has no project")
  const workflow = yield* workflowName(d, run.workflow_id)
  const found = yield* workOf(d, task, project)
  const work: WorkflowWork = found.work.elsewhere ? { ...found.work, last_message: yield* d.readers.lastAssistantText(task.id) } : found.work
  const taskConfig = yield* d.launchFacts.config(task)
  const own = node.claude_config_id === undefined ? null : Option.getOrNull(yield* d.configs.get(AgentConfigId.make(node.claude_config_id)))
  // A step whose config was deleted works with the task's.
  const config = own ?? taskConfig
  const configId = config?.id ?? null
  const model = node.model ?? null
  const effort = node.effort ?? null
  const lbl = label(config?.name ?? null, model, effort)
  const verdict = node.output === "verdict"
  // What the steps before it in the graph said.
  const earlier: Array<readonly [string, string]> = []
  for (const n of upstream(run.graph, node.id)) {
    const r = run.nodes[n.id]
    if (r?.state === "done" && r.text !== undefined) earlier.push([n.name, r.text])
  }
  const existing = yield* threadFor(d, run, node.id, configId, model, effort)
  // Its conversation goes on from its last run's (HA-310): only in the same thread, which has one.
  const keep = node.keep_conversation === true && existing?.session_id !== null && existing?.session_id !== undefined
  // Issues it found last time, if the agent was sent them since.
  let recheck: ReadonlyArray<string> = []
  if (verdict && Object.keys(run.rounds).length > 0) {
    const last = lastRan(yield* d.store.earlierRuns(run.workflow_id, run.task_id, run.id, true), node.id)
    const n = last?.nodes[node.id]
    if (n?.port === "issues") recheck = n.issues ?? []
  }
  const src = yield* valueSource(d, { id: run.workflow_id, name: workflow, graph: run.graph }, task, project, run)
  const rendered = inputValue(src, node, "prompt", node.prompt)
  const asked = rendered.trim() !== "" ? rendered : verdict ? projectReview(project) : `Read the work, and report on it as "${node.name}".`
  const text = workflowStep({
    title: task.title,
    description: task.description,
    pr_url: task.pr_url,
    work,
    workflow,
    step: node.name,
    instructions: asked,
    output: node.output,
    skills: node.skills ?? [],
    codex: config?.agent === "codex",
    earlier,
    replies: verdict ? yield* d.readers.userReplies(task.id, REPLIES) : null,
    recheck,
    inputOnly: node.input_only === true,
    continued: keep,
  })
  const title = `${node.name} (${workflow}) of ${task.key}`
  let thread: Task
  if (existing !== null) {
    if (existing.title !== title) yield* d.tasks.change(existing.id, () => ({ title }), Actor.board).pipe(Effect.ignore)
    thread = existing
  } else {
    const id = TaskId.make(yield* d.newId)
    yield* d.reviewRepo.insertThread(
      id,
      {
        profile_id: task.profile_id,
        project_id: project.id,
        parent_id: task.id,
        task_type: "workflow",
        title,
        description: "",
        model,
        effort,
        claude_config_id: configId,
      },
      yield* now,
    )
    const made = yield* d.taskRepo.get(id)
    if (made === null) return yield* fail("the thread is gone")
    yield* d.events.emit({ type: "task", task: made })
    thread = made
  }
  if (yield* d.runs.isRunning(thread.id)) return yield* fail(`its thread's agent (${lbl}) is busy`)
  const afterRun = (yield* d.reviewRepo.latestRun(thread.id)) ?? ""
  yield* d.reviewRepo.setSkills(thread.id, node.skills ?? [])
  yield* d.store.setDisabledMcpServers(thread.id, node.disabled_mcp_servers ?? [])
  // A fresh conversation each run, unless it keeps its conversation; the thread keeps every one's messages.
  if (!keep) {
    yield* d.tasks.change(thread.id, (t) => (t.session_id === null ? null : { session_id: null }), Actor.board).pipe(Effect.ignore)
    yield* d.meter.clear(thread.id)
  }
  // A step of a run that's been stopped meanwhile doesn't start; one that starts first is stopped with it (below).
  const threadId = thread.id
  const recorded = yield* withRun(d, run.id, (current) =>
    Effect.gen(function* () {
      if (current.state !== "running" || runNode(current, node.id).state !== "running") return [current, false] as const
      const next = withNode({ ...current, updated_at: yield* now }, node.id, (r) => ({ ...r, thread_id: threadId, label: lbl, after_run: afterRun }))
      return [next, true] as const
    }),
  )
  if (recorded !== true) return false
  yield* notice(d, thread.id, "info", `Running "${node.name}" on commit ${work.commit}`)
  const sent = yield* Effect.exit(d.runs.send(thread.id, { text, source: "board", auto: true, review: true }))
  if (Exit.isFailure(sent)) return yield* fail(why(sent.cause))
  // Stopped while it started: its agent stops with it.
  const after = yield* d.store.getRun(run.id)
  if (after === null || after.state !== "running" || runNode(after, node.id).thread_id !== threadId || runNode(after, node.id).state !== "running") {
    yield* d.runs.stop(thread.id)
  }
  return true
})

/** The running run and node agent thread `thread` works for, if any. */
const stepOf = Effect.fnUntraced(function* (d: Deps, thread: Task) {
  if (thread.parent_id === null) return null
  for (const r of yield* d.store.running(thread.parent_id)) {
    const id = Object.keys(r.nodes)
      .toSorted()
      .find((k) => r.nodes[k]?.state === "running" && r.nodes[k]?.thread_id === thread.id)
    if (id !== undefined) return { run: r, id }
  }
  return null
})

/** Whether run `runId` of the thread is the one its step asked for (not an earlier one ending late). */
const askedFor = (d: Deps, thread: TaskId, after: string | undefined, runId: string) =>
  after === undefined ? Effect.succeed(false) : d.reviewRepo.runAfter(thread, RunId.make(runId), RunId.make(after))

/** `submit_review` from a workflow's verdict step: its verdict, acted on when its run ends. */
export const submit = Effect.fnUntraced(function* (
  d: Deps,
  thread: Task,
  runId: string,
  args: { readonly verdict: "pass" | "needs_fixes"; readonly summary?: string | undefined; readonly serious_issues: ReadonlyArray<string> },
) {
  const step = yield* stepOf(d, thread)
  if (step === null) return yield* WorkflowRefused.conflict("no workflow step is running in this thread, so there's nothing to submit")
  const n = step.run.graph.nodes.find((x) => x.id === step.id)
  if (n?.kind !== "agent" || n.output !== "verdict") {
    return yield* WorkflowRefused.conflict("this step reports with its last message, not submit_review: end your turn with its output")
  }
  if (!(yield* askedFor(d, thread.id, runNode(step.run, step.id).after_run, runId))) {
    return yield* WorkflowRefused.conflict("the step this run was asked for has ended, so there's nothing to submit")
  }
  const issues = args.serious_issues.map((i) => i.trim()).filter((i) => i !== "")
  const summary = args.summary !== undefined && args.summary.trim() !== "" ? args.summary.trim() : null
  if (args.verdict === "needs_fixes" && issues.length === 0) issues.push(summary ?? "The step asked for fixes without saying what they are; see its thread.")
  const id = step.id
  yield* withRun(d, step.run.id, (run) =>
    Effect.gen(function* () {
      if (run.state !== "running" || runNode(run, id).state !== "running") return [run, null] as const
      const next = withNode({ ...run, updated_at: yield* now }, id, (r) => {
        const { issues: _i, text: _t, ...rest } = r
        return {
          ...rest,
          verdict: issues.length > 0 ? ("issues" as const) : ("pass" as const),
          ...(issues.length > 0 ? { issues } : {}),
          ...(summary !== null ? { text: summary } : {}),
        }
      })
      return [next, null] as const
    }),
  )
  return { ok: true, note: "Recorded. End your turn now with a short summary." }
})

/**
 * Records how the step thread `thread` worked for ended, if its run `runId` was the step's. The workflow run's id, to
 * go on from, or null.
 */
export const stepEnded = Effect.fnUntraced(function* (d: Deps, threadId: TaskId, runId: string, outcome: Outcome, attention: string | null) {
  const thread = yield* d.taskRepo.get(threadId)
  if (thread === null || !isWorkflowThread(thread)) return null
  const step = yield* stepOf(d, thread)
  if (step === null) return null
  const r = runNode(step.run, step.id)
  if (!(yield* askedFor(d, thread.id, r.after_run, runId))) return null
  const n = step.run.graph.nodes.find((x) => x.id === step.id)
  const verdict = n?.kind === "agent" && n.output === "verdict"
  const written = Effect.map(d.readers.saidSinceAsked(thread.id), (t) => {
    const s = t?.trim() ?? ""
    return s === "" ? null : s
  })
  let done: Done
  if (outcome._tag === "Cancelled") done = { state: "stopped", port: null, text: "The step was stopped." }
  else if (outcome._tag === "Failed") done = { state: "failed", port: "failed", text: `The step failed: ${outcome.reason.split("\n")[0] ?? ""}` }
  else if (attention !== null) done = { state: "failed", port: "failed", text: `The step's agent asked: ${attention}` }
  else if (verdict && r.verdict === undefined) done = { state: "failed", port: "failed", text: "The step finished without submitting a verdict." }
  else if (verdict) done = { state: "done", port: r.verdict === "pass" ? "pass" : "issues", text: r.text ?? (yield* written) }
  else {
    const t = yield* written
    done = t !== null ? { state: "done", port: "done", text: t } : { state: "failed", port: "failed", text: "The step finished without writing its output." }
  }
  const saved = yield* record(d, step.run.id, step.id, done)
  return saved === null ? null : saved.id
})
