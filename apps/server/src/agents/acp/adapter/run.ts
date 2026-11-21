import { Effect, FileSystem, Option, Predicate, Queue, Random, Schema, Stream } from "effect"
import type { Cause, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { toJson } from "../../../platform/columns.ts"
import { field, strField } from "../../codex/items.ts"
import {
  answerPermission,
  askPermission,
  cancelled,
  endTurn,
  initialState,
  modelLine,
  outcomeFor,
  rejected,
  resolvedLine,
  settle,
  startTurn,
  threadStarted,
  update,
  warning,
} from "../map.ts"
import type { AcpState, Pending, Step, TurnEnd } from "../map.ts"
import { decodePermission, decodePrompt, sessionUpdate } from "../protocol.ts"
import { acpAgent, INVALID_PARAMS } from "../rpc.ts"
import type { AgentMessage } from "../rpc.ts"
import { currentModel, fullAccess } from "../session.ts"
import { specFromJson } from "../spec.ts"
import type { AdapterError } from "./setup.ts"
import { agentServers, redactor, redactStrings, applySettings, errorText, exitedReason, fail, initialize, openSession, refuse } from "./setup.ts"

// The adapter, `huntaway acp-run <run dir>/acp.json` (docs/plan/07-agents.md, ACP agents): it runs an ACP agent's turns
// for a run, under ia-shim, between the run's files and the agent (`agy acp` by default), and is a Codex run to the rest
// of the board (the contract at the top of spec.ts). It starts the agent, initializes it, opens the session (setup.ts),
// and with `AcpSpec.input` takes the same stream-json input as `codex-run`: the prompt is the first user message; one
// that arrives between turns starts a turn and is echoed at once; one during a turn is held (ACP has no steer) and starts
// the next turn, echoed then; an `interrupt` is `session/cancel` (the agent is killed if the turn hasn't ended 10 seconds
// later); a `codex_response` answers the agent's permission request it names. Without input all of stdin is the prompt,
// one turn. Each session update is written as Codex lines (map.ts); a permission request goes to the board with
// `requests_on_output` (and input), and is otherwise refused here, or allowed in a mode that asks nothing. It is done once
// its input has ended with no turn going.

/** What the adapter is given of its process. */
export interface AdapterIo {
  /** Its stdin: the prompt, then (with input) the run's `input.jsonl`, as ia-shim relays them. */
  readonly stdin: Stream.Stream<Uint8Array, unknown>
  /** A line to its stdout, written whole (and at once, so nothing is lost when it exits). */
  readonly writeLine: (line: string) => Effect.Effect<void>
  /** A line to its stderr (the run's `err.log`). */
  readonly warn: (text: string) => Effect.Effect<void>
  /** The board's version, for `initialize`. */
  readonly version: string
  /** The board's launcher (`HUNTAWAY_EXE`), for `huntaway mcp-stdio`; null if it isn't known. */
  readonly exe: string | null
}

/** How long a cancelled turn may take to end before the agent is killed. */
const CANCEL_GRACE = "10 seconds"

/** What the agent's environment has beside the adapter's: a browser that opens nothing (the adapter never signs in). */
export const AGENT_ENV: Readonly<Record<string, string>> = { BROWSER: "true" }

type Input =
  | { readonly type: "user"; readonly id: string; readonly text: string }
  | { readonly type: "interrupt" }
  | { readonly type: "response"; readonly id: unknown; readonly result?: unknown; readonly error?: unknown }

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A stream-json user message's text: a string, or its text blocks. */
const userText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.flatMap((b: unknown) => (typeof strField(b, "text") === "string" ? [strField(b, "text") ?? ""] : [])).join("\n\n")
  return ""
}

/** One line of input, or null for one the adapter doesn't take (as `codex-run` reads it). */
export const inputOf = (line: string): Input | null => {
  const v = Option.getOrUndefined(parseJson(line))
  if (!isRecord(v)) return null
  if (v["type"] === "user") return { type: "user", id: strField(v, "uuid") ?? "", text: userText(field(v["message"], "content")) }
  if (v["type"] === "control_request" && strField(v["request"], "subtype") === "interrupt") return { type: "interrupt" }
  if (v["type"] === "codex_response" && "id" in v) {
    return {
      type: "response",
      id: v["id"],
      ...(v["result"] === undefined ? {} : { result: v["result"] }),
      ...(v["error"] === undefined ? {} : { error: v["error"] }),
    }
  }
  return null
}

/** One event of the main loop: a message from the agent (null once it's gone), a line of input (null once it ends), or a cancel's grace running out. */
type Event =
  | { readonly k: "agent"; readonly v: AgentMessage | null }
  | { readonly k: "line"; readonly v: Input | null }
  | { readonly k: "grace"; readonly turn: string }

/** A seed for the run's item ids, so a resumed session's runs don't share them. */
const makeSeed = Effect.gen(function* () {
  const a = yield* Random.nextIntBetween(0, 2 ** 31)
  const b = yield* Random.nextIntBetween(0, 2 ** 31)
  return `${a.toString(36)}${b.toString(36)}`
})

