import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { FAKE_CODEX } from "@huntaway/testing"
import { BOARD_TOOLS_METHOD } from "../items.ts"
import { boardTools } from "../requests.ts"
import { defaultSpec } from "../spec.ts"
import type { CodexSpec } from "../spec.ts"

// The adapter (`huntaway codex-run`, run.ts) against a fake `codex app-server` (huntaway's agent/codex/adapter.test.ts):
// the board's tools go to a new thread as dynamic tools, the app-server's requests go to the run's output and their
// answers come back on its input, and with no input (a compaction) they're declined. The adapter runs as the process it
// is in a run (`node codex-run.ts <spec>`), as the old test ran it.

const ENTRY = new URL("../../../codex-run.ts", import.meta.url).pathname

/**
 * A fake app-server: it records what it's sent (`sent.jsonl`), starts a thread, and for each turn asks for approval of
 * a command (request 10) and a dynamic tool call (request 11), then a third (request 12) it stops waiting for at once
 * (serverRequest/resolved), and ends the turn with an agent message saying what it was answered.
 */
const FAKE = String.raw`
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const log = (m) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + "\n");
// Each call is one write, so messages sent together reach the adapter together.
const send = (...ms) => process.stdout.write(ms.map((m) => JSON.stringify(m) + "\n").join(""));
const answers = {};
let turn = 0;
const t = { threadId: "th1" };
rl.on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === "initialize") return send({ id: m.id, result: {} });
  if (m.method === "thread/start" && m.params.dynamicTools && process.env.FAKE_NO_DYNAMIC_TOOLS)
    return send({ id: m.id, error: { code: -32600, message: "thread/start.dynamicTools requires experimentalApi capability" } });
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: "th1" }, model: "gpt-x" } });
  if (m.method === "thread/compact/start") {
    send({ id: m.id, result: {} });
    send({ id: 20, method: "item/commandExecution/requestApproval", params: { ...t, itemId: "c0", command: "ls" } });
    return;
  }
  if (m.method === "turn/start") {
    turn++;
    send({ id: m.id, result: { turn: { id: "turn" + turn } } });
    send({ method: "turn/started", params: { ...t, turn: { id: "turn" + turn } } });
    send({ method: "item/started", params: { ...t, item: { type: "commandExecution", id: "c1", command: "make" } } });
    send({ id: 10, method: "item/commandExecution/requestApproval", params: { ...t, itemId: "c1", command: "make" } });
    send({ id: 11, method: "item/tool/call", params: { ...t, callId: "d1", namespace: "huntaway", tool: "get_task", arguments: {} } });
    // With its resolution, so the adapter reads that with the request, before the board can answer it.
    send({ id: 12, method: "item/tool/requestUserInput", params: { ...t, itemId: "q1", questions: [] } }, { method: "serverRequest/resolved", params: { ...t, requestId: 12 } });
    return;
  }
  if (m.method === undefined && "id" in m) {
    answers[m.id] = m.result ?? m.error;
    if (m.id === 20) {
      send({ method: "thread/compacted", params: t });
      return;
    }
    if (answers[10] && answers[11]) {
      send({ method: "serverRequest/resolved", params: { ...t, requestId: 10 } });
      send({ method: "item/completed", params: { ...t, item: { type: "agentMessage", id: "m1", text: JSON.stringify(answers) } } });
      send({ method: "turn/completed", params: { ...t, turn: { id: "turn" + turn, status: "completed" } } });
    }
  }
});
`

/** A line of output, or of what the app-server was sent. */
type Line = unknown

/** The value at `path` in `v` (objects' fields and arrays' items), if there is one. */
const at = (v: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((x, k) => (typeof x === "object" && x !== null ? Reflect.get(x, k) : undefined), v)

const Json = Schema.fromJsonString(Schema.Unknown)
const decode = Schema.decodeUnknownOption(Json)
const encode = Schema.encodeOption(Json)
const parse = (line: string): Line => Option.getOrUndefined(decode(line))
const text = (value: unknown): string => Option.getOrElse(encode(value), () => "null")

interface Ran {
  readonly out: ReadonlyArray<Line>
  readonly sent: ReadonlyArray<Line>
  readonly code: number | null
}

/** The board's MCP server, as the launch leaves it in a new session's `mcp.json`. */
const BOARD_SERVER = { type: "http", url: "http://127.0.0.1:1/mcp/run/huntaway", headers: { Authorization: "Bearer x" } }

/** The board's tools as a run is given them, from a server with one tool. */
const TOOLS = boardTools({
  initializeResult: { instructions: "The board." },
  toolsListResult: { tools: [{ name: "get_task", description: "A task.", inputSchema: { type: "object" } }] },
})

const lines = (s: string): ReadonlyArray<Line> =>
  s
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => parse(l))

