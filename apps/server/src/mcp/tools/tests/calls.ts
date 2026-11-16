import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { CallId } from "@huntaway/contracts"
import type { BoardEvent, Profile, TaskId } from "@huntaway/contracts"
import { fakeAgent } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { callResult } from "../../jsonrpc.ts"
import { ToolCalls } from "../../ToolCalls.ts"
import { assistant, profile, project, task } from "./board.ts"
import { Events } from "../../../platform/Events.ts"

// Calling an MCP server's tools as an agent would, for tests (the old docs_mcp.test.ts's `caller` and `tool`): a profile
// with a task and an agent of it, a call of a server's tools through `ToolCalls` (so the gates run as for any call), and
// the board's events since a point.

/** An agent calling tools: its profile, its task and its run. */
export interface Caller {
  readonly profile: Profile
  readonly task: TaskId
  readonly agent: FakeAgent
}

/** A profile named `name` with a task and a run of it: the task in a project called `projectName` if given, else its assistant (no project). */
export const caller = (name = "p", projectName?: string) =>
  Effect.gen(function* () {
    const p = yield* profile(name)
    const t =
      projectName === undefined
        ? yield* assistant(p)
        : (yield* task(
            yield* project(
              p,
              projectName,
              projectName
                .replace(/[^A-Za-z]/g, "")
                .slice(0, 3)
                .toUpperCase() || "PRJ",
            ),
            `${name}'s task`,
          )).id
    const out: Caller = { profile: p, task: t, agent: yield* fakeAgent({ task: t }) }
    return out
  })

const Said = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
})

/** A tool's answer: its JSON (or its text), whether it failed, and its text. */
export interface Answer {
  readonly v: unknown
  readonly error: boolean
  readonly text: string
}

/** A call of `server`'s tool (a plugin's, HE-34) by `c`'s agent, through `ToolCalls`. */
export const tool = (c: Caller, name: string, args: unknown, server: string) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* (yield* ToolCalls).call({ call_id: id, run: c.agent.run.id, server, tool: name, args })
    const out = yield* callResult(result, server)
    if (!Schema.is(Said)(out)) return assert.fail("not a tool's result")
    const text = out.content.map((x) => x.text).join("")
    const answer: Answer = { v: out.structuredContent ?? text, error: out.isError === true, text }
    return answer
  })

/** A call that succeeds: its JSON. */
export const ok = (c: Caller, name: string, args: unknown, server: string) =>
  Effect.map(tool(c, name, args, server), (a) => (a.error ? assert.fail(`${name} failed: ${a.text}`) : a.v))

/** A call that fails: its message. */
export const refused = (c: Caller, name: string, args: unknown, server: string) =>
  Effect.map(tool(c, name, args, server), (a) => (a.error ? a.text : assert.fail(`${name} didn't fail: ${a.text}`)))

/** The board's events from now on: `seen` gives those emitted since, without their numbers. */
export const since = Effect.gen(function* () {
  const events = yield* Events
  const from = { boot: events.boot, seq: yield* events.seq }
  return {
    seen: Effect.scoped(
      Effect.map(events.watch(from), (w): ReadonlyArray<Readonly<Record<string, unknown>>> =>
        (w.replay ?? []).map((e: BoardEvent) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "seq"))),
      ),
    ),
  }
})
