// A stand-in ACP agent (Agent Client Protocol: JSON-RPC 2.0, one message to a line, on stdin and stdout) for the ACP
// adapter (`huntaway acp-run`) and its model listing, without a model: it plays Google's Antigravity (`agy acp`). Plain
// Node: it stands in for an outside program. It prints one line that isn't JSON-RPC first (Antigravity prints others
// too), and exits when its stdin ends.
//
// It answers `initialize` as Antigravity 1.5.13 does (no `mcpCapabilities` unless FAKE_ACP_HTTP_MCP=1), `session/new` (a
// session with the modes default, auto_edit and yolo, a `model` config option with FAKE_ACP_MODELS and a `thought_level`
// option, low and high), `session/resume`, `session/load` (it replays a short history first: an agent message
// "history" and a user message), `session/set_config_option` (answers with all the options), `session/set_mode`,
// `session/set_model`, `session/prompt` (a turn, below) and the notification `session/cancel` (the turn going ends
// `cancelled`; a permission it waits for is given up on). Anything else is -32601.
//
// A turn does what its text asks (below), then streams its reply as `agent_message_chunk`s (FAKE_ACP_TEXT, default
// "Done.", and what it was answered, a line each), and answers the prompt `{stopReason}`. Markers in the prompt's text:
//   fake-ask-permission       a command (`tool_call` kind execute, `ls`) and its permission asked
//                             (`session/request_permission`, allow_once/allow_always/reject_once/reject_always); allowed,
//                             it completes with output "fake\n" (exit code 0), else it fails; the reply says
//                             "permission execute: <optionId | cancelled>"
//   fake-edit                 an edit (`tool_call` kind edit with a diff of <cwd>/fake.txt, "old" to "new") and its
//                             permission; the reply says "permission edit: <optionId | cancelled>"
//   fake-question             a question (an `interaction_` permission request whose options, "a" and "b", are its
//                             answers); the reply says "question: <optionId | cancelled>"
//   fake-board-call <tool> <JSON arguments>   (a line each) a call of the tool on the MCP server named `huntaway` given
//                             to the session: a stdio one is started (its command, args and env) and spoken MCP to on its
//                             stdio (initialize, notifications/initialized, tools/call), an http one POSTed to; shown as a
//                             `tool_call` titled `mcp__huntaway__<tool>` completed with the result's text; the reply says
//                             "board <tool>: <text>"
//   fake-plan                 a `plan` update (two entries)
//   fake-think                an `agent_thought_chunk` before the reply
//   fake-usage                a `usage_update` (used 1234 of 100000) and the prompt's `usage` (1000 in, 200 out)
//   fake-until-interrupted    the turn goes on until `session/cancel`
//   fake-child                a child process (`sleep 600`, its pid logged as {"child": pid}) that runs until it's killed
//   fake-crash                a permission asked (of a command), then it exits 5 without waiting for the answer
//
// Knobs (environment):
//   FAKE_ACP_LOG          appends a JSON line for its start (args, cwd, BROWSER) and each message it's sent
//   FAKE_ACP_TEXT         the reply (default "Done.")
//   FAKE_ACP_MODELS       the models it offers, a comma list (default "fake-flash,fake-pro"; the first is current)
//   FAKE_ACP_HTTP_MCP     "1": it takes http MCP servers (`mcpCapabilities.http`)
//   FAKE_ACP_SIGNED_OUT   "1": `session/new` (and resume, load) is refused with -32000 "Authentication required"
//   FAKE_ACP_NO_RESUME    "1": no `sessionCapabilities.resume` (a session is continued with `session/load`)
//   FAKE_ACP_NO_LOAD      "1": no `loadSession` either (with FAKE_ACP_NO_RESUME, a session can't be continued)
//   FAKE_ACP_IGNORE_CANCEL "1": `session/cancel` is ignored (a turn going on until it's interrupted never ends)
//   FAKE_ACP_CANCEL_ERROR "1": a cancelled prompt is answered with an error, not `{stopReason: "cancelled"}`
//   FAKE_ACP_RESUME_ERROR "1": `session/resume` and `session/load` fail, the error naming the MCP servers given
//   FAKE_ACP_RESUME_MODE  the mode a continued session is in (default "default"), e.g. "yolo" from an earlier run
//   FAKE_ACP_NO_MODES     "1": sessions report no modes (`session/set_mode` still works)
//   FAKE_ACP_SET_MODE_ERROR "1": `session/set_mode` fails with -32603
// It logs {"closed": true} when its stdin ends, before it exits.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

