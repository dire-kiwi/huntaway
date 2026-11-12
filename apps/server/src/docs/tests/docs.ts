import { assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { CallId } from "@huntaway/contracts"
import type { BoardEvent, Profile, TaskId } from "@huntaway/contracts"
import { fakeAgent } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { callResult } from "../../mcp/jsonrpc.ts"
import { ToolCalls } from "../../mcp/ToolCalls.ts"
import { assistant, profile, project, task } from "../../mcp/tools/tests/board.ts"
import { Events } from "../../platform/Events.ts"

// What the docs area's tests share (the old docs_mcp.test.ts's `caller` and `tool`): a profile with a task and an agent
// of it to publish as, a call of the docs server's tools through `ToolCalls` (so the gates run as for any call), and the
// board's events since a point.

/** An agent publishing documents: its profile, its task and its run. */
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

/** A call of a docs tool by `c`'s agent, through `ToolCalls`. */
export const tool = (c: Caller, name: string, args: unknown = {}) =>
  Effect.gen(function* () {
    const id = CallId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    const result = yield* (yield* ToolCalls).call({ call_id: id, run: c.agent.run.id, server: "docs", tool: name, args })
    const out = yield* callResult(result, "docs")
    if (!Schema.is(Said)(out)) return assert.fail("not a tool's result")
    const text = out.content.map((x) => x.text).join("")
    const answer: Answer = { v: out.structuredContent ?? text, error: out.isError === true, text }
    return answer
  })

/** A call that succeeds: its JSON. */
export const ok = (c: Caller, name: string, args: unknown = {}) =>
  Effect.map(tool(c, name, args), (a) => (a.error ? assert.fail(`${name} failed: ${a.text}`) : a.v))

/** A call that fails: its message. */
export const refused = (c: Caller, name: string, args: unknown = {}) =>
  Effect.map(tool(c, name, args), (a) => (a.error ? a.text : assert.fail(`${name} didn't fail: ${a.text}`)))

/** What is at `path` in a JSON value (undefined if it isn't there): a field's name, or a list's index. */
export const at = (v: unknown, ...path: ReadonlyArray<string | number>): unknown =>
  path.reduce<unknown>((x, k) => {
    if (typeof k === "number") return Array.isArray(x) ? x[k] : undefined
    return typeof x === "object" && x !== null && !Array.isArray(x) ? Object.entries(x).find(([n]) => n === k)?.[1] : undefined
  }, v)

/** A list in a JSON value. */
export const listAt = (v: unknown, ...path: ReadonlyArray<string | number>): ReadonlyArray<unknown> => {
  const found = at(v, ...path)
  return Array.isArray(found) ? found : assert.fail(`no list at ${path.join(".")}`)
}

/** Each of a list's `field`. */
export const pluck = (list: ReadonlyArray<unknown>, ...path: ReadonlyArray<string | number>) => list.map((x) => at(x, ...path))

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

/** A plan of two pages, linking each other. */
export const PLAN = [
  { path: "index", content: "# The plan\n\nSee [phase 1](plan/phase-1.md).\n" },
  { path: "plan/phase-1.md", content: "# Phase 1\n\nBack to [the start](../index.md).\n\n## Steps\n\nOne.\n" },
]

/** One page with this title. */
export const one = (title: string) => [{ path: "index", content: `# ${title}\n` }]
