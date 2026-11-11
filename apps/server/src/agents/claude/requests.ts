import type { PermissionRequest, Question, ThreadMetadata, ThreadRequest, Timestamp, ToolKind } from "@huntaway/contracts"
import { HashMap, Predicate } from "effect"
import { Draft, get, sameSession, type TranslateWarning, type TranslatorState } from "./state.ts"
import { question, sameJson, str, toolFields, toolTitle } from "./tools.ts"

// A permission prompt as a thread request, and the call it is for: the request half of the old translator's
// `permission`, for the permissions area to open with `Threads.openRequest`. The board writes requests itself now
// (docs/plan/07-agents.md, Threads), but which call a prompt is for is the translator's to say, since it knows the calls:
// a prompt can name a call that has not come yet, or one of several with the same id.

/** The tools whose prompts are a plan and questions. */
export const EXIT_PLAN = "ExitPlanMode"
export const ASK_USER = "AskUserQuestion"

/** A prompt for the user: Claude's can_use_tool, or one of the board's own approvals. */
export interface Prompt {
  /** The request's id (`permission_requests.id`). */
  readonly id: string
  readonly tool_name: string
  readonly input: unknown
  /** The call it is for, as the agent names it. */
  readonly tool_use_id?: string | undefined
  /** One of the board's own approvals (`project`, `delete_task`, `automation`, `workflow`): its kind is `app`. */
  readonly kind?: string | undefined
  readonly created_at?: Timestamp | undefined
  readonly metadata?: ThreadMetadata | undefined
}

/** The call a prompt is linked to, and the subagent call asking it. */
export interface PromptLink {
  readonly tool_call_id?: string
  readonly parent_id?: string
}

/**
 * The call prompt `requestId` for tool_use id `toolUseId` (with `input`) is for. With no call with the id yet, it is the
 * one to come (the first call with an id has it as its item's). With one, it is that one if it could still ask (it has no
 * result) or has the input; with several, the one with the input that could still ask in the current session. With none
 * that could, the prompt waits for a call with its id and input to come (and `translate` opens the request again, linked,
 * when it does); with several, there is no telling.
 */
export const linkPrompt = (
  state: TranslatorState,
  prompt: { readonly requestId: string; readonly toolUseId: string; readonly input: unknown },
): { readonly state: TranslatorState; readonly link: PromptLink; readonly warnings: ReadonlyArray<TranslateWarning> } => {
  const d = new Draft(state)
  const { requestId, toolUseId: id, input } = prompt
  const all = d.callsWith(id)
  if (all.length === 0) return { state, link: { tool_call_id: id }, warnings: [] }
  const found = all.filter((c) => !c.hasResult && sameSession(c.session, state.session) && sameJson(c.input, input))
  const only = all.length === 1 ? all[0] : undefined
  let call = found.length === 1 ? found[0] : undefined
  if (found.length > 1) d.warn("ambiguous_call", `a prompt for call ${id}, which ${found.length} calls with the id and its input could have asked`)
  else if (call === undefined && only !== undefined && sameJson(only.input, input)) call = only
  else if (call === undefined) {
    // The one call that could still ask, whose input the prompt's needn't quite be (Codex's approvals say less): its for
    // now, unless a call with the id and the input comes.
    call = only !== undefined && !only.hasResult ? only : undefined
    const waiting = [...(get(state.waitingPrompts, id) ?? []), { request: requestId, input, linked: call !== undefined }]
    d.s = { ...d.s, waitingPrompts: HashMap.set(d.s.waitingPrompts, id, waiting) }
  }
  if (call === undefined) return { state: d.s, link: {}, warnings: d.warnings }
  const parent = d.parentOf(call)
  return { state: d.s, link: { tool_call_id: call.item, ...(parent === undefined ? {} : { parent_id: parent }) }, warnings: d.warnings }
}

/**
 * Prompt `prompt` as the request the thread shows: a plan for ExitPlanMode, questions for AskUserQuestion (told apart by
 * their text when all differ, and always taking an answer of one's own), otherwise a permission for the tool, with its
 * kind, server and title as its call has them. Linked to its call as `linkPrompt` says. Null for a question prompt with
 * no questions.
 */
export const requestForPrompt = (
  state: TranslatorState,
  prompt: Prompt,
): { readonly state: TranslatorState; readonly request: ThreadRequest | null; readonly warnings: ReadonlyArray<TranslateWarning> } => {
  const linked =
    prompt.tool_use_id === undefined
      ? { state, link: {}, warnings: [] }
      : linkPrompt(state, { requestId: prompt.id, toolUseId: prompt.tool_use_id, input: prompt.input ?? {} })
  const input = prompt.input ?? {}
  const base = {
    id: prompt.id,
    ...linked.link,
    ...(prompt.created_at === undefined ? {} : { created_at: prompt.created_at }),
    ...(prompt.metadata === undefined ? {} : { metadata: prompt.metadata }),
  }
  const done = (request: ThreadRequest | null, warnings: ReadonlyArray<TranslateWarning> = []) => ({
    state: linked.state,
    request,
    warnings: [...linked.warnings, ...warnings],
  })
  if (prompt.tool_name === EXIT_PLAN) return done({ ...base, type: "plan", plan: str(input, "plan") ?? "" })
  if (prompt.tool_name === ASK_USER) {
    const asked: ReadonlyArray<unknown> = Predicate.isObject(input) && Array.isArray(input["questions"]) ? input["questions"] : []
    const texts = asked.map((q) => (Predicate.isObject(q) && typeof q["question"] === "string" ? q["question"] : ""))
    const byText = texts.every((t, i) => t !== "" && texts.indexOf(t) === i)
    const questions = asked.map((q, i): Question => question(q, str(q, "id") ?? (byText ? (texts[i] ?? "") : String(i)), true))
    const [first, ...rest] = questions
    if (first === undefined) return done(null, [{ code: "empty_question", text: "a question prompt with no questions" }])
    return done({ ...base, type: "question", questions: [first, ...rest] })
  }
  const fields = toolFields(prompt.tool_name, input)
  // The board's own approvals (a project change, deleting a task, an automation) are for its tools.
  const kind: ToolKind = prompt.kind !== undefined && prompt.kind !== "tool" ? "app" : fields.kind
  const request: PermissionRequest = {
    ...base,
    type: "permission",
    kind,
    name: fields.name,
    input,
    ...(fields.server !== undefined && kind === "mcp" ? { server: fields.server } : {}),
    title: toolTitle(fields),
  }
  return done(request)
}
