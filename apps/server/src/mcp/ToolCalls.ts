import { Cause, Context, DateTime, Deferred, Effect, FiberSet, Layer, Option, Ref, Schedule, Schema } from "effect"
import type { SqlError } from "effect/sql"
import { CallId, RunId, Timestamp } from "@huntaway/contracts"
import type { PermissionMode, RemoteToolCall, Task, ToolOutcome } from "@huntaway/contracts"
import { blockedReason } from "@huntaway/shared"
import { SecureRandom } from "effect/crypto"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { ASKS_ITSELF } from "../agents/rules.ts"
import { toJson } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { RunDir } from "../runs/RunDir.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { callResult, mcpResponseLine, rpcResult, SavedControlCall } from "./jsonrpc.ts"
import type { RpcId } from "./jsonrpc.ts"
import { CONTROL_PREFIX, McpCallRepo } from "./McpCallRepo.ts"
import type { NewCall, OpenCall } from "./McpCallRepo.ts"
import { McpHooks } from "./McpHooks.ts"
import { McpServers } from "./McpServers.ts"
import type { RegisteredTool } from "./McpServers.ts"
import { grants } from "./resolve.ts"
import { makeAcross } from "./acrossHosts.ts"
import {
  annotation,
  ApprovalKind,
  BOARD_SERVER,
  checkArgs,
  ForPlanning,
  ForReviewers,
  onlyOnItsHost,
  Rerunnable,
  THREAD_TOOLS,
  ToolError,
  ToolResult,
} from "./tool.ts"
import type { LocalCaller, McpCaller, ServerName } from "./tool.ts"

// Running the board's tool calls (docs/plan/07-agents.md, Dispatch; docs/plan/inventory/03-mcp.md 2.3 and 2.4): at
// most once per call id, whoever delivers a call and however often. A call is recorded `executing` in `mcp_calls`
// before it runs and `done` with its result after; a call that came on a run's output is answered on the run's input
// before it is recorded done, so "done" means "answered". A second delivery while the call runs waits for it (and is
// not answered on the input again); one after it is done gets the recorded result. A call found executing that
// nothing here is running (the server stopped mid-call) runs again only if that is safe, and is otherwise answered
// that it was interrupted. Calls run in fibers of this service's own, so a client that goes away (an HTTP stream
// that broke) does not stop the call it made; stopping the server does, leaving the call executing for `resume`.

/** How long a finished call is kept in `mcp_calls`, and how many are deleted at a time. */
export const KEEP_CALLS = "1 hour"
export const PRUNE_BATCH = 1000

/** How a call that came on a run's output (Claude's `mcp_message`) is answered: the control request and the JSON-RPC id. */
export interface ControlAnswer {
  readonly request_id: string
  readonly rpc_id: RpcId
}

export interface CallInput {
  readonly call_id: CallId
  readonly run: RunId
  readonly server: ServerName
  readonly tool: string
  /** The arguments as the agent sent them (null or missing: none). */
  readonly args: unknown
  /** Set for a call that came on the run's output: it is answered on the run's input before it is recorded done. */
  readonly answer?: ControlAnswer | undefined
  /** Set for a call another host's agent passed up its link (`upCall`): that host, and the caller's profile's name. */
  readonly from?: { readonly host: string; readonly profile: string } | undefined
}

/** A call that an agent on linked host `host` passed up its link to this host, its hub. */
export interface UpCallInput {
  readonly host: string
  /** The agent's own call id: the call runs at most once per (host, call id). */
  readonly call_id: string
  readonly profile: string
  readonly tool: string
  readonly args: unknown
}

/** The run id up-calls from `host` are recorded under in `mcp_calls`, and their call id. */
export const upRun = (host: string) => RunId.make(`up:${host}`)
export const upCallId = (host: string, call: string) => CallId.make(`up:${host}:${call}`)

export const RUN_ENDED = (tool: string) => `This run has ended on the board, so its ${tool} call wasn't run. Stop here: the board no longer follows this run.`

