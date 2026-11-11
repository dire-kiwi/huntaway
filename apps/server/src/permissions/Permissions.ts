import {
  Context,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { Approval, Invalid, RequestId, Timestamp } from "@huntaway/contracts"
import type {
  AnsweredBy,
  PendingPermission,
  PermissionAnswer,
  PermissionMode,
  ProfileId,
  RunId,
  Task,
  TaskId,
  ThreadMetadata,
  ThreadRequest,
} from "@huntaway/contracts"
import { threadKindOf } from "@huntaway/contracts"
import { blockedReason } from "@huntaway/shared"
import type { Rule } from "@huntaway/shared"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { requestForPrompt } from "../agents/claude/requests.ts"
import { emptyState, stateFromItems } from "../agents/claude/state.ts"
import { ASKS_ITSELF, BOARD_SERVER, boardRule } from "../agents/rules.ts"
import { Actor, Changes } from "../platform/Changes.ts"
import type { Change } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp, toJson } from "../platform/columns.ts"
import { keepPlanningLate, keepPlanningNote, planApprovedLate } from "../prompts/planAnswer.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { AgentRequests } from "../runs/AgentRequests.ts"
import type { ControlRequest } from "../runs/AgentRequests.ts"
import type { Run } from "../runs/Run.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import type { SendRefused } from "../runs/Runs.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { deriveColumns } from "../tasks/decide.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { WriteNo } from "../threads/model.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"
import { PermissionRepo } from "./PermissionRepo.ts"
import type { ExpireScope, PromptRow, PromptStatus } from "./PermissionRepo.ts"
import {
  allow,
  approvalQuestion,
  checkAnswers,
  decisionIn,
  deny,
  DENIED,
  DONT_ASK_DENIAL,
  EXIT_PLAN,
  EXPIRED,
  EXPIRED_UNANSWERED,
  isQuestion,
  lateAnswers,
  modeAfterPlan,
  reason,
  shownAnswers,
  shownKind,
  toolAnswers,
  withModelEffort,
} from "./prompts.ts"
import type { Decision, PromptKind } from "./prompts.ts"

// Permission prompts (docs/plan/07-agents.md, Permissions, questions, approvals; docs/plan/inventory/03-mcp.md 2.7; the
// old mcp/permissions.ts): what an agent asks to do, decided by the user's approval rules, the thread's always-allowed
// tools and documents folder, its mode, or the user. A prompt is a row of `permission_requests`, the one source of
// truth: the thread's request is opened from it in the same transaction, and rewritten from it as it settles. Waiting
// for the user is a `Deferred` per request id, registered before the row is read, so an answer can't slip in between;
// a call delivered again (after a restart) finds the same row and waits again. Claude's `can_use_tool` control requests
// come here through `AgentRequests` (`Permissions.registered`), answered on the run's input; the board's tools ask
// through `McpHooks.askRule` (`askRule`), and the board's own approvals (3.4) through `approve`.

export { DONT_ASK_DENIAL, EXPIRED, EXPIRED_UNANSWERED } from "./prompts.ts"
export type { Decision } from "./prompts.ts"
export type { ExpireScope } from "./PermissionRepo.ts"

export class PromptNotFound extends Schema.TaggedError<PromptNotFound, { readonly brand: unique symbol }>()("PromptNotFound", { id: Schema.String }) {}
/** Answered already (another answer came first), or expired. */
export class PromptNotPending extends Schema.TaggedError<PromptNotPending, { readonly brand: unique symbol }>()("PromptNotPending", { id: Schema.String }) {}
/** A question or plan whose run ended, asked before a message the agent was sent since. */
export class PromptMovedOn extends Schema.TaggedError<PromptMovedOn, { readonly brand: unique symbol }>()("PromptMovedOn", { id: Schema.String }) {}

/** How often the sweeper looks for prompts that have expired. */
export const SWEEP_EVERY = "15 seconds"

/** A tool call an agent asks about: Claude Code's `can_use_tool`. */
export interface ToolUse {
  readonly tool_name: string
  readonly input: unknown
  /** The call it is for, which links the thread's request to it (and names the subagent asking). */
  readonly tool_use_id: string | null
}

/** Who asks: a call (`call_id`) of a run. A `can_use_tool` prompt also has its control request (`control_id`). */
export interface Asker {
  readonly run: Run
  readonly call_id: string
  readonly control_id?: string | undefined
}

