import { Effect, Option, Predicate, Schema } from "effect"
import { jsonText } from "../../claude/tools.ts"
import { warning } from "../map.ts"
import type { Line } from "../map.ts"
import { AUTH_REQUIRED, decodeInitialize, decodeSession } from "../protocol.ts"
import type { InitializeResponse, SessionResponse } from "../protocol.ts"
import { AcpError, METHOD_NOT_FOUND } from "../rpc.ts"
import type { AcpAgent, AgentMessage } from "../rpc.ts"
import {
  asksNothing,
  currentMode,
  effortChoice,
  fullAccess,
  modeChoice,
  modelChoice,
  reportsModes,
  withConfigOptions,
  withModel,
  withValue,
} from "../session.ts"
import type { Choice } from "../session.ts"
import type { AcpMcpServer, AcpSpec } from "../spec.ts"

// The start of an ACP session, before its first turn (the adapter's, adapter/run.ts, and `acp-run --list-models`'):
// `initialize`, then `session/new` or the session it continues (`session/resume`, else `session/load`, whose history is
// dropped), then the model, effort and mode it is to run with. Requests are answered one at a time here
// (`call`): what the agent sends meanwhile is history, or nothing the adapter needs yet.

/** Why the adapter stopped before its work was done; said on its stderr (the run's `err.log`), and it exits 1. */
export class AdapterError extends Schema.TaggedError<AdapterError, { readonly brand: unique symbol }>()("AdapterError", { reason: Schema.String }) {}

/** The agent is signed out (`session/new` refused with -32000): `acp-run --list-models` exits 3 for it. */
export class SignInRequired extends Schema.TaggedError<SignInRequired, { readonly brand: unique symbol }>()("SignInRequired", { reason: Schema.String }) {}

export const fail = (reason: string) => new AdapterError({ reason })

/** Why the agent's gone: how it exited and the last of its stderr. */
export const exitedReason = (agent: AcpAgent, what: string) =>
  Effect.gen(function* () {
    const status = Option.getOrNull(yield* agent.exited.pipe(Effect.timeoutOption("1 second")))
    const tail = (yield* agent.stderrTail).trim()
    return `the agent exited${status === null ? "" : ` (${status})`} ${what}${tail === "" ? "" : `:\n${tail}`}`
  })

/** A request the adapter doesn't take (`fs/*`, `terminal/*`…), or a permission asked before a turn: refused. */
export const refuse = (agent: AcpAgent, m: AgentMessage & { readonly _tag: "Request" }) =>
  m.method === "session/request_permission"
    ? agent.respond(m.id, { outcome: { outcome: "cancelled" } })
    : agent.respondError(m.id, METHOD_NOT_FOUND, `Method not supported by Huntaway: ${m.method}`)

/** Request `method` and wait for its answer, refusing the agent's requests and dropping its notifications meanwhile. */
/** How long the agent has to answer a request of the session's start; a session's resume or load (its history) longer. */
export const ANSWER_WITHIN = "60 seconds"
export const RESUME_WITHIN = "120 seconds"

/** The code of the error a request that wasn't answered in time fails with (not a JSON-RPC code). */
export const TIMED_OUT = -1

export const call = (agent: AcpAgent, method: string, params: unknown, within: `${number} seconds` = ANSWER_WITHIN): Effect.Effect<unknown, AcpError> =>
  Effect.gen(function* () {
    const id = yield* agent.send(method, params)
    while (true) {
      const m = yield* agent.next
      if (m === null) return yield* new AcpError({ method, code: null, reason: yield* exitedReason(agent, `before answering ${method}`) })
      if (m._tag === "Response") {
        if (m.id !== id) continue
        if (m.error !== null) return yield* new AcpError({ method, code: m.error.code, reason: m.error.message })
        return m.result
      }
      if (m._tag === "Request") yield* refuse(agent, m)
    }
  }).pipe(
    Effect.timeoutOption(within),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new AcpError({ method, code: TIMED_OUT, reason: `the agent didn't answer within ${within}` })),
        onSome: Effect.succeed,
      }),
    ),
  )

/** An error as the adapter says it: `<method>: <reason>`. */
export const errorText = (e: AcpError): string => (e.method === "" ? e.reason : `${e.method}: ${e.reason}`)

/** `initialize`, as Huntaway, with no file system or terminal of its own to offer. */
export const initialize = (agent: AcpAgent, version: string): Effect.Effect<InitializeResponse, AcpError> =>
  Effect.map(
    call(agent, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "huntaway", title: "Huntaway", version },
    }),
    (r) => Option.getOrElse(decodeInitialize(r), (): InitializeResponse => ({})),
  )

