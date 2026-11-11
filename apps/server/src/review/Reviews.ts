import { Context, Effect, Exit, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { RunId, TaskId } from "@huntaway/contracts"
import type { Review, ReviewerRun, Task } from "@huntaway/contracts"
import { ContextMeter } from "../agents/ContextMeter.ts"
import { reviewerInstructions } from "../agents/prompts/project.ts"
import { Git } from "../git/Git.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { Changes } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { REPLIES, review as reviewPrompt, reviewSkills } from "../prompts/review.ts"
import type { ReviewWork } from "../prompts/review.ts"
import { reviewFixes } from "../prompts/reviewFixes.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import type { Outcome } from "../runs/Run.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { changesCode } from "./changesCode.ts"
import {
  decideExtend,
  decideIssues,
  endPart,
  failureText,
  found,
  inProgress,
  isReviewer,
  label,
  listed,
  nonBlank,
  recoveredOutcome,
  reviewerEnd,
  reviewersFor,
  ReviewRefused,
  same,
  stopReview,
  submission,
  submitted,
} from "./model.ts"
import type { Submitted } from "./model.ts"
import { ReviewRepo } from "./ReviewRepo.ts"
import { ReviewStats } from "./ReviewStats.ts"
import { Summaries } from "./Summaries.ts"
import { changeTask, changeTaskWith, writeTask } from "./taskWrites.ts"
import type { Writes } from "./taskWrites.ts"
import { readWork, revParse } from "./work.ts"

// Automatic code review (docs/plan/inventory/04-git-review.md 2.12; huntaway's review.ts). When a task moves to In
// review (usually because its agent finished), each of the project's reviewers reviews the branch in the task's
// worktree, in a review thread of its own under the task. The task's `review` holds the latest review: each reviewer's
// part and their combined outcome. Once every reviewer has finished, the serious issues they reported with
// `submit_review` go back to the task's agent to fix; when it finishes, the new commit is reviewed again. After the
// project's `review_rounds` rounds of that in a row, the task is left for the user, who can give it as many more
// (`extend`). Only code changes are reviewed automatically: a branch with no commits of its own is skipped unless the
// agent changed code somewhere else (`changedElsewhere`). The task stays in In review while it's reviewed.

/** What `submit_review` tells the reviewer. */
export const RECORDED = "Recorded. End your turn now with a short summary of the review."

const skip = (manual: boolean, why: string) => (manual ? Effect.fail(ReviewRefused.conflict(`Can't review: ${why}`)) : Effect.succeed(null))

export interface ReviewsShape {
  /**
   * Review a task's work. `manual` (the user's Review now) reviews even when the project doesn't review automatically or
   * the commit was already reviewed, and says why when it can't (`ReviewRefused`). The task, or null with nothing to do.
   */
  readonly start: (task: TaskId, manual: boolean) => Effect.Effect<Task | null, ReviewRefused | SendRefused | TaskNotFound>
  /** A task entered In review (or a run of it ended there): review it if a review is due. Safe to call at any time. */
  readonly reconcile: (task: TaskId) => Effect.Effect<void>
  /** `submit_review` from a reviewer's run: its verdict, acted on when its run ends. */
  readonly submit: (thread: Task, run: RunId, args: Submitted) => Effect.Effect<{ readonly ok: boolean; readonly note: string }, ReviewRefused>
  /** A review or summary thread's run ended: its part of the review (or its summary) ends; the last part acts on the review. */
  readonly finished: (thread: TaskId, run: RunId, outcome: Outcome, attention: string | null) => Effect.Effect<void>
  /** The task's agent started a prompt run: the review and summaries in progress are out of date and stop. */
  readonly supersede: (task: TaskId) => Effect.Effect<void>
  /** The user's Stop: the task's agent, its review and its summaries. Whether any was going. */
  readonly stopTask: (task: TaskId) => Effect.Effect<{ readonly stopped: boolean }>
  /** Give a task out of rounds of fixes as many again (at least one): its agent is sent the issues once more. */
  readonly extend: (task: TaskId) => Effect.Effect<Task, ReviewRefused | SendRefused | TaskNotFound>
  /** Startup: reviews and summaries a stopped server left running whose threads have no run going end as their runs did. */
  readonly reconcileAll: Effect.Effect<void>
}

export class Reviews extends Context.Service<Reviews, ReviewsShape>()("huntaway-server/review/Reviews") {
  static readonly layer = Layer.effect(
    Reviews,
    Effect.gen(function* () {
      const db = yield* Db
      const locks = yield* KeyedLock
      const tasks = yield* TaskRepo
      const projects = yield* ProjectRepo
      const profiles = yield* ProfileRepo
      const configs = yield* AgentConfigRepo
      const facts = yield* LaunchFacts
      const git = yield* Git
      const taskBase = yield* TaskBase
      const runs = yield* Runs
      const runRepo = yield* RunRepo
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const meter = yield* ContextMeter
      const repo = yield* ReviewRepo
      const stats = yield* ReviewStats
      const summaries = yield* Summaries
      const config = yield* ServerConfig
      const random = yield* SecureRandom.SecureRandom
      const w: Writes = { db, locks, tasks, events: yield* Events, changes: yield* Changes }

      const notice = (id: TaskId, level: "info" | "warning" | "error", text: string, detail?: string | null) =>
        threads.notice(id, level, text, detail ?? undefined).pipe(Effect.ignore)

      /**
       * Whether the agent of a task whose branch has no commits of its own changed code anywhere since its last finished
       * review: it edited files, committed, pushed, opened a pull request or wrote files from the shell. Uncommitted
       * changes in the worktree count too, and before the first review, a pull request on the task.
       */
      const changedElsewhere = Effect.fnUntraced(function* (task: Task, dir: string, previous: Review | null) {
        const since = previous !== null && (previous.state === "passed" || previous.state === "issues") ? previous.updated_at : null
        if ((yield* readers.toolCallsSince(task.id, since)).some((c) => changesCode(c.call, c.result))) return true
        if (since === null && task.pr_url !== null && task.pr_url.trim() !== "") return true
        const o = yield* git.run(dir, ["status", "--porcelain"]).pipe(Effect.orElseSucceed(() => null))
        return o !== null && o.ok && o.stdout.trim() !== ""
      })

      /**
       * End `thread`'s part of the review in progress with `end`: the part of run `run` if given (a later round's run only),
       * else the thread's. The review once that was the last part to finish, combined, for the caller to act on.
       */
      const endThreadPart = Effect.fnUntraced(function* (
        parent: TaskId,
        thread: TaskId,
        run: RunId | null,
        end: (p: ReviewerRun) => Pick<ReviewerRun, "state" | "summary">,
      ) {
        const ended = yield* changeTaskWith(w, parent, (task) =>
          Effect.gen(function* () {
            const r = inProgress(task.review, thread)
            const part = r?.reviewers.find((p) => p.thread_id === thread)
            if (r === null || part === undefined) return null
            if (run !== null && !(yield* repo.runAfter(thread, run, part.after_run))) return null
            const next = endPart(r, thread, end, yield* nowTimestamp)
            return next === null ? null : ([{ review: next }, next] as const)
          }),
        )
        return ended === null || ended.value.state === "running" ? null : { task: ended.after, review: ended.value }
      })

      /** Ask the task's agent to fix what the review found, if it waits in In review with rounds left; else leave it for the user. */
      const sendIssues = Effect.fnUntraced(function* (id: TaskId, review: Review) {
        const task = yield* tasks.get(id)
        if (task === null) return
        const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
        const running = task.running || (yield* runs.isRunning(id))
        const decision = decideIssues({ status: task.status, running }, review, project?.review_rounds ?? 0)
        if (decision._tag === "MovedOn") {
          // The user (or the agent) has moved on; the findings are left for them.
          yield* notice(id, "warning", found(review), listed(review))
          return
        }
        if (decision._tag === "OutOfRounds") {
          yield* notice(id, "warning", found(review), listed(review))
          yield* writeTask(w, id, { status: "needs_attention", attention_reason: decision.reason })
          return
        }
        yield* writeTask(w, id, { review: decision.review })
        const sent = yield* Effect.exit(
          runs.send(id, {
            text: reviewFixes(decision.review.issues, decision.review.reviewers.length),
            source: "board",
            auto: true,
            review_round: decision.review.fixes,
          }),
        )
        if (Exit.isFailure(sent)) yield* notice(id, "error", "Couldn't send the review's issues to the agent", failureText(sent.cause))
      })

      /** Every reviewer has finished: act on their combined review. */
      const act = Effect.fnUntraced(function* (task: Task, review: Review) {
        if (review.state === "passed") {
          yield* notice(task.id, "info", "Review passed", review.summary)
          yield* summaries.reviewPassed(task.id)
        } else if (review.state === "issues") yield* sendIssues(task.id, review)
        else yield* notice(task.id, "warning", "Review didn't finish", review.summary)
      })

      const startLocked = Effect.fnUntraced(function* (id: TaskId, manual: boolean) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const project = task.project_id !== null && task.kind === "task" ? Option.getOrNull(yield* projects.get(task.project_id)) : null
        if (project === null) return yield* skip(manual, "only tasks in a project can be reviewed")
        // What's read of the work below is what this run left, unless another starts meanwhile: read before the check
        // that none is running, so one that starts in between counts as later.
        const lastRun = yield* repo.latestRun(task.id)
        // A task its agent moved to In review mid-run is reviewed when the run ends.
        if (yield* runs.isRunning(task.id)) return yield* skip(manual, "the agent is still working; its changes are reviewed when it finishes")
        // A project that uses workflows has them review its tasks instead, as steps of theirs (HA-277).
        if (!manual && (!project.auto_review || project.use_workflows)) return null
        if (config.noAgents) return yield* skip(manual, "this host can't run agents")
        const dir = task.worktree_state === "ready" ? task.worktree_path : null
        const branch = task.branch
        if (dir === null || branch === null) return yield* skip(manual, "the task has no worktree branch to review")
        const previous = task.review
        if (previous?.state === "running") return yield* skip(manual, "a review is already running")
        const head = yield* revParse(git, dir, "HEAD")
        if (head === null) return yield* ReviewRefused.invalid("couldn't read the worktree's HEAD commit")
        const work = yield* readWork(git, taskBase, dir, task, project, head)
        // Without commits of its own, the head doesn't change when the agent fixes the issues found elsewhere, so it's
        // reviewed again after a round of fixes (review_rounds still caps those).
        const done = work.elsewhere ? ["passed"] : ["passed", "issues"]
        const reviewed = previous !== null && previous.head === head && done.includes(previous.state)
        if (reviewed && !manual) return null
        if (work.elsewhere && !manual && !(yield* changedElsewhere(task, dir, previous))) {
          yield* notice(
            task.id,
            "info",
            "Not reviewed: no code changes",
            "The branch has no commits of its own, and the agent didn't edit files, commit, push or open a pull request. Use Review now to review it anyway.",
          )
          return null
        }

        // Each reviewer reviews in its own thread, kept from one review to the next.
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const specs = reviewersFor(project, profile)
        const taskConfig = yield* facts.config(task)
        // Summary and workflow threads aren't reviewers'.
        const existing = (yield* tasks.reviewThreads(task.id)).filter(isReviewer)
        const parts: Array<ReviewerRun> = []
        // What each reviewer looks for: its own instructions, else the project's.
        const instructions: Array<string> = []
        for (const spec of specs) {
          // A reviewer whose config was deleted reviews with the task's.
          const own = spec.claude_config_id === null ? null : Option.getOrNull(yield* configs.get(spec.claude_config_id))
          const cfg = own ?? taskConfig
          const configId = cfg?.id ?? null
          const model = nonBlank(spec.model)
          const effort = nonBlank(spec.effort)
          const lbl = label(cfg?.name ?? null, model, effort)
          const at = existing.findIndex((t) => same(t.claude_config_id, configId) && same(t.model, model) && same(t.effort, effort))
          let thread: Task | null = at >= 0 ? (existing.splice(at, 1)[0] ?? null) : null
          if (thread === null) {
            const threadId = TaskId.make(yield* random.uuidV4())
            yield* repo.insertThread(
              threadId,
              {
                profile_id: task.profile_id,
                project_id: project.id,
                parent_id: task.id,
                task_type: null,
                title: specs.length > 1 ? `Review of ${task.key} (${lbl})` : `Review of ${task.key}`,
                description: "",
                model,
                effort,
                claude_config_id: configId,
              },
              yield* nowTimestamp,
            )
            thread = yield* tasks.get(threadId)
            if (thread === null) return yield* new TaskNotFound({ id: threadId })
            yield* w.events.emit({ type: "task", task: thread })
          }
          if (yield* runs.isRunning(thread.id)) {
            return yield* ReviewRefused.conflict(`the review thread's agent (${lbl}) is busy; wait for it to finish or stop it`)
          }
          const afterRun = (yield* repo.latestRun(thread.id)) ?? RunId.make("")
          const skills = spec.skills ?? []
          yield* repo.setSkills(thread.id, skills)
          instructions.push(reviewerInstructions(project, spec) + reviewSkills(skills, cfg?.agent === "codex"))
          parts.push({ thread_id: thread.id, label: lbl, state: "running", summary: null, issues: [], after_run: afterRun })
        }
        const first = parts[0]
        if (first === undefined) return null

        // Issues the agent was asked to fix are checked again; a review the user asked for starts a fresh round of fixes.
        const fixed = previous?.state === "issues" ? previous.issues : []
        const at = yield* nowTimestamp
        const review: Review = {
          thread_id: first.thread_id,
          state: "running",
          head,
          summary: null,
          issues: [],
          fixes: manual ? 0 : (previous?.fixes ?? 0),
          extra_rounds: manual ? 0 : (previous?.extra_rounds ?? 0),
          updated_at: at,
          started_at: at,
          reviewers: parts,
        }
        // The agent may have started again while git was read: `supersede` found no review to stop then, so this one
        // would review work that's changing, or has changed since it was read if that run has ended too. Once this is
        // recorded, a run that starts has it to stop.
        const recorded = yield* changeTask(w, task.id, () =>
          Effect.gen(function* () {
            if ((yield* repo.laterRun(task.id, lastRun)) || (yield* runs.isRunning(task.id))) return null
            return { review }
          }),
        )
        if (recorded === null) return yield* skip(manual, "the agent is working again; its changes are reviewed when it finishes")
        const commit = head.slice(0, 10)
        const where: ReviewWork = work.elsewhere
          ? { kind: "elsewhere", last_message: yield* readers.lastAssistantText(task.id) }
          : { kind: "branch", own_start: work.ownStart }
        const replies = yield* readers.userReplies(task.id, REPLIES)
        let started = 0
        let failed: Exit.Exit<Task, SendRefused | TaskNotFound> | null = null
        for (const [i, part] of parts.entries()) {
          const text = reviewPrompt({
            key: task.key,
            title: task.title,
            description: task.description,
            pr_url: task.pr_url,
            branch,
            base: work.base,
            commit,
            work: where,
            fixed,
            replies,
            instructions: instructions[i] ?? "",
          })
          // Each review starts from a clean slate; the thread keeps every round's messages.
          yield* writeTask(w, part.thread_id, { session_id: null })
          yield* meter.clear(part.thread_id)
          // A reviewer of a review `supersede` has stopped doesn't start.
          if (inProgress((yield* tasks.get(task.id))?.review ?? null, part.thread_id) === null) return yield* tasks.get(task.id)
          yield* notice(part.thread_id, "info", `Reviewing commit ${commit}`)
          const sent = yield* Effect.exit(runs.send(part.thread_id, { text, source: "board", auto: true, review: true }))
          if (Exit.isSuccess(sent)) {
            started += 1
            // One that started as `supersede` stopped the review is stopped with it.
            if (inProgress((yield* tasks.get(task.id))?.review ?? null, part.thread_id) === null) yield* runs.stop(part.thread_id)
            continue
          }
          const why = `Couldn't start the review: ${failureText(sent.cause)}`
          const ended = yield* endThreadPart(task.id, part.thread_id, null, () => ({ state: "failed", summary: why }))
          // The others have already finished.
          if (ended !== null && started > 0) yield* act(ended.task, ended.review)
          failed ??= sent
        }
        if (failed !== null && started === 0) return yield* failed
        const who = parts.length > 1 ? ` with ${parts.length} reviewers` : ""
        yield* notice(task.id, "info", `Reviewing the changes (commit ${commit})${who}`)
        if ((task.status === "in_progress" || task.status === "needs_attention") && !task.merging) {
          // A task under review sits in In review (one reviewed again from Needs attention after its rounds of fixes,
          // say), so the issues found can go back to its agent. Unless its agent has started again since (stopping the
          // review): its column is that run's.
          yield* changeTask(w, task.id, () =>
            Effect.map(repo.laterRun(task.id, lastRun), (later) => (later ? null : { status: "in_review" as const, attention_reason: null })),
          )
        }
        return yield* tasks.get(task.id)
      })

      const start = Effect.fn("Reviews.start")(function* (id: TaskId, manual: boolean) {
        return yield* locks.withLock(["review", id])(startLocked(id, manual))
      })

      /** Stop the task's review in progress, if there is one, saying `why`. Whether there was. */
      const stopReviewOf = Effect.fnUntraced(function* (id: TaskId, why: string) {
        const stopped = yield* changeTaskWith(w, id, (task) =>
          Effect.map(nowTimestamp, (at) => {
            const done = stopReview(task.review, why, at)
            return done === null ? null : ([{ review: done.review }, done.running] as const)
          }),
        )
        const running = stopped?.value ?? []
        for (const thread of running) yield* runs.stop(thread)
        return running.length > 0
      })

      const finished = Effect.fn("Reviews.finished")(function* (threadId: TaskId, run: RunId, outcome: Outcome, attention: string | null) {
        const thread = yield* tasks.get(threadId)
        if (thread === null || thread.kind !== "review" || thread.parent_id === null) return
        // A workflow's agent step is the workflow engine's (6.6).
        if (thread.task_type === "workflow") return
        if (thread.task_type === "summary") {
          yield* summaries.finished(thread, run, outcome, attention)
          return
        }
        const ended = yield* endThreadPart(thread.parent_id, thread.id, run, reviewerEnd(outcome, attention))
        if (ended !== null) yield* act(ended.task, ended.review)
      })

      const submit = Effect.fn("Reviews.submit")(function* (thread: Task, run: RunId, args: Submitted) {
        if (thread.kind !== "review") return yield* ReviewRefused.invalid("submit_review is only for review threads")
        const parent = thread.parent_id
        if (parent === null) return yield* ReviewRefused.conflict("no review is in progress, so there's nothing to submit")
        const recorded = yield* changeTask(w, parent, (task) =>
          Effect.gen(function* () {
            const r = inProgress(task.review, thread.id)
            const part = r?.reviewers.find((p) => p.thread_id === thread.id)
            if (r === null || part === undefined) return yield* ReviewRefused.conflict("no review is in progress, so there's nothing to submit")
            // From a run of an earlier round (a call retried late, say): this round isn't its.
            if (!(yield* repo.runAfter(thread.id, run, part.after_run))) {
              return yield* ReviewRefused.conflict("the review this run was asked for has ended, so there's nothing to submit")
            }
            const s = submission(args)
            const at = yield* nowTimestamp
            yield* stats.record(
              {
                task_id: task.id,
                thread_id: thread.id,
                round: r.started_at ?? r.updated_at,
                run_id: run,
                verdict: s.verdict,
                serious: s.issues.length,
                minor: s.minor === null ? 0 : s.minor.length,
                summary: s.summary,
                label: part.label,
              },
              at,
            )
            return { review: submitted(r, thread.id, s, at) }
          }),
        )
        if (recorded === null) return yield* ReviewRefused.conflict("no review is in progress, so there's nothing to submit")
        return { ok: true, note: RECORDED }
      })

      const extend = Effect.fn("Reviews.extend")(function* (id: TaskId) {
        const extended = yield* changeTaskWith(w, id, (task) =>
          Effect.gen(function* () {
            const project = task.project_id !== null && task.kind === "task" ? Option.getOrNull(yield* projects.get(task.project_id)) : null
            if (project === null) return yield* ReviewRefused.conflict("only tasks in a project are reviewed")
            const running = task.running || (yield* runs.isRunning(task.id))
            const decision = decideExtend({ status: task.status, merging: task.merging, review: task.review, running }, project.review_rounds)
            if (decision._tag === "Refused") return yield* ReviewRefused.conflict(decision.reason)
            return [{ review: decision.review }, { before: task.review, given: decision }] as const
          }),
        )
        if (extended === null) return yield* new TaskNotFound({ id })
        const { before, given } = extended.value
        const sent = yield* Effect.exit(
          runs.send(id, {
            text: reviewFixes(given.review.issues, given.review.reviewers.length),
            source: "board",
            auto: true,
            review_round: given.review.fixes,
          }),
        )
        if (Exit.isSuccess(sent)) {
          yield* notice(id, "info", `Given ${given.more === 1 ? "another round of fixes" : `${given.more} more rounds of fixes`}`)
          return sent.value
        }
        // Unless something changed it meanwhile, it's as it was, so it can be tried again.
        yield* changeTask(w, id, (task) =>
          Effect.succeed(
            task.review !== null &&
              task.review.fixes === given.review.fixes &&
              task.review.extra_rounds === given.review.extra_rounds &&
              task.review.updated_at === given.review.updated_at
              ? { review: before }
              : null,
          ),
        )
        return yield* sent
      })

      const reconcileAll = Effect.gen(function* () {
        for (const id of yield* repo.unsettled) {
          yield* Effect.gen(function* () {
            const task = yield* tasks.get(id)
            const review = task?.review ?? null
            if (review !== null && review.state === "running") {
              for (const part of review.reviewers.filter((p) => p.state === "running")) {
                if (yield* runs.isRunning(part.thread_id)) continue
                const latest = yield* repo.latestRun(part.thread_id)
                const ran = latest !== null && (yield* repo.runAfter(part.thread_id, latest, part.after_run))
                const row = ran && latest !== null ? Option.getOrNull(yield* runRepo.get(latest)) : null
                if (row !== null) yield* finished(part.thread_id, row.id, recoveredOutcome(row), row.attention)
                else {
                  const ended = yield* endThreadPart(id, part.thread_id, null, () => ({
                    state: "failed",
                    summary: "Couldn't start the review: the server stopped first",
                  }))
                  if (ended !== null) yield* act(ended.task, ended.review)
                }
              }
            }
            yield* summaries.recover(id)
          }).pipe(Effect.catchCause((cause) => Effect.logError(`task=${id} settling a review the server stopped during`, cause)))
        }
      }).pipe(Effect.withSpan("Reviews.reconcileAll"))

      return Reviews.of({
        start,
        reconcile: (id) =>
          start(id, false).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const why = failureText(cause)
                yield* Effect.logWarning(`task=${id} couldn't start a review: ${why}`)
                yield* notice(id, "warning", "Couldn't start the review", why)
              }),
            ),
          ),
        submit,
        finished,
        supersede: Effect.fn("Reviews.supersede")(function* (id: TaskId) {
          const why = "Stopped because the agent started working on the task again."
          yield* stopReviewOf(id, why)
          yield* summaries.stop(id, true)
        }),
        stopTask: Effect.fn("Reviews.stopTask")(function* (id: TaskId) {
          const agent = (yield* runs.stop(id)).stopped
          const reviewing = yield* stopReviewOf(id, "Stopped by the user.")
          if (reviewing) yield* notice(id, "warning", "Review stopped")
          const summarising = yield* summaries.stop(id, false)
          return { stopped: agent || reviewing || summarising }
        }),
        extend,
        reconcileAll,
      })
    }),
  )
}
