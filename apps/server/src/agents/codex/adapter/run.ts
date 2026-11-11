import { Effect, FileSystem, Option, Path, Predicate, Queue, Schema, Stream } from "effect"
import type { Cause, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { toJson } from "../../../platform/columns.ts"
import { BOARD_SERVER } from "../../claude/access.ts"
import { BOARD_TOOLS_METHOD, field, MODEL_METHOD, ownThread, strField } from "../items.ts"
import { appServer, errorText } from "../rpc.ts"
import type { AppServer, AppServerError, Incoming } from "../rpc.ts"
import { codexServer, mcpServerConfig } from "../servers.ts"
import { REVIEW_PROFILE, specFromJson, threadParams, usesProfile } from "../spec.ts"
import type { CodexSpec } from "../spec.ts"
import { ChildThreads, makeRequests } from "./requests.ts"
import type { Answer, Emit } from "./requests.ts"

// The adapter, `huntaway codex-run <run dir>/codex.json` (huntaway's agent/codex/adapter.ts; inventory 01, section 5,
// _Codex_): it runs Codex turns for a run, under ia-shim, between the run's files and `codex app-server`. It starts the
// app-server and speaks its JSON-RPC protocol: it starts or resumes the thread (a new one with the board's tools as
// dynamic tools), sends the prompt, writes the app-server's notifications worth keeping to its stdout (the run's
// `out.jsonl`) as they are, passes its requests (approvals, questions, the board's tools' calls) to the board the same
// way and their answers back from its stdin, and with `CodexSpec.input` takes the same stream-json input as Claude Code:
// the prompt is the first user message, one that arrives during a turn is steered into it (`turn/steer`), one between
// turns starts the next turn, and an `interrupt` control request interrupts the turn. It echoes each message back (as
// `--replay-user-messages` does) once the model has taken it in, and is done when its input ends with no turn going.

/** Notifications worth keeping in `out.jsonl`; the rest (output deltas, moderation, read state…) are noise or too bulky. */
export const KEEP: ReadonlyArray<string> = [
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
]

/** Why the adapter stopped before its work was done; said on its stderr (the run's `err.log`), and it exits 1. */
export class AdapterError extends Schema.TaggedError<AdapterError, { readonly brand: unique symbol }>()("AdapterError", { reason: Schema.String }) {}

/** What the adapter is given of its process. */
export interface AdapterIo {
  /** Its stdin: the prompt, then (with input) the run's `input.jsonl`, as ia-shim relays them. */
  readonly stdin: Stream.Stream<Uint8Array, unknown>
  /** A line to its stdout, written whole (and at once, so nothing is lost when it exits). */
  readonly writeLine: (line: string) => Effect.Effect<void>
  /** A line to its stderr (the run's `err.log`). */
  readonly warn: (text: string) => Effect.Effect<void>
  /** The app-server's program: `$HUNTAWAY_CODEX_BIN`, else `codex`. */
  readonly program: string
  /** The home folder, for a `~` in the spec's paths. */
  readonly home: string
  /** The board's version, for `initialize`. */
  readonly version: string
}

/** A line of the adapter's stream-json input. */
type Input = { readonly type: "user"; readonly id: string; readonly text: string } | { readonly type: "interrupt" } | ({ readonly type: "response" } & Answer)

const Json = Schema.fromJsonString(Schema.Unknown)
const parseJson = Schema.decodeUnknownOption(Json)
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A stream-json user message's text: a string, or its text blocks. */
const userText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.flatMap((b: unknown) => (typeof strField(b, "text") === "string" ? [strField(b, "text") ?? ""] : [])).join("\n\n")
  return ""
}

/** One line of input, or null for one the adapter doesn't take. */
const inputOf = (line: string): Input | null => {
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

/** `~` expanded against `home`. */
const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)

const fail = (reason: string) => new AdapterError({ reason })
/** An app-server request's failure, with what it was for in front (the old `context`). */
const failWith = (what: string) => (e: AppServerError) => fail(`${what}: ${errorText(e)}`)
const asAdapter = (e: AppServerError) => fail(errorText(e))

