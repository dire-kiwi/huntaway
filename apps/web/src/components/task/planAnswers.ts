/**
 * A plan's questions: the <ia-question>s (and other named form fields) its agent put in it, which the plan's frame
 * reports (iaForm in planTheme.ts). HE-122: an older task's plan is read only, so they're no longer answered and sent.
 */
import { type PlanAnswers, type PlanValue } from "../../state/drafts"

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
