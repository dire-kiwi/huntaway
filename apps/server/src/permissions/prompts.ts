import { Predicate, Result } from "effect"
import { Effort, PermissionMode as PermissionModes } from "@huntaway/contracts"
import type { PermissionMode } from "@huntaway/contracts"
import { lateAnswers as lateAnswersText } from "../prompts/planAnswer.ts"

// The plain part of permission prompts (huntaway's mcp/permissions.ts): what a prompt waits for, what its mode decides,
// and how a question's answers are checked and given to the agent. No I/O; `Permissions` uses them.

/** Why a request wasn't answered: its run ended or its thread was deleted first. */
export const EXPIRED = "Request expired"

/** Why a request from a routine run wasn't answered: nobody did in time (the sweeper). */
export const EXPIRED_UNANSWERED =
  "Nobody answered this in time, so it was denied. Carry on without this action, and say in your report what you couldn't do and why."

/**
 * What the agent is told of a prompt the user skipped: they sent the thread a message instead of answering it
 * (`Permissions.skipFor`), which it reads next.
 */
export const SKIPPED =
  "Skipped: the user did not approve this. They sent you a new message instead of answering, so read it now, and don't retry this unless their message asks you to."

export const DONT_ASK_DENIAL = 'Denied automatically: this thread is in "Don\'t ask" mode.'

/** Why `permissions.answer`'s `input` is refused (HE-23): Codex's approval can't carry one, nor anything but a tool call allowed. */
export const EDIT_REFUSED = "only a tool call of a Claude Code run, allowed, takes an edited input"

/** What the agent is told of a denial without a message. */
export const DENIED = "The user denied this action."

/** Claude Code's tool for asking the user multiple-choice questions, answered with the answers in its input (`answers`). */
export const ASK_USER = "AskUserQuestion"
/** What Codex's questions are asked as: AskUserQuestion's input with each question's `id`, answered by id. */
export const CODEX_QUESTIONS = "request_user_input"
/** Claude Code's tool for presenting a plan in plan mode: allowed, the agent carries on with it; denied, it keeps planning. */
export const EXIT_PLAN = "ExitPlanMode"

/** A prompt's kind (`permission_requests.kind`): a tool call, or one of the board's own approvals. */
export type PromptKind = "tool" | "project" | "delete_task" | "automation"

/** What the agent is told: Claude Code's `can_use_tool` answer. */
export type Decision =
  | {
      readonly behavior: "allow"
      readonly updatedInput: unknown
      readonly updatedPermissions?: ReadonlyArray<{ readonly type: "setMode"; readonly mode: PermissionMode; readonly destination: "session" }>
    }
  | { readonly behavior: "deny"; readonly message: string }

export const allow = (input: unknown): Decision => ({ behavior: "allow", updatedInput: input ?? null })
export const deny = (message: string): Decision => ({ behavior: "deny", message })

/** Whether prompts for `tool` ask the user questions: only the user answers them, whatever the mode but Don't ask. */
export const isQuestion = (tool: string): boolean => tool === ASK_USER || tool === CODEX_QUESTIONS

/**
 * Tool prompts only the user answers: Bypass doesn't allow them, and they can't be always allowed. HE-49's
 * `space_request_sign_ins` sends the host browser's sign-ins into a Space, where the agent could read them.
 */
export const USER_ONLY: ReadonlySet<string> = new Set(["mcp__spaces__space_request_sign_ins"])

/**
 * Whether only the user answers a tool prompt: Bypass doesn't answer questions for the user, nor what an approval rule
 * asks, nor `USER_ONLY`'s; and none of them can be always allowed.
 */
export const onlyTheUser = (tool: string, rule: string | null): boolean => isQuestion(tool) || rule !== null || USER_ONLY.has(tool)

/**
 * Whether a prompt is skipped when the user sends the thread a message (`Permissions.skipFor`): a tool call or one of
 * the board's own approvals, not a question or a plan, which a message doesn't answer.
 */
export const skippedByMessage = (kind: string, tool: string): boolean => kind !== "tool" || !(isQuestion(tool) || tool === EXIT_PLAN)