export interface PermissionsShape {
  /** An agent wants to use a tool: decided by the rules, the thread's list and folder, its mode, or the user. */
  readonly ask: (asker: Asker, use: ToolUse) => Effect.Effect<Decision>
  /** An approval rule asks about board tool call `name` (`mcp__huntaway__<tool>`): Don't ask denies it, else the user decides. */
  readonly askRule: (asker: Asker, name: string, input: unknown, rule: Rule) => Effect.Effect<Decision>
  /**
   * One of the board's own approvals (3.4: a project change, a deletion, an automation or workflow): only the user
   * decides, whatever the mode. The input they approved (the first asked for this call, if it is retried), or why not.
   */
  readonly approve: (asker: Asker, kind: Exclude<PromptKind, "tool">, tool: string, input: unknown) => Effect.Effect<Result.Result<unknown, string>>
  /** What board approval call `call` asked the user to approve, if it asked (a retried call carries on with it). */
  readonly asked: (call: string) => Effect.Effect<Option.Option<unknown>>
  /**
   * The user's (or `by`'s) answer. The first wins; allow-always adds the tool to the thread's list; a plan's approval
   * changes the thread's mode; a question or plan whose run ended is answered as the user's message, unless the
   * conversation moved on.
   */
  readonly answer: (
    id: RequestId,
    answer: PermissionAnswer,
    by: AnsweredBy,
  ) => Effect.Effect<"allowed" | "denied", PromptNotFound | PromptNotPending | PromptMovedOn | Invalid | SendRefused | TaskNotFound>
  /** Prompts waiting for an answer, oldest first: all, a task's, or a profile's. */
  readonly pending: (filter: {
    readonly task?: TaskId | undefined
    readonly profile?: ProfileId | undefined
  }) => Effect.Effect<ReadonlyArray<PendingPermission>>
  /** The board's own approvals waiting for the user, oldest first. */
  readonly approvals: Effect.Effect<ReadonlyArray<Approval>>
  /** The thread's mode changed: Bypass allows, Don't ask denies, what it is waiting on (not questions or what a rule asked, for Bypass). */
  readonly applyMode: (task: TaskId) => Effect.Effect<void>
  /** Expires the pending prompts of `scope`, unanswered ("Request expired"). */
  readonly expireFor: (scope: ExpireScope) => Effect.Effect<void>
  /** Denies the routine runs' prompts nobody answered by `at` (the sweeper's pass); how many. */
  readonly sweep: (at: Timestamp) => Effect.Effect<number>
  /** For Recovery, before runs are re-attached: expires the prompts whose run had already exited (or is gone). */
  readonly expireOrphans: Effect.Effect<void>
  /**
   * A run re-attached after a restart (`AgentRequests`' `resume`): its `can_use_tool` prompts whose answer isn't on its
   * input are waited on again in the background, and answered there once decided.
   */
  readonly resume: (run: Run) => Effect.Effect<void>
  /**
   * `run` ended (`AgentRequests`' `ended`): what it asked and nobody answered expires: the thread's prompts when no later
   * run has started (`idle`), else the run's own.
   */
  readonly ended: (run: Run, idle: boolean) => Effect.Effect<void>
  /** A `can_use_tool` control request on `run`'s output: asked, and answered on its input. Safe to read again. */
  readonly onControl: (run: Run, request: ControlRequest) => Effect.Effect<void>
  /** The agent no longer wants control request `requestId` answered: its prompt expires, and it isn't answered. */
  readonly onCancel: (run: Run, requestId: string) => Effect.Effect<void>
  /** For tests: waits until `can_use_tool` call `call` is no longer being asked here (answered, or given up on). */
  readonly settled: (call: string) => Effect.Effect<void>
  /** For tests: waits until the prompt call `call` raised is being waited on, and gives its id. */
  readonly asking: (call: string) => Effect.Effect<RequestId>
}

/** The call id of `can_use_tool` request `request` on run `run`'s output. */
export const promptCallId = (run: RunId, request: string) => `stdio:${run}:${request}`

const Json = Schema.fromJsonString(Schema.Unknown)
/** A stored input: its JSON, or the text itself when it isn't JSON (a row an old board wrote). */
const parsed = (text: string): unknown => Option.getOrElse(Schema.decodeOption(Json)(text), () => text)

const OWN_FOLDER: ReadonlySet<string> = new Set(["Scratch", "Assistant", "PensRoot", "Pen", "Document"])
const WRITES: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** A waiter per request id, with the task it is for. */
type Waiters = ReadonlyMap<RequestId, { readonly task: TaskId; readonly call: string | null; readonly waiting: ReadonlyArray<Deferred.Deferred<void>> }>

const decodeApproval = Schema.decodeUnknownOption(Approval)

/** One of the board's own approvals as the board lists it (none for a tool prompt, or one whose input doesn't read). */
const approvalOf = (row: PromptRow): Option.Option<Approval> =>
  row.kind === "tool"
    ? Option.none()
    : decodeApproval({
        request_id: row.id,
        status: row.status,
        note: row.note,
        task_id: row.task_id,
        created_at: row.created_at,
        kind: shownKind(row.kind, parsed(row.input)),
        tool_name: row.tool_name,
        input: parsed(row.input),
      })
/** What the thread's request carries of the row (its card's data, inventory 08 3.3). */
const metadataOf = (row: PromptRow, type: ThreadRequest["type"], input: unknown): ThreadMetadata => ({
  tool_name: row.tool_name,
  ...(type === "permission" ? {} : { input }),
  request_id: row.id,
  status: row.status,
  ...(row.kind === "tool" ? {} : { kind: shownKind(row.kind, input) }),
  ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
  ...(row.rule === null ? {} : { rule: { tool: row.rule, decision: "ask" } }),
  ...(row.note === null ? {} : { note: row.note }),
  message_id: row.write_no,
})

