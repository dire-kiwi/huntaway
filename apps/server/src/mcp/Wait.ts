import { Cause, Clock, Context, DateTime, Duration, Effect, Exit, Fiber, FiberMap, FileSystem, Layer, Option, Queue, Ref, Result, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Timestamp } from "@huntaway/contracts"
import type { AgentWait, BoardEvent, CallId, RunId, Task, TaskId, WaitTask } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import type { Run } from "../runs/Run.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { RunWaits } from "../runs/RunWaits.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { McpHooks, refuseAsk } from "./McpHooks.ts"
import { ToolError } from "./tool.ts"
import type { LocalCaller } from "./tool.ts"
import { startCommand } from "./wait/command.ts"
import type { RunningCommand } from "./wait/command.ts"
import { period, resuming, tasksChanged, TICK } from "./wait/ended.ts"
import type { Ended, Watched } from "./wait/ended.ts"

// The `wait` tool's waiting (docs/plan/07-agents.md, `wait`; docs/plan/inventory/03-mcp.md 2.8; huntaway's
// mcp/wait.ts). An agent with nothing to do until something happens waits in the tool call rather than polling or
// ending its turn; meanwhile its task stays in its column and the board shows it as waiting (`Task.agent_wait`, the
// stored wait), with the reason the agent gave. The call returns at the first of:
//
// - the end of the wait period (`period`);
// - a change of status of a task it watches, one being deleted, or its review finishing;
// - one of its subagents completing, failing or stopping (recorded on the stored wait by the run's output: `RunWaits`);
// - the exit of the shell command it was given, which runs in the agent's working directory while it waits;
// - news about the pull request it was given (plan task 4.5: recorded on the stored wait by `PrWatch`; the seams are
//   marked "4.5" below);
// - a message sent to the agent (queued, or steered into this run), which it reads after the call;
// - the run being stopped, or ending, or the task gone;
// - the task moved to another column, explicitly (`moved_to`, which `Tasks.update` writes with the move);
// - the run carrying on with other work: another board call (`callMade`), a tool call of its own thread (`RunWaits`),
//   or the agent giving up on the call (`cancelled`), which clear the stored wait under it.
//
// A wait is a fiber in a `FiberMap` keyed by run; it subscribes to the board's events before it reads anything, and
// reads the stored wait and the tasks again on every event about its task or one it watches, and every `TICK` for what
// no event announces (a stop). The stored wait is what a call retried after a restart picks up: the same deadline and
// watched tasks, its command started again from the start. It is cleared when the call returns, whichever way, but not
// when the server stops under it.

/** What a new `wait` call asks for (the tool has resolved its tasks and had its command approved). */
export interface WaitRequest {
  readonly reason: string | null
  readonly seconds: number | null
  /** The tasks to watch, with their keys and the status (and review) to watch them from. */
  readonly tasks: ReadonlyArray<WaitTask>
  /** A shell command to run while waiting, in the agent's working directory. */
  readonly command: string | null
}

/** How a wait ended. */
export interface WaitOutcome {
  readonly ended: Ended
  /** The wait as it was when it ended, with what came in meanwhile (a subagent's end, a pull request's news). */
  readonly wait: AgentWait
  /** The end of its command's output so far, if the wait ended some other way while the command ran. */
  readonly output: string | null
}

export interface WaitShape {
  /**
   * Wait in the call `caller.call_id` until the period is over or something happens, showing the task as waiting
   * meanwhile. A call whose wait is stored (retried after a restart) carries on with it. Fails with why the wait didn't
   * start (a period too long for what it watches, a command that couldn't be started).
   */
  readonly wait: (caller: LocalCaller, request: WaitRequest) => Effect.Effect<WaitOutcome, ToolError>
  /** Where the task's agent works, and a wait's command runs: its worktree, its project's repository, or its profile's scratch folder. */
  readonly workDir: (task: Task) => Effect.Effect<string>
  /** Any board call but `wait` (`McpHooks.callMade`): the run carried on with other work, so its wait ends. */
  readonly callMade: (caller: LocalCaller) => Effect.Effect<void>
  /** The agent gave up on call `call` of `run` (`McpHooks.cancelled`): its wait ends, unanswered. */
  readonly cancelled: (run: Run, call: CallId) => Effect.Effect<void>
}

/** The milliseconds of a stored time; an unreadable one is now. */
const millisOf = (at: string, now: number): number => Option.match(DateTime.make(at), { onNone: () => now, onSome: DateTime.toEpochMillis })

const iso = (millis: number): Timestamp => Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)))

const TICK_MILLIS = Duration.toMillis(Duration.fromInputUnsafe(TICK))