interface Drive {
  readonly fields: Partial<CodexSpec>
  /** The app-server's program, given the run's folder (where it may write itself), and its environment. */
  readonly program: (dir: string) => string
  readonly env: (log: string) => Readonly<Record<string, string>>
  /** The adapter's stdin before its output is read: the prompt (and, with input, more lines may follow). */
  readonly stdin: string
  /** Each line of output, with what writes a line of input and what ends the input. */
  readonly onLine: (v: Line, write: (line: unknown) => void, end: () => void) => void
}

/** Runs the adapter as a run does (`node codex-run.ts <spec>`) until it exits: its output, what the app-server was sent, its exit code. */
const drive = (d: Drive) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-run-"))),
    (dir) =>
      Effect.callback<Ran>((resume) => {
        const spec = defaultSpec({ cwd: dir, approval_policy: "untrusted", approvals_reviewer: "user", sandbox: "workspace-write", ...d.fields })
        writeFileSync(join(dir, "codex.json"), text(spec))
        writeFileSync(join(dir, "mcp.json"), text({ mcpServers: { huntaway: BOARD_SERVER } }))
        const log = join(dir, "sent.jsonl")
        writeFileSync(log, "")
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, join(dir, "codex.json")], {
          env: { ...process.env, HUNTAWAY_CODEX_BIN: d.program(dir), ...d.env(log) },
          stdio: ["pipe", "pipe", "inherit"],
        })
        const out: Array<Line> = []
        const write = (line: unknown) => child.stdin.write(`${text(line)}\n`)
        child.stdin.write(d.stdin)
        if (!spec.input) child.stdin.end()
        createInterface({ input: child.stdout }).on("line", (line) => {
          const v = parse(line)
          out.push(v)
          d.onLine(v, write, () => child.stdin.end())
        })
        child.on("exit", (code) => resume(Effect.succeed({ out, sent: lines(readFileSync(log, "utf8")).filter((m) => at(m, "start") === undefined), code })))
        return Effect.sync(() => child.kill("SIGKILL"))
      }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const PROMPT = `${text({ type: "user", uuid: "u1", message: { role: "user", content: "Go" } })}\n`

/**
 * Runs the adapter against the old test's fake app-server (`FAKE` above) with `fields` over a spec, answering each
 * request on its output with `answer` (with input), until it exits. `noDynamicTools`: a Codex that won't take them.
 */
const adapter = (fields: Partial<CodexSpec>, answer: (req: Line) => Readonly<Record<string, unknown>>, noDynamicTools = false) =>
  drive({
    fields,
    program: (dir) => {
      const fake = join(dir, "fake-codex.cjs")
      writeFileSync(fake, `#!/usr/bin/env node\n${FAKE}`, { mode: 0o755 })
      return fake
    },
    env: (log) => ({ FAKE_LOG: log, ...(noDynamicTools ? { FAKE_NO_DYNAMIC_TOOLS: "1" } : {}) }),
    stdin: fields.input === true ? PROMPT : "Go",
    onLine: (v, write, end) => {
      if (fields.input !== true) return
      if (isRequest(v)) write({ type: "codex_response", id: at(v, "id"), ...answer(v) })
      if (at(v, "method") === "turn/completed") end()
    },
  })

/** The adapter with input against fake-codex (packages/testing/bin/fake-codex), started with `prompt`. */
const withFakeCodex = (prompt: string, onLine: Drive["onLine"]) =>
  drive({
    fields: { input: true, requests_on_output: true, board_tools: TOOLS },
    program: () => FAKE_CODEX,
    env: (log) => ({ FAKE_CODEX_LOG: log }),
    stdin: `${text({ type: "user", uuid: "u1", message: { role: "user", content: prompt } })}\n`,
    onLine,
  })

/** A request of the app-server's: it has an id and a method. */
const isRequest = (v: Line): boolean => at(v, "id") !== undefined && at(v, "method") !== undefined

const byMethod = (list: ReadonlyArray<Line>, method: string | undefined) => list.filter((v) => at(v, "method") === method)

/** The reply its last turn wrote. */
const replyOf = (out: ReadonlyArray<Line>): unknown =>
  at(
    out.findLast((v) => at(v, "method") === "item/completed" && at(v, "params", "item", "type") === "agentMessage"),
    "params",
    "item",
    "text",
  )

