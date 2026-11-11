import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { Scope } from "effect"
import { TestRuns } from "@huntaway/testing"
import { RunId } from "@huntaway/contracts"
import { formatSupport, headerFormat, RUN_FORMAT, RunDir, sortKeys } from "./RunDir.ts"

// The run folder's files (inventory 01, section 3), read and written as the shim and older servers do.

const run = <A, E>(effect: Effect.Effect<A, E, RunDir | FileSystem.FileSystem | Scope.Scope>) => effect.pipe(Effect.scoped, Effect.provide(TestRuns()))

/** A run's folder with `files` in it. */
const folder = (id: string, files: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const dir = yield* RunDir
    const fs = yield* FileSystem.FileSystem
    const runId = RunId.make(id)
    yield* dir.make(runId)
    for (const [name, text] of Object.entries(files)) yield* fs.writeFileString(`${dir.path(runId)}/${name}`, text)
    return runId
  })

/** An assistant message saying `text` (plain words), as a line of output. */
const said = (text: string) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}`

/** A tool result with an image that makes its line over 1 MiB, as a Read of a big screenshot does. */
const screenshot = () =>
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"image","source":{"type":"base64","data":"${"A".repeat(3 << 20)}"}}]}]}}`

describe("RunDir", () => {
  it.effect("writes format 6 with this boot, and follows formats 5 and 6 only", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const id = yield* folder("r1")
        yield* dir.writeHeader(id)
        const header = yield* dir.header(id)
        assert.deepStrictEqual(header, { boot: dir.boot, format: RUN_FORMAT, version: "0.1.0" })
        assert.strictEqual(RUN_FORMAT, 6)
        assert.strictEqual(formatSupport(header), "supported")
        assert.strictEqual(formatSupport({ format: 5 }), "supported")
        assert.strictEqual(formatSupport({ format: 7 }), "newer")
        assert.strictEqual(formatSupport({ format: 4 }), "older")
        // No run.json is format 1.
        assert.strictEqual(headerFormat(yield* dir.header(yield* folder("r2"))), 1)
        assert.strictEqual(headerFormat({ format: "6" }), 1)
        assert.isFalse(yield* dir.rebooted(id))
      }),
    ),
  )

  // HA-341: a pid recorded before a reboot may be someone else's now; a run from before boot ids goes by its pid.
  it.effect("tells a run from before a reboot", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const before = yield* folder("r1", { "run.json": '{"boot":"a boot before this one","format":5}' })
        const unknown = yield* folder("r2", { "run.json": '{"format":5}' })
        assert.strictEqual(yield* dir.rebooted(before), dir.boot !== null)
        assert.isFalse(yield* dir.rebooted(unknown))
      }),
    ),
  )

  it.effect("appends whole lines to the input until it is closed or the run exits", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        // A run that takes no input (a compaction) has no input.jsonl.
        const compact = yield* folder("r1")
        assert.isFalse(yield* dir.appendInput(compact, "{}"))
        yield* dir.closeInput(compact)
        assert.isFalse(yield* dir.inputClosed(compact))

        const id = yield* folder("r2")
        yield* dir.createInput(id)
        assert.isTrue(yield* dir.acceptsInput(id))
        assert.isTrue(yield* dir.appendInput(id, '{"a":1}\n\n'))
        assert.isTrue(yield* dir.appendInput(id, '{"b":2}'))
        assert.strictEqual(yield* dir.input(id), '{"a":1}\n{"b":2}\n')
        yield* dir.closeInput(id)
        yield* dir.closeInput(id)
        assert.isTrue(yield* dir.inputClosed(id))
        assert.isFalse(yield* dir.appendInput(id, '{"c":3}'))

        const exited = yield* folder("r3", { "input.jsonl": "", exit: '{"code":0,"signal":null}' })
        assert.isFalse(yield* dir.acceptsInput(exited))
        assert.isFalse(yield* dir.appendInput(exited, "{}"))
        assert.strictEqual(yield* dir.input(exited), "")
      }),
    ),
  )

  it.effect("reads whole lines while the run goes, and everything once it has exited", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const fs = yield* FileSystem.FileSystem
        const partial = said("three").slice(0, 20)
        const out = `${said("one")}\n${said("two")}\r\n${partial}`
        const id = yield* folder("r1", { "out.jsonl": out })
        const first = yield* dir.readOutput(id, 0)
        assert.deepStrictEqual(first.lines, [said("one"), said("two")])
        const whole = Buffer.byteLength(`${said("one")}\n${said("two")}\r\n`)
        assert.deepStrictEqual([first.end, first.exit, first.drained], [whole, null, false])
        assert.deepStrictEqual(yield* dir.readOutput(id, whole), { lines: [], end: whole, exit: null, drained: false })
        // The agent was killed while writing: its last line is taken as it is.
        yield* fs.writeFileString(`${dir.path(id)}/exit`, '{"code":null,"signal":9}')
        const last = yield* dir.readOutput(id, whole)
        assert.deepStrictEqual(last, { lines: [partial], end: Buffer.byteLength(out), exit: { code: null, signal: 9 }, drained: true })
        // A saved offset past what the file has (it was cut short) reads as nothing new.
        assert.deepStrictEqual(yield* dir.readOutput(id, Buffer.byteLength(out) + 10), {
          lines: [],
          end: Buffer.byteLength(out) + 10,
          exit: { code: null, signal: 9 },
          drained: true,
        })
        // A run with no output yet.
        assert.deepStrictEqual(yield* dir.readOutput(yield* folder("r2"), 0), { lines: [], end: 0, exit: null, drained: false })
      }),
    ),
  )

  it.effect("reads past a line longer than a chunk", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const out = `${said("checking the screenshot")}\n${screenshot()}\n${said("looks right")}\n`
        const id = yield* folder("r1", { "out.jsonl": out })
        const first = yield* dir.readOutput(id, 0)
        assert.strictEqual(first.lines.length, 1)
        const second = yield* dir.readOutput(id, first.end)
        assert.strictEqual(second.lines.length, 2)
        assert.strictEqual(second.lines[0], screenshot())
        assert.strictEqual(second.end, Buffer.byteLength(out))
        // Small chunks double the same way.
        const small = yield* dir.readOutput(id, 0, 16)
        assert.deepStrictEqual(small.lines, [said("checking the screenshot")])
      }),
    ),
  )

  it.effect("reads the exit leniently, the pids, and the end of err.log", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const id = yield* folder("r1", {
          exit: '{"code":1,"signal":null,"error":"failed to start x: No such file"}',
          "shim.pid": "123\n",
          pid: "-",
          "err.log": `${"x".repeat(5000)}the end`,
        })
        assert.deepStrictEqual(yield* dir.exit(id), { code: 1, signal: null, error: "failed to start x: No such file" })
        assert.deepStrictEqual(yield* dir.pids(id), { shim: 123, agent: null })
        const tail = yield* dir.errorTail(id)
        assert.strictEqual(tail.length, 4000)
        assert.isTrue(tail.endsWith("the end"))
        const odd = yield* folder("r2", { exit: '{"code":"0","signal":1.5}' })
        assert.deepStrictEqual(yield* dir.exit(odd), { code: null, signal: null })
        const broken = yield* folder("r3", { exit: "{" })
        assert.deepStrictEqual(yield* dir.exit(broken), { code: null, signal: null })
        assert.strictEqual(yield* dir.exit(yield* folder("r4")), null)
        assert.strictEqual(yield* dir.errorTail(odd), "")
        yield* dir.writeExit(odd, { code: null, signal: null, error: "the run's supervisor (ia-shim) disappeared" })
        const fs = yield* FileSystem.FileSystem
        assert.strictEqual(
          yield* fs.readFileString(`${dir.path(odd)}/exit`),
          `{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}`,
        )
      }),
    ),
  )

  it.effect("writes a launch's files, spec.json last", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* RunDir
        const fs = yield* FileSystem.FileSystem
        const id = RunId.make("r1")
        yield* dir.prepare(id, {
          program: "claude",
          args: ["-p", "--mcp-config", dir.mcpConfigPath(id)],
          env: [],
          cwd: "/w",
          configDir: "~/.claude-me",
          prompt: "hello",
          input: true,
          promptId: "u1",
          systemPrompt: "be good",
          mcpServers: { gh: { url: "http://x", type: "http" }, docs: { type: "http", url: "http://y" } },
          mcpRun: { cwd: "/w", github_account: null, review: false, in_process: true, desktop: false },
        })
        const read = (name: string) => fs.readFileString(`${dir.path(id)}/${name}`)
        assert.strictEqual(yield* read("prompt"), "hello")
        assert.strictEqual(yield* read("input.jsonl"), "")
        assert.strictEqual(yield* dir.awaited(id), "u1")
        assert.strictEqual(yield* read("system-prompt.md"), "be good")
        assert.strictEqual(
          yield* read("mcp.json"),
          `{\n  "mcpServers": {\n    "docs": {\n      "type": "http",\n      "url": "http://y"\n    },\n    "gh": {\n      "type": "http",\n      "url": "http://x"\n    }\n  }\n}`,
        )
        assert.deepStrictEqual(yield* dir.mcpRun(id), { cwd: "/w", github_account: null, review: false, in_process: true, desktop: false })
        assert.deepStrictEqual(yield* dir.spec(id), { args: ["-p", "--mcp-config", dir.mcpConfigPath(id)], config_dir: "~/.claude-me", cwd: "/w" })
        assert.strictEqual(headerFormat(yield* dir.header(id)), RUN_FORMAT)
        yield* dir.setAwaited(id, null)
        assert.strictEqual(yield* dir.awaited(id), null)
        yield* dir.setMarker(id, "reap", true)
        assert.isTrue(yield* dir.marker(id, "reap"))
        yield* dir.setMarker(id, "reap", false)
        assert.isFalse(yield* dir.marker(id, "reap"))
        assert.isFalse(yield* dir.started(id))
        assert.deepStrictEqual(yield* dir.list, ["r1"])
        yield* dir.remove(id)
        assert.isFalse(yield* dir.exists(id))
      }),
    ),
  )

  it("sorts keys at every depth", () => {
    const sorted = sortKeys({ b: 1, a: [{ d: 1, c: 2 }] })
    assert.deepStrictEqual(sorted, { a: [{ c: 2, d: 1 }], b: 1 })
    assert.deepStrictEqual(Object.keys(Object(sorted)), ["a", "b"])
    assert.deepStrictEqual(Object.keys(Object(Object(sorted).a[0])), ["c", "d"])
  })
})
