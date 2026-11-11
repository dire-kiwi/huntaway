import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { CallId, threadKindOf } from "@huntaway/contracts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { fakeAgent, fakeCuaDriver, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeCuaDriver } from "@huntaway/testing"
import { DESKTOP_READS, DESKTOP_WRITES } from "../agents/claude/access.ts"
import { keyPrefix } from "../agents/prompts/context.ts"
import { callResult } from "../mcp/jsonrpc.ts"
import { DESKTOP_INSTRUCTIONS, McpServers } from "../mcp/McpServers.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { CuaDriver } from "./CuaDriver.ts"
import { forAgent } from "./cua.ts"
import { Desktop } from "./Desktop.ts"
import { DesktopClaims, LEASE_MS } from "./DesktopClaims.ts"
import { DesktopOpRepo } from "./DesktopOpRepo.ts"

// Computer use (docs/plan/inventory/05-hosts-update.md 2.8, 03-mcp.md 2.12): the `desktop` server's tools against the
// fake driver (`@huntaway/testing`'s `fakeCuaDriver`), which logs what it's called with, and the viewer's frames. The
// old desktop/tests.test.ts's cases, called as a run does, through `ToolCalls`. Installing is CuaInstall.test.ts's.

/** The whole board with computer use on, over a fake driver. */
const withDesktop = <A, E, R>(body: (fake: FakeCuaDriver) => Effect.Effect<A, E, R>, overrides: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const fake = yield* fakeCuaDriver
    const on = Effect.gen(function* () {
      yield* (yield* Desktop).setEnabled(true)
    })
    return yield* Effect.andThen(on, body(fake)).pipe(Effect.provide(TestBoard({ cuaDriver: fake.bin, ...overrides })))
  }).pipe(Effect.provide(NodeServices.layer))

/** A call of the desktop server's `tool`, as run `agent` makes it, and its result as the agent gets it. */
const desktopCall = (agent: FakeAgent, tool: string, args: unknown) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* (yield* ToolCalls).call({ call_id: id, run: agent.run.id, server: "desktop", tool, args })
    return yield* callResult(result, "desktop")
  })

const Said = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String })

/** A result's text, and whether it is an error. */
const said = (result: unknown): { readonly text: string; readonly error: boolean; readonly images: ReadonlyArray<string> } => {
  if (!Schema.is(Said)(result)) return assert.fail("not a tool's result")
  const text = result.content
    .filter(Schema.is(TextPart))
    .map((c) => c.text)
    .join("\n")
  const images = result.content.filter(Schema.is(ImagePart)).map((c) => c.mimeType)
  return { text, error: result.isError === true, images }
}

/** The session the agent's task is driven under (`huntaway-<key>`). */
const sessionOf = (agent: FakeAgent) =>
  Effect.gen(function* () {
    const task = (yield* (yield* TaskRepo).get(agent.run.task_id)) ?? assert.fail("no task")
    return `huntaway-${keyPrefix(threadKindOf(task), task, null)}-${task.number}`
  })

const step = { pid: 1, steps: [{ tool: "click", args: { x: 1, y: 1 } }] }

