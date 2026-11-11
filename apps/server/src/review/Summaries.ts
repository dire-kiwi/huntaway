import { Context, Effect, Exit, Layer, Option } from "effect"
import { RunId, TaskId } from "@huntaway/contracts"
import type { AgentConfigId, ChangeSummary, Reviewer, Task } from "@huntaway/contracts"
import { SecureRandom } from "effect/crypto"
import { ContextMeter } from "../agents/ContextMeter.ts"
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
import { summary as summaryPrompt } from "../prompts/summary.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import type { Outcome } from "../runs/Run.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import {
  failureText,
  isSummary,
  label,
  nonBlank,
  recoveredOutcome,
  ReviewRefused,
  same,
  stopSummaries,
  SUMMARY,
  summarizersFor,
  summaryEnd,
  variantKey,
} from "./model.ts"
import { ReviewRepo } from "./ReviewRepo.ts"
import { changeTask, changeTaskWith, writeTask } from "./taskWrites.ts"
import type { Writes } from "./taskWrites.ts"
import { readWork, revParse } from "./work.ts"

// Summaries of a task's changes (docs/plan/inventory/04-git-review.md 2.13; huntaway's review/summary.ts). Once a
// task's review passes, each of the project's summarizers (else its profile's, else one with the task's config) reads
// the work and writes a summary of what changed for the user to read before merging it. It works read-only in the
// task's worktree, in a thread of its own: a `review` thread of type `summary` under the task, run like a reviewer but
// not one of its reviewers. Its last message is the summary, kept in the task's `summaries` with the commit it
// describes. A summary in progress is stopped when the task's agent starts working again.

const skip = (manual: boolean, why: string) => (manual ? Effect.fail(ReviewRefused.conflict(`Can't summarise: ${why}`)) : Effect.succeed(null))

/** The summaries' threads, in order, to tell whether summarizers were taken out or reordered. */
const threadIds = (all: ReadonlyArray<ChangeSummary>) => all.map((s) => s.thread_id).join(" ")

/** What a summary's start needs to know of one summarizer. */
interface Plan {
  readonly spec: Reviewer
  /** Its agent is Codex, which is asked for skills differently. */
  readonly codex: boolean
  readonly configId: AgentConfigId | null
  readonly model: string | null
  readonly effort: string | null
  /** What tells its thread from the others' with the same agent (`variantKey`). */
  readonly variant: string
  readonly label: string
}

export interface SummariesShape {
  /**
   * Summarise a task's changes. `manual` (the user asked) summarises whatever its review and column, and even a commit
   * already summarised, and says why when it can't (`ReviewRefused`). The task, or null when there was nothing to do.
   */
  readonly start: (task: TaskId, manual: boolean) => Effect.Effect<Task | null, ReviewRefused | SendRefused | TaskNotFound>
  /** The task's review passed: summarise its changes, if its project wants that; a failure is told in its thread. */
  readonly reviewPassed: (task: TaskId) => Effect.Effect<void>
  /** A summary thread's run ended: its last message since it was asked is the summary. */
  readonly finished: (thread: Task, run: RunId, outcome: Outcome, attention: string | null) => Effect.Effect<void>
  /** The task's agent started working again (`superseded`) or the user stopped it: stop the summaries being written. */
  readonly stop: (task: TaskId, superseded: boolean) => Effect.Effect<boolean>
  /** Summaries a stopped server left running whose thread has no run going: ended as their runs did (Recovery). */
  readonly recover: (task: TaskId) => Effect.Effect<void>
}