describe("codex-run", () => {
  it.live(
    "requests go to the output and their answers come back on the input",
    () =>
      Effect.gen(function* () {
        const { out, sent, code } = yield* adapter({ input: true, requests_on_output: true, board_tools: TOOLS }, (req) =>
          at(req, "method") === "item/tool/call"
            ? { result: { contentItems: [{ type: "inputText", text: "task" }], success: true } }
            : { result: { decision: "accept" } },
        )
        assert.strictEqual(code, 0)
        // The board's tools, on the new thread, and not its MCP server.
        const start = byMethod(sent, "thread/start")[0]
        assert.deepStrictEqual(at(start, "params", "dynamicTools"), [TOOLS])
        assert.strictEqual(at(start, "params", "config", "mcp_servers", "huntaway"), undefined)
        assert.strictEqual(byMethod(out, BOARD_TOOLS_METHOD).length, 0)
        // Each request on the output, an approval with the item it's about.
        const requests = out.filter(isRequest)
        assert.deepStrictEqual(
          requests.map((r) => at(r, "id")),
          [10, 11, 12],
        )
        assert.deepStrictEqual(at(requests[0], "item"), { type: "commandExecution", id: "c1", command: "make" })
        // Their answers, passed on.
        const answers = byMethod(sent, undefined).filter((m) => [10, 11, 12].includes(Number(at(m, "id"))))
        assert.deepStrictEqual(
          answers.map((a) => [at(a, "id"), at(a, "result")]),
          [
            [10, { decision: "accept" }],
            [11, { contentItems: [{ type: "inputText", text: "task" }], success: true }],
          ],
        )
        // What the app-server stopped waiting for is told only of one the board hadn't answered.
        assert.deepStrictEqual(
          byMethod(out, "serverRequest/resolved").map((v) => at(v, "params", "requestId")),
          [12],
        )
        assert.isAbove(byMethod(out, "turn/completed").length, 0)
        // The thread it started, and the model it runs on, for the board.
        assert.deepStrictEqual(out[0], { method: "thread/started", params: { thread: { id: "th1" } } })
        assert.deepStrictEqual(byMethod(out, "huntaway/model"), [{ method: "huntaway/model", params: { threadId: "th1", model: "gpt-x" } }])
      }),
    30_000,
  )

  it.live(
    "a resumed thread gets no dynamic tools",
    () =>
      Effect.gen(function* () {
        // thread/resume can't change them: the fake starts a thread, which is what's checked here.
        const { sent } = yield* adapter({ input: true, requests_on_output: true, board_tools: null }, () => ({ result: { decision: "accept" } }))
        const start = byMethod(sent, "thread/start")[0]
        assert.strictEqual(at(start, "params", "dynamicTools"), undefined)
        // The board's MCP server instead.
        assert.isDefined(at(start, "params", "config", "mcp_servers", "huntaway"))
      }),
    30_000,
  )

  it.live(
    "a Codex that won't take dynamic tools gets the board's MCP server and says so",
    () =>
      Effect.gen(function* () {
        const { out, sent } = yield* adapter({ input: true, requests_on_output: true, board_tools: TOOLS }, () => ({ result: { decision: "accept" } }), true)
        const starts = byMethod(sent, "thread/start")
        assert.strictEqual(starts.length, 2)
        assert.deepStrictEqual(at(starts[0], "params", "dynamicTools"), [TOOLS])
        assert.strictEqual(at(starts[0], "params", "config", "mcp_servers", "huntaway"), undefined)
        // Started again without them, with the board's server.
        assert.strictEqual(at(starts[1], "params", "dynamicTools"), undefined)
        assert.strictEqual(at(starts[1], "params", "config", "mcp_servers", "huntaway", "url"), BOARD_SERVER.url)
        // It says so: a warning, and the notification the server records it from.
        assert.match(
          String(at(byMethod(out, "warning")[0], "params", "message")),
          /doesn't take the board's tools as dynamic tools .* on the board's MCP server instead/,
        )
        assert.deepStrictEqual(at(byMethod(out, BOARD_TOOLS_METHOD)[0], "params"), { dynamic: false })
        assert.isAbove(byMethod(out, "turn/completed").length, 0)
      }),
    30_000,
  )

  it.live(
    "with no input requests are declined",
    () =>
      Effect.gen(function* () {
        const { out, sent, code } = yield* adapter({ input: false, compact: true, requests_on_output: false }, () => ({}))
        assert.strictEqual(code, 0)
        assert.deepStrictEqual(
          at(
            byMethod(sent, undefined).find((m) => at(m, "id") === 20),
            "result",
          ),
          { decision: "decline" },
        )
        assert.strictEqual(out.filter(isRequest).length, 0)
      }),
    30_000,
  )

  it.live(
    "a message during a turn is steered into it, and echoed once the model has moved on",
    () =>
      Effect.gen(function* () {
        let steered = false
        const { out, sent, code } = yield* withFakeCodex('fake-ask-permission\nfake-board-call get_task {"task_id":"T-1"}', (v, write, end) => {
          const method = at(v, "method")
          if (method === "item/commandExecution/requestApproval") {
            if (!steered) write({ type: "user", uuid: "s1", message: { role: "user", content: [{ type: "text", text: "And this" }] } })
            steered = true
            write({ type: "codex_response", id: at(v, "id"), result: { decision: "accept" } })
          } else if (method === "item/tool/call") {
            write({ type: "codex_response", id: at(v, "id"), result: { contentItems: [{ type: "inputText", text: "task" }], success: true } })
          } else if (method === "turn/completed") end()
        })
        assert.strictEqual(code, 0)
        const steer = byMethod(sent, "turn/steer")[0]
        assert.strictEqual(at(steer, "params", "clientUserMessageId"), "s1")
        assert.strictEqual(at(steer, "params", "expectedTurnId"), "turn-1")
        // Echoed as the model moves on: just before the board call's item starts.
        const echo = out.findIndex((v) => at(v, "type") === "user" && at(v, "isReplay") === true && at(v, "uuid") === "s1")
        const call = out.findIndex((v) => at(v, "method") === "item/started" && at(v, "params", "item", "type") === "dynamicToolCall")
        assert.isTrue(call > 0 && echo === call - 1)
        assert.deepStrictEqual(at(out[echo], "message"), { role: "user", content: "And this" })
        assert.strictEqual(replyOf(out), "Done.\nsteered: And this\npermission Bash: accept\nboard get_task: task")
        // One turn: the steered message joined it.
        assert.strictEqual(byMethod(sent, "turn/start").length, 1)
      }),
    30_000,
  )

  it.live(
    "a message between turns starts the next one, and an interrupt ends the turn going",
    () =>
      Effect.gen(function* () {
        let completed = 0
        const { out, sent, code } = yield* withFakeCodex("Hello", (v, write, end) => {
          if (at(v, "method") === "turn/started" && at(v, "params", "turn", "id") === "turn-2") {
            write({ type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } })
          }
          if (at(v, "method") !== "turn/completed") return
          completed++
          if (completed === 1) write({ type: "user", uuid: "u2", message: { role: "user", content: "fake-until-interrupted" } })
          else end()
        })
        assert.strictEqual(code, 0)
        const starts = byMethod(sent, "turn/start")
        assert.deepStrictEqual(
          starts.map((m) => at(m, "params", "input", 0, "text")),
          ["Hello", "fake-until-interrupted"],
        )
        assert.deepStrictEqual(at(byMethod(sent, "turn/interrupt")[0], "params"), { threadId: at(starts[0], "params", "threadId"), turnId: "turn-2" })
        assert.deepStrictEqual(
          byMethod(out, "turn/completed").map((v) => at(v, "params", "turn", "status")),
          ["completed", "interrupted"],
        )
        // The second message is echoed as it starts its turn.
        assert.isTrue(out.some((v) => at(v, "type") === "user" && at(v, "isReplay") === true && at(v, "uuid") === "u2"))
      }),
    30_000,
  )

  it.live(
    "a spec it can't read is said on its stderr, and it exits 1",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "codex-run-"))),
        (dir) =>
          Effect.callback<{ readonly code: number | null; readonly err: string }>((resume) => {
            writeFileSync(join(dir, "codex.json"), "{}")
            const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, join(dir, "codex.json")], {
              stdio: ["ignore", "ignore", "pipe"],
            })
            let err = ""
            child.stderr.on("data", (c: Buffer) => (err += c.toString()))
            child.on("exit", (code) => resume(Effect.succeed({ code, err })))
          }).pipe(
            Effect.map(({ code, err }) => {
              assert.strictEqual(code, 1)
              assert.strictEqual(err, "huntaway codex-run: codex.json isn't a run's spec\n")
            }),
          ),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      ),
    30_000,
  )
})