export class Wait extends Context.Service<Wait, WaitShape>()("huntaway-server/mcp/Wait") {
  static readonly layer = Layer.effect(
    Wait,
    Effect.gen(function* () {
      const { tx } = yield* Db
      const tasks = yield* TaskRepo
      const runs = yield* RunRepo
      const projects = yield* ProjectRepo
      const events = yield* Events
      const runWaits = yield* RunWaits
      const tmp = yield* TaskTmp
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fibers = yield* FiberMap.make<RunId, WaitOutcome, ToolError>()

      const publish = Effect.fnUntraced(function* (task: TaskId) {
        const now = yield* tasks.get(task)
        if (now !== null) yield* events.emit({ type: "task", task: now })
      })

      /** The task shows `wait` as what its agent waits for. */
      const store = (task: TaskId, wait: AgentWait) =>
        tx(
          Effect.gen(function* () {
            yield* tasks.write(task, { agent_wait: wait }, yield* nowTimestamp)
            yield* publish(task)
          }),
        )

      /** The task's agent isn't waiting any more in the call `call`. */
      const clear = (task: TaskId, call: string) =>
        tx(
          Effect.gen(function* () {
            const now = yield* tasks.get(task)
            if (now?.agent_wait?.call_id !== call) return
            yield* tasks.write(task, { agent_wait: null }, yield* nowTimestamp)
            yield* publish(task)
          }),
        )

      const workDir = Effect.fn("Wait.workDir")(function* (task: Task) {
        if (task.kind === "review" && task.parent_id !== null) {
          const parent = yield* tasks.get(task.parent_id)
          if (parent?.worktree_path != null && parent.worktree_state === "ready") return parent.worktree_path
        }
        if (task.worktree_path !== null) return task.worktree_path
        const project = task.project_id === null ? Option.none() : yield* projects.get(task.project_id)
        if (Option.isSome(project)) return project.value.repo_path
        const scratch = `${dataDir.profileDir(task.profile_id)}/scratch`
        yield* fs.makeDirectory(scratch, { recursive: true }).pipe(Effect.ignore)
        return scratch
      })

      /** Whether the wait is over, other than by its deadline or its command. */
      const check = Effect.fnUntraced(function* (task: TaskId, wait: AgentWait) {
        const run = yield* runs.get(wait.run_id)
        if (Option.isNone(run) || run.value.stop !== "none" || !run.value.isLive) return { _tag: "Stopped" } satisfies Ended
        const now = yield* tasks.get(task)
        if (now === null) return { _tag: "Stopped" } satisfies Ended
        // Cleared under it: the run carried on with something else (or its turn ended, or the agent gave up on the call).
        const current = resuming(now, wait.call_id)
        if (current === null) return { _tag: "Resumed" } satisfies Ended
        // Only an explicit move counts: the board moves the task to Needs attention and back by itself for a
        // subagent's permission prompt.
        if (current.moved_to !== undefined) return { _tag: "Moved", status: current.moved_to } satisfies Ended
        if ((yield* tasks.queued(task)).length > 0 || (yield* tasks.steers(task, wait.run_id)).length > 0) return { _tag: "Message" } satisfies Ended
        if (current.subagent_finished !== undefined) return { _tag: "Subagent", agent: current.subagent_finished } satisfies Ended
        if (current.pull_request?.news !== undefined) return { _tag: "PullRequest", news: current.pull_request.news } satisfies Ended
        if (wait.tasks.length === 0) return null
        const found = new Map((yield* tasks.getMany(wait.tasks.map((w) => w.id))).map((t) => [t.id, t] as const))
        return tasksChanged(wait.tasks, (id): Watched | null => {
          const t = found.get(id)
          return t === undefined ? null : { status: t.status, review: t.review === null ? null : { state: t.review.state, updated_at: t.review.updated_at } }
        })
      })

      /** How the wait ended, and the end of its command's output so far if that hadn't exited. */
      const waitOut = Effect.fnUntraced(function* (task: Task, wait: AgentWait, live: Stream.Stream<BoardEvent>) {
        const until = millisOf(wait.until, yield* Clock.currentTimeMillis)
        const ids = new Set<string>([...wait.tasks.map((t) => t.id), task.id])
        // A change to one of the tasks involved (or a subscriber that fell behind) has the wait look again.
        const changed = yield* Queue.sliding<void>(1)
        const relevant = (e: BoardEvent) => (e.type === "task" && ids.has(e.task.id)) || (e.type === "task_deleted" && ids.has(e.id)) || e.type === "resync"
        yield* live.pipe(
          Stream.runForEach((e) => (relevant(e) ? Queue.offer(changed, undefined) : Effect.void)),
          Effect.forkScoped,
        )
        let command: RunningCommand | null = null
        if (wait.command !== undefined) {
          // In the agent's working directory, with the task's temp folder as its TMPDIR, as the agent's own commands
          // have: a command that looks for a file the agent put in $TMPDIR would otherwise look in the wrong place for
          // as long as the wait lasts (HA-301). gh acting as the task's GitHub account is plan task 4.4's.
          const cwd = yield* workDir(task)
          const dir = yield* tmp.ensure(task)
          command = yield* startCommand(spawner, wait.command, cwd, { ...config.agentEnv, ...(dir === null ? {} : { TMPDIR: dir }) })
        }
        const exited = command === null ? null : yield* Effect.forkScoped(command.exited)
        const soFar = command === null ? Effect.succeed(null) : command.soFar
        // 4.5: a pull request without news is read (straight away for a wait carried on after a restart) until there is
        // some, which `PrWatch` records on the stored wait, racing here.
        while (true) {
          const ended = yield* check(task.id, wait)
          if (ended !== null) return { ended, output: yield* soFar }
          const left = until - (yield* Clock.currentTimeMillis)
          if (left <= 0) return { ended: { _tag: "Timeout" } satisfies Ended, output: yield* soFar }
          // Until a change to one of the tasks involved, the next tick, the deadline, or the command's exit.
          const next = yield* Effect.raceAll([
            Queue.take(changed).pipe(Effect.as(null)),
            Effect.sleep(Duration.millis(Math.min(left, TICK_MILLIS))).pipe(Effect.as(null)),
            ...(exited === null ? [] : [Fiber.join(exited)]),
          ])
          if (next !== null) return { ended: { _tag: "Command", code: next.code, output: next.output } satisfies Ended, output: null }
        }
      })

      /** A wait from start to end, in its fiber. */
      const waiting = (caller: LocalCaller, request: WaitRequest, shown: Ref.Ref<AgentWait>) =>
        Effect.gen(function* () {
          // Subscribed before anything is read, so no change can slip in between.
          const watching = yield* events.watch(undefined)
          const task = yield* tasks.get(caller.task.id)
          if (task === null) return yield* ToolError.other("unknown task")
          let wait = resuming(task, caller.call_id)
          if (wait === null) {
            const command = request.command?.trim() ?? ""
            const secs = period({ seconds: request.seconds, tasks: request.tasks, command, pullRequest: false })
            if (Result.isFailure(secs)) return yield* ToolError.other(secs.failure)
            const now = yield* Clock.currentTimeMillis
            const reason = request.reason?.trim() ?? ""
            wait = {
              reason: reason === "" ? null : reason,
              since: iso(now),
              until: iso(now + Math.trunc(secs.success * 1000)),
              tasks: request.tasks,
              ...(command === "" ? {} : { command }),
              call_id: caller.call_id,
              run_id: caller.run.id,
            }
            yield* store(task.id, wait)
          }
          yield* Ref.set(shown, wait)
          const out = yield* Effect.exit(waitOut(task, wait, watching.live))
          // Stopped with the server: the stored wait stays, for the call retried after the restart.
          if (Exit.isFailure(out) && Cause.hasInterruptsOnly(out.cause)) return yield* Effect.failCause(out.cause)
          // As it is now, with what came in meanwhile, before it's cleared.
          const now = yield* tasks.get(task.id)
          const last = (now === null ? null : resuming(now, caller.call_id)) ?? wait
          yield* clear(task.id, caller.call_id)
          if (Exit.isFailure(out)) return yield* Effect.failCause(out.cause)
          const ended = out.value
          // 4.5: the call returns its pull request's news, unless the agent won't see it (Stopped, Resumed), which
          // `PrWatch` then counts as told.
          const outcome: WaitOutcome = { ended: ended.ended, wait: last, output: ended.output }
          return outcome
        }).pipe(Effect.scoped)

      const wait = Effect.fn("Wait.wait")(function* (caller: LocalCaller, request: WaitRequest) {
        const now = yield* nowTimestamp
        const shown = yield* Ref.make<AgentWait>({ reason: null, since: now, until: now, tasks: request.tasks, call_id: caller.call_id, run_id: caller.run.id })
        const fiber = yield* FiberMap.run(fibers, caller.run.id, waiting(caller, request, shown))
        const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
        if (Exit.isSuccess(exit)) return exit.value
        if (!Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
        // Another wait of the run took its place: this one ended as the run carried on.
        yield* clear(caller.task.id, caller.call_id)
        const outcome: WaitOutcome = { ended: { _tag: "Resumed" }, wait: yield* Ref.get(shown), output: null }
        return outcome
      })

      return Wait.of({
        wait,
        workDir,
        callMade: (caller) => runWaits.over(caller.task.id, caller.run.id),
        cancelled: (run, call) => clear(run.task_id, call),
      })
    }),
  )

  /**
   * The board's hooks with `Wait`'s part (`callMade`, `cancelled`); an approval rule that asks is refused, as
   * `McpHooks.layerNone` does, until `Permissions` (3.3) is combined in (see docs/plan/07-agents.md, `wait`).
   */
  static readonly hooks = Layer.effect(
    McpHooks,
    Effect.gen(function* () {
      const waits = yield* Wait
      return McpHooks.of({ callMade: waits.callMade, askRule: refuseAsk, cancelled: waits.cancelled })
    }),
  )
}