export class Summaries extends Context.Service<Summaries, SummariesShape>()("huntaway-server/review/Summaries") {
  static readonly layer = Layer.effect(
    Summaries,
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
      const threads = yield* Threads
      const readers = yield* ThreadReaders
      const meter = yield* ContextMeter
      const repo = yield* ReviewRepo
      const runRepo = yield* RunRepo
      const config = yield* ServerConfig
      const random = yield* SecureRandom.SecureRandom
      const w: Writes = { db, locks, tasks, events: yield* Events, changes: yield* Changes }

      const setSummaries = (id: TaskId, summaries: ReadonlyArray<ChangeSummary>) => writeTask(w, id, { summaries })
      const notice = (id: TaskId, level: "info" | "warning" | "error", text: string, detail?: string | null) =>
        threads.notice(id, level, text, detail ?? undefined).pipe(Effect.ignore)

      const startLocked = Effect.fnUntraced(function* (id: TaskId, manual: boolean) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const project = task.project_id !== null && task.kind === "task" ? Option.getOrNull(yield* projects.get(task.project_id)) : null
        if (project === null) return yield* skip(manual, "only tasks in a project have their changes summarised")
        // Only a review that has passed (and the task's agent hasn't gone back to work since).
        if (!manual && (!project.auto_summary || project.use_workflows || task.review?.state !== "passed" || task.status !== "in_review")) return null
        const lastRun = yield* repo.latestRun(task.id)
        if (yield* runs.isRunning(task.id)) return yield* skip(manual, "the agent is still working")
        if (config.noAgents) return yield* skip(manual, "this host can't run agents")
        const dir = task.worktree_state === "ready" ? task.worktree_path : null
        const branch = task.branch
        if (dir === null || branch === null) return yield* skip(manual, "the task has no worktree branch to summarise")
        const previous = task.summaries
        if (previous.some((s) => s.state === "running")) return yield* skip(manual, "a summary is already being written")
        const head = yield* revParse(git, dir, "HEAD")
        if (head === null) return yield* ReviewRefused.invalid("couldn't read the worktree's HEAD commit")
        // What the reviewers had as its work, too.
        const work = yield* readWork(git, taskBase, dir, task, project, head)

        // Each summarizer writes in a thread of its own, kept while its config, model, effort, name, skills and prompt stay the same.
        const taskConfig = yield* facts.config(task)
        const profile = Option.getOrNull(yield* profiles.get(task.profile_id))
        const plans: Array<Plan> = []
        for (const spec of summarizersFor(project, profile)) {
          // A summarizer whose config was deleted writes with the task's.
          const own = spec.claude_config_id === null ? null : Option.getOrNull(yield* configs.get(spec.claude_config_id))
          const cfg = own ?? taskConfig
          const configId = cfg?.id ?? null
          const model = nonBlank(spec.model)
          const effort = nonBlank(spec.effort)
          const variant = variantKey(spec)
          // Two the same would share a thread.
          if (plans.some((p) => same(p.configId, configId) && same(p.model, model) && same(p.effort, effort) && p.variant === variant)) continue
          plans.push({ spec, codex: cfg?.agent === "codex", configId, model, effort, variant, label: label(cfg?.name ?? null, model, effort) })
        }
        const existing = (yield* tasks.reviewThreads(task.id)).filter(isSummary)
        const writing: Array<readonly [Plan, Task]> = []
        const summaries: Array<ChangeSummary> = []
        for (const plan of plans) {
          const name = plan.spec.name?.trim() ?? ""
          const title = name !== "" ? `Summary of ${task.key} · ${name}` : `Summary of ${task.key}`
          let thread =
            existing.find(
              (t) => same(t.claude_config_id, plan.configId) && same(t.model, plan.model) && same(t.effort, plan.effort) && t.description === plan.variant,
            ) ?? null
          if (thread === null) {
            const threadId = TaskId.make(yield* random.uuidV4())
            const at = yield* nowTimestamp
            yield* repo.insertThread(
              threadId,
              {
                profile_id: task.profile_id,
                project_id: project.id,
                parent_id: task.id,
                task_type: SUMMARY,
                title,
                description: plan.variant,
                model: plan.model,
                effort: plan.effort,
                claude_config_id: plan.configId,
              },
              at,
            )
            thread = yield* tasks.get(threadId)
            if (thread === null) return yield* new TaskNotFound({ id: threadId })
            yield* w.events.emit({ type: "task", task: thread })
          }
          // Already summarised at this commit, and not asked for again.
          if (!manual) {
            const done = previous.find((s) => s.thread_id === thread?.id && s.state === "done" && s.head === head)
            if (done !== undefined) {
              summaries.push(done)
              continue
            }
          }
          if (thread.title !== title) yield* writeTask(w, thread.id, { title })
          if (yield* runs.isRunning(thread.id)) {
            return yield* ReviewRefused.conflict(`the summary thread's agent (${plan.label}) is busy; wait for it to finish or stop it`)
          }
          const lastOfThread = (yield* repo.latestRun(thread.id)) ?? RunId.make("")
          const skills = plan.spec.skills ?? []
          // The board's skills it names are on in its thread, whether or not they are for the project.
          yield* repo.setSkills(thread.id, skills)
          const nm = nonBlank(plan.spec.name)
          summaries.push({
            thread_id: thread.id,
            label: plan.label,
            ...(nm !== null ? { name: nm } : {}),
            ...(skills.length > 0 ? { skills: [...skills] } : {}),
            ...(plan.spec.prompt !== undefined ? { custom_prompt: true } : {}),
            state: "running",
            head,
            text: null,
            after_run: lastOfThread,
            updated_at: yield* nowTimestamp,
          })
          writing.push([plan, thread])
        }
        if (writing.length === 0) {
          // Nothing to write, but summarizers taken out or reordered since change which summaries it has.
          if (threadIds(summaries) !== threadIds(previous)) yield* setSummaries(task.id, summaries)
          return null
        }
        const commit = head.slice(0, 10)
        const lastMessage = work.elsewhere ? yield* readers.lastAssistantText(task.id) : null
        const texts: Array<string> = []
        for (const [plan, thread] of writing) {
          texts.push(
            summaryPrompt({
              key: task.key,
              title: task.title,
              description: task.description,
              pr_url: task.pr_url,
              review: task.review?.summary ?? null,
              branch,
              base: work.base,
              commit,
              elsewhere: work.elsewhere,
              own_start: work.ownStart,
              last_message: lastMessage,
              prompt: plan.spec.prompt ?? null,
              skills: plan.spec.skills ?? [],
              codex: plan.codex,
            }),
          )
          // A fresh conversation for each summary; the thread keeps every one's messages.
          yield* writeTask(w, thread.id, { session_id: null })
          yield* meter.clear(thread.id)
        }
        // The agent may have started again meanwhile (and found no summary to stop): recorded only if it hasn't.
        const recorded = yield* changeTask(w, task.id, () =>
          Effect.gen(function* () {
            if ((yield* repo.laterRun(task.id, lastRun)) || (yield* runs.isRunning(task.id))) return null
            return { summaries }
          }),
        )
        if (recorded === null) return yield* skip(manual, "the agent is working again")
        const sent: Array<Exit.Exit<Task, SendRefused | TaskNotFound>> = []
        for (const [i, [, thread]] of writing.entries()) {
          yield* notice(thread.id, "info", `Summarising commit ${commit}`)
          sent.push(yield* Effect.exit(runs.send(thread.id, { text: texts[i] ?? "", source: "board", auto: true, review: true })))
        }
        // Those that couldn't start have failed.
        const failed = new Map<TaskId, string>()
        writing.forEach(([, t], i) => {
          const r = sent[i]
          if (r !== undefined && Exit.isFailure(r)) failed.set(t.id, failureText(r.cause))
        })
        if (failed.size > 0) {
          const at = yield* nowTimestamp
          yield* changeTask(w, task.id, (t) =>
            Effect.succeed({
              summaries: t.summaries.map((s) => {
                const why = failed.get(s.thread_id)
                return why === undefined || s.state !== "running"
                  ? s
                  : { ...s, state: "failed" as const, text: `Couldn't start the summary: ${why}`, updated_at: at }
              }),
            }),
          )
        }
        const first = sent.find(Exit.isFailure)
        if (first !== undefined && sent.every(Exit.isFailure)) return yield* first
        yield* notice(task.id, "info", `Summarising the changes (commit ${commit})`)
        return yield* tasks.get(task.id)
      })