export class Permissions extends Context.Service<Permissions, PermissionsShape>()("huntaway-server/permissions/Permissions") {
  static readonly layer = Layer.effect(
    Permissions,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* PermissionRepo
      const threads = yield* Threads
      const store = yield* ThreadStore
      const readers = yield* ThreadReaders
      const tasks = yield* TaskRepo
      const events = yield* Events
      const changes = yield* Changes
      const runRepo = yield* RunRepo
      const runs = yield* Runs
      const rules = yield* ApprovalRules
      const projects = yield* ProjectRepo
      const settings = yield* HostSettings
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const requests = yield* AgentRequests
      const waiters = yield* SubscriptionRef.make<Waiters>(new Map())
      // The `can_use_tool` calls being asked here, and those the agent gave up on.
      const inflight = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
      const cancelled = yield* Ref.make<ReadonlySet<string>>(new Set())
      const background = yield* FiberSet.make()

      // ---- the thread's mode ----

      /** The mode a thread inherits: its project's, else the host's default, else Ask. */
      const inherited = Effect.fnUntraced(function* (task: Task) {
        const project = task.project_id === null ? Option.none() : yield* projects.get(task.project_id)
        if (Option.isSome(project) && project.value.permission_mode !== null) return project.value.permission_mode
        return (yield* settings.get).default_permission_mode ?? ("default" satisfies PermissionMode)
      })
      const modeOf = Effect.fnUntraced(function* (task: Task) {
        return task.permission_mode ?? (yield* inherited(task))
      })

      // ---- writing ----

      /** Writes `columns` on the task in the caller's transaction, emits it, and gives the change for the reactor. */
      const writeTask = Effect.fnUntraced(function* (id: TaskId, decide: (task: Task) => TaskColumns | null, cause: Actor) {
        const before = yield* tasks.get(id)
        if (before === null) return null
        const columns = decide(before)
        if (columns === null || Object.keys(columns).length === 0) return null
        const at = yield* nowTimestamp
        yield* tasks.write(id, deriveColumns(before, columns, at), at)
        const after = yield* tasks.get(id)
        if (after !== null) yield* events.emit({ type: "task", task: after })
        const change: Change = { _tag: "TaskChanged", before, after, cause }
        return change
      })
      const offer = (made: ReadonlyArray<Change | null>) =>
        Effect.forEach(made, (c) => (c === null ? Effect.void : changes.offer(c)), { concurrency: 1, discard: true })

      /** A prompt of the task was settled: back to work if none is left waiting and its agent runs. In the caller's transaction. */
      const backToWork = (task: TaskId, cause: Actor) =>
        Effect.flatMap(repo.anyPending(task), (still) =>
          still
            ? Effect.succeed(null)
            : writeTask(
                task,
                (t) => (t.running ? { attention_reason: null, ...(t.kind === "task" ? { status: t.merging ? "ready_for_merge" : "in_progress" } : {}) } : null),
                cause,
              ),
        )

      const approvalChanged = (row: PromptRow, open: boolean) =>
        row.kind === "tool" ? Effect.void : events.emit({ type: "approval", request_id: row.id, approval: open ? Option.getOrNull(approvalOf(row)) : null })

      /** The thread's request rewritten from row `row` (settled with `resolution`), with `extra` card data. In the caller's transaction. */
      const rewrite = Effect.fnUntraced(function* (row: PromptRow, resolution: ThreadRequest["resolution"], extra: ThreadMetadata = {}) {
        const found = yield* store.request(row.task_id, row.id)
        if (found === null) return
        const input = parsed(row.input)
        const was = found.request
        const metadata: ThreadMetadata = { ...was.metadata, ...metadataOf(row, was.type, input), ...extra }
        const next: ThreadRequest =
          was.type === "permission"
            ? { ...was, input, metadata, ...(resolution === undefined ? {} : { resolution }) }
            : { ...was, metadata, ...(resolution === undefined ? {} : { resolution }) }
        yield* threads.appendFromAgent(row.task_id, [{ type: "request.opened", request: next }]).pipe(Effect.ignore)
      })

      // ---- waiting ----

      const register = (id: RequestId, task: TaskId, call: string | null, d: Deferred.Deferred<void>) =>
        SubscriptionRef.update(waiters, (all) => {
          const next = new Map(all)
          next.set(id, { task, call, waiting: [...(all.get(id)?.waiting ?? []), d] })
          return next
        })
      const unregister = (id: RequestId, d: Deferred.Deferred<void>) =>
        SubscriptionRef.update(waiters, (all) => {
          const had = all.get(id)
          if (had === undefined) return all
          const next = new Map(all)
          const waiting = had.waiting.filter((x) => x !== d)
          if (waiting.length === 0) next.delete(id)
          else next.set(id, { task: had.task, call: had.call, waiting })
          return next
        })
      /** Wakes whoever waits on `id` (they read the row again). */
      const wake = (id: RequestId) =>
        Effect.flatMap(SubscriptionRef.get(waiters), (all) =>
          Effect.forEach(all.get(id)?.waiting ?? [], (d) => Deferred.succeed(d, undefined), { concurrency: 1, discard: true }),
        )
      /** Wakes whoever waits on a prompt of `task` (its rows may be gone with it). */
      const wakeTask = (task: TaskId) =>
        Effect.flatMap(SubscriptionRef.get(waiters), (all) =>
          Effect.forEach(
            [...all.values()].filter((w) => w.task === task).flatMap((w) => w.waiting),
            (d) => Deferred.succeed(d, undefined),
            { concurrency: 1, discard: true },
          ),
        )

      /** Waits for the user to decide prompt `id`: null if they allowed it, else why not. */
      const decision = (id: RequestId, task: TaskId, call: string | null): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          while (true) {
            // Register before reading, so a decision can't slip in between.
            const woken = yield* Deferred.make<void>()
            yield* register(id, task, call, woken)
            const settled = yield* Effect.gen(function* () {
              const row = yield* repo.get(id)
              // Gone with its thread.
              if (Option.isNone(row)) return { done: EXPIRED }
              if (row.value.status === "allowed") return { done: null }
              if (row.value.status !== "pending") return { done: row.value.note ?? DENIED }
              yield* Deferred.await(woken)
              return null
            }).pipe(Effect.ensuring(unregister(id, woken)))
            if (settled !== null) return settled.done
          }
        })

      /** What the agent is told once the user allowed prompt `id`: its input as approved, and for a plan the mode it carries on in. */
      const allowed = Effect.fnUntraced(function* (id: RequestId) {
        const row = yield* repo.get(id)
        if (Option.isNone(row)) return deny(EXPIRED)
        const input = parsed(row.value.input)
        if (row.value.tool_name !== EXIT_PLAN) return allow(input)
        // Claude Code leaves plan mode for Ask: another mode it can switch to is set for the rest of the run.
        const task = yield* tasks.get(row.value.task_id)
        const mode = task === null ? null : yield* modeOf(task)
        return mode === "acceptEdits" || mode === "auto"
          ? ({ behavior: "allow", updatedInput: input ?? null, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] } satisfies Decision)
          : allow(input)
      })

      // ---- raising ----

      /** When a prompt from `run` is denied unanswered: for a routine run in a thread the rules hold for, the profile's expiry. */
      const expiry = Effect.fnUntraced(function* (task: Task, run: Run) {
        const held = yield* rules.forTask(task)
        if (held === null || held.expiry_minutes <= 0 || run.write_no === null) return null
        const turn = yield* readers.userMessage(task.id, WriteNo.make(run.write_no))
        if (turn?.routine !== true) return null
        return Timestamp.make(DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: held.expiry_minutes })))
      })

      /** The thread's state for linking a prompt to its call. */
      const translatorState = Effect.fnUntraced(function* (task: TaskId) {
        const stored = yield* threads.stored(task).pipe(Effect.orElseSucceed(() => ({ entries: [], requests: [], seq: 0 })))
        if (stored.entries.length === 0 && stored.requests.length === 0) return emptyState
        const metas = new Map(stored.entries.map((e) => [e.item.id, e.meta] as const))
        return stateFromItems(
          stored.entries.map((e) => e.item),
          stored.requests,
          (id) => metas.get(id),
        )
      })

      interface Raise {
        readonly asker: Asker
        readonly task: Task
        readonly kind: PromptKind
        readonly tool: string
        readonly input: unknown
        readonly toolUseId: string | null
        readonly attention: string
        readonly rule: Rule | null
        /** The name the action log gives it. */
        readonly logged: string
      }

      /**
       * The prompt for the call, raised if it is new (its row, the thread's request and the task's attention in one
       * transaction). Refused when the call's run is no longer the one the board follows for the task.
       */
      const raise = Effect.fnUntraced(function* (r: Raise) {
        const existing = yield* repo.byCall(r.asker.call_id, r.tool)
        if (Option.isSome(existing)) return Result.succeed(existing.value.id)
        const latest = yield* runRepo.latest(r.task.id)
        if (!r.asker.run.isLive || Option.isNone(latest) || latest.value.id !== r.asker.run.id || !latest.value.isLive) {
          return Result.fail("this call's run has ended on the board")
        }
        const id = RequestId.make(yield* random.uuidV4().pipe(Effect.orDie))
        const expires = yield* expiry(r.task, r.asker.run)
        const state = yield* translatorState(r.task.id)
        const created = yield* nowTimestamp
        const { request } = requestForPrompt(state, {
          id,
          tool_name: r.tool,
          input: r.input,
          tool_use_id: r.toolUseId ?? undefined,
          kind: r.kind,
          created_at: created,
        })
        const input = yield* toJson(r.input ?? null)
        const done = yield* db.tx(
          Effect.gen(function* () {
            const base: Omit<PromptRow, "write_no"> = {
              id,
              task_id: r.task.id,
              tool_name: r.tool,
              input,
              status: "pending",
              kind: r.kind,
              call_id: r.asker.call_id,
              note: null,
              expires_at: expires,
              rule: r.rule?.tool ?? null,
              created_at: created,
              run_id: r.asker.run.id,
              control_id: r.asker.control_id ?? null,
              answered: false,
            }
            const opened = (n: WriteNo): ThreadRequest => {
              const shown =
                request ?? ({ id, type: "permission", kind: "other", name: r.tool, input: r.input ?? {}, created_at: created } satisfies ThreadRequest)
              const metadata = { ...metadataOf({ ...base, write_no: n }, shown.type, r.input), tool_use_id: r.toolUseId }
              return { ...shown, metadata }
            }
            const { writeNo } = yield* threads.writeFromAgent(r.task.id, (n) => ({ events: [{ type: "request.opened", request: opened(n) }] }))
            const row: PromptRow = { ...base, write_no: writeNo }
            yield* repo.insert(row)
            if (r.rule !== null) {
              yield* rules.record({ task: r.task, tool: r.logged, input: r.input, rule: { tool: r.rule.tool, decision: "ask" }, result: { request: id } })
            }
            yield* approvalChanged(row, true)
            return yield* writeTask(
              r.task.id,
              (t) => ({ attention_reason: r.attention, ...(t.kind === "task" ? { status: "needs_attention" } : {}) }),
              Actor.board,
            )
          }),
        )
        yield* offer([done])
        return Result.succeed(id)
      })

      /** Raise the prompt and wait for the user. */
      const askUser = Effect.fnUntraced(function* (r: Raise) {
        const raised = yield* raise(r).pipe(Effect.catchTag("TaskNotFound", () => Effect.succeed(Result.fail(EXPIRED))))
        if (Result.isFailure(raised)) return { decision: deny(raised.failure), id: null }
        const why = yield* decision(raised.success, r.task.id, r.asker.call_id)
        return { decision: why === null ? yield* allowed(raised.success) : deny(why), id: raised.success }
      })

      // ---- deciding ----

      /** Whether the call writes the thread's own documents folder (a labelled task's, a scratch or document thread's). */
      const writesOwnFolder = Effect.fnUntraced(function* (task: Task, tool: string, input: unknown) {
        const kind = threadKindOf(task)
        if (task.kind !== "task" || !(task.labels.length > 0 || OWN_FOLDER.has(kind._tag)) || !WRITES.has(tool)) return false
        const file = Predicate.isObject(input) ? (input["file_path"] ?? input["notebook_path"]) : undefined
        // A `..`, or a symlink in the folder, could lead back out of it.
        if (typeof file !== "string" || !file.startsWith("/") || file.split("/").includes("..")) return false
        const f = yield* resolved(file)
        const d = yield* resolved(dataDir.documents(task.id))
        return f !== null && d !== null && (f === d || f.startsWith(d.endsWith("/") ? d : `${d}/`))
      })

      /** A path with its symlinks resolved as far as it exists; null for a symlink that leads nowhere, or an error on the way. */
      const resolved = Effect.fnUntraced(function* (path: string) {
        const rest: Array<string> = []
        let existing = path.length > 1 ? path.replace(/\/+$/, "") : path
        while (true) {
          const real = yield* Effect.result(fs.realPath(existing))
          if (Result.isSuccess(real)) return [real.success, ...rest.toReversed()].join("/").replace(/\/+/g, "/")
          // A dangling symlink: writing through it would create its target, wherever that is.
          if (Result.isSuccess(yield* Effect.result(fs.readLink(existing)))) return null
          const cut = existing.lastIndexOf("/")
          if (cut <= 0 || existing === "/") return null
          rest.push(existing.slice(cut + 1))
          existing = existing.slice(0, cut)
        }
      })

      const decide = Effect.fnUntraced(function* (asker: Asker, use: ToolUse) {
        const task = yield* tasks.get(asker.run.task_id)
        if (task === null) return { decision: deny(EXPIRED), id: null }
        const input = use.input ?? null
        const question = isQuestion(use.tool_name)
        const mode = yield* modeOf(task)
        // The user's approval rules come first, whatever the mode.
        const rule = yield* rules.decide(task, use.tool_name, mode)
        if (rule?.decision === "never") {
          yield* rules.record({ task, tool: use.tool_name, input, rule: { tool: rule.tool, decision: "never" }, result: { outcome: "blocked", by: "rule" } })
          return { decision: deny(blockedReason(rule.tool)), id: null }
        }
        if (rule?.decision === "allow") return { decision: allow(input), id: null }
        if (rule?.decision === "ask") {
          // Don't ask never asks: it's denied, as anything it would have asked is.
          if (mode === "dontAsk") {
            yield* rules.record({ task, tool: use.tool_name, input, rule: { tool: rule.tool, decision: "ask" }, result: { outcome: "denied", by: "mode" } })
            return { decision: deny(DONT_ASK_DENIAL), id: null }
          }
        } else {
          // A labelled task's agent writes its documents in its own folder.
          if (!question && (task.auto_allow.includes(use.tool_name) || (yield* writesOwnFolder(task, use.tool_name, input)))) {
            return { decision: allow(input), id: null }
          }
          // The run was started under an older mode; honour the one selected now.
          const live = decisionIn(mode)
          if (live === true && !question) return { decision: allow(input), id: null }
          if (live === false) return { decision: deny(DONT_ASK_DENIAL), id: null }
        }
        return yield* askUser({
          asker,
          task,
          kind: "tool",
          tool: use.tool_name,
          input,
          toolUseId: use.tool_use_id,
          attention: reason(use.tool_name, input),
          rule: rule?.decision === "ask" ? rule : null,
          logged: use.tool_name,
        })
      })

      const ask = Effect.fn("Permissions.ask")(function* (asker: Asker, use: ToolUse) {
        return (yield* decide(asker, use)).decision
      })

      const askRule = Effect.fn("Permissions.askRule")(function* (asker: Asker, name: string, input: unknown, rule: Rule) {
        const task = yield* tasks.get(asker.run.task_id)
        if (task === null) return deny(EXPIRED)
        if ((yield* modeOf(task)) === "dontAsk") {
          yield* rules.record({ task, tool: name, input, rule: { tool: rule.tool, decision: "ask" }, result: { outcome: "denied", by: "mode" } })
          return deny(DONT_ASK_DENIAL)
        }
        const asked = yield* askUser({ asker, task, kind: "tool", tool: name, input, toolUseId: null, attention: reason(name, input), rule, logged: name })
        return asked.decision
      })

      const approve = Effect.fn("Permissions.approve")(function* (asker: Asker, kind: Exclude<PromptKind, "tool">, tool: string, input: unknown) {
        const task = yield* tasks.get(asker.run.task_id)
        if (task === null) return Result.fail(EXPIRED)
        // An ask rule on the tool doesn't ask again: this request is its asking, and goes in the action log.
        const held = yield* rules.forTask(task)
        const found = held !== null && ASKS_ITSELF.includes(tool) ? boardRule(held, tool) : null
        const rule = found !== null && found.rule.decision === "ask" ? found.rule : null
        const asked = yield* askUser({
          asker,
          task,
          kind,
          tool,
          input,
          toolUseId: null,
          attention: approvalQuestion(kind, tool, input),
          rule,
          logged: `mcp__${BOARD_SERVER}__${tool}`,
        })
        if (asked.decision.behavior === "deny") return Result.fail(asked.decision.message)
        const row = asked.id === null ? Option.none() : yield* repo.get(asked.id)
        return Option.isSome(row) ? Result.succeed(parsed(row.value.input)) : Result.fail(EXPIRED)
      })

      // ---- settling ----

      /** Expires pending prompt `row` with `note`; whether it was still pending. */
      const expireOne = Effect.fnUntraced(function* (row: PromptRow, note: string, by: AnsweredBy, shownNote: boolean) {
        const taken = yield* db.tx(
          Effect.gen(function* () {
            if (!(yield* repo.settle(row.id, "pending", { status: "expired", note, input: row.input }))) return false
            const now: PromptRow = { ...row, status: "expired", note: shownNote ? note : null }
            yield* rewrite(now, { outcome: "cancel", message: note })
            yield* approvalChanged(now, false)
            return true
          }),
        )
        if (!taken) return false
        if (row.rule !== null) yield* rules.settle(row.id, "expired", by)
        yield* wake(row.id)
        return true
      })

      const expireFor = Effect.fn("Permissions.expireFor")(function* (scope: ExpireScope) {
        const rows = yield* repo.pendingIn(scope)
        for (const row of rows) yield* expireOne(row, EXPIRED, "ended", false)
        if (scope._tag === "Call") {
          for (const task of new Set(rows.map((r) => r.task_id))) yield* offer([yield* db.tx(backToWork(task, Actor.board))])
        }
        // A thread being deleted takes its rows with it: whoever waits finds them gone.
        if (scope._tag === "Task") yield* wakeTask(scope.task)
      })

      const sweep = Effect.fn("Permissions.sweep")(function* (at: Timestamp) {
        let denied = 0
        for (const row of yield* repo.due(at)) {
          if (!(yield* expireOne(row, EXPIRED_UNANSWERED, "expiry", true))) continue
          denied += 1
          yield* offer([yield* db.tx(backToWork(row.task_id, Actor.board))])
        }
        return denied
      })

      const answer: PermissionsShape["answer"] = Effect.fn("Permissions.answer")(function* (id: RequestId, a: PermissionAnswer, by: AnsweredBy) {
        const found = yield* repo.get(id)
        if (Option.isNone(found)) return yield* new PromptNotFound({ id })
        const row = found.value
        const question = isQuestion(row.tool_name)
        const plan = row.tool_name === EXIT_PLAN && row.kind === "tool"
        const allowIt = a.decision !== "deny"
        // Each approval of the board's own and each question is answered on its own; what a rule asks is asked each time.
        const always = a.decision === "allow_always" && row.kind === "tool" && !question && row.rule === null
        // A question or plan the agent's run ended on can still be answered, by message.
        const late = row.status === "expired" && (question || plan)
        if (row.status !== "pending" && !late) return yield* new PromptNotPending({ id })
        if (late && (yield* readers.movedOn(row.task_id, WriteNo.make(row.write_no)))) return yield* new PromptMovedOn({ id })
        const picked = plan && allowIt && a.mode !== undefined && a.mode !== null ? a.mode : null
        if (picked === "plan") return yield* new Invalid({ field: "mode", reason: "mode must be one of the permission modes other than plan" })
        let input = parsed(row.input)
        let answers: ReadonlyArray<ReadonlyArray<string>> | null = null
        if (question && allowIt && a.answers !== undefined && a.answers !== null) {
          const checked = checkAnswers(input, a.answers)
          if (Result.isFailure(checked)) return yield* new Invalid({ field: "answers", reason: checked.failure })
          answers = checked.success
          input = { ...(Predicate.isObject(input) && !Array.isArray(input) ? input : {}), answers: toolAnswers(row.tool_name, input, answers) }
        }
        let edited = false
        if (allowIt && row.kind === "automation" && a.automation !== undefined && a.automation !== null) {
          const made = withModelEffort(input, a.automation)
          if (Result.isFailure(made)) return yield* new Invalid({ field: "automation", reason: made.failure })
          if (made.success !== null) {
            input = made.success
            edited = true
          }
        }
        const fb = a.feedback?.trim() ?? ""
        const feedback = plan && !allowIt && fb !== "" ? fb : null
        const note = a.message !== undefined && a.message !== null ? a.message : feedback !== null || (plan && !allowIt) ? keepPlanningNote(feedback) : null
        const status: PromptStatus = allowIt ? "allowed" : "denied"
        const settled: PromptRow = { ...row, status, note, input: yield* toJson(input) }
        const cause = by === "user" ? Actor.user : Actor.board
        const extra: ThreadMetadata = {
          ...(answers === null ? {} : { answers: shownAnswers(input, answers) }),
          ...(feedback === null ? {} : { feedback }),
          ...(picked === null ? {} : { mode: picked }),
          ...(late ? { late: true } : {}),
        }
        /** The thread's request settled as the row now is, in the caller's transaction. */
        const shown = Effect.gen(function* () {
          const stored = yield* store.request(row.task_id, row.id)
          const qs = stored?.request.type === "question" ? stored.request.questions : []
          const resolution: ThreadRequest["resolution"] =
            answers !== null
              ? { outcome: "answer", answers: Object.fromEntries(answers.map((list, i) => [qs[i]?.id ?? String(i), [...list]])) }
              : allowIt
                ? { outcome: "allow", ...(always ? { always: true } : {}) }
                : { outcome: "deny", ...(note === null ? {} : { message: note }) }
          yield* rewrite(settled, resolution, edited ? { ...extra, input } : extra)
          yield* approvalChanged(settled, false)
        })

        const done = yield* db.tx(
          Effect.gen(function* () {
            // In one statement, so of two answers at once only one is taken.
            if (!(yield* repo.settle(id, row.status, { status, note, input: settled.input }))) return yield* new PromptNotPending({ id })
            const task = yield* tasks.get(row.task_id)
            // Approving a plan ends plan mode for this thread, otherwise the next run would plan again.
            const mode = task !== null && allowIt && plan ? modeAfterPlan(task.permission_mode, yield* inherited(task), picked) : undefined
            const made: Array<Change | null> = []
            if (mode !== undefined) made.push(yield* writeTask(row.task_id, () => ({ permission_mode: mode }), cause))
            if (always) {
              made.push(
                yield* writeTask(row.task_id, (t) => (t.auto_allow.includes(row.tool_name) ? null : { auto_allow: [...t.auto_allow, row.tool_name] }), cause),
              )
            }
            if (!late) {
              yield* shown
              made.push(yield* backToWork(row.task_id, cause))
            }
            return { made, modeChanged: mode !== undefined, before: task }
          }),
        )
        yield* offer(done.made)
        if (row.rule !== null) yield* rules.settle(id, status, by)
        yield* wake(id)
        if (done.modeChanged) yield* applyMode(row.task_id)
        if (!late) return status

        // Its run is over: what the user answered goes to the agent as their message.
        const text = question
          ? allowIt && answers !== null
            ? lateAnswers(parsed(row.input), answers)
            : null
          : allowIt
            ? planApprovedLate
            : keepPlanningLate(feedback)
        if (text !== null) {
          const sent = yield* Effect.result(runs.send(row.task_id, { text, source: "user" }))
          if (Result.isFailure(sent)) {
            // Answerable again, as it was.
            yield* db.tx(
              Effect.gen(function* () {
                yield* repo.settle(id, status, { status: "expired", note: null, input: row.input })
                if (done.modeChanged && done.before !== null) {
                  const was = done.before.permission_mode
                  yield* offer([yield* writeTask(row.task_id, () => ({ permission_mode: was }), cause)])
                }
              }),
            )
            return yield* sent.failure
          }
        }
        yield* db.tx(shown)
        return status
      })

      const applyMode: PermissionsShape["applyMode"] = Effect.fn("Permissions.applyMode")(function* (taskId: TaskId) {
        const task = yield* tasks.get(taskId)
        if (task === null) return
        const allowIt = decisionIn(yield* modeOf(task))
        if (allowIt === null) return
        const rows = (yield* repo.pending({ task: taskId })).filter((r) => r.kind === "tool")
        // Bypass doesn't answer questions for the user, nor what an approval rule asks.
        for (const r of rows.filter((x) => !(allowIt && (isQuestion(x.tool_name) || x.rule !== null)))) {
          // Another client may have answered it in the meantime.
          yield* answer(r.id, allowIt ? { decision: "allow" } : { decision: "deny", message: DONT_ASK_DENIAL }, "mode").pipe(Effect.ignore)
        }
      })

      // ---- Claude's can_use_tool, on the run's files ----

      /** Asks prompt `use` of `run`'s control request `requestId` and answers it on the run's input, unless it was given up on. */
      const answerControl = (run: Run, requestId: string, use: ToolUse) => {
        const call = promptCallId(run.id, requestId)
        return Effect.gen(function* () {
          const taken = yield* SubscriptionRef.modify(inflight, (all) => (all.has(call) ? [false, all] : ([true, new Set([...all, call])] as const)))
          // Another delivery of the same request is being asked: it answers.
          if (!taken) return
          yield* Effect.gen(function* () {
            const before = yield* repo.byCall(call, use.tool_name)
            // Answered before: not again.
            if (Option.isSome(before) && before.value.answered) return
            const asked = yield* decide({ run, call_id: call, control_id: requestId }, use)
            if ((yield* Ref.get(cancelled)).has(call)) return
            const sent = yield* requests.respond(run.id, { subtype: "success", request_id: requestId, response: asked.decision })
            if (sent && asked.id !== null) yield* repo.markAnswered(asked.id)
          }).pipe(
            Effect.ensuring(
              Effect.all([SubscriptionRef.update(inflight, (all) => withoutOne(all, call)), Ref.update(cancelled, (all) => withoutOne(all, call))], {
                concurrency: 1,
                discard: true,
              }),
            ),
          )
        }).pipe(Effect.annotateLogs({ module: "permissions" }))
      }

      const onControl = Effect.fn("Permissions.onControl")(function* (run: Run, line: ControlRequest) {
        const request = line.request
        if (request.subtype !== "can_use_tool" || !("tool_name" in request)) return
        yield* answerControl(run, line.request_id, { tool_name: request.tool_name, input: request.input ?? null, tool_use_id: request.tool_use_id ?? null })
      })

      const onCancel = Effect.fn("Permissions.onCancel")(function* (run: Run, requestId: string) {
        const call = promptCallId(run.id, requestId)
        // Unless it's been answered already.
        if (!(yield* SubscriptionRef.get(inflight)).has(call)) return
        yield* Ref.update(cancelled, (all) => new Set([...all, call]))
        yield* expireFor({ _tag: "Call", call })
      })

      const expireOrphans = Effect.gen(function* () {
        for (const row of yield* repo.orphans) yield* expireOne(row, EXPIRED, "ended", false)
      }).pipe(Effect.withSpan("Permissions.expireOrphans"), Effect.annotateLogs({ module: "permissions" }))

      const resume = Effect.fn("Permissions.resume")(function* (run: Run) {
        for (const row of yield* repo.unanswered(run.id)) {
          if (row.control_id === null) continue
          yield* Effect.logInfo(`run=${run.id} waiting again on permission prompt ${row.control_id}`)
          // The thread's request names the call it is for.
          const stored = yield* store.request(row.task_id, row.id)
          const toolUse = stored?.request.metadata?.["tool_use_id"]
          const use: ToolUse = { tool_name: row.tool_name, input: parsed(row.input), tool_use_id: typeof toolUse === "string" ? toolUse : null }
          yield* FiberSet.run(background, answerControl(run, row.control_id, use))
        }
      })

      const ended = Effect.fn("Permissions.ended")(function* (run: Run, idle: boolean) {
        yield* expireFor(idle ? { _tag: "Task", task: run.task_id } : { _tag: "Run", run: run.id })
      })

      return Permissions.of({
        ask,
        askRule,
        approve,
        asked: (call) =>
          Effect.map(
            repo.asked(call),
            Option.map((row) => parsed(row.input)),
          ),
        answer,
        pending: Effect.fn("Permissions.pending")(function* (filter) {
          return (yield* repo.pending(filter)).map((r): PendingPermission => ({
            id: r.id,
            task_id: r.task_id,
            tool_name: r.tool_name,
            input: parsed(r.input),
            created_at: r.created_at,
            expires_at: r.expires_at,
            rule: r.rule,
          }))
        }),
        approvals: Effect.map(repo.approvals, (rows) => rows.flatMap((r) => Option.toArray(approvalOf(r)))),
        applyMode,
        expireFor,
        sweep,
        expireOrphans,
        resume,
        ended,
        onControl,
        onCancel,
        settled: (call) =>
          SubscriptionRef.changes(inflight).pipe(
            Stream.filter((all) => !all.has(call)),
            Stream.runHead,
            Effect.asVoid,
          ),
        asking: (call) =>
          SubscriptionRef.changes(waiters).pipe(
            Stream.map((all) => [...all].find(([, w]) => w.call === call)?.[0]),
            Stream.filter((id): id is RequestId => id !== undefined),
            Stream.runHead,
            Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : Effect.never)),
          ),
      })
    }),
  )

  /** The sweeper: denies routine runs' prompts as they expire, at once (for those that expired while the board was down), then every 15 s. */
  static readonly sweeper = Layer.effectDiscard(
    Effect.gen(function* () {
      const permissions = yield* Permissions
      yield* nowTimestamp.pipe(
        Effect.flatMap(permissions.sweep),
        Effect.catchCause((cause) => Effect.logWarning("expiring prompts failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.annotateLogs({ module: "permissions" }),
        Effect.forkScoped,
      )
    }),
  )

  /**
   * Claude's `can_use_tool` control requests come here from the runs area (`AgentRequests`), with their cancellations,
   * a re-attached run's open prompts (`resume`) and a run's end (`ended`).
   */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const permissions = yield* Permissions
      const requests = yield* AgentRequests
      yield* requests.register("can_use_tool", {
        handle: permissions.onControl,
        cancel: permissions.onCancel,
        resume: permissions.resume,
        ended: permissions.ended,
      })
    }),
  )
}

const withoutOne = <K>(set: ReadonlySet<K>, key: K): ReadonlySet<K> => new Set([...set].filter((k) => k !== key))