/** The sign-in an agent refused `session/new` for. */
const signIn = (program: string) => new SignInRequired({ reason: `the ACP agent needs a sign-in: run \`${program}\` once in a terminal and sign in` })

/** `session/new`; a signed-out agent's refusal is `SignInRequired`. */
export const newSession = (agent: AcpAgent, program: string, cwd: string, mcpServers: ReadonlyArray<unknown>) =>
  call(agent, "session/new", { cwd, mcpServers }).pipe(
    Effect.mapError((e) => (e.code === AUTH_REQUIRED ? signIn(program) : e)),
    Effect.map((r) => Option.getOrElse(decodeSession(r), (): SessionResponse => ({}))),
  )

/** The board's MCP servers as the agent takes them: http ones through `huntaway mcp-stdio` unless it takes http. */
export const agentServers = (
  servers: ReadonlyArray<AcpMcpServer>,
  http: boolean,
  exe: string | null,
): { readonly servers: ReadonlyArray<unknown>; readonly warnings: ReadonlyArray<string> } => {
  const out: Array<unknown> = []
  const warnings: Array<string> = []
  for (const s of servers) {
    if (!("type" in s) || http) {
      out.push(s)
      continue
    }
    if (exe === null) {
      warnings.push(`The agent doesn't take http MCP servers, and the board's launcher isn't known (HUNTAWAY_EXE), so it hasn't the ${s.name} server.`)
      continue
    }
    const headers = Object.fromEntries(s.headers.map((h) => [h.name, h.value]))
    out.push({ name: s.name, command: exe, args: ["mcp-stdio", s.url], env: [{ name: "HUNTAWAY_MCP_HEADERS", value: jsonText(headers) }] })
  }
  return { servers: out, warnings }
}

/**
 * What takes the run's secrets out of a text the adapter writes (the agent's errors and stderr can say what they were
 * given): the http MCP servers' `Authorization` headers (the board's bearer secret, and a project server's own), as they
 * are and the token after their scheme, is `[redacted]`. Other headers and a stdio server's environment are not
 * secrets of the run's and are left alone (they are paths, ports and the like, which a thread shows). Values shorter
 * than 8 characters are left: they're no secret.
 */
export const redactor = (servers: ReadonlyArray<AcpMcpServer>): ((text: string) => string) => {
  const secrets = new Set<string>()
  for (const s of servers) {
    if (!("type" in s)) continue
    for (const h of s.headers) {
      if (h.name.toLowerCase() !== "authorization") continue
      const token = /^\S+\s+(\S+)$/u.exec(h.value.trim())?.[1]
      for (const x of [h.value, ...(token === undefined ? [] : [token])]) if (x.length >= 8) secrets.add(x)
    }
  }
  // The longest first, so a value's token isn't taken out of it before the value.
  const all = [...secrets].toSorted((a, b) => b.length - a.length)
  return all.length === 0 ? (text) => text : (text) => all.reduce((t, x) => t.split(x).join("[redacted]"), text)
}

/** `value` with `redact` applied to each string in it (keys included), so what it encodes to is still JSON. */
export const redactStrings = (redact: (text: string) => string, value: unknown): unknown => {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactStrings(redact, v))
  if (Predicate.isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redactStrings(redact, v)]))
  return value
}

/** The session the run goes on in: its id, what the agent said of it, and whether it's new. */
export interface Opened {
  readonly sessionId: string
  readonly session: SessionResponse
  readonly fresh: boolean
  readonly warnings: ReadonlyArray<Line>
}

/** `spec.session_id` continued (resumed, else loaded, else a new session, with a warning), or a new session. */
export const openSession = (agent: AcpAgent, init: InitializeResponse, spec: AcpSpec, servers: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const warnings: Array<Line> = []
    const fresh = Effect.gen(function* () {
      const session = yield* newSession(agent, spec.program, spec.cwd, servers)
      if (session.sessionId === undefined || session.sessionId === null) return yield* fail("session/new returned no session id")
      return { sessionId: session.sessionId, session, fresh: true, warnings }
    })
    const id = spec.session_id
    if (id === null) return yield* fresh
    const caps = init.agentCapabilities
    const method =
      caps?.sessionCapabilities?.resume !== undefined && caps.sessionCapabilities.resume !== null
        ? "session/resume"
        : caps?.loadSession === true
          ? "session/load"
          : null
    if (method === null) {
      warnings.push(warning("This agent can't continue an earlier session, so the conversation starts again."))
      return yield* fresh
    }
    const continued = yield* Effect.result(call(agent, method, { sessionId: id, cwd: spec.cwd, mcpServers: servers }, RESUME_WITHIN))
    if (continued._tag === "Failure") {
      if (continued.failure.code === AUTH_REQUIRED) return yield* signIn(spec.program)
      warnings.push(warning(`The agent couldn't continue the session (${errorText(continued.failure)}), so the conversation starts again.`))
      return yield* fresh
    }
    const session = Option.getOrElse(decodeSession(continued.success), (): SessionResponse => ({}))
    return { sessionId: id, session, fresh: false, warnings }
  })