      const start = Effect.fn("Summaries.start")(function* (id: TaskId, manual: boolean) {
        return yield* locks.withLock(["summary", id])(startLocked(id, manual))
      })

      const finished = Effect.fn("Summaries.finished")(function* (thread: Task, run: RunId, outcome: Outcome, attention: string | null) {
        const parentId = thread.parent_id
        if (parentId === null) return
        const ended = yield* changeTaskWith(w, parentId, (parent) =>
          Effect.gen(function* () {
            const summary = parent.summaries.find((s) => s.state === "running" && s.thread_id === thread.id)
            if (summary === undefined) return null
            // From an earlier run of the thread (one stopped late, say): this summary isn't its.
            if (!(yield* repo.runAfter(thread.id, run, summary.after_run))) return null
            // What it said after it was asked for this summary.
            const written = outcome._tag === "Ok" && attention === null ? yield* readers.saidSinceAsked(thread.id) : null
            const done: ChangeSummary = Object.assign({}, summary, summaryEnd(outcome, attention, written), { updated_at: yield* nowTimestamp })
            const columns = { summaries: parent.summaries.map((s) => (s.thread_id === thread.id ? done : s)) }
            return [columns, { done, several: parent.summaries.length > 1 }] as const
          }),
        )
        if (ended === null) return
        const { done, several } = ended.value
        // With several, the event says whose it is.
        const title = (what: string) => (several ? `${what} (${done.label})` : what)
        if (done.state === "done") yield* notice(parentId, "info", title("Changes summarised"))
        else if (done.state !== "stopped") yield* notice(parentId, "warning", title("Couldn't summarise the changes"), done.text)
      })

