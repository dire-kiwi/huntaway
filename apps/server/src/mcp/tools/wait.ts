import { Clock, Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { ReviewState, Status } from "@huntaway/contracts"
import type { Task, WaitTask } from "@huntaway/contracts"
import { ApprovalRules } from "../../agents/ApprovalRules.ts"
import { PrWatch } from "../../github/PrWatch.ts"
import { EVENTS, note as prNote } from "../../github/prWatch/pr.ts"
import { approvesOwnWaits } from "../../agents/claude/access.ts"
import { toJson } from "../../platform/columns.ts"
import { BackgroundWork } from "../../runs/BackgroundWork.ts"
import { RunDir } from "../../runs/RunDir.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { makeReach } from "../resolve.ts"
import { ForPlanning, ForReviewers, Rerunnable, ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { Wait } from "../Wait.ts"
import { CommandApproval } from "../wait/CommandApproval.ts"
import { COMMAND_MAX_SECS, COMMAND_STOPPED, DEFAULT_SECS, endedName, MAX_SECS, note, resuming, UNWATCHED_MAX_SECS } from "../wait/ended.ts"
import { boardTool, Json } from "./common.ts"
import type { JsonObject } from "./common.ts"
import { makeTaskJson } from "./taskJson.ts"

// The waiting tools (docs/plan/inventory/03-mcp.md 2.5, 2.8; the old mcp/schemas/waiting.ts `wait_tools`,
// mcp/tools/dispatch.ts `wait_tool` and agent/runner/background.ts `wait_tool`): `wait`, which blocks until something
// happens (`Wait`), and `background_wait`, which says the agent waits on a background shell of its own.

/**
 * The bounds the agent is shown for `seconds`. They are not enforced, as before: a shorter wait lasts a second, a longer
 * one the most it may (`period`).
 */
const shownBounds = Schema.makeFilter<number>(() => true, { toJsonSchema: () => ({ minimum: 1, maximum: MAX_SECS }) })

export const WaitTool = Tool.make("wait", {
  description:
    "Wait without doing anything, e.g. for the tasks you created to finish, for a pull request's checks or reviews, or for a deploy or a background command. " +
    "The call blocks until the wait period is over, one of the listed tasks changes status or its review finishes, there's news about your pull_request, a subagent completes, fails or stops, your command exits, a message is sent to you, the run is " +
    "stopped, or you make another tool call (your subagents' tool calls other than board tools don't count), and says which. Meanwhile your task stays where it is (it doesn't need the user's attention) and the board shows it " +
    "as waiting rather than working, with your reason. Use it instead of sleeping or polling in a loop; call it again to keep " +
    `waiting. Without tasks, a command or a pull request, a wait lasts ${UNWATCHED_MAX_SECS} seconds at most, as little but a message or a subagent can end it early: for CI ` +
    "or reviews on a pull request, give pull_request; for a deploy, give a command that exits once it's ready, or check and wait again. To wait for the user, use request_user_input instead.",
  parameters: Schema.Struct({
    reason: Schema.String.annotate({
      description: "What you're waiting for, shown on the board (e.g. 'waiting on OBP-1 and OWC-1', 'waiting for CI and review')",
    }),
    seconds: Schema.optionalKey(
      Schema.Finite.check(shownBounds).annotate({
        description: `How long to wait at most (with tasks or a pull request: default ${DEFAULT_SECS}, at most ${MAX_SECS}; with a command: default and at most ${COMMAND_MAX_SECS}; without any of them: default and at most ${UNWATCHED_MAX_SECS})`,
      }),
    ),
    tasks: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description:
          "Tasks (ids or keys like ABC-12, on this host) to watch: the wait ends as soon as one of them changes status, or its review finishes (passes, finds issues, fails or is stopped), which a review that passes does with the task still in in_review. " +
          "Nothing else about them ends it (e.g. its agent's run ending in the same column, its pull request being set, a merge waiting for the user's approval): for those, give a shorter seconds and check on them in between. " +
          "The result has each one's summary, with only its review's state (read the rest with get_task_field). " +
          "Each is watched from how it is when the wait starts, so a change before then doesn't end it: give last_seen, how you last saw each (its status, and its review's state if you wait for its review).",
      }),
    ),
    last_seen: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Union([
          Status,
          Schema.Struct({
            status: Schema.optionalKey(Status),
            review: Schema.optionalKey(Schema.NullOr(ReviewState).annotate({ description: "Its review's state (review.state), or null if it had none" })),
          }),
        ]),
      ).annotate({
        description:
          'For tasks in tasks, how you last saw each: its status, e.g. {"ABC-12": "in_progress"}, or its status and review state, e.g. {"ABC-12": {"status": "in_review", "review": "running"}} (null if it had no review). ' +
          "One whose status has moved on since, or whose review has finished in another state since (passed while you saw it running, say), ends the wait at once, rather than being watched from where it is now. " +
          "Give the review state when you wait for a task's review: a review that ends between your read and the wait is otherwise missed.",
      }),
    ),
    // A number is taken too, as agents send one (`7`, or `7.0`).
    pull_request: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Finite]).annotate({
        description:
          "A pull request to watch: its number (in your task's repository), OWNER/REPO#NUMBER or URL. The wait ends on news about it you haven't been told yet (see pull_request_events): its head commit's checks finished (one failed, or all the required ones passed), someone other than your GitHub account commented or reviewed, it started to conflict with its base branch, or it was merged or closed. It says what happened in pull_request: the failed checks with their links, new comments with their author, file, line and text, and its merge state. What you've been told is remembered across waits, so after acting on the news wait on it again: a comment made meanwhile ends that wait straight away. The first wait on a pull request reports how its checks ended and a conflict, but not its earlier comments. GitHub is read every minute or so, as your GitHub account.",
      }),
    ),
    pull_request_events: Schema.optionalKey(
      Schema.Array(Schema.Literals(EVENTS)).annotate({
        description:
          "With pull_request, news to end the wait on besides checks_failed, checks_passed and conflicts, which every wait on a pull request ends on (default all of it): comments (comments and reviews), and the three it always has. Its being merged or closed always ends it too, and so does its conflicting while none of its checks is running, since GitHub runs no pull request checks on it then.",
      }),
    ),
    command: Schema.optionalKey(
      Schema.String.annotate({
        description: `A shell command (bash) to run in your working directory while you wait: the wait ends as soon as it exits, and returns its exit code and the end of its output. Use one that blocks until what you're waiting for is ready (e.g. 'gh run watch 123'), or loop until it is (e.g. 'until curl -sf https://example.com/health; do sleep 15; done'). It's approved like your Bash calls and runs with the same $TMPDIR, and it's stopped with everything it started if the wait ends first, which then returns its output so far (so a loop that can't succeed shows why; a wait with a command lasts ${COMMAND_MAX_SECS} seconds at most, then wait again if it's still fine). For a pull request, give pull_request instead.`,
      }),
    ),
  }),
  success: Json,
})
  // It picks up its stored wait by its call id, so a call cut short by a restart carries on.
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const BackgroundWait = Tool.make("background_wait", {
  description:
    "Say that you're waiting on a command you started in the background (the Bash tool's run_in_background), such as a long build or test run, " +
    "so the board keeps showing your task as working while it runs. Pass its task ID, the one the Bash tool gave back when it started it. " +
    "Not for something you leave running, such as a dev server or a watcher: once your turn ends, those leave the task shown as idle, with " +
    "a banner of what's running, and the user's messages reach you at once. waiting=false clears it. It doesn't stop the command or wait for it: " +
    "you're told when it ends, as usual.",
  parameters: Schema.Struct({
    task_id: Schema.String.annotate({ description: "The background task's ID, as the Bash tool gave it back (e.g. b5o2nmhr9)" }),
    waiting: Schema.optionalKey(Schema.Boolean.annotate({ description: "false to say you no longer wait on it (default true)" })),
  }),
  success: Schema.Struct({ ok: Schema.Boolean, note: Schema.String }),
})
  // It records what it's given.
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

