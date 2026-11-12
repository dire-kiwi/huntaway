import { Effect, Option, Predicate, Schema, SchemaTransformation } from "effect"
import { issueText } from "../family.ts"

// The JSON values an old task row keeps (docs/plan/inventory/09-data-model.md, section 3b, and section 9 items 6 and
// 11), read as the old readers read them (huntaway's db/task_data.ts `*_from_json`, db.ts `json_list`): fields added
// over time default as there (serde's `#[serde(default)]`), an `Option` field missing or null is null, and a field the
// old reader left out when it was null (`skip_serializing_if`) is left out. What comes out is the value the new
// schema reads (the writer checks it strictly, and lists a value it does not read); a value the old reader could not
// read either reads as the old fallback, with a note.

type Plain = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }

/** A key the old reader filled in when it was missing. */
const def = <S extends Plain>(schema: S, value: S["Encoded"]) => schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** An `Option` field: missing or null reads as null. */
const nullable = <S extends Plain>(schema: S) => def(Schema.NullOr(schema), null)

/** A text field the old reader wrote only when it was set: null reads as missing. */
const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(
  Schema.decodeTo(
    Schema.optionalKey(Schema.String),
    SchemaTransformation.transformOptional<string, string | null>({ decode: (o) => Option.filter(o, Predicate.isNotNull), encode: (o) => o }),
  ),
)

/** A field the old reader took whatever was in: `read` makes its value of what is there (undefined when missing). */
const loose = <T>(to: Schema.Codec<T, T>, read: (value: unknown) => T) =>
  Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(to, SchemaTransformation.transformOptional<T, unknown>({ decode: (o) => Option.some(read(Option.getOrUndefined(o))), encode: (o) => o })),
  )

const textOr = (fallback: string) => (v: unknown) => (typeof v === "string" ? v : fallback)
/** Text that is not empty, else null (the tracked list's `opt_str`). */
const someText = (v: unknown) => (typeof v === "string" && v !== "" ? v : null)
const oneOf =
  <L extends string>(values: ReadonlyArray<L>, fallback: L) =>
  (v: unknown): L =>
    values.find((x) => x === v) ?? fallback

const Strings = Schema.Array(Schema.String)

export const OldExternalLink = Schema.Struct({ provider: Schema.String, id: Schema.String, url: Schema.String, title: def(Schema.String, "") })

const OldFailedCheck = Schema.Struct({ name: Schema.String, conclusion: Schema.String, url: nullable(Schema.String) })

export const OldPrChecks = Schema.Struct({
  url: Schema.String,
  head: Schema.String,
  outcome: Schema.String,
  failed: def(Schema.Array(OldFailedCheck), []),
  more_failed: def(Schema.Int, 0),
  pending: def(Schema.Int, 0),
  passed: def(Schema.Int, 0),
  since: Schema.String,
})

export const OldContext = Schema.Struct({
  tokens: Schema.Int,
  max_tokens: nullable(Schema.Int),
  compact_at: nullable(Schema.Int),
  model: nullable(Schema.String),
  updated_at: Schema.String,
  detail_at: nullable(Schema.String),
})

/** Lenient, as the list is the agent's: what isn't text is empty, and an unknown status is pending. */
export const OldTodo = Schema.Struct({
  text: loose(Schema.String, textOr("")),
  status: loose(Schema.Literals(["pending", "in_progress", "completed"]), oneOf(["in_progress", "completed"], "pending")),
})

const TRACKED = ["working", "waiting_user", "waiting_task", "done", "failed"] as const

/** Lenient, as the list is the agent's: an unknown status is working. */
export const OldTrackedItem = Schema.Struct({
  id: loose(Schema.String, textOr("")),
  title: loose(Schema.String, textOr("")),
  note: loose(Schema.NullOr(Schema.String), someText),
  status: loose(Schema.Literals(TRACKED), oneOf(TRACKED, "working")),
  task_id: loose(Schema.NullOr(Schema.String), someText),
  task_key: loose(Schema.NullOr(Schema.String), someText),
  url: loose(Schema.NullOr(Schema.String), someText),
  created_at: loose(Schema.String, textOr("")),
  updated_at: loose(Schema.String, textOr("")),
})

export const OldStartFrom = Schema.Union([
  Schema.Struct({ type: Schema.Literal("branch"), branch: Schema.String }),
  Schema.Struct({ type: Schema.Literal("task"), task_id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("pull_request"), number: Schema.Int, repo: OptionalText }),
  Schema.Struct({ type: Schema.Literal("commit"), commit: Schema.String }),
])

/** Carries: what isn't text reads as null. */
export const OldCarries = Schema.Struct({
  key: loose(Schema.NullOr(Schema.String), (v) => (typeof v === "string" ? v : null)),
  commit: loose(Schema.NullOr(Schema.String), (v) => (typeof v === "string" ? v : null)),
})

const OldReviewerRun = Schema.Struct({
  thread_id: Schema.String,
  // Blank before API 29.
  label: def(Schema.String, ""),
  state: Schema.String,
  summary: nullable(Schema.String),
  issues: def(Strings, []),
  verdict: OptionalText,
  after_run: OptionalText,
})

export const OldReview = Schema.Struct({
  thread_id: Schema.String,
  state: Schema.String,
  head: nullable(Schema.String),
  summary: nullable(Schema.String),
  issues: def(Strings, []),
  verdict: OptionalText,
  fixes: def(Schema.Int, 0),
  extra_rounds: def(Schema.Int, 0),
  updated_at: Schema.String,
  started_at: OptionalText,
  reviewers: def(Schema.Array(OldReviewerRun), []),
})

const OldChangeSummary = Schema.Struct({
  thread_id: Schema.String,
  label: def(Schema.String, ""),
  name: OptionalText,
  skills: def(Strings, []),
  custom_prompt: def(Schema.Boolean, false),
  state: Schema.String,
  head: nullable(Schema.String),
  text: nullable(Schema.String),
  after_run: OptionalText,
  updated_at: Schema.String,
})

/** `tasks.summary`: the list of summaries, or the one summary kept before there could be several (section 9, item 6). */
export const OldSummaries = Schema.Union([Schema.Array(OldChangeSummary), OldChangeSummary])

export const OldRewind = Schema.Struct({ turn: Schema.Int, message_id: Schema.Int, session: Schema.String, resume_at: OptionalText, before_turn: OptionalText })

/** A message sent to a run and not taken in yet (`tasks.steering`). */
export const OldSteer = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  from_agent: def(Schema.Boolean, false),
  run_id: Schema.String,
  written: def(Schema.Boolean, false),
  routine_runs: loose(Strings, (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])),
  routine: loose(Schema.Boolean, (v) => v === true),
})

/** `json_list`: a list of strings, else empty. */
export const OldStrings = Strings

/** What the old reader made of a column: the value (null for a null column), and why it read the fallback, if it did. */
export interface JsonRead<A> {
  readonly value: A | null
  readonly problem: string | null
}

/**
 * A reader of a JSON column with `schema`: null stays null, text that is not JSON or not a value of `schema` reads as
 * `fallback` with the reason, as the old reader read it as its fallback. JSON `null` reads as null.
 */
export const readJson = <S extends Plain>(schema: S, fallback: S["Type"] | null) => {
  const decode = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.NullOr(schema)))
  return (text: string | null): JsonRead<S["Type"]> => {
    if (text === null) return { value: null, problem: null }
    const result = decode(text)
    return result._tag === "Success" ? { value: result.success, problem: null } : { value: fallback, problem: issueText(result.failure) }
  }
}