      const stop = Effect.fn("Summaries.stop")(function* (id: TaskId, superseded: boolean) {
        const why = superseded ? "Stopped because the agent started working on the task again." : "Stopped by the user."
        const stopped = yield* changeTaskWith(w, id, (task) =>
          Effect.map(nowTimestamp, (at) => {
            const done = stopSummaries(task.summaries, why, at)
            return done === null ? null : ([{ summaries: done.summaries }, done.running] as const)
          }),
        )
        const running = stopped?.value ?? []
        for (const thread of running) yield* runs.stop(thread)
        return running.length > 0
      })

      const recover = Effect.fn("Summaries.recover")(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return
        for (const s of task.summaries.filter((x) => x.state === "running")) {
          const thread = yield* tasks.get(s.thread_id)
          if (thread === null || (yield* runs.isRunning(s.thread_id))) continue
          const latest = yield* repo.latestRun(s.thread_id)
          const ran = latest !== null && (yield* repo.runAfter(s.thread_id, latest, s.after_run))
          const run = ran && latest !== null ? Option.getOrNull(yield* runRepo.get(latest)) : null
          if (run !== null) yield* finished(thread, run.id, recoveredOutcome(run), run.attention)
          else {
            yield* changeTask(w, id, (t) =>
              Effect.gen(function* () {
                const at = yield* nowTimestamp
                return {
                  summaries: t.summaries.map((x) =>
                    x.thread_id === s.thread_id && x.state === "running"
                      ? { ...x, state: "failed" as const, text: "Couldn't start the summary: the server stopped first", updated_at: at }
                      : x,
                  ),
                }
              }),
            )
          }
        }
      })

      return Summaries.of({
        start,
        reviewPassed: (id) =>
          start(id, false).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const why = failureText(cause)
                yield* Effect.logWarning(`task=${id} couldn't start a summary: ${why}`)
                yield* notice(id, "warning", "Couldn't summarise the changes", why)
              }),
            ),
          ),
        finished,
        stop,
        recover,
      })
    }),
  )
}
