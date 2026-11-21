import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { FAKE_ACP, fakeAgent, TestMcp, TestTools } from "@huntaway/testing"
import { Identity } from "./platform/Identity.ts"
import { RunDir } from "./runs/RunDir.ts"
import { McpHttpRoute } from "./mcp/transport/http.ts"

// `huntaway mcp-stdio <url>` (mcp-stdio.ts) against the board's own MCP server over HTTP (mcp/transport/http.ts, with
// the test tools, on a real port): the handshake, a notification that gets no answer, calls answered from their event
// streams, a long call not holding up another; and an ACP agent (fake-acp under `acp-run`) calling a board tool through
// it, as Antigravity, which takes no http MCP servers, does, and over http as one that takes them does.

const MCP_STDIO = new URL("./mcp-stdio.ts", import.meta.url).pathname
const ACP_RUN = new URL("./acp-run.ts", import.meta.url).pathname
const LAUNCHER = new URL("../bin/huntaway", import.meta.url).pathname

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = (line: string): unknown => Option.getOrUndefined(Schema.decodeOption(Json)(line))
const text = (value: unknown): string => Option.getOrElse(Schema.encodeOption(Json)(value), () => "null")
const at = (v: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((x, k) => (typeof x === "object" && x !== null ? Reflect.get(x, k) : undefined), v)

/** The board's MCP route on a real port, over the test tools and a fresh board. */
const served = HttpRouter.serve(McpHttpRoute, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(TestMcp()),
)

/** A running run's board server: its URL and the headers its secret goes in. */
const boardServer = Effect.gen(function* () {
  const agent = yield* fakeAgent()
  yield* (yield* RunDir).writeMcpRun(agent.run.id, { cwd: "/tmp", github_account: null, review: false, in_process: false, desktop: false }).pipe(Effect.orDie)
  const secret = yield* (yield* Identity).runSecret(agent.run.id)
  const address = (yield* HttpServer.HttpServer).address
  const port = "port" in address ? address.port : 0
  return { url: `http://127.0.0.1:${port}/api/mcp/${agent.run.id}/huntaway`, headers: { Authorization: `Bearer ${secret}` }, task: agent.run.task_id }
})

/** `node mcp-stdio.ts <url>`: its lines out, one at a time; what writes a line to it; what ends its input. */
const bridge = (url: string, headers: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const out = yield* Queue.unbounded<unknown>()
      const exited = yield* Queue.unbounded<number | null>()
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MCP_STDIO, url], {
        env: { ...process.env, HUNTAWAY_MCP_HEADERS: text(headers) },
        stdio: ["pipe", "pipe", "inherit"],
      })
      createInterface({ input: child.stdout }).on("line", (line) => Queue.offerUnsafe(out, parse(line)))
      child.on("exit", (code) => Queue.offerUnsafe(exited, code))
      return {
        child,
        next: Queue.take(out),
        send: (m: unknown) => Effect.sync(() => child.stdin.write(`${text(m)}\n`)),
        end: Effect.sync(() => child.stdin.end()),
        exited: Queue.take(exited),
      }
    }),
    (b) => Effect.sync(() => b.child.kill("SIGKILL")),
  )

describe("mcp-stdio", () => {
  it.live(
    "speaks the board's MCP server on stdio: the handshake, a notification, calls answered as they finish",
    () =>
      Effect.gen(function* () {
        const tools = yield* TestTools
        const server = yield* boardServer
        const b = yield* bridge(server.url, server.headers)
        yield* b.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        })
        const init = yield* b.next
        assert.deepStrictEqual([at(init, "id"), at(init, "result", "serverInfo", "name")], [1, "huntaway"])
        yield* b.send({ jsonrpc: "2.0", method: "notifications/initialized" })
        // A long call, then a short one: the short one's answer doesn't wait for it.
        yield* b.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "test_block", arguments: { key: "k" } } })
        yield* tools.blocked("k")
        yield* b.send({ jsonrpc: "2.0", id: "three", method: "tools/call", params: { name: "test_echo", arguments: { text: "hi" } } })
        const echo = yield* b.next
        assert.strictEqual(at(echo, "id"), "three")
        assert.include(String(at(echo, "result", "content", 0, "text")), '"text": "hi"')
        yield* tools.release("k")
        const block = yield* b.next
        assert.deepStrictEqual([at(block, "id"), at(block, "result", "content", 0, "text")], [2, '{\n  "key": "k"\n}'])
        // A method the board hasn't is answered with its error.
        yield* b.send({ jsonrpc: "2.0", id: 4, method: "server/discover" })
        const refused = yield* b.next
        assert.deepStrictEqual([at(refused, "id"), at(refused, "error", "code")], [4, -32601])
        // A batch's messages go each on its own (the board takes no batches): its request is answered, its notification isn't.
        yield* b.send([
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } },
          { jsonrpc: "2.0", id: 5, method: "tools/list" },
        ])
        const listed = yield* b.next
        assert.strictEqual(at(listed, "id"), 5)
        assert.isTrue(Array.isArray(at(listed, "result", "tools")))
        yield* b.end
        assert.strictEqual(yield* b.exited, 0)
      }).pipe(Effect.scoped, Effect.provide(served)),
    30_000,
  )

  it.live(
    "a board server it can't reach answers each request with an error",
    () =>
      Effect.gen(function* () {
        const b = yield* bridge("http://127.0.0.1:1/api/mcp/r/huntaway", {})
        yield* b.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        const answer = yield* b.next
        assert.strictEqual(at(answer, "id"), 1)
        assert.match(String(at(answer, "error", "message")), /couldn't reach the board/)
        yield* b.end
        assert.strictEqual(yield* b.exited, 0)
      }).pipe(Effect.scoped),
    30_000,
  )
})