describe("the desktop server", () => {
  it.effect("lists its 11 tools, the ones that only look saying so, and tells agents how to use them", () =>
    withDesktop(() =>
      Effect.gen(function* () {
        const servers = yield* McpServers
        const tools = yield* servers.tools("desktop", false)
        assert.deepStrictEqual(
          tools.map((t) => t.name),
          [...DESKTOP_READS.slice(0, 7), DESKTOP_READS[7], ...DESKTOP_WRITES],
        )
        for (const t of tools) assert.strictEqual(t.annotations?.["readOnlyHint"], DESKTOP_READS.includes(t.name), t.name)
        const act = tools.find((t) => t.name === "act") ?? assert.fail("no act")
        assert.deepStrictEqual(act.inputSchema["required"], ["pid", "steps"])
        const init = servers.initializeResult("desktop", "2025-06-18")
        assert.deepStrictEqual([init["serverInfo"], init["instructions"]], [{ name: "huntaway-desktop", version: "0.1.0" }, DESKTOP_INSTRUCTIONS])
        // Runs get it while computer use is on and there's a driver; not once it's off.
        assert.isTrue(yield* servers.serves("desktop"))
        yield* (yield* Desktop).setEnabled(false)
        assert.isFalse(yield* servers.serves("desktop"))
      }),
    ),
  )

  it.effect("read-only tools pass on Cua's arguments, with the task's session where a tool takes one", () =>
    withDesktop((fake) =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        const session = yield* sessionOf(agent)
        const read = said(yield* desktopCall(agent, "read", { pid: 4242, query: "Save" }))
        assert.include(read.text, 'button "Save"')
        assert.include(said(yield* desktopCall(agent, "apps", {})).text, "Fake Notes")
        const screen = said(yield* desktopCall(agent, "screen", { pid: 4242, window_id: 7 }))
        assert.deepStrictEqual(screen.images, ["image/png"])
        // An argument the tool doesn't have is refused, naming the ones it has (the old server dropped it).
        assert.include(said(yield* desktopCall(agent, "read", { pid: 4242, bogus: 1 })).text, "read has no argument")
        const [state, list, look] = yield* fake.calls
        // A tree without the image unless asked; the session, which list_apps doesn't take, isn't given it.
        assert.deepStrictEqual(state, { tool: "get_window_state", args: { include_screenshot: false, pid: 4242, query: "Save", session } })
        assert.deepStrictEqual(list, { tool: "list_apps", args: {} })
        assert.deepStrictEqual(look?.args, { pid: 4242, window_id: 7, include_screenshot: true, include_accessibility_tree: false, session })
        // The viewer shows the window it last looked at.
        const target = yield* (yield* DesktopClaims).target(agent.run.task_id)
        assert.deepStrictEqual([target?.pid, target?.window_id], [4242, 7])
      }),
    ),
  )

  it.effect("agents get a result's text with its structured fields as JSON, not as structured content", () =>
    // Claude Code gives the model a result's structuredContent in place of its text when it has some, which hid the
    // tree's rows (found running a haiku agent against the fake driver).
    withDesktop(() =>
      Effect.gen(function* () {
        const tree = 'snapshot s1\n[0] window "untitled"\n  [2] button "Save" with a long enough label'
        assert.deepStrictEqual(forAgent({ content: [{ type: "text", text: tree }], structuredContent: { snapshot_id: "s1", tree_markdown: tree } }), {
          content: [
            { type: "text", text: tree },
            { type: "text", text: '{"snapshot_id":"s1"}' },
          ],
        })
        const agent = yield* fakeAgent()
        const read = yield* desktopCall(agent, "read", { pid: 4242 })
        assert.isFalse(typeof read === "object" && read !== null && "structuredContent" in read)
        const text = said(read).text
        assert.isTrue(text.includes('button "Save"') && text.includes('"snapshot_id":"s00000001"'), text)
      }),
    ),
  )

  it.effect("an action is journaled, and one with an op_id runs once", () =>
    withDesktop((fake) =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        const session = yield* sessionOf(agent)
        const ops = yield* DesktopOpRepo
        const steps = [
          { tool: "type_text", args: { element_token: "s00000001:1", text: "hi" } },
          { tool: "press_key", args: { key: "return" } },
        ]
        assert.include(said(yield* desktopCall(agent, "act", { pid: 4242, steps, op_id: "a1" })).text, "ran 2 steps")
        assert.isTrue(said(yield* desktopCall(agent, "act", { pid: 4242, steps, op_id: "a1" })).text.startsWith("op a1 already ran (ok)"))
        // Run once, and by default it reads what changed after.
        const runs = (yield* fake.calls).filter((c) => c.tool === "run_steps")
        assert.strictEqual(runs.length, 1)
        assert.deepStrictEqual(runs[0]?.args, { observe: {}, pid: 4242, steps, session })
        const [op] = yield* ops.ofTask(agent.run.task_id)
        assert.deepStrictEqual([op?.tool, op?.op_id, op?.status, op?.summary], ["act", "a1", "ok", 'type "hi", press return'])
        assert.include(said(yield* desktopCall(agent, "op_status", { op_id: "a1" })).text, ": ok")
        assert.include(said(yield* desktopCall(agent, "op_status", { op_id: "nope" })).text, "didn't run")
        // A failed one is journaled as failed, and comes back as the driver's error.
        yield* fake.fail("launch_app")
        const failed = said(yield* desktopCall(agent, "launch", { name: "notes", op_id: "l1" }))
        assert.isTrue(failed.error)
        assert.strictEqual((yield* ops.find(agent.run.task_id, "l1"))?.status, "failed")
        // A launched app's window is the one the viewer shows.
        yield* fake.fail(null)
        yield* desktopCall(agent, "launch", { name: "notes" })
        const target = yield* (yield* DesktopClaims).target(agent.run.task_id)
        assert.deepStrictEqual([target?.pid, target?.window_id], [5151, 9])
      }),
    ),
  )

  it.effect("turned off, its tools refuse and nothing starts the driver again", () =>
    // HA-273's review: turning computer use off stops the driver, and a run that was going kept acting by starting it.
    withDesktop((fake) =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        assert.isFalse(said(yield* desktopCall(agent, "act", step)).error)
        yield* (yield* Desktop).setEnabled(false)
        const before = (yield* fake.calls).length
        for (const [tool, args] of [
          ["act", step],
          ["launch", { name: "x" }],
          ["clipboard", {}],
          ["windows", {}],
        ] as const) {
          const res = said(yield* desktopCall(agent, tool, args))
          assert.isTrue(res.error && res.text.includes("turned off"), res.text)
        }
        const Health = Schema.fromJsonString(Schema.Struct({ driver: Schema.Struct({ error: Schema.String }) }))
        const health = yield* Schema.decodeEffect(Health)(said(yield* desktopCall(agent, "health", {})).text)
        assert.include(health.driver.error, "turned off")
        assert.strictEqual((yield* fake.calls).length, before)
        assert.strictEqual((yield* (yield* CuaDriver).status).state, "stopped")
      }),
    ),
  )

  it.effect("plan mode and reviewers only look, and a plan approved mid-run can act", () =>
    // HA-407's review: plan mode took the tools that act away at launch, so a run whose plan was approved (it goes on,
    // in the same process) couldn't act for the rest of it. They're refused per call instead, as the board's are.
    withDesktop((fake) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const agent = yield* fakeAgent()
        yield* sql`UPDATE tasks SET permission_mode = 'plan' WHERE id = ${agent.run.task_id}`
        for (const [tool, args] of [
          ["act", step],
          ["launch", { name: "x" }],
          ["clipboard", { text: "x" }],
        ] as const) {
          const res = said(yield* desktopCall(agent, tool, args))
          assert.isTrue(res.error && res.text.includes("plan mode"), res.text)
        }
        assert.strictEqual((yield* fake.calls).filter((c) => c.tool === "run_steps").length, 0)
        assert.strictEqual((yield* (yield* DesktopOpRepo).ofTask(agent.run.task_id)).length, 0)
        // It still looks.
        assert.isFalse(said(yield* desktopCall(agent, "windows", {})).error)
        // Its plan approved, the same run acts.
        yield* sql`UPDATE tasks SET permission_mode = 'default' WHERE id = ${agent.run.task_id}`
        assert.isFalse(said(yield* desktopCall(agent, "act", step)).error)
        assert.strictEqual((yield* fake.calls).filter((c) => c.tool === "run_steps").length, 1)
        // A reviewer only looks, whatever its tool list.
        const reviewer = yield* fakeAgent()
        yield* sql`UPDATE tasks SET kind = 'review' WHERE id = ${reviewer.run.task_id}`
        const res = said(yield* desktopCall(reviewer, "act", step))
        assert.isTrue(res.error && res.text.includes("reviewers"), res.text)
      }),
    ),
  )

  it.effect("the clipboard reads its text", () =>
    // HA-273's review: Cua's clipboard_read gives the text only when asked for it (include_text).
    withDesktop((fake) =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        yield* desktopCall(agent, "clipboard", { text: "copied words" })
        assert.include(said(yield* desktopCall(agent, "clipboard", {})).text, "copied words")
        assert.deepStrictEqual((yield* fake.calls).find((c) => c.tool === "clipboard_read")?.args, { include_text: true, session: yield* sessionOf(agent) })
      }),
    ),
  )

  it.effect("an op left running by an earlier server is interrupted, and not run again", () =>
    withDesktop((fake) =>
      Effect.gen(function* () {
        const agent = yield* fakeAgent()
        const sql = yield* SqlClient.SqlClient
        yield* (yield* DesktopOpRepo).start({
          id: "o1",
          task_id: agent.run.task_id,
          run_id: agent.run.id,
          op_id: "c1",
          tool: "clipboard",
          summary: "copy",
          args: {},
          now: agent.run.created_at,
        })
        yield* sql`UPDATE desktop_ops SET boot = 'an-older-boot' WHERE id = 'o1'`
        const res = said(yield* desktopCall(agent, "clipboard", { text: "x", op_id: "c1" }))
        assert.include(res.text, "already ran (interrupted: whether it took effect isn't known")
        assert.include(said(yield* desktopCall(agent, "op_status", { op_id: "c1" })).text, "interrupted (the board's server stopped while it ran")
        assert.strictEqual((yield* fake.calls).length, 0)
      }),
    ),
  )

  it.effect("a locked screen stops everything but health and op_status", () =>
    withDesktop(
      (fake) =>
        Effect.gen(function* () {
          const agent = yield* fakeAgent()
          for (const [tool, args] of [
            ["windows", {}],
            ["act", step],
          ] as const) {
            const res = said(yield* desktopCall(agent, tool, args))
            assert.isTrue(res.error && res.text.includes("is locked"), res.text)
          }
          const Health = Schema.fromJsonString(Schema.Struct({ locked: Schema.Boolean, driver: Schema.Struct({ version: Schema.String }) }))
          const health = yield* Schema.decodeEffect(Health)(said(yield* desktopCall(agent, "health", {})).text)
          assert.deepStrictEqual([health.locked, health.driver.version], [true, "0.0.0-fake"])
          assert.isFalse(said(yield* desktopCall(agent, "op_status", { op_id: "a" })).error)
          assert.strictEqual((yield* fake.calls).filter((c) => c.tool !== "check_permissions").length, 0)
        }),
      { desktopLocked: true },
    ),
  )

  it.effect("one task drives the desktop at a time", () =>
    withDesktop(() =>
      Effect.gen(function* () {
        const claims = yield* DesktopClaims
        const sql = yield* SqlClient.SqlClient
        const agent = yield* fakeAgent()
        const other = yield* fakeAgent()
        yield* sql`UPDATE tasks SET title = 't' WHERE id = ${agent.run.task_id}`
        assert.isFalse(said(yield* desktopCall(agent, "act", step)).error)
        const refused = said(yield* desktopCall(other, "act", step))
        const key = (yield* sessionOf(agent)).slice("huntaway-".length)
        assert.isTrue(refused.error && refused.text.includes(`${key} ("t") is using this desktop`), refused.text)
        // Reads don't wait for it, and once its lease is up the other task may act.
        assert.isFalse(said(yield* desktopCall(other, "windows", {})).error)
        assert.isNull(yield* claims.claim(other.run.task_id, LEASE_MS))
        assert.deepStrictEqual(yield* claims.claim(agent.run.task_id, LEASE_MS), { task_id: other.run.task_id, at: LEASE_MS })
      }),
    ),
  )

  it.effect("the viewer gets frames of the window the agent last used, only while the driver runs", () =>
    withDesktop((fake) =>
      Effect.gen(function* () {
        const desktop = yield* Desktop
        const agent = yield* fakeAgent()
        const task = agent.run.task_id
        assert.include((yield* desktop.frame({ task_id: task })).reason ?? "", "isn't running")
        yield* desktopCall(agent, "read", { pid: 4242, window_id: 7 })
        const { frame } = yield* desktop.frame({ task_id: task })
        assert.deepStrictEqual([frame?.mime, frame?.pid, frame?.window_id, frame?.width], ["image/png", 4242, 7, 160])
        assert.isTrue((frame?.data.length ?? 0) > 100)
        assert.deepStrictEqual((yield* fake.calls).at(-1), {
          tool: "get_window_state",
          args: { pid: 4242, include_screenshot: true, window_id: 7, include_accessibility_tree: false, display_only: true, max_image_dimension: 1280 },
        })
        // A task that hasn't used it sees the desktop.
        const other = yield* fakeAgent()
        assert.isNull((yield* desktop.frame({ task_id: other.run.task_id })).frame?.pid)
        assert.strictEqual((yield* fake.calls).at(-1)?.tool, "get_desktop_state")
        // What the task did, newest first, with the window it last used.
        yield* desktopCall(agent, "act", { ...step, pid: 4242, window_id: 7 })
        const ops = yield* desktop.ops(task)
        assert.deepStrictEqual([ops.ops.map((o) => o.summary), ops.target?.pid], [["click"], 4242])
        // Off, it shows nothing.
        yield* desktop.setEnabled(false)
        assert.isNull((yield* desktop.frame({ task_id: task })).frame)
      }),
    ),
  )

  it.effect("a run launched while computer use is on gets the server, with its reads allowed and a word on the desktop", () =>
    withDesktop(() =>
      Effect.gen(function* () {
        const facts = yield* LaunchFacts
        const agent = yield* fakeAgent()
        const on = (yield* facts.claude(agent.run, "go")).spec
        assert.isTrue(on.mcpServers !== null && "desktop" in on.mcpServers)
        assert.isTrue(on.mcpRun?.desktop)
        assert.include(on.args.join(" "), "mcp__desktop__read")
        assert.include(on.systemPrompt ?? "", "You can see and use the desktop of test")
        yield* (yield* Desktop).setEnabled(false)
        const off = (yield* facts.claude(agent.run, "go")).spec
        assert.isFalse(off.mcpServers !== null && "desktop" in off.mcpServers)
        assert.isFalse(off.mcpRun?.desktop)
        assert.notInclude(off.systemPrompt ?? "", "desktop of test")
      }),
    ),
  )

  it.effect("the host's page sees the driver, starts it to check it, and stops it", () =>
    withDesktop((fake) =>
      Effect.gen(function* () {
        const desktop = yield* Desktop
        const before = yield* desktop.status
        assert.deepStrictEqual(
          [before.enabled, before.installed, before.driver.state, before.locked],
          [true, { path: fake.bin, source: "env", version: null }, "stopped", false],
        )
        const checked = yield* desktop.check
        assert.deepStrictEqual(
          [checked.check, checked.driver.state, checked.driver.version],
          ["accessibility: granted\nscreen_recording: granted", "running", "0.0.0-fake"],
        )
        // A task holding the desktop is shown.
        const agent = yield* fakeAgent()
        yield* desktopCall(agent, "act", step)
        assert.strictEqual((yield* desktop.status).in_use_by?.task_id, agent.run.task_id)
        assert.strictEqual((yield* desktop.stop).driver.state, "stopped")
      }),
    ),
  )
})
