import { Cause, Context, Effect, Exit, Fiber, FiberMap, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { DocumentLabel, RunId, threadKindOf } from "@huntaway/contracts"
import type { Task, TaskId, Timestamp } from "@huntaway/contracts"
import { planRest, startInstructions } from "../agents/prompts/start.ts"
import { Actor, Changes } from "../platform/Changes.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { KeyedLock } from "../platform/KeyedLock.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { deriveColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { isMerged } from "../tasks/Dependencies.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import type { WriteNo } from "../threads/model.ts"
import { LaunchFacts } from "./LaunchFacts.ts"
import { combine, decideSend, isCompact, newCommand, rowOf } from "./queue.ts"
import type { Outgoing, Refusal, Take } from "./queue.ts"
import type { Run, RunKind } from "./Run.ts"
import { RunDir } from "./RunDir.ts"
import { RunFollower } from "./RunFollower.ts"
import { RunInput } from "./RunInput.ts"
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
  /** Waits until the task's run being prepared, if any, has started its agent or given up (tests). */
  readonly launched: (task: TaskId) => Effect.Effect<void>
  /** `/new`: the thread's next message starts a new conversation with its agent; its items stay. Refused while it runs. */
  readonly newSession: (task: TaskId) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** Compact the conversation (the board's own, `why` its notice); unlike a prompt, the card stays where it is. */
  readonly compact: (task: TaskId, why: string) => Effect.Effect<Task, TaskNotFound | SendRefused>
  /** For Recovery (plan task 2.6): adopt every run that had not exited. */
  readonly reattach: Effect.Effect<void>
}

/** What registering a run did. */
interface Registered {
  readonly run: Run
  readonly text: string
  readonly before: Task
  readonly after: Task
}

export class Runs extends Context.Service<Runs, RunsShape>()("huntaway-server/runs/Runs") {
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
      const fs = yield* FileSystem.FileSystem
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
        yield* shim.reap(run.id)
        const error = Cause.hasInterruptsOnly(exit.cause) ? "it was stopped while it was being prepared" : Cause.pretty(exit.cause).split("\n")[0]
        if (!Cause.hasInterruptsOnly(exit.cause)) yield* Effect.logError(`task=${run.task_id} run=${run.id} launching the agent failed`, exit.cause)
        yield* changes.offer({ _tag: "RunExited", run: run.id, task: run.task_id, exit: { code: null, signal: null, error }, errorTail: "" })
      })

      /** Prepares the run's folder and starts its agent, then follows it. Interrupted by a stop while it prepares. */
      const launch = (run: Run, text: string) =>
        Effect.gen(function* () {
          const prepared = yield* facts.claude(run, text)
          if (prepared.writesDocuments) yield* Ref.update(writesDocuments, (all) => new Set([...all, run.id]))
          yield* dir.prepare(run.id, prepared.spec)
          // Not if it was stopped meanwhile (after spec.json, which a reap goes by): an agent started now would work
          // unseen. Interruption is the check; a stop marks the row first.
          const row = yield* runs.get(run.id)
          if (Option.isNone(row) || row.value.stop !== "none") return yield* Effect.interrupt
          // Once the shim is asked to start, it is let finish: a stop meanwhile reaps what it started.
          yield* Effect.uninterruptible(shim.spawn(run.id, prepared.spec))
          yield* runs.setPhase(run.id, "running")
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
        // The agent is changing the work under review: reviews, summaries and workflow steps are superseded (5.x, 6.x).
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

      const sendLocked = Effect.fnUntraced(function* (id: TaskId, message: Outgoing | null) {
        const task = yield* load(id)
        const project = task.project_id === null ? null : yield* tasks.project(task.project_id)
        const live = yield* liveRun(id)
        const text = message?.text.trim() ?? ""
        const plan = task.kind === "task" && message !== null && !message.review && planRest(text) !== null
        const decision = decideSend({
          task,
          message,
          plan,
          project: project === null ? null : { name: project.name, archived: project.archived },
          // Merges are plan task 4.x: until then no task is merging another's lane.
          activeMerge: null,
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
        if (plan) {
          yield* db.tx(labelled(task))
          yield* fs.makeDirectory(facts.documentsOf(id), { recursive: true }).pipe(Effect.ignore)
        }
        return yield* start(id, message, decision.kind, decision.take)
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
        return yield* withLock(id, sendLocked(id, message))
      })

      // ---- stopping ----

      const stopLocked = Effect.fnUntraced(function* (id: TaskId, kill: boolean) {
        const run = yield* liveRun(id)
        if (run === null) return false
        // `requested` until the turn it interrupts ends, then `interrupted`. A later stop gets its own id, so the grace of
        // an earlier one leaves it alone.
        const stopId = `stop-${yield* uuid}`
        yield* runs.update(run.id, { stop: "requested", stop_id: stopId })
        // Being prepared: the launch is given up, and its end reaps what it may have started.
        if (yield* FiberMap.has(launches, id)) {
          yield* FiberMap.remove(launches, id)
          return true
        }
        // 2.8: between turns, an agent kept going by its background tasks has no turn to interrupt (it is killed).
        if (!kill && (yield* input.interrupt(run.id, stopId))) return true
        const signalled = yield* input.closeAndKill(run.id)
        // Never got as far as starting the agent: it ends here.
        if (!signalled && !(yield* dir.started(run.id))) {
          yield* changes.offer({
            _tag: "RunExited",
            run: run.id,
            task: id,
            exit: { code: null, signal: null, error: "it was stopped before its agent started" },
            errorTail: "",
          })
        }
        return true
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
        sendQueued: Effect.fn("Runs.sendQueued")(function* (id: TaskId) {
          return yield* withLock(id, sendLocked(id, null))
        }),
        stop,
        abort,
        dropQueued,
        isRunning: (id) => runs.hasActive(id),
        launched: (id) =>
          FiberMap.get(launches, id).pipe(
            Effect.flatMap((found) => (Option.isSome(found) ? Fiber.await(found.value) : Effect.void)),
            Effect.asVoid,
          ),
        newSession: Effect.fn("Runs.newSession")(function* (id: TaskId) {
          return yield* withLock(id, newSessionLocked(id))
        }),
        compact,
        // Plan task 2.6: re-attach each run that had not exited (`RunInput.rearm`, the follower from its offset).
        reattach: Effect.void,
      })
    }),
  )
}

export { isCompact }
export type { Outgoing }
