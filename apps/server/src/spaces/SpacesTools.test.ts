import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { CallId } from "@huntaway/contracts"
import { fakeAgent, fakeDocker, fakeSpacesd, TestBoard } from "@huntaway/testing"
import type { FakeAgent, FakeDocker, FakeSpacesd } from "@huntaway/testing"
import { SPACES_READS } from "../agents/claude/access.ts"
import { callResult } from "../mcp/jsonrpc.ts"
import { McpServers, SPACES_INSTRUCTIONS } from "../mcp/McpServers.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { Permissions } from "../permissions/Permissions.ts"
import { NAME_PREFIX } from "./containers.ts"
import { Spaces } from "./Spaces.ts"

// The `spaces` server (HE-37) as a run calls it, through `ToolCalls`, on the whole board over a fake Docker CLI
// (`fakeDocker`: bin/fake-docker, which keeps its containers in a folder) and a fake spacesd (`fakeSpacesd`: its health
// check and the driver's `/mcp`). Never this machine's Docker.

interface Fakes {
  readonly docker: FakeDocker
  readonly spacesd: FakeSpacesd
}

/** The whole board with Spaces on for its agents, over the fakes. */
const withSpaces = <A, E, R>(body: (fakes: Fakes) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const docker = yield* fakeDocker
    const spacesd = yield* fakeSpacesd
    yield* docker.setSpacesdPort(spacesd.port)
    const on = Effect.flatMap(Spaces, (s) => s.setAgentTools(true))
    return yield* Effect.andThen(on, body({ docker, spacesd })).pipe(Effect.provide(TestBoard({ dockerBin: docker.bin })))
  }).pipe(Effect.provide(NodeServices.layer))

/** A call of the spaces server's `tool`, as run `agent` makes it (with call id `id`), and its result as the agent gets it. */
const spacesCall = (agent: FakeAgent, tool: string, args: unknown, id?: string) =>
  Effect.gen(function* () {
    const call = CallId.make(id ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4()))
    const result = yield* (yield* ToolCalls).call({ call_id: call, run: agent.run.id, server: "spaces", tool, args })
    return yield* callResult(result, "spaces")
  })

const Said = Schema.Struct({ content: Schema.Array(Schema.Unknown), isError: Schema.optional(Schema.Boolean) })
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ImagePart = Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String })

/** A result's text, its images' types, and whether it is an error. */
const said = (result: unknown): { readonly text: string; readonly error: boolean; readonly images: ReadonlyArray<string> } => {
  if (!Schema.is(Said)(result)) return assert.fail("not a tool's result")
  const text = result.content
    .filter(Schema.is(TextPart))
    .map((c) => c.text)
    .join("\n")
  return { text, error: result.isError === true, images: result.content.filter(Schema.is(ImagePart)).map((c) => c.mimeType) }
}

/** Every Docker command starts a Node process (bin/fake-docker), and a Space takes a dozen. */
const TIMEOUT = 30_000

/** The id of the Space a create_space answer names. */
const idIn = (text: string) => /\(([a-z0-9]+)\)/u.exec(text)?.[1] ?? assert.fail(`no id in ${text}`)