const done = (s: SessionResponse, said: string | null = null) => ({ session: s, warning: said })

/** One setting made; the session as it is after it, and a warning if it couldn't be. */
const apply = (agent: AcpAgent, sessionId: string, session: SessionResponse, choice: Choice) =>
  Effect.gen(function* () {
    if (choice._tag === "None") return done(session)
    if (choice._tag === "Unavailable") return done(session, `The agent doesn't offer ${choice.what}, so it runs with its own.`)
    if (choice._tag === "Config") {
      const r = yield* Effect.result(call(agent, "session/set_config_option", { sessionId, configId: choice.configId, value: choice.value }))
      if (r._tag === "Failure") return done(session, `Couldn't set the agent's ${choice.configId} to ${choice.value}: ${errorText(r.failure)}`)
      const options = Schema.is(Schema.Struct({ configOptions: Schema.Array(Schema.Unknown) }))(r.success) ? r.success.configOptions : null
      // An agent that answers with nothing has the value set.
      return done(options !== null ? withConfigOptions(session, options) : withValue(session, choice.configId, choice.value))
    }
    if (choice._tag === "SetModel") {
      const r = yield* Effect.result(call(agent, "session/set_model", { sessionId, modelId: choice.modelId }))
      return r._tag === "Failure"
        ? done(session, `Couldn't set the agent's model to ${choice.modelId}: ${errorText(r.failure)}`)
        : done(withModel(session, choice.modelId))
    }
    const r = yield* Effect.result(call(agent, "session/set_mode", { sessionId, modeId: choice.modeId }))
    return r._tag === "Failure"
      ? done(session, `Couldn't set the agent's mode to ${choice.modeId}: ${errorText(r.failure)}`)
      : done(session.modes === undefined || session.modes === null ? session : { ...session, modes: { ...session.modes, currentModeId: choice.modeId } })
  })

/**
 * The board's mode set on the session. Out of "Bypass permissions" a session must not stay in a mode that asks nothing
 * (a resumed one can be in `yolo` from an earlier run): the agent would run commands and edits without the board
 * asking, and nothing sandboxes it. So when the session is in such a mode, or was resumed, and its mode couldn't be
 * changed, the run fails; and a resumed session that reports no modes is set to the agent's `default` all the same (an
 * agent without `session/set_mode` has none).
 */
const applyMode = (agent: AcpAgent, opened: Opened, session: SessionResponse, mode: string) =>
  Effect.gen(function* () {
    const choice = modeChoice(session, mode)
    if (fullAccess(mode)) return yield* apply(agent, opened.sessionId, session, choice)
    if (!opened.fresh && !reportsModes(session)) {
      const r = yield* Effect.result(call(agent, "session/set_mode", { sessionId: opened.sessionId, modeId: "default" }))
      if (r._tag === "Failure" && r.failure.code !== METHOD_NOT_FOUND)
        return yield* fail(`couldn't set the continued session's mode to default for the board's ${mode}: ${errorText(r.failure)}`)
      return done(session)
    }
    const r = yield* apply(agent, opened.sessionId, session, choice)
    const changing = choice._tag === "Config" || choice._tag === "SetMode"
    if (r.warning !== null && (asksNothing(currentMode(r.session)) || (!opened.fresh && changing)))
      return yield* fail(
        `the agent's session is in its ${currentMode(r.session) ?? "own"} mode and can't be taken out of it for the board's ${mode}: ${r.warning}`,
      )
    return r
  })

/** The spec's model, effort and mode set on the session; the session after them, and the warnings to say. */
export const applySettings = (agent: AcpAgent, opened: Opened, spec: AcpSpec) =>
  Effect.gen(function* () {
    let session = opened.session
    const warnings: Array<Line> = []
    for (const set of [
      (s: SessionResponse) => apply(agent, opened.sessionId, s, modelChoice(s, spec.model)),
      (s: SessionResponse) => apply(agent, opened.sessionId, s, effortChoice(s, spec.effort)),
      (s: SessionResponse) => applyMode(agent, opened, s, spec.mode),
    ]) {
      const r = yield* set(session)
      session = r.session
      if (r.warning !== null) warnings.push(warning(r.warning))
    }
    return { session, warnings }
  })
