import { Predicate, Result, Schema } from "effect"
import { BOARD_TOOLS_METHOD, MODEL_METHOD } from "./items.ts"
import type { CodexRequest } from "./requests.ts"

// The lines of a Codex run's `out.jsonl` that the server reads (docs/plan/inventory/01-run-lifecycle.md, section 5,
// _Codex_): what the adapter (`huntaway codex-run`) writes there. The app-server's notifications it keeps, passed through
// as they are; the app-server's requests, with the item they are about attached; `serverRequest/resolved` for a request
// the app-server stopped waiting for; its own `huntaway/model` and `huntaway/boardTools`; and the Claude-shaped echo of
// a message the model has taken in. A schema each, told apart by `method` (or, for the echo, `type`). A notification's
// `params` stay `Schema.Unknown`: the translator reads them leniently, field by field, as the old driver did, since
// they are Codex's own protocol and a newer Codex adds to them. `decodeLine` never throws: a line that is not JSON, not
// one of these, or one of these with a field of the wrong type is a `LineProblem`, which the caller logs and skips.

/** The app-server's notifications the adapter keeps (its `KEEP`): the others are noise or too bulky. */
export const KEPT_METHODS = [
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "thread/compacted",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "error",
  "warning",
  "model/rerouted",
  "mcpServer/startupStatus/updated",
] as const
export type KeptMethod = (typeof KEPT_METHODS)[number]

const RpcId = Schema.Union([Schema.Finite, Schema.String])

/** A notification the adapter passed through: its method and params, as Codex sent them. */
const NotificationLine = Schema.Struct({
  method: Schema.Literals(KEPT_METHODS),
  params: Schema.optionalKey(Schema.Unknown),
  emittedAtMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})

/** One of the app-server's requests (an approval, a question, a dynamic tool's call), with the item it is about. */
const RequestLine = Schema.Struct({ id: RpcId, method: Schema.String, params: Schema.optionalKey(Schema.Unknown), item: Schema.optionalKey(Schema.Unknown) })

/** The app-server no longer wants request `requestId` answered (the adapter says so only of one the board hasn't answered). */
const ResolvedLine = Schema.Struct({
  method: Schema.Literal("serverRequest/resolved"),
  params: Schema.Struct({ requestId: Schema.optionalKey(Schema.NullOr(RpcId)) }),
})

/** The adapter's: the model a thread runs on, for the board's token counts. */
const ModelLine = Schema.Struct({
  method: Schema.Literal(MODEL_METHOD),
  params: Schema.Struct({ threadId: Schema.optionalKey(Schema.NullOr(Schema.String)), model: Schema.String }),
})

/** The adapter's: whether a new thread took the board's tools as dynamic tools (`dynamic: false` when Codex wouldn't). */
const BoardToolsLine = Schema.Struct({
  method: Schema.Literal(BOARD_TOOLS_METHOD),
  params: Schema.Struct({ dynamic: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) }),
})

/** The adapter's echo of a message the model has taken in, shaped as Claude Code's `--replay-user-messages`. */
const EchoLine = Schema.Struct({
  type: Schema.Literal("user"),
  isReplay: Schema.Literal(true),
  uuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** A line the server reads. */
export type CodexLine =
  | {
      readonly _tag: "Notification"
      readonly method: KeptMethod
      /** Null when the notification had none. */
      readonly params: unknown
      readonly emittedAtMs: number | null
    }
  | { readonly _tag: "Request"; readonly request: CodexRequest }
  | { readonly _tag: "Resolved"; readonly requestId: string | number | null }
  | { readonly _tag: "Model"; readonly threadId: string | null; readonly model: string }
  | { readonly _tag: "BoardTools"; readonly dynamic: boolean | null }
  | { readonly _tag: "Echo"; readonly uuid: string | null }

/** Why a line is skipped. */
export type LineProblem =
  /** Not a JSON object. */
  | { readonly _tag: "NotJson" }
  /** A line the server has no use for: a response, a notification the adapter would not keep. */
  | { readonly _tag: "Ignored"; readonly method: string }
  /** A method (or type) the server does not know. */
  | { readonly _tag: "Unknown"; readonly method: string }
  /** One of the lines above with a field the server reads of the wrong type. */
  | { readonly _tag: "Malformed"; readonly method: string; readonly issue: string }

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const decodeNotification = Schema.decodeUnknownResult(NotificationLine)
const decodeRequest = Schema.decodeUnknownResult(RequestLine)
const decodeResolved = Schema.decodeUnknownResult(ResolvedLine)
const decodeModel = Schema.decodeUnknownResult(ModelLine)
const decodeBoardTools = Schema.decodeUnknownResult(BoardToolsLine)
const decodeEcho = Schema.decodeUnknownResult(EchoLine)
const isKept = (method: string): method is KeptMethod => KEPT_METHODS.some((m) => m === method)

const malformed = (method: string, e: Schema.SchemaError): Result.Result<CodexLine, LineProblem> => Result.fail({ _tag: "Malformed", method, issue: e.message })

/** A value decoded into a line, or the problem with it. */
export const decodeValue = (value: unknown): Result.Result<CodexLine, LineProblem> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) return Result.fail({ _tag: "NotJson" })
  const method = value["method"]
  if (typeof method !== "string") {
    // The echo; or a response to one of the adapter's own requests, which it never writes here.
    if (value["type"] === "user" && value["isReplay"] === true) {
      const echo = decodeEcho(value)
      return Result.isFailure(echo) ? malformed("user", echo.failure) : Result.succeed({ _tag: "Echo", uuid: echo.success.uuid ?? null })
    }
    const type = value["type"]
    if (typeof type === "string") return Result.fail({ _tag: "Unknown", method: type })
    return Result.fail({ _tag: "Ignored", method: "" })
  }
  if ("id" in value) {
    const r = decodeRequest(value)
    if (Result.isFailure(r)) return malformed(method, r.failure)
    const { id, params, item } = r.success
    return Result.succeed({ _tag: "Request", request: { id, method, params: params ?? null, ...(item === undefined ? {} : { item }) } })
  }
  if (method === "serverRequest/resolved") {
    const r = decodeResolved(value)
    return Result.isFailure(r) ? malformed(method, r.failure) : Result.succeed({ _tag: "Resolved", requestId: r.success.params.requestId ?? null })
  }
  if (method === MODEL_METHOD) {
    const r = decodeModel(value)
    return Result.isFailure(r)
      ? malformed(method, r.failure)
      : Result.succeed({ _tag: "Model", threadId: r.success.params.threadId ?? null, model: r.success.params.model })
  }
  if (method === BOARD_TOOLS_METHOD) {
    const r = decodeBoardTools(value)
    return Result.isFailure(r) ? malformed(method, r.failure) : Result.succeed({ _tag: "BoardTools", dynamic: r.success.params.dynamic ?? null })
  }
  if (!isKept(method)) return Result.fail({ _tag: "Unknown", method })
  const n = decodeNotification(value)
  if (Result.isFailure(n)) return malformed(method, n.failure)
  return Result.succeed({ _tag: "Notification", method: n.success.method, params: n.success.params ?? null, emittedAtMs: n.success.emittedAtMs ?? null })
}

/** One line of `out.jsonl` (without its newline), decoded; a problem for one to log and skip. */
export const decodeLine = (line: string): Result.Result<CodexLine, LineProblem> => {
  const parsed = parseJson(line)
  if (Result.isFailure(parsed)) return Result.fail({ _tag: "NotJson" })
  return decodeValue(parsed.success)
}
