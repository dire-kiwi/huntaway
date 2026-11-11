import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { RemoteToolCall, ToolOutcome } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { mcpLayer } from "../Main.ts"
import { McpHooks } from "./McpHooks.ts"
import { OtherHosts } from "./OtherHosts.ts"
import type { OtherHost } from "./OtherHosts.ts"
import { agentOf, at, call, err, list, ok, profile, project, task } from "./tools/tests/board.ts"

// A board tool call across hosts (docs/plan/08-hosts.md, Board tools across hosts; the old mcp/tools/dispatch.ts
// `dispatch`) against scripted other hosts: what each is asked, and how their answers come together. The calls between
// two real boards are in hosts/HostTools.test.ts. The old dispatch.test.ts cases for hosts on older builds (`too_old`,
// legacy `get_task` details, pens and marks on old hosts) are dropped: a host of the old code can't link.

/** A host that answers each call with `answer`, recording what it was asked. */
const scripted = (id: string, name: string, answer: (call: RemoteToolCall) => ToolOutcome) => {
  const asked: Array<RemoteToolCall> = []
  const host: OtherHost = {
    id,
    name,
    call: (c) =>
      Effect.sync(() => {
        asked.push(c)
        return answer(c)
      }),
  }
  return { host, asked }
}

const notFound = (what: string): ToolOutcome => ({ _tag: "Err", message: `not found: ${what}`, not_found: true })
const taskOf = (c: RemoteToolCall) => (typeof c.args === "object" && c.args !== null && "task_id" in c.args ? String(c.args.task_id) : "")

/** The board's tools over `links` and `hubs`. */
const over = (links: ReadonlyArray<OtherHost>, hubs: ReadonlyArray<OtherHost>) =>
  mcpLayer(McpHooks.layerNone).pipe(
    Layer.provideMerge(Layer.succeed(OtherHosts, OtherHosts.of({ links: Effect.succeed(links), hubs: Effect.succeed(hubs) }))),
    Layer.provideMerge(TestBoard({ name: "mybox" })),
  )

const laptop = scripted("l1", "Laptop", (c) =>
  ["LAP-1", "t-lap"].includes(taskOf(c))
    ? { _tag: "Ok", value: { id: "t-lap", key: "LAP-1", title: "On the laptop", status: "todo" } }
    : notFound(`task ${taskOf(c)}`),
)
const strict = scripted("l2", "strict", (c) =>
  taskOf(c) === "STR-1" ? { _tag: "Err", message: "deleting STR-1 needs the user's approval", not_found: false } : notFound(`task ${taskOf(c)}`),
)
const lists: Record<string, ToolOutcome> = {
  l1: { _tag: "Ok", value: [{ id: "p-lap", key: "LAP" }] },
  hub: {
    _tag: "Ok",
    value: [
      { id: "p-lap", key: "LAP" },
      { id: "p-hub", key: "HUB" },
    ],
  },
}
const lister = (id: string, name: string) => scripted(id, name, () => lists[id] ?? notFound("?"))

