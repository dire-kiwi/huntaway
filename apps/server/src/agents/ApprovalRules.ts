import { Context, Effect, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import type {
  ActionOutcome,
  AnsweredBy,
  ApprovalAction,
  ApprovalRulesUpdate,
  ApprovalRulesView,
  Invalid,
  PermissionMode,
  ProfileId,
  RequestId,
  Task,
  TaskId,
} from "@huntaway/contracts"
import { decide, forMode, isBoardTool } from "@huntaway/shared"
import type { Rule, Rules } from "@huntaway/shared"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { elapsedMs, Telemetry } from "../platform/Telemetry.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProfileNotFound } from "../profiles/Profiles.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ApprovalRulesRepo } from "./ApprovalRulesRepo.ts"
import { BOARD_SERVER, boardRule, checkRules, CREATE_TASK_TOOLS, defaultRuleSet, GOOGLE_SERVER, summarize } from "./rules.ts"

/** Most entries `log` lists at once, and how many unless asked. */
export const MAX_LISTED = 500
export const DEFAULT_LISTED = 200

/** What `ApprovalRules.forTask` needs of a thread. */
export type RuledTask = Pick<Task, "id" | "profile_id" | "kind" | "task_type" | "parent_id">

/** A call checked against a rule that asks or refuses, for the action log. */
export interface ActionEntry {
  readonly task: { readonly id: TaskId; readonly profile_id: ProfileId }
  /** The tool as the agent named it (a board tool as `mcp__huntaway__<tool>`). */
  readonly tool: string
  readonly input: unknown
  readonly rule: Rule & { readonly decision: "ask" | "never" }
  /**
   * An ask that raised prompt `request`, pending until `settle`; or what the call came to without one (a never rule's
   * `blocked`, an ask that Don't ask `denied`) and who decided.
   */
  readonly result: { readonly request: RequestId } | { readonly outcome: Exclude<ActionOutcome, "pending">; readonly by: AnsweredBy }
}

export interface ApprovalRulesShape {
  /** A profile's rules as Settings shows them: saved, else the defaults, with the defaults beside them. */
  readonly get: (profile: ProfileId) => Effect.Effect<ApprovalRulesView, ProfileNotFound>
  /**
   * Saves the rules, the expiry or both (what is left out stays as it is), checked and tidied (`checkRules`), or with
   * `reset` goes back to the defaults. They hold from a thread's next run on. Emits `approval_rules`.
   */
  readonly set: (profile: ProfileId, update: ApprovalRulesUpdate) => Effect.Effect<ApprovalRulesView, ProfileNotFound | Invalid>
  /** A profile's rules: the ones saved, or else the defaults. Its routine runs' prompts expire after their `expiry_minutes`. */
  readonly rules: (profile: ProfileId) => Effect.Effect<Rules>
  /** The rules for a thread's runs, if they hold for it: its profile's assistant, and threads whose parent is the assistant. */
  readonly forTask: (task: RuledTask) => Effect.Effect<Rules | null>
  /**
   * For `Permissions`, first: the rule that decides a call of `tool` in `task`'s thread in `mode` (plan mode takes no
   * allow rules), or null when none does, the rules don't hold for the thread, or the tool is a question or a plan.
   */
  readonly decide: (task: RuledTask, tool: string, mode: PermissionMode) => Effect.Effect<Rule | null>
  /**
   * For the board's own tools (`create_task`), which the board decides as it runs them: the rule that decides `tool`
   * under any name the board's server has gone by, and the name it matched.
   */
  readonly decideBoardTool: (task: RuledTask, tool: string) => Effect.Effect<{ readonly name: string; readonly rule: Rule } | null>
  /** Logs a call a rule asked about or refused, inside the caller's transaction if there is one. Emits `approval_log`. */
  readonly record: (entry: ActionEntry) => Effect.Effect<ApprovalAction>
  /**
   * The approval hook blocked a call of `tool` in a Claude run of `task`'s (`blockedToolUses` found it in the run's
   * output): it is logged if a never rule decides it for the hook (not another tool's output that quotes the reason,
   * nor a board tool, which the board logs itself).
   */
  readonly blocked: (task: RuledTask, tool: string, input: unknown) => Effect.Effect<void>
  /** Prompt `request` was answered, expired, or its run ended first: its entry says so. Emits `approval_log` if it had one. */
  readonly settle: (request: RequestId, outcome: "allowed" | "denied" | "expired", by: AnsweredBy) => Effect.Effect<void>
  /** A profile's action log, newest first: `limit` entries (200 unless given, 1 to 500). */
  readonly log: (filter: {
    readonly profile_id: ProfileId
    readonly limit?: number | undefined
  }) => Effect.Effect<ReadonlyArray<ApprovalAction>, ProfileNotFound>
}

const isAssistant = (task: Pick<Task, "kind" | "task_type">) => task.kind === "task" && task.task_type === "assistant"

/** The rules as Settings shows them, given the ones a profile saved (null: none, the defaults hold). */
const view = (saved: Rules | null): ApprovalRulesView => {
  const defaults = defaultRuleSet()
  const rules = saved ?? defaults
  return {
    rules: rules.rules,
    expiry_minutes: rules.expiry_minutes,
    is_default: saved === null,
    defaults,
    board_server: BOARD_SERVER,
    google_server: GOOGLE_SERVER,
    create_task_tools: CREATE_TASK_TOOLS,
  }
}

/**
 * Approval rules (docs/plan/inventory/02-agent-support.md 2.6): for each tool or MCP server, a profile's assistant and
 * the threads under it may use it, ask the user first, or never do, whatever their mode. A Claude run holds them with
 * `huntaway approval-hook` (`claudeHook`), the board's prompt with `decide`, the board's tools with `decideBoardTool`;
 * the calls they ask about or refuse go in the profile's action log.
 */