type Json = Record<string, unknown>

const env = process.env
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const field = (v: unknown, name: string): unknown => (isObject(v) ? v[name] : undefined)
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const parse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
const list = (v: unknown): Array<unknown> => (Array.isArray(v) ? [...v] : [])
const hex = () => randomUUID().replaceAll("-", "").slice(0, 12)
const send = (v: Json): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...v })}\n`)
}
const log = (v: unknown) => {
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify(v)}\n`)
}

log({ start: { args: process.argv.slice(2), cwd: process.cwd(), browser: env.BROWSER ?? null } })
process.stdout.write("Antigravity ACP server (fake) starting\n")

const MODELS = (env.FAKE_ACP_MODELS ?? "fake-flash,fake-pro").split(",").filter((m) => m !== "")
const config = { model: MODELS[0] ?? "", thinking: "low", mode: "default" }
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: config.model,
    options: MODELS.map((m) => ({ value: m, name: m.replace(/^fake-/u, "Fake ").replace(/\b\w/gu, (c) => c.toUpperCase()), description: `The ${m} model.` })),
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: config.thinking,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
]
const sessionAnswer = (sessionId: string) => ({
  sessionId,
  ...(env.FAKE_ACP_NO_MODES === "1"
    ? {}
    : {
        modes: {
          currentModeId: config.mode,
          availableModes: [
            { id: "default", name: "Default" },
            { id: "auto_edit", name: "Auto edit" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      }),
  configOptions: configOptions(),
})

let session = ""
let mcpServers: Array<unknown> = []
let nextRequest = 1000
/** Our requests waiting for the client's answer, by id. */
const waiting = new Map<number, (answer: Json | null) => void>()
/** The turn going: whether it was cancelled, and what to wake when it is. */
let turn: { cancelled: boolean; wake: Array<() => void> } | null = null

const update = (u: Json) => send({ method: "session/update", params: { sessionId: session, update: u } })

/** Asks the client `method`; its answer, or null if the turn is cancelled first. */
const ask = (method: string, params: Json): Promise<Json | null> =>
  new Promise((done) => {
    const id = nextRequest++
    waiting.set(id, done)
    turn?.wake.push(() => {
      if (waiting.delete(id)) done(null)
    })
    send({ id, method, params })
  })

const PERMISSIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Deny", kind: "reject_once" },
  { optionId: "reject-always", name: "Deny always", kind: "reject_always" },
]

/** The option the client chose, or "cancelled". */
const chosen = (a: Json | null): string => {
  const outcome = field(field(a, "result"), "outcome")
  return field(outcome, "outcome") === "selected" ? str(field(outcome, "optionId")) : "cancelled"
}

/** A permission-asked tool call, completed or failed as the answer says; the option chosen. */
const permitted = async (call: Json, done: Json): Promise<string> => {
  update({ sessionUpdate: "tool_call", ...call, status: "pending" })
  const a = await ask("session/request_permission", {
    sessionId: session,
    toolCall: { toolCallId: call.toolCallId, title: call.title, kind: call.kind },
    options: PERMISSIONS,
  })
  const option = chosen(a)
  if (turn?.cancelled === true) return option
  const ok = option.startsWith("allow")
  update({ sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: ok ? "completed" : "failed", ...(ok ? done : {}) })
  return option
}

/** MCP over a server's stdio: initialize, initialized, the call; its result's text. */
const callStdio = (server: Json, tool: string, args: unknown): Promise<string> =>
  new Promise((done) => {
    const extra = Object.fromEntries((Array.isArray(server.env) ? server.env : []).map((e: unknown) => [str(field(e, "name")), str(field(e, "value"))]))
    const child = spawn(str(server.command), Array.isArray(server.args) ? server.args.map(str) : [], {
      env: { ...env, ...extra },
      stdio: ["pipe", "pipe", "inherit"],
    })
    const write = (m: Json) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`)
    let finished = false
    const finish = (text: string) => {
      if (finished) return
      finished = true
      child.stdin.end()
      done(text)
    }
    child.on("error", (e) => finish(`couldn't start the MCP server: ${e.message}`))
    child.on("exit", (code) => finish(`the MCP server exited (${code})`))
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = parse(line)
      if (field(m, "id") === 1) {
        write({ method: "notifications/initialized" })
        write({ id: 2, method: "tools/call", params: { name: tool, arguments: args } })
      } else if (field(m, "id") === 2) finish(resultText(m))
    })
    write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "0.0.0" } } })
  })