/** What a call found executing that cannot run again is answered. */
export const interrupted = (server: ServerName, tool: string) =>
  `This ${tool} call was interrupted (the board's server restarted while it ran), so it isn't run again: it may or may not have ` +
  (server === BOARD_SERVER
    ? "taken effect. Check (with get_task or list_tasks, say) before you call it again."
    : "taken effect. Check before you call it again.")

/** What the database said, down to SQLite's own words ("disk full"). */
const sqlMessage = (e: SqlError.SqlError) => {
  const said: Array<string> = []
  for (let at: unknown = e; at instanceof Error; at = at.cause) if (!said.includes(at.message)) said.push(at.message)
  return said.join(": ")
}

const unrecorded = (tool: string, e: SqlError.SqlError) => `The board couldn't record this ${tool} call, so it wasn't run (call it again): ${sqlMessage(e)}`

const JsonText = Schema.fromJsonString(Schema.Unknown)
const SavedJson = Schema.fromJsonString(SavedControlCall)

/** A result's JSON text, as `mcp_calls.result` keeps it (a value that won't encode is kept as null). */
const jsonOrNull = (value: unknown) => Option.getOrNull(Schema.encodeOption(JsonText)(value))

/** A call's result as `mcp_calls` recorded it. */
const stored = (row: { readonly result: string | null; readonly error: string | null }) =>
  row.error !== null
    ? Effect.succeed(ToolResult.err(row.error))
    : row.result === null
      ? Effect.succeed(ToolResult.ok(null))
      : Schema.decodeEffect(JsonText)(row.result).pipe(
          Effect.map(ToolResult.ok),
          Effect.orElseSucceed(() => ToolResult.ok(null)),
        )

export interface ToolCallsShape {
  /** Run a call at most once per call id, whoever delivers it and however often; its result. */
  readonly call: (input: CallInput) => Effect.Effect<ToolResult>
  /**
   * A board tool call of another host's agent that came down a link from its hub (`tools.call`): run here only, as
   * this host's profile of the caller's name (or for the profiles that let that name in), with no run or thread here.
   * Not recorded (it has no call id: the hub doesn't retry it).
   */
  readonly remote: (call: RemoteToolCall) => Effect.Effect<ToolOutcome>
  /**
   * A board tool call of an agent on linked host `host` that it passed up its link, once the hub has let it in
   * (`hosts/HostTools`): run here, and on this host's other links, never back down to that host nor further up; at
   * most once per call id (recorded as `up:<host>:<call id>`).
   */
  readonly upCall: (input: UpCallInput) => Effect.Effect<ToolOutcome>
  /**
   * The agent no longer wants call `call` of run `run` answered (Claude Code's `notifications/cancelled`, a
   * `control_cancel_request`): if it is running, it is not answered, the prompt it raised expires and its wait ends.
   */
  readonly cancel: (run: RunId, call: CallId) => Effect.Effect<void>
  /** Whether a call is running here now. */
  readonly isRunning: (call: CallId) => Effect.Effect<boolean>
  /**
   * For Recovery: the calls that came on the output of runs that have not exited and were executing when the server
   * stopped are taken up again in the background (run again if safe, else answered that they were interrupted), and
   * answered on their runs' input. Calls made over HTTP are taken up when their client reconnects.
   */
  readonly resume: Effect.Effect<void>
  /** Delete the calls older than `KEEP_CALLS` whose run is gone or ended before then; how many. Also hourly, in the layer. */
  readonly prune: Effect.Effect<number>
}

