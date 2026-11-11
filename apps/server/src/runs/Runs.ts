import { Cause, Clock, Context, Effect, Exit, Fiber, FiberMap, FileSystem, Layer, Option, Ref, Schedule, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { DocumentLabel, RunId, threadKindOf } from "@huntaway/contracts"
import type { NewTask, ProjectId, Task, TaskId, Timestamp } from "@huntaway/contracts"
import { ContextMeter } from "../agents/ContextMeter.ts"
import { planRest, startInstructions } from "../agents/prompts/start.ts"
import { worthAsking } from "../agents/titles/text.ts"
import { Titles } from "../agents/Titles.ts"
import { Checkpoints } from "../git/Checkpoints.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { Usage } from "../profiles/Usage.ts"
import { isResetDue } from "../profiles/usage/limits.ts"
import { Actor, Changes } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { deriveColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { Dependencies, isMerged } from "../tasks/Dependencies.ts"
import { activeMerge, mergeLane, stackWaits } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import type { WriteNo } from "../threads/model.ts"
import { LaunchFacts } from "./LaunchFacts.ts"
import { combine, decideSend, isCompact, newCommand, rowOf } from "./queue.ts"
import type { Outgoing, Refusal, Take } from "./queue.ts"
import type { Run, RunKind } from "./Run.ts"
import { AgentRequests } from "./AgentRequests.ts"
import { BackgroundWork } from "./BackgroundWork.ts"
import { formatSupport, RunDir } from "./RunDir.ts"
import { RunFollower } from "./RunFollower.ts"
import { BackgroundRefused, RunInput } from "./RunInput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Shim } from "./Shim.ts"

// The commands on a thread's agent (docs/plan/07-agents.md, The run, Starting; inventory 01, section 2, "Starting a
// run", "Messages while a run is live", "Stopping", "Gates"; huntaway's runner.ts, runner/send.ts, runner/queue.ts).
// Each takes the task's lock, decides with a plain function (`decideSend`), and commits in one transaction. Starting a
// run has two parts: registering it (one transaction: the run, the queue it takes, the thread items that explain it,
// the task's columns), then launching it, a fiber per task that prepares its folder, starts its shim and hands it to
// the follower. A stop while it is being prepared interrupts that fiber.

/** The message can't be sent (`Refusal` says why). */
export class SendRefused extends Schema.TaggedError<SendRefused, { readonly brand: unique symbol }>()("SendRefused", {
  reason: Schema.Literals(["archived", "merge_queued", "no_agents", "already_running", "no_conversation", "nothing_queued", "agent_running"]),
  detail: Schema.String,
}) {}

/** A task can't wait for its usage limit's reset (`invalid`: it isn't a task). */
export class WaitRefused extends Schema.TaggedError<WaitRefused, { readonly brand: unique symbol }>()("WaitRefused", {
  reason: Schema.String,
  invalid: Schema.Boolean,
}) {}

const refused = (r: Refusal): SendRefused => {
  if (r._tag === "Archived") {
    return new SendRefused({ reason: "archived", detail: `the project "${r.project}" is archived; unarchive it in the board's settings to run its agents` })
  }
  if (r._tag === "MergeQueued") {
    return new SendRefused({
      reason: "merge_queued",
      detail: `this task is queued to merge after "${r.after}"; move it out of Ready for merge to talk to its agent now`,
    })
  }
  if (r._tag === "NoAgents") return new SendRefused({ reason: "no_agents", detail: "This host doesn't run agents (it was started with --no-agents)" })
  if (r._tag === "AlreadyRunning") return new SendRefused({ reason: "already_running", detail: "an agent is already running on this thread" })
  return new SendRefused({ reason: "no_conversation", detail: "There's no conversation to compact yet" })
}

/** Who a message's change is recorded as caused by. */
const actorOf = (message: Outgoing | null): Actor => (message?.source === "user" ? Actor.user : Actor.board)

export interface RunsShape {
  /**
   * A message for a thread: steered into its live run, queued, held for its dependencies, or it starts a run. `/new`
   * (the user's) starts a new conversation first, `/compact` compacts the conversation, and `/plan` gives the task the
   * plan label. The task as it is after.
   */
  readonly send: (task: TaskId, message: Outgoing) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** Send what is queued on a thread whose run has ended (the old `send_queued`): it stays queued until the run's start takes it. */
  readonly sendQueued: (task: TaskId) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /**
   * Ask the thread's run to stop: one being prepared is given up, an agent that takes input is asked to end its turn
   * (its session stays resumable) and stopped if it hasn't within `STOP_GRACE`, others are stopped. False with no run.
   */
  readonly stop: (task: TaskId) => Effect.Effect<{ readonly stopped: boolean }>
  /** Before deleting a thread: its queue and steers dropped, its run stopped at once. */
  readonly abort: (task: TaskId) => Effect.Effect<void>
  /** Take back what is queued: the task as it was, so that the text can be given back to the user. */
  readonly dropQueued: (task: TaskId) => Effect.Effect<Task, TaskNotFound>
  readonly isRunning: (task: TaskId) => Effect.Effect<boolean>
  /**
   * The banner's Stop: stop the agent's background shells (or just `shell`), leaving the agent be (the old
   * `background.stop`). The ids it asked Claude Code to stop.
   */
  readonly stopBackground: (task: TaskId, shell: string | null) => Effect.Effect<ReadonlyArray<string>, BackgroundRefused>
  /**
   * A task just created (`Tasks.create`, from `input`): with no title but a description, its title is written first
   * (`Titles.generateLater`), then its agent starts if it is to; else its agent starts now if it is to (`start`: true, or
   * a message to start it with). The old `new_task`.
   */
  readonly created: (task: Task, input: NewTask) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** "Carry on then": a task whose agent ran out of usage waits in In progress for the reset (the old `wait_for_reset`). */
  readonly waitForReset: (task: TaskId) => Effect.Effect<Task, TaskNotFound | WaitRefused>
  /** Waits until the task's run being prepared, if any, has started its agent or given up (tests). */
  readonly launched: (task: TaskId) => Effect.Effect<void>
  /** `/new`: the thread's next message starts a new conversation with its agent; its items stay. Refused while it runs. */
  readonly newSession: (task: TaskId) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** Compact the conversation (the board's own, `why` its notice); unlike a prompt, the card stays where it is. */
  readonly compact: (task: TaskId, why: string) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /**
   * For Recovery: carry on the kills a restart interrupted, then adopt every run that had not exited (its open requests
   * taken up again, its timers re-armed, followed from its saved offset), ending those that cannot be followed, and
   * the tasks marked running with no run send what is queued or need attention.
   */
  readonly reattach: Effect.Effect<void>
  /**
   * Start the agent of a task that was waiting (for its dependencies, or a usage limit's reset) (the old
   * `start_waiting`): what is queued, else its start, else a note to carry on. If its project has been archived since,
   * it goes back to waiting.
   */
  readonly startWaiting: (task: TaskId) => Effect.Effect<void>
  /** Start the waiting tasks whose dependencies are all merged, in a project (every project for null) (`start_unblocked`). */
  readonly startUnblocked: (project: ProjectId | null) => Effect.Effect<void>
}

/** What registering a run did. */
interface Registered {
  readonly run: Run
  readonly text: string
  readonly before: Task
  readonly after: Task
}

export class Runs extends Context.Service<Runs, RunsShape>()("huntaway-server/runs/Runs") {
  /** Tasks waiting for a usage limit carry on once it resets: every 30 seconds, as long as the server runs. */
  static readonly limitResets = Layer.effectDiscard(
    Effect.gen(function* () {
      const runs = yield* Runs
      // A pass that fails is logged; the loop goes on (a defect would otherwise end it until the server restarts).
      const pass = runs.startUnblocked(null).pipe(Effect.catchCause((cause) => Effect.logError("starting the tasks whose usage limit reset failed", cause)))
      yield* pass.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)
    }),
  )

  static readonly layer = Layer.effect(
    Runs,
    Effect.gen(function* () {
      const db = yield* Db
      const tasks = yield* TaskRepo
      const projects = yield* ProjectRepo
      const runs = yield* RunRepo
      const dir = yield* RunDir
      const shim = yield* Shim
      const input = yield* RunInput
      const follower = yield* RunFollower
      const threads = yield* Threads
      const events = yield* Events
      const changes = yield* Changes
      const locks = yield* KeyedLock
      const random = yield* SecureRandom.SecureRandom
      const config = yield* ServerConfig
      const facts = yield* LaunchFacts
      const requests = yield* AgentRequests
      const dependencies = yield* Dependencies
      const background = yield* BackgroundWork
      const meter = yield* ContextMeter
      const titles = yield* Titles
      const usage = yield* Usage
      const profileRepo = yield* ProfileRepo
      const configRepo = yield* AgentConfigRepo
      const fs = yield* FileSystem.FileSystem
      const checkpoints = yield* Checkpoints
      // The launches being prepared, by task: a stop interrupts one.
      const launches = yield* FiberMap.make<TaskId>()
      // The runs that may write their task's documents folder (they started with labels): a `/plan` is steered only
      // into those. Lost on a restart, so `/plan` then waits for the next run, as before.
      const writesDocuments = yield* Ref.make<ReadonlySet<RunId>>(new Set())

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })
      const uuid = random.uuidV4()

      /** Writes `columns` on `before` with what follows from them, in the caller's transaction, and publishes the task. */
      const write = Effect.fnUntraced(function* (before: Task, columns: TaskColumns, at: Timestamp) {
        yield* tasks.write(before.id, deriveColumns(before, columns, at), at)
        const after = yield* load(before.id)
        yield* events.emit({ type: "task", task: after })
        return after
      })
      const publish = Effect.fnUntraced(function* (id: TaskId) {
        const after = yield* load(id)
        yield* events.emit({ type: "task", task: after })
        return after
      })

      /** The run going on the thread, if any. */
      const liveRun = Effect.fnUntraced(function* (task: TaskId) {
        const latest = yield* runs.latest(task)
        return Option.isSome(latest) && latest.value.isLive ? latest.value : null
      })

      // ---- launching ----

      /** A launch that ended before its agent started: nothing it launched goes on, and the reactor hears of its end. */
      const launchEnded = Effect.fnUntraced(function* (run: Run, exit: Exit.Exit<unknown, unknown>) {
        if (Exit.isSuccess(exit)) return
        // An agent that reads its input as it works would wait for more forever, and one started after the launch
        // gave up on it would work unseen.
        yield* background.keepKilled(run.id)
        yield* shim.reap(run.id)
        const error = Cause.hasInterruptsOnly(exit.cause) ? "it was stopped while it was being prepared" : Cause.pretty(exit.cause).split("\n")[0]
        if (!Cause.hasInterruptsOnly(exit.cause)) yield* Effect.logError(`task=${run.task_id} run=${run.id} launching the agent failed`, exit.cause)
        yield* changes.offer({ _tag: "RunExited", run: run.id, task: run.task_id, exit: { code: null, signal: null, error }, errorTail: "" })
      })

      /** Prepares the run's folder and starts its agent, then follows it. Interrupted by a stop while it prepares. */
      const launch = (run: Run, text: string) =>
        Effect.gen(function* () {
          const prepared = yield* facts.launch(run, text)
          if (prepared.writesDocuments) yield* Ref.update(writesDocuments, (all) => new Set([...all, run.id]))
          yield* dir.prepare(run.id, prepared.spec)
          // Not if it was stopped meanwhile (after spec.json, which a reap goes by): an agent started now would work
          // unseen. Interruption is the check; a stop marks the row first.
          const row = yield* runs.get(run.id)
          if (Option.isNone(row) || row.value.stop !== "none") return yield* Effect.interrupt
          // Once the shim is asked to start, it is let finish: a stop meanwhile reaps what it started.
          yield* Effect.uninterruptible(shim.spawn(run.id, prepared.spec))
          yield* runs.setPhase(run.id, "running")
          // 4.3: the conversation rollback a rewind asked for is done with (made, or for another session).
          yield* checkpoints.rewound(run.task_id, prepared.rewind ?? null)
          // Preparing is over: from here a stop goes to the agent, and messages sent meanwhile go to it now.
          yield* input.writeSteers(run.task_id)
          const started = yield* runs.get(run.id)
          return yield* Option.isSome(started) ? follower.follow(started.value) : Effect.void
        }).pipe(
          Effect.onExit((exit) => launchEnded(run, exit)),
          // Its end is told above; a failure is not the map's.
          Effect.ignore,
          Effect.annotateLogs({ module: "runs", run: run.id }),
        )

      // ---- registering ----

      /** The thread items that explain a run, in its registration's transaction: its message, or a task's start. */
      const record = Effect.fnUntraced(function* (task: Task, kind: RunKind, combined: ReturnType<typeof combine>, message: Outgoing | null) {
        if (combined.text.trim() !== "") {
          return yield* threads.userMessage(task.id, combined.text, {
            ...(message?.auto === true ? { auto: true } : {}),
            ...(message?.review_round === undefined ? {} : { review_round: message.review_round }),
            ...(combined.fromAgent
              ? { from_agent: true }
              : combined.userText !== null && combined.userText !== combined.text
                ? { user_text: combined.userText }
                : {}),
            ...(combined.routine ? { routine: true } : {}),
          })
        }
        if (task.session_id === null && task.kind === "task" && kind !== "compact") {
          const project = task.project_id === null ? null : Option.getOrNull(yield* projects.get(task.project_id))
          return yield* threads.userMessage(task.id, startInstructions(threadKindOf(task), project, null), {
            auto: true,
            start: true,
            ...(combined.routine ? { routine: true } : {}),
          })
        }
        return null
      })

      /**
       * Register a run (one transaction): the run `preparing`, what is queued taken (`take`), the thread items that
       * explain it, the task running. Either the message is still queued, or all of it is recorded.
       */
      const register = Effect.fnUntraced(function* (
        id: TaskId,
        message: Outgoing | null,
        kind: RunKind,
        take: Take,
        explain?: (task: Task) => Effect.Effect<WriteNo | null, TaskNotFound>,
      ) {
        const runId = RunId.make(yield* uuid)
        const at = yield* nowTimestamp
        return yield* db.tx(
          Effect.gen(function* () {
            const before = yield* load(id)
            if (yield* runs.hasActive(id)) return yield* refused({ _tag: "AlreadyRunning" })
            const taken = take === "No" ? [] : yield* tasks.takeQueued(id)
            if (take === "Only" && taken.every((q) => q.text.trim() === "")) {
              return yield* new SendRefused({ reason: "nothing_queued", detail: "nothing is queued to send" })
            }
            const combined = combine([...taken, ...(message === null ? [] : [rowOf(message)])])
            const run = yield* runs.insert({ id: runId, task_id: id, kind, created_at: at })
            // 6.5: the automation runs whose messages it starts with are its, for their cost.
            yield* runs.chargeAutomationRuns(run.id, combined.automationRuns)
            const writeNo = explain === undefined ? yield* record(before, kind, combined, message) : yield* explain(before)
            // The message its first turn starts with (checkpoints).
            if (writeNo !== null) yield* runs.update(run.id, { write_no: writeNo })
            const compact = kind === "compact"
            const columns: TaskColumns = {
              running: true,
              steerable: !compact,
              // A queued message sent as the last run ends carries on the same stretch of work.
              ...(before.running ? {} : { run_started_at: at }),
              // A compaction never moves the card.
              ...(compact
                ? {}
                : {
                    attention_reason: null,
                    waiting: false,
                    limit_reset_at: null,
                    ...(before.kind === "task" ? { status: before.merging ? ("ready_for_merge" as const) : ("in_progress" as const) } : {}),
                  }),
            }
            const after = yield* write(before, columns, at)
            const registered: Registered = { run, text: combined.text, before, after }
            return registered
          }),
        )
      })

      /** Register a run and launch it in the background. */
      const start = Effect.fnUntraced(function* (
        id: TaskId,
        message: Outgoing | null,
        kind: RunKind,
        take: Take,
        explain?: (task: Task) => Effect.Effect<WriteNo | null, TaskNotFound>,
      ) {
        const done = yield* register(id, message, kind, take, explain)
        yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: actorOf(message) })
        yield* FiberMap.run(launches, id, launch(done.run, done.text))
        // The agent is changing the work under review: its review and summaries (4.6) and workflow steps (6.6) are
        // superseded, by the reactor.
        if (kind === "prompt" && done.after.kind === "task") yield* changes.offer({ _tag: "PromptStarted", task: id, run: done.run.id })
        return done.after
      })

      // ---- sending ----

      /** `/plan` gives a task the plan label (in the caller's transaction), so it shows the Plan tab wherever the message goes. */
      const planLabel = Effect.fnUntraced(function* (task: Task, at: Timestamp) {
        if (task.labels.includes("plan")) return task
        const labels = DocumentLabel.literals.filter((l) => l === "plan" || task.labels.includes(l))
        return yield* write(task, { labels }, at)
      })

      /** The keys of the tasks `task` depends on that aren't merged. */
      const unmetOf = Effect.fnUntraced(function* (task: Task) {
        if (task.depends_on.length === 0) return []
        return (yield* tasks.getMany(task.depends_on)).filter((t) => !isMerged(t)).map((t) => t.key)
      })

      /**
       * 4.7: the task merging in `task`'s merge lane, if another and it waits for its turn (its approval isn't pending):
       * a message to it is refused, as it can't run alongside the merge going on.
       */
      const activeMergeOf = Effect.fnUntraced(function* (task: Task) {
        if (!task.merging || task.merge_approval === "pending" || task.project_id === null) return null
        const rows = yield* tasks.projectTasks(task.project_id)
        const other = activeMerge(rows, mergeLane(rows, task), yield* tasks.finishedLast(task.project_id))
        return other !== null && other.id !== task.id ? { title: other.title } : null
      })

      /**
       * 4.8: a stack level waiting in Ready for merge for the one below it isn't merging yet, so a message to it takes it
       * out of the merge queue while its agent works, holding no merge slot; it goes back to waiting when its run ends
       * (`remerge`). Not one summarising its merge for the user's approval, which is out of the queue as it is.
       */
      const outOfStackWait = Effect.fnUntraced(function* (task: Task, live: boolean) {
        if (!task.merging || task.status !== "ready_for_merge" || task.running || live || task.merge_approval === "pending" || task.project_id === null) {
          return task
        }
        if (!stackWaits(yield* tasks.projectTasks(task.project_id), task)) return task
        const at = yield* nowTimestamp
        const after = yield* db.tx(
          Effect.gen(function* () {
            yield* threads
              .notice(task.id, "info", "Out of Ready for merge while its agent works: it goes back to waiting for the task it lands after when it's done")
              .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
            return yield* write(task, { status: "in_progress", merging: false, remerge: true }, at)
          }),
        )
        yield* changes.offer({ _tag: "TaskChanged", before: task, after, cause: Actor.board })
        return after
      })

      const sendLocked = Effect.fnUntraced(function* (id: TaskId, message: Outgoing | null) {
        const live = yield* liveRun(id)
        const task = yield* outOfStackWait(yield* load(id), live !== null)
        const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
        const text = message?.text.trim() ?? ""
        const plan = task.kind === "task" && message !== null && !message.review && planRest(text) !== null
        const decision = decideSend({
          task,
          message,
          plan,
          project: project === null ? null : { name: project.name, archived: project.archived },
          activeMerge: yield* activeMergeOf(task),
          live:
            live === null
              ? null
              : {
                  kind: live.kind,
                  phase: live.phase,
                  acceptsInput: yield* dir.acceptsInput(live.id),
                  writesDocuments: (yield* Ref.get(writesDocuments)).has(live.id),
                },
          agents: !config.noAgents,
          unmet: yield* unmetOf(task),
        })
        const at = yield* nowTimestamp
        const labelled = (t: Task) => (plan ? planLabel(t, at) : Effect.succeed(t))
        if (decision._tag === "Refuse") return yield* refused(decision.refusal)
        if (decision._tag === "Nothing") return task
        if (decision._tag === "Steer") {
          if (message === null || live === null) return task
          const steerId = yield* uuid
          yield* db.tx(
            Effect.gen(function* () {
              yield* tasks.addSteer(
                id,
                { id: steerId, run_id: live.id, text, source: message.source, automation_run_id: message.automation_run_id ?? null },
                at,
              )
              yield* labelled(task)
            }),
          )
          yield* input.writeSteers(id)
          return yield* publish(id)
        }
        if (decision._tag === "Queue") {
          if (message === null) return task
          return yield* db.tx(
            Effect.gen(function* () {
              yield* tasks.enqueue(id, rowOf(message), at)
              yield* labelled(task)
              return yield* publish(id)
            }),
          )
        }
        if (decision._tag === "WaitForDependencies") {
          const done = yield* db.tx(
            Effect.gen(function* () {
              if (message !== null) yield* tasks.enqueue(id, rowOf(message), at)
              else if ((yield* tasks.queued(id)).every((q) => q.text.trim() === "")) {
                return yield* new SendRefused({ reason: "nothing_queued", detail: "nothing is queued to send" })
              }
              const before = yield* labelled(task)
              if (!task.waiting) {
                const list = decision.unmet
                yield* threads
                  .notice(id, "info", `Queued until ${list.join(", ")} ${list.length === 1 ? "is" : "are"} merged`)
                  .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
              }
              // Reached as a run ends (its queued message sent): unless another has started since, no run goes on.
              const idle = task.running && !(yield* runs.hasActive(id))
              const after = yield* write(before, { waiting: true, status: "in_progress", attention_reason: null, ...(idle ? { running: false } : {}) }, at)
              return { before: task, after }
            }),
          )
          yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: actorOf(message) })
          return done.after
        }
        // A config that's out of usage would refuse the run: it starts on another, or waits for the reset.
        if (decision.kind === "prompt" && task.kind === "task" && !task.merging) {
          const held = yield* usageGate(task, message, at)
          if (held !== null) return held
        }
        if (plan) {
          yield* db.tx(labelled(task))
          yield* fs.makeDirectory(facts.documentsOf(id), { recursive: true }).pipe(Effect.ignore)
        }
        return yield* start(id, message, decision.kind, decision.take)
      })

      /**
       * A task out of usage waits in In progress, keeping `message` queued, until its config's limit resets (the old
       * `wait_for_limit`); `Runs.startUnblocked` carries it on then.
       */
      const waitForLimit = Effect.fnUntraced(function* (task: Task, configName: string, until: Timestamp, message: Outgoing | null, at: Timestamp) {
        const done = yield* db.tx(
          Effect.gen(function* () {
            if (message !== null) yield* tasks.enqueue(task.id, rowOf(message), at)
            if (!(task.waiting && task.limit_reset_at === until)) {
              yield* threads.notice(task.id, "info", `Waiting for ${configName}'s usage limit to reset`, `It resets at ${until}`)
            }
            const idle = task.running && !(yield* runs.hasActive(task.id))
            const after = yield* write(
              task,
              { waiting: true, limit_reset_at: until, status: "in_progress", attention_reason: null, ...(idle ? { running: false } : {}) },
              at,
            )
            return after
          }),
        )
        yield* changes.offer({ _tag: "TaskChanged", before: task, after: done, cause: actorOf(message) })
        return done
      })

      /**
       * Before a run of `task` starts (the old `usage::before_run`): already waiting for a reset, a message joins the
       * queue; else with its config out of usage, a task that hasn't started moves to another config of the same agent
       * with room (the profile's `limit_switch`), or it waits for the reset (`limit_wait`). The task if it waits.
       */
      const usageGate = Effect.fnUntraced(function* (task: Task, message: Outgoing | null, at: Timestamp) {
        const nowMs = Date.parse(at)
        const own = yield* facts.config(task)
        const name = own?.name ?? "its config"
        if (task.limit_reset_at !== null && task.waiting && !isResetDue(task.limit_reset_at, nowMs)) {
          return yield* waitForLimit(task, name, task.limit_reset_at, message, at)
        }
        const profile = Option.getOrNull(yield* profileRepo.get(task.profile_id))
        if (profile === null || own === null || (!profile.limit_wait && !profile.limit_switch)) return null
        const until = yield* usage.outUntil(own.id)
        if (until === null) return null
        if (profile.limit_switch && task.session_id === null) {
          // Another of its configs with the same agent, so its model and effort still apply.
          const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
          for (const other of yield* tasks.configs(task.profile_id, project)) {
            if (other === own.id) continue
            const row = Option.getOrNull(yield* configRepo.get(other))
            if (row === null || row.agent !== own.agent || (yield* usage.outUntil(other)) !== null) continue
            yield* db.tx(
              Effect.gen(function* () {
                yield* write(task, { claude_config_id: other }, at)
                yield* threads.notice(task.id, "info", `Starting on ${row.name} instead: ${own.name} is out of usage`, `${own.name} resets at ${until}`)
              }),
            )
            return null
          }
        }
        if (!profile.limit_wait) return null
        return yield* waitForLimit(task, own.name, until, message, at)
      })

      const withLock = <A, E>(id: TaskId, effect: Effect.Effect<A, E>) => locks.withLock(["task", id])(effect)

      const newSessionLocked = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* load(id)
        if ((yield* liveRun(id)) !== null) {
          return yield* new SendRefused({ reason: "agent_running", detail: "The agent is running: stop it before starting a new conversation" })
        }
        if (task.session_id === null) return task
        const at = yield* nowTimestamp
        // The assistant and the pens threads start it with the config their profile picks for them now.
        const picked = yield* facts.threadConfig(task)
        const done = yield* db.tx(
          Effect.gen(function* () {
            const after = yield* write(
              task,
              { session_id: null, rewind: null, context: null, ...(picked === undefined ? {} : { claude_config_id: picked }) },
              at,
            )
            yield* threads.notice(id, "info", "The next message starts a new conversation with the agent")
            yield* meter.clear(id)
            return after
          }),
        )
        yield* changes.offer({ _tag: "TaskChanged", before: task, after: done, cause: Actor.user })
        return done
      })

      const send = Effect.fn("Runs.send")(function* (id: TaskId, message: Outgoing) {
        // `/new [message]` starts a new conversation first.
        const rest = message.source === "user" ? newCommand(message.text) : null
        if (rest !== null) {
          const renewed = yield* withLock(id, newSessionLocked(id))
          return rest === "" ? renewed : yield* withLock(id, sendLocked(id, { ...message, text: rest }))
        }
        const sent = yield* withLock(id, sendLocked(id, message))
        // The user's prompt may have moved the task on, so its title follows.
        if (message.source === "user" && message.auto !== true && !isCompact(message.text) && worthAsking(message.text)) yield* titles.refreshLater(id)
        return sent
      })

      // ---- stopping ----

      const stopLocked = Effect.fnUntraced(function* (id: TaskId, kill: boolean) {
        const run = yield* liveRun(id)
        if (run === null) return false
        // Being prepared: the launch is given up, and its end reaps what it may have started.
        if (yield* FiberMap.has(launches, id)) {
          yield* runs.update(run.id, { stop: "requested", stop_id: `stop-${yield* uuid}` })
          yield* FiberMap.remove(launches, id)
          return true
        }
        yield* input.stop(run, kill)
        return true
      })

      const stopBackground = Effect.fn("Runs.stopBackground")(function* (id: TaskId, shell: string | null) {
        const run = yield* liveRun(id)
        if (run === null) return yield* new BackgroundRefused({ reason: "the task's agent isn't running" })
        return yield* input.stopBackground(run, shell)
      })

      const waitForReset = Effect.fn("Runs.waitForReset")(function* (id: TaskId) {
        return yield* withLock(
          id,
          Effect.gen(function* () {
            const task = yield* load(id)
            if (task.kind !== "task") return yield* new WaitRefused({ reason: "only tasks can wait for a usage limit to reset", invalid: true })
            // Out of the merge queue's slot while it waited, another merge could start alongside it.
            if (task.merging) {
              return yield* new WaitRefused({
                reason:
                  "a merge can't wait for a usage limit to reset, as it would give up its place in the merge queue; message its agent once the limit has reset",
                invalid: false,
              })
            }
            const at = yield* nowTimestamp
            const until = task.limit_reset_at
            if (until === null || isResetDue(until, Date.parse(at))) {
              return yield* new WaitRefused({ reason: "its agent isn't out of usage (or the limit has reset already)", invalid: false })
            }
            if (yield* runs.hasActive(id)) return yield* new WaitRefused({ reason: "its agent is running", invalid: false })
            const own = yield* facts.config(task)
            return yield* waitForLimit(task, own?.name ?? "its config", until, null, at)
          }),
        )
      })

      const stop = Effect.fn("Runs.stop")(function* (id: TaskId) {
        // Review, summary and workflow-step threads' runs are stopped with their task's (plan tasks 5.x, 6.6).
        return { stopped: yield* withLock(id, stopLocked(id, false)) }
      })

      const abort = Effect.fn("Runs.abort")(function* (id: TaskId) {
        yield* withLock(
          id,
          Effect.gen(function* () {
            yield* db.tx(Effect.andThen(tasks.takeQueued(id), tasks.takeSteers(id)))
            yield* stopLocked(id, true)
          }),
        )
      })

      const dropQueued = Effect.fn("Runs.dropQueued")(function* (id: TaskId) {
        return yield* withLock(
          id,
          db.tx(
            Effect.gen(function* () {
              const before = yield* load(id)
              if ((yield* tasks.takeQueued(id)).length > 0) yield* publish(id)
              return before
            }),
          ),
        )
      })

      // ---- after a restart ----

      /** A run that can't be followed ends here: what it may start is stopped, and the reactor hears of its end. */
      const giveUp = Effect.fnUntraced(function* (run: Run, error: string) {
        yield* background.keepKilled(run.id)
        yield* shim.reap(run.id)
        yield* changes.offer({ _tag: "RunExited", run: run.id, task: run.task_id, exit: { code: null, signal: null, error }, errorTail: "" })
      })

      const adopt = Effect.fnUntraced(function* (run: Run) {
        // Written by a newer build (a downgrade): it can't be followed safely, so its agent is stopped rather than left
        // working (and calling the board's tools) unfollowed.
        if ((yield* dir.started(run.id)) && formatSupport(yield* dir.header(run.id)) === "newer") {
          yield* giveUp(run, "This run was started by a newer huntaway; update this host to follow it")
          return
        }
        // Stopped while it was prepared, before the agent started (or before ia-shim wrote its output): an agent the
        // shim starts now is stopped.
        if (!(yield* dir.started(run.id))) {
          yield* giveUp(run, "Interrupted by a server restart before the agent started")
          return
        }
        if (run.phase === "preparing") yield* runs.setPhase(run.id, "running")
        yield* Effect.logInfo(`run=${run.id} resuming at offset ${run.out_offset}`)
        // The requests it asked before that offset and still open, before its output is read again.
        const now = yield* runs.get(run.id)
        if (Option.isNone(now)) return
        yield* requests.resume(now.value)
        yield* follower.follow(now.value)
        // A run started before steering, or by a build that queued its messages, takes none.
        const steerable = run.kind !== "compact" && (yield* dir.acceptsInput(run.id))
        const task = yield* tasks.get(run.task_id)
        if (task !== null && task.steerable !== steerable) yield* db.tx(write(task, { steerable }, yield* nowTimestamp))
        yield* input.rearm(now.value)
      })

      /** A task marked running with no run: its last one ended as the server stopped, before its end was written. */
      const idleRunning = Effect.fnUntraced(function* (id: TaskId) {
        const queued = (yield* tasks.queued(id)).some((q) => q.text.trim() !== "")
        if (queued) {
          const sent = yield* Effect.exit(sendQueued(id))
          if (Exit.isSuccess(sent) && (sent.value.running || sent.value.waiting)) return
        }
        const done = yield* withLock(
          id,
          db.tx(
            Effect.gen(function* () {
              const before = yield* load(id)
              if (!before.running || (yield* runs.hasActive(id))) return null
              yield* threads.notice(id, "warning", "Run interrupted by server restart")
              const after = yield* write(
                before,
                {
                  running: false,
                  ...(before.kind === "task" ? { status: "needs_attention" as const, attention_reason: "Interrupted by server restart" } : {}),
                },
                yield* nowTimestamp,
              )
              return { before, after }
            }),
          ),
        )
        if (done !== null) yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: Actor.board })
      })

      const reattach = Effect.gen(function* () {
        for (const name of yield* dir.list) yield* shim.resumeMarked(RunId.make(name))
        for (const run of yield* runs.active) {
          yield* adopt(run).pipe(Effect.catchCause((cause) => Effect.logError(`run=${run.id} re-attaching`, cause)))
        }
        for (const id of yield* runs.idleRunning) {
          yield* idleRunning(id).pipe(Effect.catchCause((cause) => Effect.logError(`task=${id} ending a run the restart interrupted`, cause)))
        }
      }).pipe(Effect.withSpan("Runs.reattach"), Effect.annotateLogs({ module: "runs" }))

      const sendQueued = Effect.fn("Runs.sendQueued")(function* (id: TaskId) {
        return yield* withLock(id, sendLocked(id, null))
      })

      const startWaiting = Effect.fn("Runs.startWaiting")(function* (id: TaskId) {
        // Claimed under the task's lock, in one transaction: a task deleted meanwhile, no longer waiting (the reactor's
        // pass and the 30-second one both found it, and the other took it) or with a run going is left alone, so it is
        // started once.
        const before = yield* withLock(
          id,
          db.tx(
            Effect.gen(function* () {
              if (yield* runs.hasActive(id)) return null
              const task = yield* load(id).pipe(Effect.orElseSucceed(() => null))
              if (task === null || !task.waiting) return null
              yield* write(task, { waiting: false, limit_reset_at: null }, yield* nowTimestamp)
              const why =
                task.limit_reset_at !== null
                  ? "Its usage limit has reset, so its agent is carrying on"
                  : task.depends_on.length === 0
                    ? "Its agent is starting"
                    : "Nothing it depends on is left to merge, so its agent is starting"
              yield* threads.notice(id, "info", why)
              return task
            }),
          ),
          // Deleted while it was being claimed: there is nothing to start.
        ).pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(null)))
        if (before === null) return
        const limit = before.limit_reset_at !== null
        const queued = (yield* tasks.queued(id)).some((q) => q.text.trim() !== "")
        const text = queued
          ? null
          : before.session_id === null
            ? ""
            : limit
              ? "The usage limit you ran into has reset, so carry on where you left off."
              : "The tasks this one was waiting for are merged (or no longer needed), so carry on with it."
        const sent = yield* Effect.exit(text === null ? sendQueued(id) : send(id, { text, source: "board", auto: true }))
        if (Exit.isSuccess(sent)) return
        const archived = Cause.findErrorOption(sent.cause).pipe(Option.exists((e) => e._tag === "SendRefused" && e.reason === "archived"))
        const done = yield* withLock(
          id,
          db.tx(
            Effect.gen(function* () {
              const task = yield* load(id)
              if (archived) {
                yield* threads.notice(id, "info", "Its project was archived, so it waits until the project is unarchived")
                return { before: task, after: yield* write(task, { waiting: true, limit_reset_at: before.limit_reset_at }, yield* nowTimestamp) }
              }
              const reason = `Couldn't start the agent: ${Cause.pretty(sent.cause).split("\n")[0] ?? ""}`
              yield* threads.notice(id, "error", reason)
              return { before: task, after: yield* write(task, { status: "needs_attention", attention_reason: reason }, yield* nowTimestamp) }
            }),
          ),
        ).pipe(Effect.orDie)
        yield* changes.offer({ _tag: "TaskChanged", before: done.before, after: done.after, cause: Actor.board })
      })

      const compact = Effect.fn("Runs.compact")(function* (id: TaskId, why: string) {
        return yield* withLock(
          id,
          Effect.gen(function* () {
            const task = yield* load(id)
            if (config.noAgents) return yield* refused({ _tag: "NoAgents" })
            if (task.session_id === null) return yield* refused({ _tag: "NoConversation" })
            return yield* start(id, { text: "/compact", source: "board", auto: true }, "compact", "No", (t) => threads.notice(t.id, "info", why))
          }),
        )
      })

      return Runs.of({
        send,
        sendQueued,
        stop,
        abort,
        dropQueued,
        isRunning: (id) => runs.hasActive(id),
        created: Effect.fn("Runs.created")(function* (task: Task, fields: NewTask) {
          const starting = fields.start === true ? "" : typeof fields.start === "string" ? fields.start : null
          const generate = (fields.title ?? "").trim() === "" && (fields.description ?? "").trim() !== ""
          if (generate) {
            // The user may have started it by hand meanwhile.
            const then =
              starting === null
                ? undefined
                : Effect.gen(function* () {
                    if (yield* runs.hasActive(task.id)) return
                    const sent = yield* Effect.exit(send(task.id, { text: starting, source: "user" }))
                    if (Exit.isFailure(sent)) {
                      yield* threads.notice(task.id, "error", "Failed to start agent", Cause.pretty(sent.cause).split("\n")[0]).pipe(Effect.ignore)
                    }
                  })
            yield* titles.generateLater(task.id, then)
            return task
          }
          return starting === null ? task : yield* send(task.id, { text: starting, source: "user" })
        }),
        stopBackground,
        waitForReset,
        launched: (id) =>
          FiberMap.get(launches, id).pipe(
            Effect.flatMap((found) => (Option.isSome(found) ? Fiber.await(found.value) : Effect.void)),
            Effect.asVoid,
          ),
        newSession: Effect.fn("Runs.newSession")(function* (id: TaskId) {
          return yield* withLock(id, newSessionLocked(id))
        }),
        compact,
        reattach,
        startWaiting,
        startUnblocked: Effect.fn("Runs.startUnblocked")(function* (project: ProjectId | null) {
          if (config.noAgents) return
          // One task's failure doesn't keep the others waiting.
          for (const id of yield* dependencies.ready(project, yield* Clock.currentTimeMillis)) {
            yield* startWaiting(id).pipe(Effect.catchCause((cause) => Effect.logError(`task=${id} starting a waiting task failed`, cause)))
          }
        }),
      })
    }),
  )
}

export type { Outgoing }