const resultText = (m: unknown): string => {
  const error = field(m, "error")
  if (error !== undefined) return `error: ${str(field(error, "message"))}`
  const content = field(field(m, "result"), "content")
  return Array.isArray(content) ? content.map((c) => str(field(c, "text"))).join("\n") : ""
}

/** MCP over HTTP: the call POSTed, its answer read from JSON or an event stream. */
const callHttp = async (server: Json, tool: string, args: unknown): Promise<string> => {
  const headers = Object.fromEntries((Array.isArray(server.headers) ? server.headers : []).map((h: unknown) => [str(field(h, "name")), str(field(h, "value"))]))
  try {
    const response = await fetch(str(server.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
    })
    const body = await response.text()
    const json = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? body
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => parse(l.slice(5).trim()))
          .find((m) => field(m, "id") === 2)
      : parse(body)
    return resultText(json)
  } catch (e) {
    return `couldn't reach the MCP server: ${String(e)}`
  }
}

const runTurn = async (id: unknown, text: string) => {
  const t = { cancelled: false, wake: [] as Array<() => void> }
  turn = t
  const said: Array<string> = []
  if (text.includes("fake-ask-permission")) {
    const option = await permitted(
      { toolCallId: `call_${hex()}`, title: "ls", kind: "execute", rawInput: { command: "ls", cwd: process.cwd() } },
      { rawOutput: { combinedOutput: "fake\n", exitCode: 0 } },
    )
    said.push(`permission execute: ${option}`)
  }
  if (text.includes("fake-edit") && !t.cancelled) {
    const path = `${process.cwd()}/fake.txt`
    const option = await permitted(
      {
        toolCallId: `call_${hex()}`,
        title: "Edit fake.txt",
        kind: "edit",
        content: [{ type: "diff", path, oldText: "old\n", newText: "new\n" }],
        locations: [{ path }],
      },
      {},
    )
    said.push(`permission edit: ${option}`)
  }
  if (text.includes("fake-question") && !t.cancelled) {
    const a = await ask("session/request_permission", {
      sessionId: session,
      toolCall: { toolCallId: `interaction_${hex()}`, title: "Which one?" },
      options: [
        { optionId: "a", name: "A", kind: "allow_once" },
        { optionId: "b", name: "B", kind: "allow_once" },
      ],
    })
    said.push(`question: ${chosen(a)}`)
  }
  for (const line of text.split("\n")) {
    const m = /fake-board-call (\S+)(?: (.*))?$/u.exec(line.trim())
    if (m === null || t.cancelled) continue
    const tool = m[1] ?? ""
    const args = parse(m[2] ?? "{}") ?? {}
    const toolCallId = `call_${hex()}`
    update({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `mcp__huntaway__${tool}`,
      kind: "other",
      status: "in_progress",
      rawInput: args,
      _meta: { is_mcp_tool_call: true },
    })
    const server = mcpServers.find((s) => field(s, "name") === "huntaway")
    const out = !isObject(server)
      ? "no huntaway MCP server"
      : field(server, "type") === "http"
        ? await callHttp(server, tool, args)
        : await callStdio(server, tool, args)
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: out } }] })
    said.push(`board ${tool}: ${out}`)
  }
  if (text.includes("fake-plan") && !t.cancelled) {
    update({
      sessionUpdate: "plan",
      entries: [
        { content: "Look around", priority: "high", status: "completed" },
        { content: "Do the work", priority: "medium", status: "in_progress" },
      ],
    })
  }
  if (text.includes("fake-child")) log({ child: spawn("sleep", ["600"], { stdio: "ignore" }).pid })
  if (text.includes("fake-crash")) {
    void ask("session/request_permission", {
      sessionId: session,
      toolCall: { toolCallId: `call_${hex()}`, title: "ls", kind: "execute" },
      options: PERMISSIONS,
    })
    process.stdout.write("", () => process.exit(5))
    return
  }
  if (text.includes("fake-until-interrupted")) await new Promise<void>((done) => (t.cancelled ? done() : t.wake.push(done)))
  if (!t.cancelled) {
    if (text.includes("fake-think")) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over." } })
    const reply = [env.FAKE_ACP_TEXT ?? "Done.", ...said].join("\n")
    for (const chunk of reply.match(/.{1,8}/gsu) ?? []) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } })
  }
  const usage = text.includes("fake-usage")
  if (usage && !t.cancelled) update({ sessionUpdate: "usage_update", used: 1234, size: 100000 })
  turn = null
  if (t.cancelled && env.FAKE_ACP_CANCEL_ERROR === "1") return send({ id, error: { code: -32603, message: "the request was cancelled" } })
  send({
    id,
    result: { stopReason: t.cancelled ? "cancelled" : "end_turn", ...(usage ? { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } : {}) },
  })
}