/** One event of the main loop: a message from the app-server (null once it is gone), or a line of input (null once it ends). */
type Event = { readonly k: "msg"; readonly v: Incoming | null } | { readonly k: "line"; readonly v: Input | null }

/**
 * `thread/start`, with the board's tools as dynamic tools (`CodexSpec.board_tools`). A Codex that doesn't take dynamic
 * tools starts the thread without them, with the board's MCP server (`board`, which the launch left in `mcp.json` for
 * this) instead, and says so: a warning, and a `huntaway/boardTools {"dynamic": false}` notification, on which the board
 * records that the session hasn't them (`runs.board_tools`), so its later runs have the board's MCP server too.
 */
const startThread = (server: AppServer, params: Readonly<Record<string, unknown>>, tools: unknown, board: unknown, emit: Emit) =>
  Effect.gen(function* () {
    if (tools === null) return yield* server.request("thread/start", params)
    const first = yield* Effect.result(server.request("thread/start", { ...params, dynamicTools: [tools] }))
    if (first._tag === "Success") return first.success
    const said = errorText(first.failure)
    if (!/dynamic.?tools|experimental|unknown field/iu.test(said)) return yield* first.failure
    const how = board !== undefined ? "they're on the board's MCP server instead" : "the agent hasn't them"
    yield* emit({ method: "warning", params: { message: `This Codex doesn't take the board's tools as dynamic tools (${said}), so ${how}.` } })
    yield* emit({ method: BOARD_TOOLS_METHOD, params: { dynamic: false } })
    if (board === undefined) return yield* server.request("thread/start", params)
    const config = isRecord(params["config"]) ? params["config"] : {}
    const servers = isRecord(config["mcp_servers"]) ? config["mcp_servers"] : {}
    return yield* server.request("thread/start", { ...params, config: { ...config, mcp_servers: { ...servers, [BOARD_SERVER]: board } } })
  })

/** Start a turn with `text` as its input; its id. */
const startTurn = (server: AppServer, thread: string, spec: CodexSpec, model: string | null, readOnly: boolean, text: string) =>
  Effect.gen(function* () {
    const turn: Record<string, unknown> = { threadId: thread, input: [{ type: "text", text, text_elements: [] }], summary: "detailed" }
    if (spec.effort !== null) turn["effort"] = spec.effort
    if (readOnly) turn["sandboxPolicy"] = { type: "readOnly" }
    if (spec.plan && model !== null) turn["collaborationMode"] = { mode: "plan", settings: { model, reasoning_effort: spec.effort } }
    const r = yield* server.request("turn/start", turn).pipe(Effect.mapError(asAdapter))
    const id = strField(field(r, "turn"), "id")
    if (id === null) return yield* fail("turn/start returned no turn id")
    return id
  })

