import { Effect, Exit } from "effect"
import { COLUMN_ROUNDS } from "@huntaway/contracts"
import type { Status, Task, WorkflowNode } from "@huntaway/contracts"
import { parseAccount } from "@huntaway/shared"
import { projectStart } from "../../agents/prompts/project.ts"
import type { Actor } from "../../platform/Changes.ts"
import { workflowFixes } from "../../prompts/workflowFixes.ts"
import {
  changedSince,
  columnText,
  endNodes,
  exhaustedReason,
  failedSteps,
  inputValue,
  keptPath,
  lastRan,
  movedReason,
  outOfRoundsReason,
  pathName,
  pickPath,
  plainCheck,
  plan,
  runIssues,
  runNode,
  settle,
  takesStartPrompt,
  wire,
  withNode,
  dropPort,
} from "../graph.ts"
import type { ColumnNode, RunState } from "../graph.ts"
import { startAgent, StepFailed, why, workOf } from "./agentStep.ts"
import { withFinish } from "./columns.ts"
import {
  chainOf,
  doneFailed,
  doneNone,
  donePort,
  forgetChain,
  nodeOf,
  notice,
  now,
  OpenPrTarget,
  projectOf,
  record,
  SplitRandom,
  valueSource,
  withRun,
  workflowName,
} from "./core.ts"
import type { Deps, Done } from "./core.ts"

// How a run goes on (inventory 06, 2.2; huntaway's integrations/workflows/engine.ts `advance` and the steps the board
// does itself, engine/steps.ts): the nodes that are ready run, each recorded as it ends, until the run waits only on its
// agent steps or has ended. Agent steps only start here; their end goes on from there (`stepEnded`).

const fail = (reason: string) => Effect.fail(new StepFailed({ reason }))

/** The run ended: say how on the task, and let a task it held move on (`WorkflowRunSettled`). */
const endedRun = Effect.fnUntraced(function* (d: Deps, run: RunState) {
  const name = yield* workflowName(d, run.workflow_id)
  const failed = failedSteps(run)
  if (failed.length === 0) yield* notice(d, run.task_id, "info", `The workflow "${name}" finished`)
  else yield* notice(d, run.task_id, "warning", `The workflow "${name}" finished with steps that failed`, failed.join("\n"))
  yield* d.changes.offer({ _tag: "WorkflowRunSettled", run: run.id, task: run.task_id, why: null })
})

/** Ends the run from a send or an edge into In progress: its other steps stop, as the agent's work is about to change. */
const endForWork = Effect.fnUntraced(function* (d: Deps, runId: string, done: (r: RunState) => RunState, stopped: string) {
  const threads = yield* withRun(d, runId, (current) =>
    Effect.gen(function* () {
      if (current.state !== "running") return [current, null] as const
      const at = yield* now
      const ended = endNodes(done(current), stopped, at)
      return [{ ...ended.run, state: "done" as const, finished_at: at, updated_at: at }, ended.threads] as const
    }),
  )
  if (threads === null) return false
  yield* forgetChain(d, runId)
  for (const t of threads) yield* d.runs.stop(t)
  return true
})

/** A check on the task. Fails saying why it couldn't be made. */
const condition = Effect.fnUntraced(function* (d: Deps, run: RunState, node: Extract<WorkflowNode, { readonly kind: "condition" }>) {
  const task = yield* d.taskRepo.get(run.task_id)
  if (task === null) return yield* fail("the task is gone")
  if (node.check === "has_commits") {
    // No worktree or branch (a scratch task, one that makes only documents, a project without worktrees): none.
    if (task.branch === null || task.worktree_path === null || task.worktree_state !== "ready") return false
    return !(yield* workOf(d, task, yield* projectOf(d, task.project_id))).work.elsewhere
  }
  // Since the latest of its runs on the task that finished, and got as far as this check.
  if (node.check === "changed") return changedSince(run, lastRan(yield* d.store.earlierRuns(run.workflow_id, run.task_id, run.id, true), node.id))
  return plainCheck(task, node.check, node.value ?? null)
})

