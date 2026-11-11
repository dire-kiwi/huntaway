/**
 * Answers to a plan's questions: the <ia-question>s (and other named form fields) its agent puts in
 * it, which the plan's frame reports (iaForm in planTheme.ts). The user's answers are kept in this
 * browser as a draft until they send them to the agent (state/drafts.ts, under the old key), so they last across
 * reloads of the plan (each change the agent makes reloads it) and of the board.
 */
import { toJson } from "../ui/json"
import { loadPlanAnswers, savePlanAnswers, type PlanAnswers, type PlanValue } from "../../state/drafts"

export type { PlanAnswers, PlanValue }

/** A question in the plan, as its frame reports it. */
export type PlanField = {
  name: string
  /** The question, or "" if the plan doesn't say. */
  label: string
  type: string
  value: PlanValue
  /** The answer in words: the chosen options' labels, or what's typed. Empty when it's unanswered. */
  answer: string[]
  /** Whether the user changed it (or it has a saved answer), rather than it being as the plan has it. */
  touched: boolean
  /** Its value and answer as the plan has them, which Reset puts back. */
  initial: { value: PlanValue; answer: string[] }
}

/** Limits on what a plan's frame (whose scripts the agent writes) can hand the board. */
const MAX_FIELDS = 200
const MAX_TEXT = 20000

const str = (x: unknown) => (typeof x === "string" ? x.slice(0, MAX_TEXT) : "")
const strs = (x: unknown) => (Array.isArray(x) ? x.slice(0, MAX_FIELDS).map(str) : [])

const answersIn = (x: unknown) => strs(x).filter((a) => a.trim())

function readValue(x: unknown): PlanValue {
  const v = strs(typeof x === "object" && x !== null && "v" in x ? x.v : undefined)
  const o = typeof x === "object" && x !== null && "o" in x ? x.o : undefined
  return typeof o === "string" && o ? { v, o: str(o) } : { v }
}

/** The fields in an iaForm message from a plan's frame, or null if it isn't one. */
export function readFields(data: unknown): PlanField[] | null {
  const list = typeof data === "object" && data !== null && "iaForm" in data ? data.iaForm : undefined
  if (!Array.isArray(list)) return null
  return list
    .slice(0, MAX_FIELDS)
    .filter((f) => typeof f?.name === "string" && f.name)
    .map((f) => ({
      name: str(f.name),
      label: str(f.label),
      type: str(f.type),
      value: readValue(f.value),
      answer: answersIn(f.answer),
      touched: !!f.touched,
      initial: { value: readValue(f.initial?.value), answer: answersIn(f.initial?.answer) },
    }))
}

/** The answers the user hasn't sent yet for a task's plan. */
export const loadAnswers = (hostId: string, taskId: string): PlanAnswers => loadPlanAnswers(hostId, taskId, readValue)

export const saveAnswers = (hostId: string, taskId: string, answers: PlanAnswers): void => savePlanAnswers(hostId, taskId, answers)

/** The saved answers with those of `fields` the user has touched: questions the plan no longer has keep theirs until they're sent. */
export const withTouched = (answers: PlanAnswers, fields: PlanField[]): PlanAnswers => ({
  ...answers,
  ...Object.fromEntries(fields.filter((f) => f.touched).map((f) => [f.name, f.value])),
})

/** Checkboxes the user left with none ticked: that's an answer too (none of them), unlike other empty fields. */
const noneChosen = (f: PlanField) => !f.answer.length && f.touched && f.type === "checkbox"

export const isAnswered = (f: PlanField) => f.answer.length > 0 || noneChosen(f)

export const answered = (fields: PlanField[]) => fields.filter(isAnswered).length

/** The fields as the plan has them, as Reset leaves them (also when the plan's frame isn't there to report them). */
export const resetFields = (fields: PlanField[]): PlanField[] => fields.map((f) => ({ ...f, value: f.initial.value, answer: f.initial.answer, touched: false }))

const same = (a: PlanValue | undefined, b: PlanValue | undefined) => toJson(a) === toJson(b)

/**
 * After a send, with the saved answers as they were when it started (`before`) and as they are now (the user can go
 * on answering while it's sent, also in a view of the task opened since): the answers left to send, which are those
 * changed since it started, and the names of those it sent as they are, which are no longer the user's own.
 */
export function afterSend(before: PlanAnswers, now: PlanAnswers): { answers: PlanAnswers; sentAsIs: string[] } {
  const sentAsIs = Object.keys(now).filter((name) => name in before && same(before[name], now[name]))
  return { answers: Object.fromEntries(Object.entries(now).filter(([name]) => !sentAsIs.includes(name))), sentAsIs }
}

/** One of a question's answers, in the message: text over several lines is quoted, as Markdown. */
const item = (a: string) =>
  a.includes("\n")
    ? a
        .split("\n")
        .map((l) => `  > ${l}`.trimEnd())
        .join("\n")
    : `  - ${a}`

/** The message that sends the answers to the agent: each question with its answer, by name. */
export function answersMessage(fields: PlanField[], version?: number | null): string {
  const lines = fields.map((f) => {
    const q = f.label && f.label !== f.name ? `${f.label} (\`${f.name}\`)` : `\`${f.name}\``
    const [first, ...rest] = f.answer
    if (first === undefined) return `- ${q}: ${noneChosen(f) ? "(none of the choices)" : "(no answer)"}`
    if (!rest.length && !first.includes("\n")) return `- ${q}: ${first}`
    return `- ${q}:\n${f.answer.map(item).join("\n")}`
  })
  return `My answers to the questions in the plan${version ? ` (v${version})` : ""}:\n\n${lines.join("\n")}\n\nPlease update the plan with them.`
}