export class ToolCalls extends Context.Service<ToolCalls, ToolCallsShape>()("huntaway-server/mcp/ToolCalls") {
  static readonly layer = Layer.effect(
    ToolCalls,
    Effect.gen(function* () {
      const repo = yield* McpCallRepo
      const servers = yield* McpServers
      const hooks = yield* McpHooks
      const runs = yield* RunRepo
      const dirs = yield* RunDir
      const tasks = yield* TaskRepo
      const profiles = yield* ProfileRepo
      const projects = yield* ProjectRepo
      const settings = yield* HostSettings
      const rules = yield* ApprovalRules
      const { hostName } = yield* Identity
      const random = yield* SecureRandom.SecureRandom
      const across = yield* makeAcross
      // The calls running here, each with what its other deliveries wait on; the ones the agent gave up on.
      const running = yield* Ref.make<ReadonlyMap<CallId, Deferred.Deferred<ToolResult>>>(new Map())
      const cancelled = yield* Ref.make<ReadonlySet<CallId>>(new Set())
      const fibers = yield* FiberSet.make()

      /** The thread's mode now: its own, else its project's, else the host's default, else `default` (Ask). */
      const modeOf = Effect.fnUntraced(function* (task: Task) {
        if (task.permission_mode !== null) return task.permission_mode
        const project = task.project_id === null ? Option.none() : yield* projects.get(task.project_id)
        if (Option.isSome(project) && project.value.permission_mode !== null) return project.value.permission_mode
        return (yield* settings.get).default_permission_mode ?? ("default" satisfies PermissionMode)
      })

      /** The user's approval rules for the board's own tools (assistant threads), which the board holds as it runs them. */
      const checkRules = (caller: LocalCaller, tool: string, args: unknown) =>
        Effect.flatMap(rules.decideBoardTool(caller.task, tool), (found): Effect.Effect<void, ToolError> => {
          // The tools that ask the user themselves aren't asked about twice; never still refuses them.
          if (found === null || found.rule.decision === "allow" || (found.rule.decision === "ask" && ASKS_ITSELF.includes(tool))) return Effect.void
          const { name, rule } = found
          if (rule.decision === "never") {
            const blocked = { tool: rule.tool, decision: "never" } as const
            return rules
              .record({ task: caller.task, tool: name, input: args, rule: blocked, result: { outcome: "blocked", by: "rule" } })
              .pipe(Effect.andThen(Effect.fail(ToolError.other(blockedReason(rule.tool)))))
          }
          return hooks.askRule(caller, name, args, rule)
        })

      /** The gates, in order, then the tool (docs/plan/07-agents.md, Dispatch). */
      const gated = Effect.fnUntraced(function* (input: CallInput, registered: RegisteredTool | undefined) {
        const { tool, server } = input
        const args = registered === undefined ? {} : yield* checkArgs(tool, registered.args, input.args)
        const run = yield* runs.get(input.run)
        if (Option.isNone(run)) return yield* ToolError.other("unknown run")
        // The board has reported the run as over (its shim vanished while the agent went on, say): its thread is no
        // longer its own, so nothing it asks for is done.
        if (!run.value.isLive) return yield* ToolError.other(RUN_ENDED(tool))
        const task = yield* tasks.get(run.value.task_id)
        if (task === null) return yield* ToolError.other("unknown task")
        const profile = yield* profiles.get(task.profile_id)
        if (Option.isNone(profile)) return yield* ToolError.other("unknown profile")
        // A tool the server doesn't have, once the run is known to be one that may call.
        if (registered === undefined) return yield* ToolError.other(`unknown tool ${tool}`)
        const caller: LocalCaller = { call_id: input.call_id, server, run: run.value, task, profile: profile.value, mode: yield* modeOf(task) }
        if (server === BOARD_SERVER) {
          // Whatever the run's tool list offers, a reviewer only reads.
          if (task.kind === "review" && !annotation(registered.tool, ForReviewers)) {
            return yield* ToolError.other(`${tool} isn't available to reviewers: they can only read the board and submit_review`)
          }
          // Nor does a thread in plan mode until its plan is approved: the run's tool list was fixed when it started.
          if (caller.mode === "plan" && !annotation(registered.tool, ForPlanning)) {
            return yield* ToolError.other(
              `${tool} isn't available in plan mode: until the user approves your plan (present it with ExitPlanMode), you can only read the board, ` +
                "wait and request_user_input",
            )
          }
          // Any other call means the run is working again.
          if (tool !== "wait") yield* hooks.callMade(caller)
          // The rules hold for every board tool but the plumbing of questions, `wait` included.
          if (tool !== "request_user_input") yield* checkRules(caller, tool, args)
          // Here, or on another host (docs/plan/08-hosts.md, Board tools across hosts): not the thread's own tools.
          if (!THREAD_TOOLS.includes(tool)) return yield* across.run({ caller, tool, args, local: (a) => registered.run(a, caller), from: null, upById: true })
        }
        return yield* registered.run(args, caller)
      })

      /**
       * Another host's agent as a caller here: this host's profile of its name, else one with no id that reaches only the
       * boards of the profiles that let that name in (none: it isn't found). No run, no thread, no mode of its own.
       */
      const remoteCaller = Effect.fnUntraced(function* (name: string, callId: CallId) {
        const all = yield* profiles.list
        const own = all.find((p) => p.name === name)
        if (own === undefined && !all.some((p) => grants(p, name))) {
          return yield* ToolError.notFound(`not found: ${hostName} has no profile named ${name}, and no profile there lets its agents in`)
        }
        const caller: McpCaller = {
          call_id: callId,
          server: BOARD_SERVER,
          run: null,
          task: null,
          profile: own ?? { id: null, name },
          mode: "default",
        }
        return caller
      })

      /** The tool another host's agent calls, its arguments checked; thread tools are refused. */
      const remoteTool = Effect.fnUntraced(function* (tool: string, given: unknown) {
        if (THREAD_TOOLS.includes(tool)) return yield* ToolError.other(onlyOnItsHost(tool))
        const registered = yield* servers.find(BOARD_SERVER, tool)
        if (registered === undefined) return yield* ToolError.other(`unknown tool ${tool}`)
        return { registered, args: yield* checkArgs(tool, registered.args, given) }
      })

      /** An up-call (`from`): the gates for another host's agent, then the tool here or on this host's other links. */
      const upGated = Effect.fnUntraced(function* (input: CallInput, from: { readonly host: string; readonly profile: string }) {
        const { registered, args } = yield* remoteTool(input.tool, input.args)
        const caller = yield* remoteCaller(from.profile, input.call_id)
        return yield* across.run({ caller, tool: input.tool, args, local: (a) => registered.run(a, caller), from: from.host, upById: true })
      })

      /** The call's outcome: the tool's result, or its error; a defect is logged and told as an error, an interruption kept. */
      const outcome = (input: CallInput, registered: RegisteredTool | undefined) =>
        (input.from === undefined ? gated(input, registered) : upGated(input, input.from)).pipe(
          Effect.map(ToolResult.ok),
          Effect.catchTag("ToolError", (e) => Effect.succeed(ToolResult.err(e.message, e.notFound))),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError(`call ${input.call_id} (${input.tool}) failed`, cause).pipe(
                Effect.as(ToolResult.err(`The board failed running ${input.tool}: ${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}`)),
              ),
          ),
        )

      /** Whether a call cut short may run again: the tool says so, or it has changed nothing yet (it was waiting on an approval). */
      const rerunnable = Effect.fnUntraced(function* (id: CallId, registered: RegisteredTool | undefined) {
        const ruled = yield* repo.ruledPrompt(id)
        if (Option.isSome(ruled) && ruled.value !== "allowed") return true
        if (registered === undefined) return false
        if (annotation(registered.tool, Rerunnable)) return true
        const kind = annotation(registered.tool, ApprovalKind)
        if (kind === null) return false
        const asked = yield* repo.approval(id, kind)
        return Option.isSome(asked) && asked.value !== "allowed"
      })

      /** A call that came on the run's output is answered on its input, unless the agent gave up on it. */
      const answer = Effect.fnUntraced(function* (input: CallInput, result: ToolResult) {
        const to = input.answer
        if (to === undefined) return
        if ((yield* Ref.get(cancelled)).has(input.call_id)) return
        const line = yield* mcpResponseLine(to.request_id, rpcResult(to.rpc_id, yield* callResult(result)))
        const sent = yield* dirs
          .appendInput(input.run, line)
          .pipe(Effect.catch((e) => Effect.logWarning(`run=${input.run} answering its ${to.request_id}: ${e.reason}`).pipe(Effect.as(true))))
        if (!sent) yield* Effect.logWarning(`run=${input.run} the agent no longer takes input, so its ${to.request_id} wasn't answered`)
      })

      const finish = (record: NewCall, result: ToolResult) =>
        repo
          .finish(record, result._tag === "Ok" ? { result: jsonOrNull(result.value), error: null } : { result: null, error: result.message })
          .pipe(Effect.catch((e) => Effect.logError(`recording the result of call ${record.id} (${record.tool}): ${e.message}`)))

      /** One delivery that runs the call (no other delivery is running it here). */
      const execute = (input: CallInput, done: Deferred.Deferred<ToolResult>) => {
        // Unset if the call is cut short (the server stopping): the other deliveries are then let go unanswered, and a
        // retry finds the call recorded as executing.
        let result: ToolResult | undefined
        return Effect.gen(function* () {
          const registered = yield* servers.find(input.server, input.tool)
          const run = yield* runs.get(input.run)
          const saved =
            input.answer === undefined ? input.args : { request_id: input.answer.request_id, rpc_id: input.answer.rpc_id, arguments: input.args ?? null }
          const record: NewCall = {
            id: input.call_id,
            run_id: input.run,
            task_id: Option.match(run, { onNone: () => "", onSome: (r) => r.task_id }),
            tool: input.tool,
            args: yield* toJson(saved ?? null),
            created_at: Timestamp.make(DateTime.formatIso(yield* DateTime.now)),
          }
          // Nothing runs unless the board knows it's running: a call it can't record may already have.
          const before = yield* Effect.result(repo.find(input.call_id))
          if (before._tag === "Failure") {
            result = ToolResult.err(unrecorded(input.tool, before.failure))
            yield* answer(input, result)
            return
          }
          if (Option.isSome(before.success)) {
            const row = before.success.value
            // Answered before: its result as recorded, not answered again.
            if (row.status === "done") {
              result = yield* stored(row)
              return
            }
            // Executing when the server stopped.
            if (!(yield* rerunnable(input.call_id, registered))) {
              result = ToolResult.err(interrupted(input.server, input.tool))
              yield* answer(input, result)
              yield* finish(record, result)
              return
            }
            yield* Effect.logInfo(`run=${input.run} carrying on with call ${input.call_id} (${input.tool})`)
          }
          const began = yield* Effect.result(repo.begin(record))
          if (began._tag === "Failure") {
            result = ToolResult.err(unrecorded(input.tool, began.failure))
            yield* answer(input, result)
            return
          }
          const ran = yield* outcome(input, registered)
          result = ran
          // Answered, then recorded: a call recorded done has been answered.
          yield* answer(input, ran)
          yield* finish(record, ran)
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.andThen(
                Effect.all([Ref.update(running, (all) => without(all, input.call_id)), Ref.update(cancelled, (all) => withoutOne(all, input.call_id))], {
                  concurrency: 1,
                  discard: true,
                }),
                result === undefined ? Deferred.interrupt(done) : Deferred.succeed(done, result),
              ),
            ),
          ),
          Effect.annotateLogs({ module: "mcp" }),
        )
      }

      const call = Effect.fn("ToolCalls.call")(function* (input: CallInput) {
        const mine = yield* Deferred.make<ToolResult>()
        // Taking the call and starting it are one step: a delivery interrupted between them would leave the others waiting.
        const first = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const found = yield* Ref.modify(
              running,
              (all): readonly [Deferred.Deferred<ToolResult> | undefined, ReadonlyMap<CallId, Deferred.Deferred<ToolResult>>] => {
                const taken = all.get(input.call_id)
                return taken === undefined ? [undefined, new Map([...all, [input.call_id, mine]])] : [taken, all]
              },
            )
            if (found === undefined) yield* FiberSet.run(fibers, Effect.interruptible(execute(input, mine)))
            return found
          }),
        )
        // A duplicate delivery while the first runs waits for its result.
        return yield* Deferred.await(first ?? mine)
      })

      const resumeOne = (open: OpenCall) =>
        Schema.decodeEffect(SavedJson)(open.args).pipe(
          Effect.flatMap((saved) =>
            saved.codex !== undefined
              ? Effect.void // Codex's dynamic tool calls are answered on their own lines (M5).
              : FiberSet.run(
                  fibers,
                  call({
                    call_id: open.id,
                    run: open.run_id,
                    server: BOARD_SERVER,
                    tool: open.tool,
                    args: saved.arguments ?? null,
                    answer: { request_id: saved.request_id, rpc_id: saved.rpc_id },
                  }),
                ).pipe(Effect.asVoid),
          ),
          Effect.catch((e) => Effect.logWarning(`call ${open.id} can't be taken up again: ${e.message}`)),
        )

      const prune = Effect.gen(function* () {
        const before = Timestamp.make(DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 })))
        let total = 0
        while (true) {
          const n = yield* repo.prune(before, PRUNE_BATCH)
          total += n
          if (n < PRUNE_BATCH) return total
        }
      })

      yield* prune.pipe(
        Effect.tap((n) => (n > 0 ? Effect.logInfo(`removed ${n} board calls`) : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("pruning board calls failed", cause)),
        Effect.repeat(Schedule.spaced(KEEP_CALLS)),
        Effect.annotateLogs({ module: "mcp" }),
        Effect.forkScoped,
      )

      const remote = Effect.fn("ToolCalls.remote")(function* (input: RemoteToolCall) {
        const ran = yield* Effect.gen(function* () {
          const { registered, args } = yield* remoteTool(input.tool, input.args)
          const caller = yield* remoteCaller(input.profile, CallId.make(input.call_id ?? (yield* random.uuidV4())))
          // Here only: a call down a link is never passed on.
          return yield* registered.run(args, caller).pipe(Effect.mapError((e) => (e.notFound ? ToolError.notFound(`not found: ${e.message}`) : e)))
        }).pipe(Effect.result)
        return outcomeOf(ran._tag === "Success" ? ToolResult.ok(ran.success) : ToolResult.err(ran.failure.message, ran.failure.notFound))
      })

      const upCall = Effect.fn("ToolCalls.upCall")(function* (input: UpCallInput) {
        const result = yield* call({
          call_id: upCallId(input.host, input.call_id),
          run: upRun(input.host),
          server: BOARD_SERVER,
          tool: input.tool,
          args: input.args,
          from: { host: input.host, profile: input.profile },
        })
        return outcomeOf(result)
      })

      return ToolCalls.of({
        call,
        remote,
        upCall,
        cancel: Effect.fn("ToolCalls.cancel")(function* (run: RunId, id: CallId) {
          // Unless it has been answered already.
          if (!(yield* Ref.get(running)).has(id)) return
          yield* Ref.update(cancelled, (all) => new Set([...all, id]))
          const row = yield* runs.get(run)
          if (Option.isSome(row)) yield* hooks.cancelled(row.value, id)
        }),
        isRunning: (id) => Effect.map(Ref.get(running), (all) => all.has(id)),
        resume: Effect.gen(function* () {
          const open = yield* repo.openOnOutput()
          yield* Effect.forEach(open, resumeOne, { concurrency: 1, discard: true })
        }).pipe(Effect.withSpan("ToolCalls.resume"), Effect.annotateLogs({ module: "mcp" })),
        prune,
      })
    }),
  )
}

/** A call's result as another host is told it. */
const outcomeOf = (result: ToolResult): ToolOutcome =>
  result._tag === "Ok" ? { _tag: "Ok", value: result.value } : { _tag: "Err", message: result.message, not_found: result.notFound === true }

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => new Map([...map].filter(([k]) => k !== key))
const withoutOne = <K>(set: ReadonlySet<K>, key: K): ReadonlySet<K> => new Set([...set].filter((k) => k !== key))

/** The id of a call that came on run `run`'s output as control request `request`. */
export const controlCallId = (run: RunId, request: string) => CallId.make(`${CONTROL_PREFIX}${run}:${request}`)