/** An A/B test: the path the task kept, or one at random, each as likely as its weight says. */
const split = Effect.fnUntraced(function* (d: Deps, run: RunState, node: Extract<WorkflowNode, { readonly kind: "split" }>) {
  const kept = keptPath(yield* d.store.earlierRuns(run.workflow_id, run.task_id, run.id), node.id)
  const x = yield* yield* SplitRandom
  const picked = pickPath(node, kept, x)
  if (picked === null) return doneFailed("none of its paths has a weight above 0")
  if (!picked.kept) {
    const name = yield* workflowName(d, run.workflow_id)
    yield* notice(d, run.task_id, "info", `The workflow "${name}" took path ${pathName(picked.port)} of its A/B test ${node.id} (${picked.share}% likely)`)
  }
  return donePort(picked.port, pathName(picked.port))
})

/** Moves the task to `status` as the run's step; a move to Needs attention says why. */
const moveTask = Effect.fnUntraced(function* (d: Deps, run: RunState, status: Status) {
  const by: Actor = { _tag: "Workflow", run: run.id, chain: yield* chainOf(d, run.id) }
  const moved = yield* Effect.exit(d.tasks.update(run.task_id, { status }, by))
  if (Exit.isFailure(moved)) return doneFailed(why(moved.cause))
  // Why it needs attention: the steps of the run that failed, or else that the workflow moved it there.
  if (status === "needs_attention") {
    const current = (yield* d.store.getRun(run.id)) ?? run
    const reason = movedReason(current, yield* workflowName(d, run.workflow_id))
    yield* attention(d, run.task_id, reason)
  }
  return donePort("out")
})

/** Gives a task in Needs attention its reason, unless it has moved on meanwhile. */
export const attention = (d: Deps, task: Task["id"], reason: string) =>
  d.tasks.change(task, (t) => (t.status === "needs_attention" ? { attention_reason: reason } : null), { _tag: "Board" }).pipe(Effect.ignore)

/** Leaves the task in Needs attention for `reason`, unless its agent is working or it's done or merging. */
const flag = Effect.fnUntraced(function* (d: Deps, task: Task, reason: string) {
  if ((yield* d.runs.isRunning(task.id)) || task.status === "done" || task.merging) return
  yield* d.tasks
    .change(task.id, (t) => (t.running || t.status === "done" || t.merging ? null : { status: "needs_attention", attention_reason: reason }), { _tag: "Board" })
    .pipe(Effect.ignore)
})

/**
 * A send step: the message to the task's agent, if it has rounds left. Ends the run once it's sent (null), as the
 * agent's work changes under it.
 */