describe("board tools across hosts", () => {
  it.effect("what isn't here is asked of each link, then each hub; a host that has it but refuses says why", () => {
    const off = scripted("hub", "desktop", () => ({ _tag: "Off", why: null }))
    return Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const found = ok(yield* call(me, "get_task", { task_id: "LAP-1" }))
      assert.strictEqual(found["title"], "On the laptop")
      // Asked as the caller's profile by name, `host` taken out, with no call id (a link doesn't record it).
      assert.deepStrictEqual(laptop.asked.at(-1), { profile: "personal", tool: "get_task", args: { task_id: "LAP-1" }, call_id: null })
      // A host that has it but refuses: its reason, not "not found".
      assert.strictEqual(err(yield* call(me, "delete_task", { task_id: "STR-1" })), "deleting STR-1 needs the user's approval")
      // Nowhere: not found here, with why a hub may have it and didn't say.
      assert.strictEqual(
        err(yield* call(me, "get_task", { task_id: "NOPE-1" })),
        `not found: task NOPE-1 (desktop doesn't let this host's agents use its board; the user can switch on "Let this host's agents use this board" for mybox in Settings → Hosts there)`,
      )
      // The hub was asked with the agent's own call id, by which it runs it at most once.
      assert.isTrue((off.asked.at(-1)?.call_id ?? "").length > 0)
      // What's here stays here.
      const kiw = yield* project(yield* profile("other"), "kiwi", "KIW")
      yield* task(kiw, "Mine")
      const asked = laptop.asked.length
      assert.isTrue(err(yield* call(me, "get_task", { task_id: "KIW-1" })).startsWith("not found"))
      assert.strictEqual(laptop.asked.length, asked + 1)
    }).pipe(Effect.provide(over([laptop.host, strict.host], [off.host])))
  })

  it.effect("lists come from every host, a hub's without what another list had", () => {
    const link = lister("l1", "Laptop")
    const hub = lister("hub", "desktop")
    return Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "web", "WEB")
      const me = yield* agentOf(p)
      assert.deepStrictEqual(
        list(yield* call(me, "list_projects", {})).map((r) => r["key"]),
        ["WEB", "LAP", "HUB"],
      )
      // A list of one project isn't asked elsewhere.
      const asked = link.asked.length
      list(yield* call(me, "list_tasks", { project_id: "WEB" }))
      assert.strictEqual(link.asked.length, asked)
      // `all` is.
      list(yield* call(me, "list_tasks", { project_id: "all" }))
      assert.strictEqual(link.asked.length, asked + 1)
    }).pipe(Effect.provide(over([link.host], [hub.host])))
  })

  it.effect("host picks one: a link by its name in any case, a hub with host as it is, this host, or none", () => {
    const link = lister("l1", "Laptop")
    const hub = lister("hub", "desktop")
    return Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      assert.strictEqual(list(yield* call(me, "list_projects", { host: "LAPTOP" })).length, 1)
      assert.deepStrictEqual(link.asked.at(-1)?.args, {})
      assert.strictEqual(list(yield* call(me, "list_projects", { host: "l1" })).length, 1)
      // Not a link: up to the hub of that name, or the first hub (which may link it), with `host` as it is.
      assert.strictEqual(list(yield* call(me, "list_projects", { host: "far-away" })).length, 2)
      assert.deepStrictEqual(hub.asked.at(-1)?.args, { host: "far-away" })
      // This host by its own name.
      assert.deepStrictEqual(list(yield* call(me, "list_projects", { host: "MyBox" })), [])
    }).pipe(Effect.provide(over([link.host], [hub.host])))
  })

  it.effect("with no hub, a host it doesn't link isn't one", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      assert.strictEqual(err(yield* call(me, "list_projects", { host: "far-away" })), "no linked host named far-away")
    }).pipe(Effect.provide(over([], []))),
  )

  it.effect("an assistant tracks a task on another host, and sees it as it is there", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const me = yield* agentOf(p)
      const tracked = ok(yield* call(me, "track_work", { title: "The laptop's task", task: "LAP-1" }))
      assert.deepStrictEqual([at(tracked, "item", "task_id"), at(tracked, "item", "task_key")], ["t-lap", "LAP-1"])
      const items = ok(yield* call(me, "list_tracked_work", {}))["items"]
      const first: unknown = Array.isArray(items) ? items[0] : undefined
      assert.deepStrictEqual(
        ["key", "title", "status"].map((k) => at(first, "task", k)),
        ["LAP-1", "On the laptop", "todo"],
      )
      // One that is nowhere is refused.
      assert.include(err(yield* call(me, "track_work", { title: "Lost", task: "NOPE-1" })), "task NOPE-1: not found: task NOPE-1")
    }).pipe(Effect.provide(over([laptop.host], []))),
  )
})
