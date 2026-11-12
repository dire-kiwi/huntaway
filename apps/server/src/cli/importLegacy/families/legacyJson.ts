import { Option, Schema } from "effect"
import { Status } from "@huntaway/contracts"
import { DEFAULT_EXPIRY_MINUTES } from "../../../agents/rules.ts"

// JSON columns and settings as the old readers read them (inventory 09, section 3: readers never throw on bad JSON; they
// return null, `[]` or a default), so a family writes what the old server showed, in the form the new one reads.

/** A value read the way the old reader read it: `readable` false when it fell back to its default. */
export interface Read<A> {
  readonly value: A
  readonly readable: boolean
}

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const isStringList = Schema.is(Schema.Array(Schema.String))
const isList = Schema.is(Schema.Array(Schema.Unknown))

/** The old `db.json_list`: a JSON list of strings; anything else is `[]`. */
export const jsonList = (text: string | null): Read<ReadonlyArray<string>> => {
  if (text === null) return { value: [], readable: true }
  const v = parseJson(text)
  return Option.isSome(v) && isStringList(v.value) ? { value: v.value, readable: true } : { value: [], readable: false }
}

const OptText = Schema.optionalKey(Schema.NullOr(Schema.String))
/** The old `Reviewer_from_json`: config, model and effort may be missing or null; skills a list of strings if there. */
const OldReviewer = Schema.Struct({
  claude_config_id: OptText,
  model: OptText,
  effort: OptText,
  name: OptText,
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  prompt: OptText,
})
const decodeReviewer = Schema.decodeUnknownOption(OldReviewer)

/** A reviewer or summarizer as the wire's `Reviewer` has it. */
export interface NewReviewer {
  readonly claude_config_id: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly name?: string
  readonly skills?: ReadonlyArray<string>
  readonly prompt?: string
}

const reviewerFrom = (v: unknown): Option.Option<NewReviewer> =>
  Option.map(decodeReviewer(v), (r) => ({
    claude_config_id: r.claude_config_id ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    ...(r.name == null ? {} : { name: r.name }),
    ...(r.skills === undefined || r.skills.length === 0 ? {} : { skills: r.skills }),
    ...(r.prompt == null ? {} : { prompt: r.prompt }),
  }))

/** The old `json_vec(…, Reviewer_from_json)`: a list of reviewers; not a list, or one that doesn't read, is `[]`. */
export const reviewerList = (text: string | null): Read<ReadonlyArray<NewReviewer>> => {
  if (text === null) return { value: [], readable: true }
  const v = parseJson(text)
  if (Option.isNone(v) || !isList(v.value)) return { value: [], readable: false }
  const out: Array<NewReviewer> = []
  for (const item of v.value) {
    const r = reviewerFrom(item)
    if (Option.isNone(r)) return { value: [], readable: false }
    out.push(r.value)
  }
  return { value: out, readable: true }
}

/**
 * The old `summarizers_column` (inventory 09, section 9, item 6): the `summarizers` list if it has any, else the single
 * `summarizer` saved before there could be several, as a list of one.
 */
export const summarizersOf = (list: string | null, single: string | null): Read<ReadonlyArray<NewReviewer>> => {
  const l = reviewerList(list)
  if (l.value.length > 0) return l
  if (single === null) return l
  const s = Option.flatMap(parseJson(single), reviewerFrom)
  return Option.isSome(s) ? { value: [s.value], readable: l.readable } : { value: [], readable: false }
}

const isStatus = Schema.is(Status)
const isStringRecord = Schema.is(Schema.Record(Schema.String, Schema.String))

/** The old `string_map` of `status_scripts`, keys sorted; keys that are not a status are left out (not readable). */
export const statusScripts = (text: string | null): Read<Readonly<Record<string, string>>> => {
  if (text === null) return { value: {}, readable: true }
  const v = parseJson(text)
  if (Option.isNone(v) || !isStringRecord(v.value)) return { value: {}, readable: false }
  const entries = Object.entries(v.value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const kept = entries.filter(([k]) => isStatus(k))
  return { value: Object.fromEntries(kept), readable: kept.length === entries.length }
}

/** Rules as the old `parse_rules` read them: `expiry_minutes` an unsigned 32-bit count, its default when missing. */
const OldRules = Schema.Struct({
  rules: Schema.Array(Schema.Struct({ tool: Schema.String, decision: Schema.Literals(["allow", "ask", "never"]) })),
  expiry_minutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff }))),
})
const decodeRules = Schema.decodeUnknownOption(OldRules)

/** A profile's rules as stored (`profiles.approval_rules`). */
export interface NewRules {
  readonly rules: ReadonlyArray<{ readonly tool: string; readonly decision: "allow" | "ask" | "never" }>
  readonly expiry_minutes: number
}

/**
 * An `approval_rules:<profile id>` setting as the old `approval_rules.saved` read it; none when it doesn't read, which
 * the old server took as the defaults.
 */
export const approvalRulesFrom = (text: string): Option.Option<NewRules> =>
  Option.map(Option.flatMap(parseJson(text), decodeRules), (r) => ({
    rules: r.rules.map((rule) => ({ tool: rule.tool, decision: rule.decision })),
    expiry_minutes: r.expiry_minutes ?? DEFAULT_EXPIRY_MINUTES,
  }))