const send = Effect.fnUntraced(function* (d: Deps, run: RunState, node: Extract<WorkflowNode, { readonly kind: "send_to_task" }>) {
  const task = yield* d.taskRepo.get(run.task_id)
  if (task === null) return doneFailed("the task is gone")
  const workflow = yield* workflowName(d, run.workflow_id)
  const issues = runIssues(run)
  const src = yield* valueSource(d, { id: run.workflow_id, name: workflow, graph: run.graph }, task, yield* projectOf(d, task.project_id), run)
  let text = inputValue(src, node, "message", node.message).trim()
  if (text === "") {
    if (issues.length === 0) return doneFailed("there are no issues to send (and the step has no message of its own)")
    text = workflowFixes(workflow, issues)
  }
  text = yield* withFinish(d, task, text)
  const used = run.rounds[node.id] ?? 0
  if (used >= node.max_rounds) {
    const hasNext = run.graph.edges.some((e) => e.from === node.id && e.port === "exhausted")
    const reason = exhaustedReason(workflow, issues.length, used)
    yield* notice(d, task.id, "warning", reason, issues.length > 0 ? issues.join("\n\n") : null)
    if (!hasNext) yield* flag(d, task, reason)
    return donePort("exhausted")
  }
  if ((yield* d.runs.isRunning(task.id)) || task.status === "done" || task.merging) {
    // The user (or the agent) has moved on: the findings are left for them.
    yield* notice(d, task.id, "warning", `The workflow "${workflow}" didn't send its message: the task has moved on`, text)
    return doneFailed("the task has moved on (its agent is working, or it's done or merging)")
  }
  const round = used + 1
  const at = yield* now
  const ended = yield* endForWork(
    d,
    run.id,
    (current) =>
      withNode({ ...current, rounds: { ...current.rounds, [node.id]: round } }, node.id, (r) => ({ ...r, state: "done", port: "sent", text, finished_at: at })),
    "Stopped because the task's agent was sent a message.",
  )
  if (!ended) return null
  const sent = yield* Effect.exit(d.runs.send(task.id, { text, source: "board", auto: true, review_round: round }))
  if (Exit.isFailure(sent)) {
    const reason = why(sent.cause)
    yield* notice(d, task.id, "error", `The workflow "${workflow}" couldn't send its message to the agent`, reason)
    yield* d.changes.offer({
      _tag: "WorkflowRunSettled",
      run: run.id,
      task: task.id,
      why: `couldn't send its message to the agent: ${reason.split("\n")[0] ?? ""}`,
    })
  }
  return null
})

/**
 * An edge into In progress with no rounds left: the task isn't moved, and goes to Needs attention with the issues the
 * run found (unless the user or its agent has moved on).
 */
const outOfRounds = Effect.fnUntraced(function* (d: Deps, run: RunState, task: Task, used: number) {
  const issues = runIssues(run)
  const reason = outOfRoundsReason(yield* workflowName(d, run.workflow_id), issues.length, used)
  yield* notice(d, task.id, "warning", reason, issues.length > 0 ? issues.join("\n\n") : null)
  yield* flag(d, task, reason)
  return doneFailed("out of rounds: the agent was given its work as many times in a row as the column allows")
})

/**
 * An edge into a column node: moves the task there, where the column's node starts the next run. In In progress the
 * agent is given its work, which ends the run as a send does: a task that hasn't started starts, and one that has is
 * sent the issues the run found, or else the column's prompt.
 */
const enterColumn = Effect.fnUntraced(function* (d: Deps, run: RunState, node: ColumnNode) {
  const first = yield* d.taskRepo.get(run.task_id)
  if (first === null) return doneFailed("the task is gone")
  // Each time in a row this gives the agent its work is a round, as a send's are.
  const used = node.status === "in_progress" ? (run.rounds[node.id] ?? 0) : 0
  if (node.status === "in_progress" && used >= (node.max_rounds ?? COLUMN_ROUNDS)) return yield* outOfRounds(d, run, first, used)
  // Done is for merged work: only the run that goes on after a merge its agent said it's done moves a task there.
  if (node.status === "done" && first.status !== "done" && !(run.source === "merged" && first.status === "ready_for_merge" && !first.merging)) {
    return doneFailed("only the run after a merge can move the task to Done")
  }
  let task = first
  if (task.status !== node.status) {
    const moved = yield* moveTask(d, run, node.status)
    if (moved.state === "failed") return moved
    const now_ = yield* d.taskRepo.get(run.task_id)
    if (now_ === null) return doneFailed("the task is gone")
    task = now_
  }
  if (node.status !== "in_progress" || task.status !== "in_progress" || task.waiting || task.merging || (yield* d.runs.isRunning(task.id))) return doneNone
  const w = yield* d.store.get(run.workflow_id)
  const issues = runIssues(run)
  // A prompt that's wired is the one to send, which can take the issues itself; else the issues, or else In progress's
  // start text, as the agent started with: the task isn't left in In progress with nothing to do.
  const wired = wire(run.graph, node.id, "prompt") !== undefined
  const project = yield* projectOf(d, task.project_id)
  let text: string | null
  if (task.session_id === null) text = ""
  else if (w === null) text = null
  else if (issues.length > 0 && !wired) text = yield* withFinish(d, task, workflowFixes(w.name, issues))
  else text = columnText(yield* valueSource(d, w, task, project, run), node, projectStart(takesStartPrompt(task) ? project : null))
  if (text === null) return doneNone
  const at = yield* now
  const ended = yield* endForWork(
    d,
    run.id,
    (current) =>
      withNode({ ...current, rounds: { ...current.rounds, [node.id]: used + 1 } }, node.id, (r) => ({ ...dropPort(r), state: "done", finished_at: at })),
    "Stopped because the task's agent was given its work.",
  )
  if (!ended) return null
  const sent = yield* Effect.exit(d.runs.send(task.id, { text, source: "board", auto: true }))
  if (Exit.isFailure(sent)) yield* notice(d, task.id, "error", `The workflow "${w?.name ?? ""}" couldn't give the agent its work`, why(sent.cause))
  return null
})