/** `acp-run` with fake-acp given the board's server, asked to call `test_echo`; its output and what fake-acp was sent. */
const acpCall = (server: { readonly url: string; readonly headers: Readonly<Record<string, string>> }, env: Readonly<Record<string, string>>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "acp-board-"))),
    (dir) =>
      Effect.callback<{ readonly out: ReadonlyArray<unknown>; readonly sent: ReadonlyArray<unknown>; readonly code: number | null }>((resume) => {
        const spec = {
          cwd: dir,
          program: FAKE_ACP,
          args: [],
          session_id: null,
          model: null,
          effort: null,
          mode: "default",
          system_prompt: "",
          input: false,
          requests_on_output: false,
          mcp_servers: [{ type: "http", name: "huntaway", url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }],
        }
        writeFileSync(join(dir, "acp.json"), text(spec))
        const log = join(dir, "sent.jsonl")
        writeFileSync(log, "")
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ACP_RUN, join(dir, "acp.json")], {
          env: { ...process.env, FAKE_ACP_LOG: log, HUNTAWAY_EXE: LAUNCHER, ...env },
          stdio: ["pipe", "pipe", "inherit"],
        })
        child.stdin.end('fake-board-call test_echo {"text":"from the agent"}')
        const out: Array<unknown> = []
        createInterface({ input: child.stdout }).on("line", (line) => out.push(parse(line)))
        child.on("close", (code) => {
          const sent = readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map(parse)
          resume(Effect.succeed({ out, sent, code }))
        })
        return Effect.sync(() => child.kill("SIGKILL"))
      }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const reply = (out: ReadonlyArray<unknown>) =>
  String(
    at(
      out.findLast((v) => at(v, "method") === "item/completed" && at(v, "params", "item", "type") === "agentMessage"),
      "params",
      "item",
      "text",
    ),
  )
const newSession = (sent: ReadonlyArray<unknown>) => sent.find((m) => at(m, "method") === "session/new")

describe("an ACP agent's board tools", () => {
  it.live(
    "go through mcp-stdio to an agent that takes no http MCP servers",
    () =>
      Effect.gen(function* () {
        const server = yield* boardServer
        const r = yield* acpCall(server, {})
        assert.strictEqual(r.code, 0)
        assert.deepStrictEqual(at(newSession(r.sent), "params", "mcpServers"), [
          { name: "huntaway", command: LAUNCHER, args: ["mcp-stdio", server.url], env: [{ name: "HUNTAWAY_MCP_HEADERS", value: text(server.headers) }] },
        ])
        assert.match(reply(r.out), /^Done\.\nboard test_echo: \{[\s\S]*"text": "from the agent"/u)
        assert.include(reply(r.out), server.task)
        // Shown as the board's MCP tool.
        const call = r.out.find((v) => at(v, "method") === "item/completed" && at(v, "params", "item", "type") === "mcpToolCall")
        assert.deepStrictEqual(
          [at(call, "params", "item", "server"), at(call, "params", "item", "tool"), at(call, "params", "item", "status")],
          ["huntaway", "test_echo", "completed"],
        )
      }).pipe(Effect.provide(served)),
    60_000,
  )

  it.live(
    "go as they are to one that takes http MCP servers",
    () =>
      Effect.gen(function* () {
        const server = yield* boardServer
        const r = yield* acpCall(server, { FAKE_ACP_HTTP_MCP: "1" })
        assert.strictEqual(r.code, 0)
        assert.strictEqual(at(newSession(r.sent), "params", "mcpServers", 0, "type"), "http")
        assert.match(reply(r.out), /board test_echo: \{[\s\S]*"text": "from the agent"/u)
      }).pipe(Effect.provide(served)),
    60_000,
  )
})