/** What `background_wait` tells the agent. */
export const BACKGROUND_WAITING =
  "The board shows this task as working while it runs. You're told when it ends; call background_wait with waiting=false if you stop waiting on it."
export const BACKGROUND_NOT_WAITING = "The board no longer counts it as work you wait on: once your turn ends, the task shows as idle while it runs."

/** The waiting tools' handlers, in the order runs are shown them. */
export const waitTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const json = yield* makeTaskJson(reach)
  const repo = yield* TaskRepo
  const waits = yield* Wait
  const approval = yield* CommandApproval
  const rules = yield* ApprovalRules
  const dirs = yield* RunDir
  const background = yield* BackgroundWork
  const prWatch = yield* PrWatch

  /**
   * Whether the agent's own reviewer has reviewed its wait calls: Claude's classifier in auto mode, or Codex's reviewer
   * on the board's MCP server (`codex.json`'s `review_waits`; a dynamic tool's call is the board's to ask about).
   */
  const reviewsOwnWaits = Effect.fnUntraced(function* (caller: McpCaller) {
    const codex = yield* dirs.codexSpec(caller.run.id)
    if (codex !== null) return codex.review_waits
    const spec = yield* dirs.spec(caller.run.id)
    return spec !== null && approvesOwnWaits(spec.args)
  })

  /** Whether the user's approval rules ask about or refuse Bash in the caller's thread now: a wait's command is a command. */
  const ruledBash = Effect.fnUntraced(function* (caller: McpCaller) {
    const rule = yield* rules.decide(caller.task, "Bash", caller.mode)
    return rule !== null && rule.decision !== "allow"
  })

  /** The tasks to watch, as they are now, and from how the agent last saw them (HA-389). */
  const watchedTasks = Effect.fnUntraced(function* (
    caller: McpCaller,
    refs: ReadonlyArray<string>,
    lastSeen: Readonly<Record<string, Status | { readonly status?: Status; readonly review?: ReviewState | null }>>,
  ) {
    const found: Array<Task> = []
    for (const r of refs) {
      const t = yield* reach
        .task(caller, r, null)
        .pipe(Effect.mapError((e) => (e.notFound ? ToolError.other(`task ${r} not found on this host (wait can only watch tasks on the host it runs on)`) : e)))
      found.push(t)
    }
    const watched: Array<{ -readonly [K in keyof WaitTask]: WaitTask[K] }> = found.map((t) => ({
      id: t.id,
      key: t.key,
      status: t.status,
      review_at: t.review?.updated_at ?? null,
    }))
    for (const [r, seen] of Object.entries(lastSeen)) {
      const id = yield* reach.task(caller, r, null).pipe(
        Effect.map((t) => t.id),
        Effect.orElseSucceed(() => null),
      )
      const at = watched.findIndex((x) => x.id === id)
      const w = watched[at]
      if (w === undefined) return yield* ToolError.other(`last_seen has ${r}, which isn't in tasks`)
      // A status, or {status, review}: either may be left out of the object.
      const given = typeof seen === "string" ? { status: seen } : seen
      if (given.status !== undefined) w.status = given.status
      // A review state other than the one it has now: its review finishing ends the wait, at once if it has finished since.
      if (given.review !== undefined && given.review !== (found[at]?.review?.state ?? null)) w.review_at = null
    }
    const list: ReadonlyArray<WaitTask> = watched
    return list
  })

  const wait = boardTool(WaitTool, (params, caller) =>
    Effect.gen(function* () {
      const task = (yield* repo.get(caller.task.id)) ?? caller.task
      const resumed = resuming(task, caller.call_id) !== null
      // A call retried after a restart watches what it started with, even tasks since deleted.
      const tasks = resumed ? [] : yield* watchedTasks(caller, params.tasks ?? [], params.last_seen ?? {})
      const reason = params.reason
      const command = params.command !== undefined && params.command.trim() !== "" ? params.command.trim() : null
      // The command runs as the agent's own Bash calls would, so it's approved like them: in auto mode the agent's
      // reviewer has already reviewed this call, otherwise the user (or the mode) decides. An approval rule on Bash
      // holds for it whoever reviewed the call: a wait's command is a command.
      if (command !== null && !resumed && (!(yield* reviewsOwnWaits(caller)) || (yield* ruledBash(caller)))) {
        const cwd = yield* waits.workDir(task)
        const answer = yield* approval.ask(caller, { command, cwd, description: `Run while waiting${reason !== "" ? `: ${reason}` : ""}` })
        if (!answer.allowed) return yield* ToolError.other(`The command wasn't approved, so the wait didn't start: ${answer.message ?? "denied"}`)
      }
      // Read as the task's GitHub account, which isn't asked about: it only reads.
      const given = params.pull_request
      const pullRequest =
        resumed || given === undefined || String(given).trim() === ""
          ? null
          : yield* prWatch.request(task, given, params.pull_request_events ?? null).pipe(Effect.mapError((e) => ToolError.other(e.reason)))
      const started = yield* Clock.currentTimeMillis
      const out = yield* waits.wait(caller, { reason, seconds: params.seconds ?? null, tasks, command, pullRequest })
      const watched = yield* Effect.forEach(
        out.wait.tasks,
        (x) =>
          Effect.gen(function* () {
            const t = yield* repo.get(x.id)
            if (t === null) return { id: x.id, key: x.key, deleted: true }
            // Only its review's state: its summary and issues run to thousands of characters, which every wait on the
            // task would repeat (HA-390). get_task_field reads them.
            const v = yield* json.summary(t)
            if (t.review !== null) v["review"] = { state: t.review.state }
            return v
          }),
        { concurrency: 1 },
      )
      const ended = out.ended
      const result: JsonObject = {
        ended: endedName(ended),
        waited_seconds: Math.floor(((yield* Clock.currentTimeMillis) - started) / 1000),
        note: note(ended, out.wait.tasks),
        tasks: watched,
      }
      if (ended._tag === "Command") result["command"] = { exit_code: ended.code, output: ended.output }
      // A command that hadn't exited was stopped: what it printed so far shows how it was doing (a check that can't succeed).
      else if (out.output !== null) {
        result["command"] = { stopped: true, output: out.output }
        result["note"] = `${String(result["note"])} ${COMMAND_STOPPED}`
      }
      if (ended._tag === "Subagent") result["subagent"] = ended.agent
      // Its news, whatever ended the wait, or else how it was when last read.
      const pr = out.wait.pull_request
      if (pr !== undefined) {
        if (pr.news !== undefined) {
          if (ended._tag !== "PullRequest") result["note"] = `${String(result["note"])} ${prNote(pr.news)}`
          result["pull_request"] = pr.news
        } else result["pull_request"] = (yield* prWatch.last(task.id, pr)) ?? { url: pr.url, number: pr.number }
      }
      return result
    }),
  )

  const backgroundWait = boardTool(BackgroundWait, (params, caller) =>
    Effect.gen(function* () {
      const id = params.task_id.trim()
      const waiting = params.waiting !== false
      // What the run has going, as its task shows it (2.8 keeps it from the run's `background` file).
      const task = (yield* repo.get(caller.task.id)) ?? caller.task
      const list = task.background_work !== null && task.background_work.run_id === caller.run.id ? task.background_work.tasks : []
      if (!list.some((t) => t.id === id)) {
        const going = list.flatMap((t) => (t.id === null ? [] : [`${t.id} (${t.description ?? t.command ?? t.kind})`]))
        return yield* ToolError.other(
          `You have no background task ${yield* toJson(id)} going. Pass the ID the Bash tool gave back when it started the command in the background` +
            (going.length > 0 ? `; yours are ${going.join(", ")}.` : "; you have none going."),
        )
      }
      const waited = (yield* dirs.backgroundWaited(caller.run.id)).filter((w) => w !== id && list.some((t) => t.id === w))
      yield* dirs
        .setBackgroundWaited(caller.run.id, waiting ? [...waited, id] : waited)
        .pipe(Effect.catch((e) => Effect.logError(`run=${caller.run.id} recording the background tasks the agent waits on: ${e.reason}`)))
      // The task's background work is shown again from it.
      yield* background.sync(caller.run.id)
      return { ok: true, note: waiting ? BACKGROUND_WAITING : BACKGROUND_NOT_WAITING }
    }),
  )

  return { wait, backgroundWait }
})