/** The first `https://` URL in gh's output: the pull request it made (or the one that's there already). */
const prLink = (out: string): string | null => /https:\/\/\S+\/pull\/\d+/.exec(out)?.[0] ?? null

/**
 * An open-a-pull-request step: pushes the task's branch and opens its pull request with the gh tools, as the task's
 * GitHub account, into its base branch. Fails saying why it couldn't.
 */
const openPr = Effect.fnUntraced(function* (d: Deps, run: RunState, node: Extract<WorkflowNode, { readonly kind: "open_pr" }>) {
  const task = yield* d.taskRepo.get(run.task_id)
  if (task === null) return yield* fail("the task is gone")
  const has = task.pr_url !== null && task.pr_url.trim() !== "" ? donePort("exists", task.pr_url) : null
  // One it has already gets its branch's new commits.
  if (has !== null && (task.branch === null || task.worktree_path === null || task.worktree_state !== "ready")) return has
  const project = yield* projectOf(d, task.project_id)
  if (project === null) return yield* fail("the task has no project")
  const { work, dir, branch } = yield* workOf(d, task, project)
  if (work.elsewhere && has !== null) return has
  if (work.elsewhere) return yield* fail("the task's branch has no commits of its own to open a pull request for")
  const base = yield* d.taskBase.remoteBase(task, project)
  const target = (yield* OpenPrTarget) ?? (yield* d.taskBase.github(project.repo_path, base))
  if (target === null) return yield* fail("the task's repository isn't on GitHub (no remote to push to there)")
  const accountName = yield* d.taskBase.account(task)
  const account = accountName === null ? null : parseAccount(accountName)
  if (accountName !== null && account === null) return yield* fail(`the GitHub account ${accountName} isn't one gh can use`)
  const call = (tool: string, args: Readonly<Record<string, unknown>>) =>
    d.gh.run(tool, args, { cwd: dir, account, mergeGate: Effect.succeed(null) }).pipe(Effect.catch((e) => Effect.succeed({ text: e.message, failed: true })))
  const workflow = yield* workflowName(d, run.workflow_id)
  const pushed = yield* call("git_push", { remote: target.remote, branch })
  if (pushed.failed) return yield* fail(`couldn't push ${branch} to ${target.remote}: ${pushed.text}`)
  if (has !== null) return has
  const src = yield* valueSource(d, { id: run.workflow_id, name: workflow, graph: run.graph }, task, project, run)
  const title = inputValue(src, node, "title", node.title).trim() || `${task.key}: ${task.title}`
  const body = inputValue(src, node, "body", node.body).trim() || ((yield* d.readers.lastAssistantText(task.id))?.trim() ?? "") || task.description.trim()
  const out = yield* call("pr_create", {
    repo: target.repo,
    head: branch,
    title,
    body: body || title,
    ...(base !== null ? { base } : {}),
    ...(node.draft === true ? { draft: true } : {}),
  })
  const url = prLink(out.text)
  // Opened meanwhile (by the agent, or by hand): gh says so, with its link.
  const exists = out.failed && /already exists/i.test(out.text)
  if (url === null || (out.failed && !exists)) return yield* fail(`couldn't open the pull request: ${out.text}`)
  yield* d.tasks.change(task.id, (t) => (t.pr_url === null || t.pr_url === "" ? { pr_url: url } : null), { _tag: "Board" }).pipe(Effect.ignore)
  yield* notice(
    d,
    task.id,
    "info",
    exists ? `The workflow "${workflow}" found the task's pull request` : `The workflow "${workflow}" opened a pull request`,
    url,
  )
  return donePort(exists ? "exists" : "opened", url)
})