export class ApprovalRules extends Context.Service<ApprovalRules, ApprovalRulesShape>()("huntaway-server/agents/ApprovalRules") {
  static readonly layer = Layer.effect(
    ApprovalRules,
    Effect.gen(function* () {
      const repo = yield* ApprovalRulesRepo
      const profiles = yield* ProfileRepo
      const tasks = yield* TaskRepo
      const db = yield* Db
      const telemetry = yield* Telemetry
      const events = yield* Events
      const random = yield* SecureRandom.SecureRandom

      const profileExists = (id: ProfileId) =>
        Effect.flatMap(profiles.get(id), (found) => (Option.isSome(found) ? Effect.void : Effect.fail(new ProfileNotFound({ id }))))

      const rules = (profile: ProfileId) => Effect.map(repo.saved(profile), (saved) => saved ?? defaultRuleSet())

      const forTask = Effect.fn("ApprovalRules.forTask")(function* (task: RuledTask) {
        if (!isAssistant(task)) {
          if (task.parent_id === null) return null
          const parent = yield* tasks.get(task.parent_id)
          if (parent === null || !isAssistant(parent)) return null
        }
        return yield* rules(task.profile_id)
      })

      const emitAction = (action: ApprovalAction, profile: ProfileId) =>
        events.emit({ type: "approval_log", profile_id: profile, task_id: action.task_id, action })

      const record = Effect.fn("ApprovalRules.record")(function* (entry: ActionEntry) {
        const id = yield* random.uuidV4().pipe(Effect.orDie)
        const now = yield* nowTimestamp
        const pending = "request" in entry.result
        const action: ApprovalAction = {
          id,
          task_id: entry.task.id,
          request_id: "request" in entry.result ? entry.result.request : null,
          tool_name: entry.tool,
          summary: yield* summarize(entry.input),
          rule: entry.rule.tool,
          decision: entry.rule.decision,
          outcome: "outcome" in entry.result ? entry.result.outcome : "pending",
          answered_by: "by" in entry.result ? entry.result.by : null,
          created_at: now,
          decided_at: pending ? null : now,
        }
        yield* db.tx(Effect.andThen(repo.insert(entry.task.profile_id, action), emitAction(action, entry.task.profile_id)))
        // 6.9: telemetry's `permission`, once it is decided (a prompt's when it is answered: `settle`).
        if (!pending) {
          const { tool_name: tool, decision: status, outcome, rule, answered_by } = action
          yield* telemetry.taskEvent(entry.task.id, { ts: now, event: "permission", tool, status, outcome, attrs: { rule, by: answered_by ?? "" } })
        }
        return action
      })

      return ApprovalRules.of({
        get: Effect.fn("ApprovalRules.get")(function* (profile: ProfileId) {
          return yield* db.tx(Effect.andThen(profileExists(profile), Effect.map(repo.saved(profile), view)))
        }),

        set: Effect.fn("ApprovalRules.set")(function* (profile: ProfileId, update: ApprovalRulesUpdate) {
          return yield* db.tx(
            Effect.gen(function* () {
              yield* profileExists(profile)
              if (update.reset === true) yield* repo.save(profile, null)
              else {
                const current = yield* rules(profile)
                const checked = yield* checkRules({ rules: update.rules ?? current.rules, expiry_minutes: update.expiry_minutes ?? current.expiry_minutes })
                yield* repo.save(profile, checked)
              }
              const saved = view(yield* repo.saved(profile))
              yield* events.emit({ type: "approval_rules", profile_id: profile, rules: saved })
              return saved
            }),
          )
        }),

        rules,
        forTask,

        decide: Effect.fn("ApprovalRules.decide")(function* (task: RuledTask, tool: string, mode: PermissionMode) {
          const held = yield* forTask(task)
          return held === null ? null : decide(forMode(held, mode), tool)
        }),

        decideBoardTool: Effect.fn("ApprovalRules.decideBoardTool")(function* (task: RuledTask, tool: string) {
          const held = yield* forTask(task)
          return held === null ? null : boardRule(held, tool)
        }),

        record,

        blocked: Effect.fn("ApprovalRules.blocked")(function* (task: RuledTask, tool: string, input: unknown) {
          const held = yield* forTask(task)
          if (held === null || isBoardTool(tool)) return
          const rule = decide(held, tool)
          if (rule === null || rule.decision !== "never") return
          yield* record({ task, tool, input, rule: { tool: rule.tool, decision: "never" }, result: { outcome: "blocked", by: "rule" } })
        }),

        settle: Effect.fn("ApprovalRules.settle")(function* (request: RequestId, outcome: "allowed" | "denied" | "expired", by: AnsweredBy) {
          const now = yield* nowTimestamp
          yield* db
            .tx(
              Effect.gen(function* () {
                const row = yield* repo.settle(request, outcome, by, now)
                if (row === null) return null
                const { profile_id, ...action } = row
                yield* emitAction(action, profile_id)
                return action
              }),
            )
            .pipe(
              // 6.9: telemetry's `permission`, with how long it waited.
              Effect.tap((action) =>
                action === null
                  ? Effect.void
                  : telemetry.taskEvent(action.task_id, {
                      event: "permission",
                      tool: action.tool_name,
                      status: action.decision,
                      outcome,
                      wait_ms: elapsedMs(action.created_at, now),
                      attrs: { rule: action.rule, by },
                    }),
              ),
            )
        }),

        log: Effect.fn("ApprovalRules.log")(function* (filter: { readonly profile_id: ProfileId; readonly limit?: number | undefined }) {
          yield* profileExists(filter.profile_id)
          const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LISTED), 1), MAX_LISTED)
          return yield* repo.list(filter.profile_id, limit)
        }),
      })
    }),
  )
}