/** Run the adapter for the spec at `specPath`. Done once the run's work is (the caller exits then). */
export const runAdapter = (
  specPath: string,
  io: AdapterIo,
): Effect.Effect<void, AdapterError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const emit: Emit = (value) => Effect.flatMap(toJson(value), io.writeLine)
    const raw = yield* fs.readFileString(specPath).pipe(Effect.mapError((e) => fail(`reading codex.json: ${e.message}`)))
    const spec = specFromJson(Option.getOrUndefined(parseJson(raw)))
    if (spec === null) return yield* fail("codex.json isn't a run's spec")
    const mcpRaw = yield* fs.readFileString(path.join(path.dirname(specPath), "mcp.json")).pipe(Effect.mapError((e) => fail(`reading mcp.json: ${e.message}`)))
    const mcpJson = Option.getOrUndefined(parseJson(mcpRaw))

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

    const servers: Record<string, unknown> = {}
    const all = isRecord(mcpJson) && isRecord(mcpJson["mcpServers"]) ? mcpJson["mcpServers"] : {}
    for (const name of Object.keys(all).toSorted()) {
      const entry = all[name]
      const cfg = mcpServerConfig(name, entry, spec.approved_mcp_servers.includes(name), spec.disabled_mcp_tools[name] ?? [], spec.review_waits)
      if (cfg === null) {
        const type = strField(entry, "type")
        if (type !== null && !["stdio", "http", "streamable-http"].includes(type))
          yield* io.warn(`skipping MCP server ${name}: Codex doesn't support ${type} servers`)
        continue
      }
      // The user's approval rules may ask about its calls, or turn it off.
      const held = spec.approval_rules === undefined ? cfg : codexServer(spec.approval_rules, name, cfg)
      if (held !== null) servers[name] = held
    }
    const cwd = expand(spec.cwd, io.home)
    // CODEX_HOME comes from the shim's environment, if the config has its own.
    const server = yield* appServer({ program: io.program, overrides: spec.config_overrides ?? [], cwd, stderr: "inherit" }).pipe(Effect.mapError(asAdapter))
    // The app-server's requests the board hasn't answered yet.
    const requests = makeRequests(server, emit, spec.requests_on_output && spec.input)
    let children: ChildThreads | null = null
    // As the old adapter's drop: the children it can no longer report are closed (the app-server is killed with the scope).
    yield* Effect.addFinalizer(() => Effect.suspend(() => children?.drop(emit) ?? Effect.void))

    yield* server.initialize(io.version).pipe(Effect.mapError(asAdapter))
    if (spec.skills_dir !== null) {
      yield* server
        .request("skills/extraRoots/set", { extraRoots: [spec.skills_dir] })
        .pipe(Effect.catch((e) => io.warn(`couldn't add the project's skills: ${errorText(e)}`)))
    }

    // A new thread given the board's tools as dynamic tools has the board's MCP server only if Codex won't take them.
    const fresh = spec.thread_id === null
    const board = fresh && spec.board_tools !== null ? servers[BOARD_SERVER] : undefined
    if (fresh && spec.board_tools !== null) Reflect.deleteProperty(servers, BOARD_SERVER)
    const params = threadParams(spec, cwd, servers)
    const started: unknown =
      spec.thread_id !== null
        ? yield* server.request("thread/resume", { ...params, threadId: spec.thread_id, excludeTurns: true })
        : yield* startThread(server, params, spec.board_tools, board, emit)
    const threadId = strField(field(started, "thread"), "id")
    if (threadId === null) return yield* fail("no thread id")
    if (spec.revert_before_turn !== undefined && spec.thread_id !== null) {
      yield* server
        .request("thread/revert", { threadId, beforeTurnId: spec.revert_before_turn })
        .pipe(Effect.mapError(failWith("couldn't take the conversation back to before the turn a rewind went back to")))
    }
    // A Codex without permission profiles ignores ours: its turns are made read-only instead.
    const readOnly = usesProfile(spec) && strField(field(started, "activePermissionProfile"), "id") !== REVIEW_PROFILE
    if (readOnly) yield* io.warn(`codex didn't take the ${REVIEW_PROFILE} permission profile, so the sandbox is read-only`)
    // So the session is known even if `thread/started` is missed.
    if (fresh) yield* emit({ method: "thread/started", params: { thread: { id: threadId } } })

    // Items seen so far, for approvals that only name theirs.
    const items = new Map<string, unknown>()
    const kids = new ChildThreads(threadId)
    children = kids
    /** A notification or request from the app-server: requests go to the board, the notifications worth keeping to stdout. True for requests. */
    const onIncoming = (msg: Incoming) =>
      Effect.gen(function* () {
        kids.observe(msg)
        const method = strField(msg, "method") ?? ""
        const p = field(msg, "params")
        if ("id" in msg) {
          const itemId = strField(p, "itemId")
          yield* requests.asked(msg, itemId !== null ? (items.get(itemId) ?? null) : null)
          return true
        }
        if (method === "item/started") {
          const item = field(p, "item")
          const id = strField(item, "id")
          if (id !== null) items.set(id, item)
        }
        if (method === "serverRequest/resolved") yield* requests.resolved(msg)
        else if (KEEP.includes(method)) yield* emit(msg)
        return false
      })

    if (spec.compact) {
      yield* server.request("thread/compact/start", { threadId }).pipe(Effect.mapError(asAdapter))
      while (true) {
        const msg = yield* server.next
        if (msg === null) break
        if (yield* onIncoming(msg)) continue
        const method = strField(msg, "method")
        if ((method === "turn/completed" || method === "thread/compacted") && ownThread(field(msg, "params"), threadId)) return yield* Effect.void
      }
      return yield* fail("codex app-server exited before compacting the conversation")
    }

    const model = spec.model ?? strField(started, "model")
    // For the board's count of the tokens each model used.
    if (model !== null) yield* emit({ method: MODEL_METHOD, params: { threadId, model } })
    const start = (text: string) => startTurn(server, threadId, spec, model, readOnly, text)
    /** Echo a message back once the model has taken it in, shaped like Claude Code's `--replay-user-messages`. */
    const replay = (id: string, text: string) => emit({ type: "user", isReplay: true, uuid: id, message: { role: "user", content: text } })

    let turnId: string | null = yield* start(prompt)
    // Steered into the turn, but the model hasn't acted since: (uuid, text).
    let steered: Array<readonly [string, string]> = []
    let inputOpen = spec.input
    const events = yield* Queue.unbounded<Event, Cause.Done>()
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const v = yield* server.next
          yield* Queue.offer(events, { k: "msg", v })
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
    while (true) {
      const got = yield* Queue.take(events).pipe(Effect.orElseSucceed((): Event => ({ k: "msg", v: null })))
      if (got.k === "msg") {
        const msg = got.v
        if (msg === null) {
          const status = Option.getOrNull(yield* server.exited.pipe(Effect.timeoutOption("1 second")))
          return yield* fail(`codex app-server exited before the turn ended${status !== null ? ` (${status})` : ""}`)
        }
        const method = strField(msg, "method") ?? ""
        const p = field(msg, "params")
        // The model has moved on, so it has seen what was steered in before.
        if (method === "item/started" && ownThread(p, threadId) && strField(field(p, "item"), "type") !== "userMessage") {
          const taken = steered
          steered = []
          for (const [id, text] of taken) yield* replay(id, text)
        }
        if (yield* onIncoming(msg)) continue
        if (method === "turn/completed" && ownThread(p, threadId) && turnId !== null && strField(field(p, "turn"), "id") === turnId) {
          turnId = null
          // Steered in too late to be acted on (or the turn was interrupted): they start the next turn, as Claude Code
          // does with messages still queued.
          if (steered.length > 0) {
            const taken = steered
            steered = []
            turnId = yield* start(taken.map(([, t]) => t).join("\n\n"))
            for (const [id, text] of taken) yield* replay(id, text)
          } else if (!inputOpen) return yield* Effect.void
        }
        continue
      }
      const line = got.v
      if (line === null) {
        inputOpen = false
        yield* requests.closed()
        if (turnId === null) return yield* Effect.void
      } else if (line.type === "response") {
        yield* requests.answered(line)
      } else if (line.type === "user") {
        if (turnId !== null) {
          const steer = { threadId, expectedTurnId: turnId, clientUserMessageId: line.id, input: [{ type: "text", text: line.text, text_elements: [] }] }
          // The turn is over already: this starts the next one, when it ends.
          yield* server.request("turn/steer", steer).pipe(Effect.catch((e) => io.warn(`steering failed, sending it as the next turn: ${errorText(e)}`)))
          steered.push([line.id, line.text])
        } else {
          turnId = yield* start(line.text)
          yield* replay(line.id, line.text)
        }
      } else if (turnId !== null) {
        yield* server.request("turn/interrupt", { threadId, turnId }).pipe(Effect.catch((e) => io.warn(`interrupting the turn failed: ${errorText(e)}`)))
      }
    }
  }).pipe(Effect.catchTag("AppServerError", (e) => Effect.fail(asAdapter(e))))