/** A step that fails with why: failed, on its `failed` port. */
const failing = <A>(e: Effect.Effect<A, StepFailed>, f: (a: A) => Done | null) =>
  e.pipe(
    Effect.map(f),
    Effect.catchTag("StepFailed", (x) => Effect.succeed(doneFailed(x.reason))),
  )

/** What node `id` does: what it did, or null when it goes on by itself (an agent step) or ended the run (a send). */
const execute = (d: Deps, run: RunState, node: WorkflowNode): Effect.Effect<Done | null> => {
  switch (node.kind) {
    case "trigger":
      return Effect.succeed(donePort("out"))
    case "condition":
      return condition(d, run, node).pipe(
        Effect.map((yes) => donePort(yes ? "yes" : "no")),
        // A condition has no `failed` port: it only ends.
        Effect.catchTag("StepFailed", (x) => Effect.succeed<Done>({ state: "failed", port: null, text: x.reason })),
      )
    case "agent":
      return failing(startAgent(d, run, node), () => null)
    case "send_to_task":
      return send(d, run, node)
    case "column":
      return enterColumn(d, run, node)
    case "split":
      return split(d, run, node)
    case "open_pr":
      return failing(openPr(d, run, node), (x) => x)
    // Data nodes: no run goes into them.
    case "text":
    case "task":
    case "project_prompt":
    case "compose":
    case "join":
    case "switch":
    default:
      return Effect.succeed(null)
  }
}

/** One pass's plan: the run ended (or gone), or the nodes to run now. */
interface Pass {
  readonly ended: RunState | null
  readonly ready: ReadonlyArray<string>
  readonly gone: boolean
}

/** Runs what's ready to run, until the run waits only on its agents or has ended. */
export const advance: (d: Deps, runId: string) => Effect.Effect<void> = Effect.fnUntraced(function* (d: Deps, runId: string) {
  for (;;) {
    const step = yield* withRun(d, runId, (run) =>
      Effect.gen(function* () {
        if (run.state !== "running") {
          const gone: Pass = { ended: null, ready: [], gone: true }
          return [run, gone] as const
        }
        const at = yield* now
        const planned = plan(run, at)
        const settled = settle(planned.run, at)
        const pass: Pass = { ended: settled, ready: planned.ready, gone: false }
        return [settled ?? planned.run, pass] as const
      }),
    )
    if (step === null || step.gone) {
      yield* forgetChain(d, runId)
      return
    }
    if (step.ended !== null) {
      yield* forgetChain(d, runId)
      yield* endedRun(d, step.ended)
      return
    }
    if (step.ready.length === 0) return
    const run = yield* d.store.getRun(runId)
    if (run === null) return
    for (const id of step.ready) {
      const node = nodeOf(run, id)
      if (node === undefined) continue
      // Each step reads the run as it is now: one before it in this pass may have changed it.
      const current = (yield* d.store.getRun(runId)) ?? run
      if (runNode(current, id).state !== "running") continue
      const done = yield* execute(d, current, node)
      if (done !== null) yield* record(d, runId, id, done)
    }
  }
})