/** What a thread's mode decides for any prompt without asking: allow (Bypass), deny (Don't ask), or ask (null). */
export const decisionIn = (mode: PermissionMode): boolean | null => (mode === "bypassPermissions" ? true : mode === "dontAsk" ? false : null)

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ")

/** A question prompt's questions. */
export const questionsOf = (input: unknown): ReadonlyArray<unknown> =>
  Predicate.isObject(input) && Array.isArray(input["questions"]) ? input["questions"] : []

const textOf = (q: unknown, key: string): string | undefined => (Predicate.isObject(q) && typeof q[key] === "string" ? q[key] : undefined)

/** What a task waiting on a prompt for `tool` says it is waiting for (its attention reason). */
export const reason = (tool: string, input: unknown): string => {
  if (isQuestion(tool)) {
    const questions = questionsOf(input)
    const found = questions.map((q) => textOf(q, "question")).find((q) => q !== undefined)
    const first = found === undefined ? "" : oneLine(found)
    if (first === "") return "The agent has questions for you"
    const n = questions.length
    if (n <= 1) return first
    return `${first} (and ${n - 1} more question${n === 2 ? "" : "s"})`
  }
  if (tool === EXIT_PLAN) {
    // The plan's title, if it starts with one ("# Plan: add a cache").
    let title: string | null = null
    const plan = textOf(input, "plan")
    if (plan !== undefined) {
      const line = plan
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "")
      if (line?.startsWith("#") === true) {
        const t = oneLine(line.slice(1).replace(/^#+/, ""))
        title = t.startsWith("Plan:") ? t.slice(5).trim() : t
      }
    }
    return title !== null && title !== "" ? `Plan ready for approval: ${title}` : "Plan ready for approval"
  }
  return `Approve ${tool}?`
}

/** The question an approval of the board's own asks (its attention reason). */
export const approvalQuestion = (kind: PromptKind, tool: string, input: unknown): string => {
  const workflow = Predicate.isObject(input) && input["workflow"] !== undefined && input["workflow"] !== null
  const remove = Predicate.isObject(input) && input["op"] === "delete"
  if (kind === "delete_task") return "Delete a task?"
  if (kind === "automation" && workflow) return remove ? "Delete a workflow?" : "Approve a workflow?"
  if (kind === "automation") return remove ? "Delete an automation?" : "Approve an automation?"
  if (kind === "project" && tool === "create_project") return "Add a project?"
  return "Approve a project change?"
}

/** The kind an approval shows: `workflow` for a workflow's (asked as an automation's, with `workflow` in its input). */
export const shownKind = (kind: string, input: unknown): string =>
  kind === "automation" && Predicate.isObject(input) && input["workflow"] !== undefined && input["workflow"] !== null ? "workflow" : kind

/**
 * The answers to a question prompt's questions, trimmed, checked against them: one list per question, and a question
 * that takes one answer gets at most one. Fails with why.
 */
export const checkAnswers = (input: unknown, answers: ReadonlyArray<ReadonlyArray<string>>): Result.Result<ReadonlyArray<ReadonlyArray<string>>, string> => {
  const qs = questionsOf(input)
  if (answers.length !== qs.length) return Result.fail(`answers must have one list for each of the ${qs.length} questions`)
  const out: Array<ReadonlyArray<string>> = []
  for (const [i, q] of qs.entries()) {
    const a = (answers[i] ?? []).map((x) => x.trim()).filter((x) => x !== "")
    if (a.length > 1 && !(Predicate.isObject(q) && q["multiSelect"] === true)) return Result.fail(`"${textOf(q, "question") ?? "?"}" takes one answer`)
    out.push(a)
  }
  return Result.succeed(out)
}

/** The answers as the agent's tool takes them: Claude Code's by question text, joined by commas; Codex's by question id. */
export const toolAnswers = (tool: string, input: unknown, answers: ReadonlyArray<ReadonlyArray<string>>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [i, q] of questionsOf(input).entries()) {
    const a = answers[i]
    if (a === undefined || a.length === 0) continue
    if (tool === CODEX_QUESTIONS) out[textOf(q, "id") ?? ""] = { answers: a }
    else out[textOf(q, "question") ?? ""] = a.join(", ")
  }
  return out
}

