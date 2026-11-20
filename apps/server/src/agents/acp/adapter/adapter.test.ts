import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { FAKE_ACP } from "@huntaway/testing"
import { decodeLine } from "../../codex/lines.ts"
import type { AcpSpec } from "../spec.ts"

// The ACP adapter (`huntaway acp-run`, run.ts) against fake-acp (packages/testing/bin/fake-acp), run as a run runs it
// (`node acp-run.ts <spec>`), as codex-run's test runs it: a reply, permissions asked on the output and answered on the
// input, a question, an interrupt, a message held during a turn, a session continued, a signed-out agent, and the
// model listing. Every line it writes decodes as a Codex run's output line. (A board tool's call through mcp-stdio is in
// mcp-stdio.test.ts, with the board's MCP server.)

const ENTRY = new URL("../../../acp-run.ts", import.meta.url).pathname

type Line = unknown

/** The value at `path` in `v`, if there is one. */
const at = (v: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((x, k) => (typeof x === "object" && x !== null ? Reflect.get(x, k) : undefined), v)

const Json = Schema.fromJsonString(Schema.Unknown)
const decode = Schema.decodeUnknownOption(Json)
const encode = Schema.encodeOption(Json)
const parse = (line: string): Line => Option.getOrUndefined(decode(line))
const text = (value: unknown): string => Option.getOrElse(encode(value), () => "null")
const lines = (s: string): ReadonlyArray<Line> =>
  s
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => parse(l))

interface Ran {
  readonly out: ReadonlyArray<Line>
  /** What the agent was sent (its log, without its start). */
  readonly sent: ReadonlyArray<Line>
  /** The agent's start: its args, cwd and BROWSER. */
  readonly start: Line
  readonly code: number | null
  readonly err: string
}

interface Drive {
  readonly fields?: Partial<AcpSpec>
  readonly env?: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
  /** Its stdin before its output is read: the prompt (and, with input, more lines may follow). */
  readonly stdin: string
  /** Each line of output, with what writes a line of input and what ends the input. */
  readonly onLine?: (v: Line, write: (line: unknown) => void, end: () => void) => void
}

/** Runs the adapter until it exits: its output, what the agent was sent, its exit code and stderr. */
const drive = (d: Drive) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "acp-run-"))),
    (dir) =>
      Effect.callback<Ran>((resume) => {
        const spec: AcpSpec = {
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
          mcp_servers: [],
          ...d.fields,
        }
        writeFileSync(join(dir, "acp.json"), text(spec))
        const log = join(dir, "sent.jsonl")
        writeFileSync(log, "")
        const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY, ...(d.args ?? []), join(dir, "acp.json")], {
          env: { ...process.env, FAKE_ACP_LOG: log, ...d.env },
          stdio: ["pipe", "pipe", "pipe"],
        })
        const out: Array<Line> = []
        let err = ""
        child.stderr.on("data", (c: Buffer) => (err += c.toString()))
        const write = (line: unknown) => child.stdin.write(`${text(line)}\n`)
        child.stdin.write(d.stdin)
        if (!spec.input) child.stdin.end()
        createInterface({ input: child.stdout }).on("line", (line) => {
          const v = parse(line)
          out.push(v)
          d.onLine?.(v, write, () => child.stdin.end())
        })
        child.on("close", (code) => {
          const all = lines(readFileSync(log, "utf8"))
          resume(Effect.succeed({ out, sent: all.filter((m) => at(m, "start") === undefined), start: at(all[0], "start"), code, err }))
        })
        return Effect.sync(() => child.kill("SIGKILL"))
      }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const user = (uuid: string, content: string) => `${text({ type: "user", uuid, message: { role: "user", content } })}\n`
const byMethod = (list: ReadonlyArray<Line>, method: string | undefined) => list.filter((v) => at(v, "method") === method)
const isRequest = (v: Line): boolean => at(v, "id") !== undefined && at(v, "method") !== undefined
/** The text of each prompt the agent was sent. */
const prompts = (sent: ReadonlyArray<Line>) => byMethod(sent, "session/prompt").map((m) => at(m, "params", "prompt", 0, "text"))
/** The reply its last turn wrote. */
const replyOf = (out: ReadonlyArray<Line>): unknown =>
  at(
    out.findLast((v) => at(v, "method") === "item/completed" && at(v, "params", "item", "type") === "agentMessage"),
    "params",
    "item",
    "text",
  )