const asIs = (text: string) => text

/** Run the adapter for the spec at `specPath`. Done once the run's work is (the caller exits then). */
export const runAdapter = (
  specPath: string,
  io: AdapterIo,
): Effect.Effect<void, AdapterError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> => {
  // The run's secrets (its MCP servers' `Authorization` headers) taken out of what it writes, once the spec says them.
  let redact = asIs
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const emit = (lines: ReadonlyArray<unknown>) =>
      Effect.forEach(lines, (l) => Effect.flatMap(toJson(redactStrings(redact, l)), io.writeLine), { concurrency: 1, discard: true })
    const raw = yield* fs.readFileString(specPath).pipe(Effect.mapError((e) => fail(`reading acp.json: ${e.message}`)))
    const spec = specFromJson(Option.getOrUndefined(parseJson(raw)))
    if (spec === null) return yield* fail("acp.json isn't a run's spec")
    redact = redactor(spec.mcp_servers)

    // The input: its lines as they come, ended by null.
    const inputs = yield* Queue.unbounded<Input | null, Cause.Done>()
    let prompt: string
    if (spec.input) {
      yield* io.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const input = inputOf(line)
          return input === null ? Effect.void : Queue.offer(inputs, input)
        }),
        Effect.ignore,
        Effect.andThen(Queue.offer(inputs, null)),
        Effect.forkScoped,
      )
      const first = yield* Queue.take(inputs).pipe(Effect.orElseSucceed(() => null))
      if (first?.type !== "user") return yield* fail("the run's input didn't start with the prompt")
      prompt = first.text
    } else {
      prompt = yield* io.stdin.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.orElseSucceed(() => ""),
      )
    }

    const agent = yield* acpAgent({ program: spec.program, args: spec.args, cwd: spec.cwd, env: AGENT_ENV, onStderr: (line) => io.warn(redact(line)) })
    const init = yield* initialize(agent, io.version)
    const mcp = agentServers(spec.mcp_servers, init.agentCapabilities?.mcpCapabilities?.http === true, io.exe)
    const opened = yield* openSession(agent, init, spec, mcp.servers)
    const sessionId = opened.sessionId
    let state: AcpState = initialState(yield* makeSeed, sessionId)
    yield* emit([threadStarted(state), ...opened.warnings, ...mcp.warnings.map(warning)])
    const settings = yield* applySettings(agent, opened, spec)
    yield* emit([...settings.warnings, modelLine(state, currentModel(settings.session) ?? spec.model ?? "")])

    const board = spec.input && spec.requests_on_output
    const allows = fullAccess(spec.mode)
    const step = (s: Step) => {
      state = s.state
      return emit(s.lines)
    }
    /** Echo a message back once it has started a turn, shaped like Claude Code's `--replay-user-messages`. */
    const replay = (id: string, text: string) => emit([{ type: "user", isReplay: true, uuid: id, message: { role: "user", content: text } }])

    // The prompt going (its request's id), and the board's requests it hasn't answered, by their id on the output.
    let promptId: number | null = null
    let cancelling = false
    const pending = new Map<number, Pending>()
    const start = (text: string) =>
      Effect.gen(function* () {
        yield* step(startTurn(state))
        cancelling = false
        promptId = yield* agent.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
      })
    /** The board's open requests, answered `cancelled` (the turn was) and told to the board as no longer wanted. */
    const dropPending = Effect.suspend(() => {
      const left = [...pending.values()]
      pending.clear()
      return Effect.forEach(left, (p) => Effect.andThen(agent.respond(p.acpId, cancelled), emit([resolvedLine(state, p)])), { concurrency: 1, discard: true })
    })

    const first = opened.fresh && spec.system_prompt.trim() !== "" ? `${spec.system_prompt.trim()}\n\n${prompt}` : prompt
    yield* start(first)
    // Held during a turn: (uuid, text).
    let held: Array<readonly [string, string]> = []
    let inputOpen = spec.input
    const events = yield* Queue.unbounded<Event, Cause.Done>()
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const v = yield* agent.next
          yield* Queue.offer(events, { k: "agent", v })
          if (v === null) return
        }
      }),
    )
    if (spec.input) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const v = yield* Queue.take(inputs).pipe(Effect.orElseSucceed(() => null))
            yield* Queue.offer(events, { k: "line", v })
            if (v === null) return
          }
        }),
      )
    }

    /** The agent's permission request: to the board, or answered here. */
    const onPermission = (m: AgentMessage & { readonly _tag: "Request" }) =>
      Effect.gen(function* () {
        const req = Option.getOrUndefined(decodePermission(m.params))
        if (req === undefined) return yield* agent.respondError(m.id, INVALID_PARAMS, "session/request_permission's params aren't ACP's")
        if (cancelling) return yield* agent.respond(m.id, cancelled)
        const asked = askPermission(state, m.id, req)
        if (board && inputOpen) {
          pending.set(asked.pending.id, asked.pending)
          return yield* step(asked)
        }
        // No board to ask: its item is shown, and it's refused (allowed in a mode that asks nothing; a question goes unanswered).
        const p = asked.pending
        const outcome = p.question ? cancelled : outcomeFor(p, allows ? "allow" : "reject")
        state = !p.question && !allows ? rejected(asked.state, p.toolCallId) : asked.state
        yield* emit(asked.lines.filter((l) => !("id" in l)))
        return yield* agent.respond(m.id, outcome)
      })

    /** The adapter is done: text the agent sent after its last turn ended is completed. */
    const finish = Effect.suspend(() => step(settle(state)))

    while (true) {
      const got = yield* Queue.take(events).pipe(Effect.orElseSucceed((): Event => ({ k: "agent", v: null })))
      if (got.k === "grace") {
        if (state.turnId !== got.turn) continue
        // The agent didn't end its cancelled turn: it's killed (with what it started), and the turn ends interrupted.
        yield* agent.kill
        yield* step(endTurn(state, { _tag: "Stopped", stopReason: "cancelled", usage: null }))
        yield* emit([warning("The agent didn't stop within 10 seconds of being cancelled, so it was stopped.")])
        if (held.length > 0) {
          const n = held.length
          yield* emit([
            warning(
              `${n === 1 ? "A message" : `${n} messages`} sent during the turn ${n === 1 ? "wasn't" : "weren't"} given to the agent, as it was stopped: send ${n === 1 ? "it" : "them"} again.`,
            ),
          ])
        }
        return yield* finish
      }
      if (got.k === "agent") {
        const m = got.v
        if (m === null) {
          const reason = yield* exitedReason(agent, state.turnId !== null ? "before the turn ended" : "while the run was waiting for input")
          // What the board was asked is no longer wanted, and the turn going failed.
          yield* dropPending
          if (state.turnId !== null) yield* step(endTurn(state, { _tag: "Failed", message: reason }))
          return yield* fail(reason)
        }
        if (m._tag === "Response") {
          if (m.id !== promptId) continue
          promptId = null
          const end: TurnEnd =
            m.error !== null
              ? // An agent may answer a cancelled prompt with an error: the turn was still interrupted.
                cancelling
                ? { _tag: "Stopped", stopReason: "cancelled", usage: null }
                : { _tag: "Failed", message: m.error.message }
              : Option.match(decodePrompt(m.result), {
                  onNone: (): TurnEnd => ({ _tag: "Stopped", stopReason: "end_turn", usage: null }),
                  onSome: (r): TurnEnd => ({ _tag: "Stopped", stopReason: r.stopReason ?? "end_turn", usage: r.usage ?? null }),
                })
          yield* dropPending
          yield* step(endTurn(state, end))
          if (held.length > 0) {
            // Held while it ran: they start the next turn, as Claude Code does with messages still queued.
            const taken = held
            held = []
            yield* start(taken.map(([, t]) => t).join("\n\n"))
            for (const [id, text] of taken) yield* replay(id, text)
          } else if (!inputOpen) return yield* finish
        } else if (m._tag === "Notification") {
          if (m.method !== "session/update") continue
          const of = strField(m.params, "sessionId")
          if (of !== null && of !== sessionId) continue
          const u = Option.getOrUndefined(sessionUpdate(field(m.params, "update")))
          if (u === undefined) yield* io.warn(`skipping a session/update the adapter couldn't read: ${yield* toJson(m.params)}`)
          else yield* step(update(state, u))
        } else if (m.method === "session/request_permission") {
          yield* onPermission(m)
        } else yield* refuse(agent, m)
        continue
      }
      const line = got.v
      if (line === null) {
        inputOpen = false
        // The board can't answer any more: what it hasn't answered is refused.
        const left = [...pending.values()]
        pending.clear()
        for (const p of left) {
          if (!p.question) state = rejected(state, p.toolCallId)
          yield* agent.respond(p.acpId, p.question ? cancelled : outcomeFor(p, "reject"))
        }
        if (state.turnId === null) return yield* finish
      } else if (line.type === "response") {
        const p = typeof line.id === "number" ? pending.get(line.id) : undefined
        if (p === undefined) continue
        pending.delete(p.id)
        const a = answerPermission(state, p, line)
        state = a.state
        yield* agent.respond(p.acpId, a.outcome)
      } else if (line.type === "user") {
        if (state.turnId !== null) held.push([line.id, line.text])
        else {
          yield* start(line.text)
          yield* replay(line.id, line.text)
        }
      } else if (state.turnId !== null && !cancelling) {
        cancelling = true
        yield* agent.notify("session/cancel", { sessionId })
        yield* dropPending
        const turn = state.turnId
        yield* Effect.sleep(CANCEL_GRACE).pipe(Effect.andThen(Queue.offer(events, { k: "grace", turn })), Effect.forkScoped)
      }
    }
  }).pipe(
    Effect.catchTags({
      AcpError: (e) => Effect.fail(fail(errorText(e))),
      SignInRequired: (e) => Effect.fail(fail(e.reason)),
    }),
    Effect.mapError((e) => fail(redact(e.reason))),
  )
}