describe("the spaces server", () => {
  it.effect(
    "lists its tools, the ones that only look saying so; runs get it while it's on and Docker answers",
    () =>
      withSpaces(({ docker }) =>
        Effect.gen(function* () {
          const servers = yield* McpServers
          const tools = yield* servers.tools("spaces", false)
          assert.deepStrictEqual(
            tools.map((t) => t.name),
            ["list_spaces", "create_space", "start_space", "stop_space", "delete_space", "space_bash", "space_list_tools", "space_call_tool", "space_view"],
          )
          for (const t of tools) assert.strictEqual(t.annotations?.["readOnlyHint"], SPACES_READS.includes(t.name), t.name)
          const init = servers.initializeResult("spaces", "2025-06-18")
          assert.deepStrictEqual([init["serverInfo"], init["instructions"]], [{ name: "huntaway-spaces", version: "0.1.0" }, SPACES_INSTRUCTIONS])
          assert.isTrue(yield* servers.serves("spaces"))
          yield* docker.setDown(true)
          assert.isFalse(yield* servers.serves("spaces"))
          yield* docker.setDown(false)
          // Off, Docker isn't asked at all.
          yield* (yield* Spaces).setAgentTools(false)
          const before = (yield* docker.calls).length
          assert.isFalse(yield* servers.serves("spaces"))
          assert.strictEqual((yield* docker.calls).length, before)
        }),
      ),
    TIMEOUT,
  )

  it.effect(
    "makes a Space (or reuses one by name), runs commands in it, and drives its desktop through its Cua Driver",
    () =>
      withSpaces(({ docker, spacesd }) =>
        Effect.gen(function* () {
          const agent = yield* fakeAgent()
          const made = said(yield* spacesCall(agent, "create_space", { name: "Lab" }))
          assert.isFalse(made.error, made.text)
          assert.include(made.text, "Made the Space Lab")
          const id = idIn(made.text)
          // The same name again is the same Space.
          const again = said(yield* spacesCall(agent, "create_space", { name: "Lab" }))
          assert.include(again.text, `Using the Space Lab (${id})`)
          assert.include(said(yield* spacesCall(agent, "list_spaces", {})).text, `"id": "${id}"`)

          // A command, by name, as the desktop user under `timeout`.
          const ran = said(yield* spacesCall(agent, "space_bash", { space: "lab", command: "uname -a", timeout: 30 }))
          assert.deepStrictEqual([ran.error, ran.text], [false, "exit code 0\n\nstdout:\nLinux space uname -a\n"])
          const exec = (yield* docker.calls).find((c) => c[0] === "exec" && c.includes("timeout")) ?? assert.fail("no exec")
          assert.deepStrictEqual(exec.slice(0, 7), ["exec", "--user", "cua", `${NAME_PREFIX}${id}`, "timeout", "--kill-after=5", "30"])
          const failed = said(yield* spacesCall(agent, "space_bash", { space: id, command: "false; exit 3" }))
          assert.isTrue(failed.error && failed.text.startsWith("exit code 3"), failed.text)

          // The driver's tools, without spacesd's own Spaces tools.
          const listed = said(yield* spacesCall(agent, "space_list_tools", { space: id }))
          assert.include(listed.text, "- get_desktop_state (read-only)(): A screenshot of the whole desktop.")
          assert.include(listed.text, "- click(pid, x, y): Click an element or a point.")
          assert.notInclude(listed.text, "create_space")
          assert.include(said(yield* spacesCall(agent, "space_list_tools", { space: id, tool: "click" })).text, '"required": [')

          // A screenshot comes back as an image; a click is passed on with the Space's own token.
          const shot = said(yield* spacesCall(agent, "space_call_tool", { space: id, tool: "get_desktop_state" }))
          assert.deepStrictEqual(shot.images, ["image/png"])
          assert.include(shot.text, '"screen_width":1280')
          const clicked = said(yield* spacesCall(agent, "space_call_tool", { space: id, tool: "click", args: { pid: 226, x: 10, y: 20 } }))
          assert.deepStrictEqual([clicked.error, clicked.text], [false, "clicked"])
          const token = (yield* docker.calls)
            .find((c) => c[0] === "run")
            ?.find((a) => a.startsWith("CUA_ENV_TOKEN="))
            ?.slice(14)
          // In one MCP session for the task, which the driver ties what it saw to (pixel clicks are measured on it).
          const session = spacesd.calls[0]?.session ?? assert.fail("no session")
          assert.deepStrictEqual(spacesd.calls.at(-1), { tool: "click", args: { pid: 226, x: 10, y: 20 }, token: token ?? "", session })
          assert.isTrue(spacesd.calls.every((c) => c.session === session))
          // Another task's agent has a session of its own; one spacesd forgot is opened again.
          const other = yield* fakeAgent()
          yield* spacesCall(other, "space_call_tool", { space: id, tool: "list_windows" })
          assert.notStrictEqual(spacesd.calls.at(-1)?.session, session)
          spacesd.sessions.clear()
          assert.isFalse(said(yield* spacesCall(agent, "space_call_tool", { space: id, tool: "list_windows" })).error)
          assert.isTrue(spacesd.sessions.has(spacesd.calls.at(-1)?.session ?? ""))
          assert.isTrue(said(yield* spacesCall(agent, "space_call_tool", { space: id, tool: "create_space" })).error)

          // The user's link to watch it.
          const view = said(yield* spacesCall(agent, "space_view", { space: id }))
          assert.match(view.text, /^http:\/\/127\.0\.0\.1:\d+\/api\/spaces\/v\/[0-9a-f]+\/viewer\/#ticket=/u)

          // Stopped, it can't run commands; started again, it can.
          assert.include(said(yield* spacesCall(agent, "stop_space", { space: id })).text, "is stopped")
          assert.include(said(yield* spacesCall(agent, "space_bash", { space: id, command: "true" })).text, "isn't running")
          assert.include(said(yield* spacesCall(agent, "start_space", { space: id })).text, "Started the Space Lab")
          assert.include(said(yield* spacesCall(agent, "space_bash", { space: "nope", command: "true" })).text, "There's no Space nope")
        }),
      ),
    TIMEOUT,
  )

  it.effect(
    "a Space that failed before it had a container is made again by name; a name two Spaces share is refused with their ids",
    () =>
      withSpaces(({ docker }) =>
        Effect.gen(function* () {
          const agent = yield* fakeAgent()
          // The first Space pulls Cua's image, and the pull fails: it shows as failed, with no container.
          yield* docker.setFail("pull", "Error response from daemon: net/http: TLS handshake timeout")
          const failed = said(yield* spacesCall(agent, "create_space", { name: "Lab" }))
          assert.isTrue(failed.error && failed.text.includes("is failed: docker pull: Error response from daemon"), failed.text)
          const first = idIn(failed.text)
          // Asked again, it's made anew rather than started (which would have found no container).
          yield* docker.setFail("pull", null)
          const made = said(yield* spacesCall(agent, "create_space", { name: "Lab" }))
          assert.isTrue(!made.error && made.text.startsWith("Made the Space Lab"), made.text)
          assert.notStrictEqual(idIn(made.text), first)
          assert.notInclude(said(yield* spacesCall(agent, "list_spaces", {})).text, first)

          // A second Lab, asked for as new: then the name is ambiguous, and reusing it is refused, not made a third time.
          const second = idIn(said(yield* spacesCall(agent, "create_space", { name: "Lab", reuse: false })).text)
          const runs = (yield* docker.calls).filter((c) => c[0] === "run").length
          const refused = said(yield* spacesCall(agent, "create_space", { name: "Lab" }))
          assert.isTrue(refused.error && refused.text.includes("2 Spaces are named Lab") && refused.text.includes(second), refused.text)
          assert.strictEqual((yield* docker.calls).filter((c) => c[0] === "run").length, runs)
        }),
      ),
    TIMEOUT,
  )

  it.effect(
    "delete_space asks the user first, whatever the mode",
    () =>
      withSpaces(({ docker }) =>
        Effect.gen(function* () {
          const agent = yield* fakeAgent()
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE tasks SET permission_mode = 'bypassPermissions' WHERE id = ${agent.run.task_id}`
          const id = idIn(said(yield* spacesCall(agent, "create_space", { name: "Doomed" })).text)
          const permissions = yield* Permissions
          const ask = (callId: string, allow: boolean) =>
            Effect.gen(function* () {
              const running = yield* Effect.forkChild(spacesCall(agent, "delete_space", { space: "Doomed" }, callId))
              const request = yield* permissions.asking(callId)
              yield* permissions.answer(request, { decision: allow ? "allow" : "deny" }, "user").pipe(Effect.orDie)
              return said(yield* Fiber.join(running))
            })
          const refused = yield* ask("d1", false)
          assert.isTrue(refused.error && refused.text.includes("wasn't deleted"), refused.text)
          assert.isTrue((yield* docker.calls).every((c) => c[0] !== "rm"))
          assert.include((yield* ask("d2", true)).text, `Deleted the Space Doomed (${id})`)
          assert.deepStrictEqual(
            (yield* docker.calls).find((c) => c[0] === "rm"),
            ["rm", "--force", "--volumes", `${NAME_PREFIX}${id}`],
          )
        }),
      ),
    TIMEOUT,
  )

  it.effect(
    "reviewers and plan mode only look, and nothing works once Spaces are turned off",
    () =>
      withSpaces(({ spacesd }) =>
        Effect.gen(function* () {
          const owner = yield* fakeAgent()
          const id = idIn(said(yield* spacesCall(owner, "create_space", { name: "Shared" })).text)
          const sql = yield* SqlClient.SqlClient
          const reviewer = yield* fakeAgent()
          yield* sql`UPDATE tasks SET kind = 'review' WHERE id = ${reviewer.run.task_id}`
          const planner = yield* fakeAgent()
          yield* sql`UPDATE tasks SET permission_mode = 'plan' WHERE id = ${planner.run.task_id}`
          for (const [agent, who] of [
            [reviewer, "reviewers"],
            [planner, "plan mode"],
          ] as const) {
            assert.isFalse(said(yield* spacesCall(agent, "list_spaces", {})).error)
            assert.deepStrictEqual(said(yield* spacesCall(agent, "space_call_tool", { space: id, tool: "get_desktop_state" })).images, ["image/png"])
            for (const [tool, args] of [
              ["space_bash", { space: id, command: "true" }],
              ["space_call_tool", { space: id, tool: "click", args: { pid: 1 } }],
              ["create_space", { name: "Mine" }],
            ] as const) {
              const res = said(yield* spacesCall(agent, tool, args))
              assert.isTrue(res.error && res.text.includes(who), `${tool}: ${res.text}`)
            }
          }
          assert.isTrue(spacesd.calls.every((c) => c.tool !== "click"))

          yield* (yield* Spaces).setAgentTools(false)
          const off = said(yield* spacesCall(owner, "list_spaces", {}))
          assert.isTrue(off.error && off.text.includes("turned off"), off.text)
        }),
      ),
    TIMEOUT,
  )
})