const turnStatuses = (out: ReadonlyArray<Line>) => byMethod(out, "turn/completed").map((v) => at(v, "params", "turn", "status"))

/** Every line decodes as the board reads a Codex run's output. */
const allDecode = (out: ReadonlyArray<Line>) => {
  for (const v of out) assert.isTrue(decodeLine(text(v))._tag === "Success", text(v))
}

/** With input and the requests on the output: a run as the board starts one. */
const withBoard = (prompt: string, onLine: NonNullable<Drive["onLine"]>, fields: Partial<AcpSpec> = {}, env: Readonly<Record<string, string>> = {}) =>
  drive({ fields: { input: true, requests_on_output: true, ...fields }, env, stdin: user("u1", prompt), onLine })

describe("acp-run", () => {
  it.live(
    "a turn: the session started, the model and mode set, the instructions before the prompt, the reply",
    () =>
      Effect.gen(function* () {
        const r = yield* drive({
          fields: { model: "fake-pro", effort: "high", mode: "bypassPermissions", system_prompt: "Be brief." },
          stdin: "Hello fake-plan fake-usage",
        })
        assert.strictEqual(r.code, 0, r.err)
        allDecode(r.out)
        const session = at(r.out[0], "params", "thread", "id")
        assert.match(String(session), /^sess-/)
        assert.deepStrictEqual(at(byMethod(r.out, "huntaway/model")[0], "params"), { threadId: session, model: "fake-pro" })
        assert.strictEqual(replyOf(r.out), "Done.")
        assert.deepStrictEqual(turnStatuses(r.out), ["completed"])
        assert.strictEqual(byMethod(r.out, "turn/plan/updated").length, 1)
        assert.strictEqual(at(byMethod(r.out, "thread/tokenUsage/updated").at(-1), "params", "tokenUsage", "total", "totalTokens"), 1200)
        // What the agent was asked: no file system or terminal of the board's, the settings, the instructions first.
        assert.deepStrictEqual(at(byMethod(r.sent, "initialize")[0], "params", "clientCapabilities"), {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        })
        assert.deepStrictEqual(
          byMethod(r.sent, "session/set_config_option").map((m) => [at(m, "params", "configId"), at(m, "params", "value")]),
          [
            ["model", "fake-pro"],
            ["thinking", "high"],
          ],
        )
        assert.strictEqual(at(byMethod(r.sent, "session/set_mode")[0], "params", "modeId"), "yolo")
        assert.deepStrictEqual(prompts(r.sent), ["Be brief.\n\nHello fake-plan fake-usage"])
        // It never opens a browser to sign in.
        assert.strictEqual(at(r.start, "browser"), "true")
        // The agent's line that isn't JSON-RPC went to its stderr.
        assert.include(r.err, "Antigravity ACP server (fake) starting")
      }),
    30_000,
  )

  it.live(
    "a permission is asked on the output and answered on the input: allowed, and refused",
    () =>
      Effect.gen(function* () {
        const run = (decision: string) =>
          withBoard("fake-ask-permission fake-edit", (v, write, end) => {
            if (isRequest(v)) write({ type: "codex_response", id: at(v, "id"), result: { decision } })
            if (at(v, "method") === "turn/completed") end()
          })
        const allowed = yield* run("accept")
        assert.strictEqual(allowed.code, 0, allowed.err)
        allDecode(allowed.out)
        const requests = allowed.out.filter(isRequest)
        assert.deepStrictEqual(
          requests.map((r) => at(r, "method")),
          ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
        )
        assert.deepStrictEqual(
          requests.map((r) => at(r, "id")),
          [1, 2],
        )
        assert.strictEqual(at(requests[0], "params", "command"), "ls")
        assert.strictEqual(at(requests[0], "item", "type"), "commandExecution")
        assert.strictEqual(at(requests[1], "item", "changes", 0, "diff"), "@@ -1,1 +1,1 @@\n-old\n+new\n")
        assert.strictEqual(replyOf(allowed.out), "Done.\npermission execute: allow-once\npermission edit: allow-once")
        const done = byMethod(allowed.out, "item/completed").find((v) => at(v, "params", "item", "type") === "commandExecution")
        assert.deepStrictEqual([at(done, "params", "item", "status"), at(done, "params", "item", "aggregatedOutput")], ["completed", "fake\n"])

        const refused = yield* run("decline")
        assert.strictEqual(replyOf(refused.out), "Done.\npermission execute: reject-once\npermission edit: reject-once")
        const declined = byMethod(refused.out, "item/completed").flatMap((v) =>
          at(v, "params", "item", "status") === "declined" ? [at(v, "params", "item", "type")] : [],
        )
        assert.deepStrictEqual(declined, ["commandExecution", "fileChange"])
      }),
    30_000,
  )

  it.live(
    "without the board, permissions are refused, or allowed in a mode that asks nothing",
    () =>
      Effect.gen(function* () {
        const refused = yield* drive({ stdin: "fake-ask-permission" })
        assert.strictEqual(refused.out.filter(isRequest).length, 0)
        assert.strictEqual(replyOf(refused.out), "Done.\npermission execute: reject-once")
        const allowed = yield* drive({ fields: { mode: "bypassPermissions" }, stdin: "fake-ask-permission" })
        assert.strictEqual(replyOf(allowed.out), "Done.\npermission execute: allow-once")
      }),
    30_000,
  )

  it.live(
    "a question is asked as Codex's and answered with the option chosen",
    () =>
      Effect.gen(function* () {
        const r = yield* withBoard("fake-question", (v, write, end) => {
          if (at(v, "method") === "item/tool/requestUserInput") {
            assert.deepStrictEqual(at(v, "params", "questions", 0, "options"), [{ label: "A" }, { label: "B" }])
            write({ type: "codex_response", id: at(v, "id"), result: { answers: { answer: { answers: ["B"] } } } })
          }
          if (at(v, "method") === "turn/completed") end()
        })
        assert.strictEqual(r.code, 0, r.err)
        assert.strictEqual(replyOf(r.out), "Done.\nquestion: b")
      }),
    30_000,
  )

  it.live(
    "an interrupt cancels the turn, which ends interrupted, its open request no longer wanted",
    () =>
      Effect.gen(function* () {
        const r = yield* withBoard("fake-ask-permission fake-until-interrupted", (v, write, end) => {
          if (at(v, "method") === "item/commandExecution/requestApproval")
            write({ type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } })
          if (at(v, "method") === "turn/completed") end()
        })
        assert.strictEqual(r.code, 0, r.err)
        allDecode(r.out)
        assert.strictEqual(byMethod(r.sent, "session/cancel").length, 1)
        assert.deepStrictEqual(turnStatuses(r.out), ["interrupted"])
        assert.deepStrictEqual(
          byMethod(r.out, "serverRequest/resolved").map((v) => at(v, "params", "requestId")),
          [1],
        )
        // The agent was told its request was cancelled.
        assert.deepStrictEqual(
          at(
            byMethod(r.sent, undefined).find((m) => at(m, "id") === 1000),
            "result",
          ),
          { outcome: { outcome: "cancelled" } },
        )
      }),
    30_000,
  )

  it.live(
    "a message during a turn is held and starts the next turn, echoed then; one between turns starts a turn at once",
    () =>
      Effect.gen(function* () {
        let ended = 0
        const r = yield* withBoard("fake-ask-permission", (v, write, end) => {
          if (isRequest(v)) {
            write({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "Second" }] } })
            write({ type: "codex_response", id: at(v, "id"), result: { decision: "accept" } })
          }
          if (at(v, "method") !== "turn/completed") return
          ended++
          if (ended === 2) write({ type: "user", uuid: "u3", message: { role: "user", content: "Third" } })
          if (ended === 3) end()
        })
        assert.strictEqual(r.code, 0, r.err)
        allDecode(r.out)
        assert.deepStrictEqual(prompts(r.sent), ["fake-ask-permission", "Second", "Third"])
        const echoes = r.out.flatMap((v, i) => (at(v, "isReplay") === true ? [[at(v, "uuid"), i]] : []))
        assert.deepStrictEqual(
          echoes.map(([id]) => id),
          ["u2", "u3"],
        )
        // Each echoed as its turn starts.
        const starts = r.out.flatMap((v, i) => (at(v, "method") === "turn/started" ? [i] : []))
        assert.deepStrictEqual(
          echoes.map(([, i]) => i),
          [Number(starts[1]) + 1, Number(starts[2]) + 1],
        )
      }),
    30_000,
  )

  it.live(
    "a session is continued: resumed, else loaded (its history dropped), else started again with a warning",
    () =>
      Effect.gen(function* () {
        const fields = { session_id: "sess-old", system_prompt: "Be brief." }
        const resumed = yield* drive({ fields, stdin: "Again" })
        assert.strictEqual(resumed.code, 0, resumed.err)
        assert.strictEqual(at(byMethod(resumed.sent, "session/resume")[0], "params", "sessionId"), "sess-old")
        assert.strictEqual(at(resumed.out[0], "params", "thread", "id"), "sess-old")
        // The instructions are the new session's only.
        assert.deepStrictEqual(prompts(resumed.sent), ["Again"])

        const loaded = yield* drive({ fields, env: { FAKE_ACP_NO_RESUME: "1" }, stdin: "Again" })
        assert.strictEqual(byMethod(loaded.sent, "session/load").length, 1)
        const texts = byMethod(loaded.out, "item/completed").map((v) => at(v, "params", "item", "text"))
        assert.deepStrictEqual(texts, ["Done."])

        const fresh = yield* drive({ fields, env: { FAKE_ACP_NO_RESUME: "1", FAKE_ACP_NO_LOAD: "1" }, stdin: "Again" })
        assert.strictEqual(byMethod(fresh.sent, "session/new").length, 1)
        assert.match(String(at(byMethod(fresh.out, "warning")[0], "params", "message")), /can't continue an earlier session/)
        assert.notStrictEqual(at(fresh.out[0], "params", "thread", "id"), "sess-old")
        assert.deepStrictEqual(prompts(fresh.sent), ["Be brief.\n\nAgain"])
      }),
    30_000,
  )

  it.live(
    "a signed-out agent fails the run with how to sign in",
    () =>
      Effect.gen(function* () {
        const r = yield* drive({ env: { FAKE_ACP_SIGNED_OUT: "1" }, stdin: "Hello" })
        assert.strictEqual(r.code, 1)
        assert.include(r.err, `huntaway acp-run: the ACP agent needs a sign-in: run \`${FAKE_ACP}\` once in a terminal and sign in`)
        assert.strictEqual(byMethod(r.sent, "authenticate").length, 0)
      }),
    30_000,
  )

  it.live(
    "--list-models: the models and efforts, or exit 3 for a sign-in",
    () =>
      Effect.gen(function* () {
        const r = yield* drive({ args: ["--list-models"], env: { FAKE_ACP_MODELS: "g-1,g-2" }, stdin: "" })
        assert.strictEqual(r.code, 0, r.err)
        assert.deepStrictEqual(r.out, [
          {
            models: [
              { id: "g-1", name: "G-1", description: "The g-1 model." },
              { id: "g-2", name: "G-2", description: "The g-2 model." },
            ],
            current: "g-1",
            efforts: ["low", "high"],
            default_effort: "low",
          },
        ])
        assert.deepStrictEqual(at(byMethod(r.sent, "session/new")[0], "params", "mcpServers"), [])
        const out = yield* drive({ args: ["--list-models"], env: { FAKE_ACP_SIGNED_OUT: "1" }, stdin: "" })
        assert.strictEqual(out.code, 3)
        assert.include(out.err, "needs a sign-in")
      }),
    30_000,
  )

  it.live(
    "an agent that exits mid-turn fails the run with its stderr",
    () =>
      Effect.gen(function* () {
        const r = yield* drive({ fields: { program: "sh", args: ["-c", "read line; echo 'it broke' >&2; exit 4"] }, stdin: "Hello" })
        assert.strictEqual(r.code, 1)
        assert.include(r.err, "the agent exited (exit status: 4) before answering initialize:\nit broke")
      }),
    30_000,
  )
})