const promptText = (params: unknown): string => {
  const prompt = field(params, "prompt")
  return Array.isArray(prompt) ? prompt.map((b) => str(field(b, "text"))).join("") : ""
}

const handle = (m: Json) => {
  const id = m.id
  const method = str(m.method)
  const params = m.params
  const result = (r: unknown) => send({ id, result: r })
  const error = (code: number, message: string) => send({ id, error: { code, message } })
  if (method === "" && typeof id === "number") {
    const done = waiting.get(id)
    waiting.delete(id)
    done?.(m)
    return
  }
  if (id === undefined) {
    if (method === "session/cancel" && turn !== null && env.FAKE_ACP_IGNORE_CANCEL !== "1") {
      turn.cancelled = true
      for (const wake of turn.wake.splice(0)) wake()
    }
    return
  }
  const signedOut = env.FAKE_ACP_SIGNED_OUT === "1"
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: env.FAKE_ACP_NO_LOAD !== "1",
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { ...(env.FAKE_ACP_NO_RESUME === "1" ? {} : { resume: {} }), close: {}, list: {} },
          ...(env.FAKE_ACP_HTTP_MCP === "1" ? { mcpCapabilities: { http: true, sse: false } } : {}),
          auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        agentInfo: { name: "Antigravity ACP Server", version: "0.0.0-fake" },
        authMethods: [{ id: "oauth-personal", name: "Sign in with Google" }],
      })
    case "session/new":
      if (signedOut) return error(-32000, "Authentication required")
      session = `sess-${hex()}`
      mcpServers = list(field(params, "mcpServers"))
      return result(sessionAnswer(session))
    case "session/resume":
    case "session/load":
      if (signedOut) return error(-32000, "Authentication required")
      if (env.FAKE_ACP_RESUME_ERROR === "1") return error(-32603, `can't continue it with ${JSON.stringify(field(params, "mcpServers"))}`)
      session = str(field(params, "sessionId"))
      mcpServers = list(field(params, "mcpServers"))
      config.mode = env.FAKE_ACP_RESUME_MODE ?? "default"
      if (method === "session/load") {
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } })
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "history" } })
      }
      return result({ ...sessionAnswer(session), sessionId: undefined })
    case "session/set_config_option": {
      const configId = str(field(params, "configId"))
      const value = str(field(params, "value"))
      if (configId === "model" && MODELS.includes(value)) config.model = value
      else if (configId === "thinking" && ["low", "high"].includes(value)) config.thinking = value
      else return error(-32602, `no ${configId} ${value}`)
      return result({ configOptions: configOptions() })
    }
    case "session/set_mode":
      if (env.FAKE_ACP_SET_MODE_ERROR === "1") return error(-32603, "can't change the mode now")
      config.mode = str(field(params, "modeId"))
      return result({})
    case "session/set_model":
      config.model = str(field(params, "modelId"))
      return result({})
    case "session/prompt":
      void runTurn(id, promptText(params))
      return
    default:
      return error(-32601, `unknown method ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  const m = parse(line)
  if (!isObject(m)) return
  log(m)
  handle(m)
})
// Its stdin ended: it exits, once what it wrote is out.
rl.on("close", () => {
  log({ closed: true })
  process.stdout.write("", () => process.exit(0))
})