/** The answers as the thread shows them: a secret's hidden. */
export const shownAnswers = (input: unknown, answers: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<ReadonlyArray<string>> =>
  questionsOf(input)
    .slice(0, answers.length)
    .map((q, i) => {
      const a = answers[i] ?? []
      return Predicate.isObject(q) && q["isSecret"] === true && a.length > 0 ? ["(hidden)"] : a
    })

/** The user's message with the answers to questions asked in a run that ended first. */
export const lateAnswers = (input: unknown, answers: ReadonlyArray<ReadonlyArray<string>>): string => {
  const shown = shownAnswers(input, answers)
  return lateAnswersText(
    questionsOf(input)
      .slice(0, shown.length)
      .map((q, i) => ({ question: textOf(q, "question") ?? "?", answers: shown[i] ?? [] })),
  )
}

/**
 * The permission mode a thread carries on in once its plan is approved, if it changes (undefined if it doesn't): the one
 * the user picked (null when that is the inherited one), or else, if it is planning, the inherited one (Ask if that is
 * Plan too). `own` is the thread's own mode, `inherited` its project's or the host's.
 */
export const modeAfterPlan = (own: PermissionMode | null, inherited: PermissionMode, picked: PermissionMode | null): PermissionMode | null | undefined => {
  const current = own ?? inherited
  if (picked !== null) {
    // The mode it's in (the agent went into plan mode by itself): a thread's own mode stays its own.
    if (picked === current && current !== "plan") return undefined
    if (picked === inherited) return null
    return picked
  }
  if (current === "plan") return inherited === "plan" ? "default" : null
  return undefined
}

/** Whether `mode` is a mode a plan may be approved into. */
export const isPlanMode = (mode: string): boolean => mode === "plan" || !PermissionModes.literals.some((m) => m === mode)

const EFFORTS: ReadonlyArray<string> = Effort.literals

/**
 * The automation approval `input` with the model and effort the user picked for its create_task action, in what it shows
 * and in what it applies; null if they're as the agent asked. Fails with why for an approval it doesn't fit.
 */
export const withModelEffort = (
  input: unknown,
  edit: { readonly model?: string | null | undefined; readonly effort?: string | null | undefined },
): Result.Result<unknown, string> => {
  const view = Predicate.isObject(input) ? input["automation"] : undefined
  const action = Predicate.isObject(view) ? view["action"] : undefined
  if (
    !Predicate.isObject(input) ||
    !Predicate.isObject(view) ||
    !Predicate.isObject(action) ||
    input["op"] === "delete" ||
    (input["workflow"] !== undefined && input["workflow"] !== null) ||
    action["kind"] !== "create_task" ||
    !Predicate.isObject(input["apply"])
  ) {
    return Result.fail("automation (a model and effort) is only for approving an automation that creates tasks")
  }
  const next: Record<string, unknown> = { ...action }
  if ("model" in edit) next["model"] = edit.model?.trim() || null
  if ("effort" in edit) {
    const effort = edit.effort || null
    if (effort !== null && !EFFORTS.includes(effort)) return Result.fail(`effort must be one of ${EFFORTS.join(", ")}`)
    next["effort"] = effort
  }
  if (next["model"] === action["model"] && next["effort"] === action["effort"]) return Result.succeed(null)
  const out: Record<string, unknown> = { ...input, automation: { ...view, action: next }, apply: { ...input["apply"], action: next } }
  // A change that left the action as it was changes it now.
  const changes = input["changes"]
  if (input["op"] === "update" && Array.isArray(changes) && !changes.includes("action")) {
    out["changes"] = [...changes.filter((c): c is string => typeof c === "string"), "action"].toSorted((x, y) => x.localeCompare(y))
  }
  return Result.succeed(out)
}
