import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Effect, Layer } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { LinkId, Timestamp } from "@huntaway/contracts"
import type { Profile, RemoteToolCall, ToolOutcome } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { mcpLayer } from "../Main.ts"
import { McpHooks } from "../mcp/McpHooks.ts"
import { OtherHosts } from "../mcp/OtherHosts.ts"
import type { OtherHost } from "../mcp/OtherHosts.ts"
import { agentOf, call, err, grant, keys, list, ok, profile, project, str, task } from "../mcp/tools/tests/board.ts"
import { ToolCalls } from "../mcp/ToolCalls.ts"
import { toJson } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { HostTools } from "./HostTools.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { LinkMode } from "./LinkRepo.ts"

// Board tools up a link, between two boards (the old hosts/uplink/tests.test.ts, at the services: the wire is the
// whole-server test's, tests/e2e/hosts-tools.test.ts). A hub ("desktop") with a personal and a work board links a host
// ("homeserver", where personal's assistant runs). Each board's `OtherHosts` is the other: the hub's link runs a call on
// the host's `ToolCalls.remote` (as `tools.call` does there), the host's hub takes it with the hub's `HostTools.takeUp`
// (as `link.upcalls` or `tools.call` up does).
//
// Dropped, with why: `a_host_that_dials_in_under_a_dialled_hosts_id_isnt_taken_for_it`'s tunnel refusal and the
// assistant's routed requests (the refusal is `LinkConnections`', tested in tests/e2e/hosts.test.ts; the assistant on
// its host is 6.7's); `…_is_dropped_when_it_becomes_an_assistant_host` (`LinkConnections`', in the e2e hosts test);
// `a_host_that_dials_in_takes_the_hub_as_an_up_link_too` and `a_hub_the_host_links_itself_is_asked_the_usual_way…` (which
// hubs a host asks: `Uplink.otherHosts` over live connections, in the e2e test); `an_up_link_goes_with_its_connection`
// is in Uplink.test.ts.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

/** A board with its own `ToolCalls` and `HostTools` over `others` (the old `node`). */
const board = (name: string, others: Layer.Layer<OtherHosts>) =>
  Layer.fresh(HostTools.layer).pipe(Layer.provideMerge(mcpLayer(McpHooks.layerNone)), Layer.provideMerge(others), Layer.provideMerge(TestBoard({ name })))

type BoardServices = Layer.Success<ReturnType<typeof board>>
type Board = Context.Context<BoardServices>

/** Runs `effect` on a board (in the test's scope). */
const on =
  (ctx: Board) =>
  <A, E, R extends BoardServices | Scope.Scope>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, ctx)

interface Boards {
  readonly hub: ReturnType<typeof on>
  readonly host: ReturnType<typeof on>
  readonly hubId: string
  readonly hostId: LinkId
  /** What the host's agents asked of the hub, and the hub of the host. */
  readonly asked: { readonly up: Array<RemoteToolCall>; readonly down: Array<RemoteToolCall> }
}

/**
 * The two boards, the hub linking the host as `mode` (dialled by default) with the calls up coming `via` (the way it is
 * linked by default).
 */
const linked = (mode: LinkMode = "outbound", via: "dialled" | "dial-in" = mode === "inbound" ? "dial-in" : "dialled") =>
  Effect.gen(function* () {
    const hubReady = yield* Deferred.make<Board>()
    const hostReady = yield* Deferred.make<Board>()
    const asked = { up: new Array<RemoteToolCall>(), down: new Array<RemoteToolCall>() }
    const hostIdOf = Effect.map(Deferred.await(hostReady), (ctx) => LinkId.make(Context.get(ctx, Identity).hostId))
    const hubOthers = Layer.succeed(
      OtherHosts,
      OtherHosts.of({
        links: Effect.map(hostIdOf, (id): ReadonlyArray<OtherHost> => [
          {
            id,
            name: "homeserver",
            call: (c) =>
              Effect.gen(function* () {
                asked.down.push(c)
                return yield* on(yield* Deferred.await(hostReady))(Effect.flatMap(ToolCalls, (calls) => calls.remote(c)))
              }),
          },
        ]),
        hubs: Effect.succeed([]),
      }),
    )
    const hostOthers = Layer.succeed(
      OtherHosts,
      OtherHosts.of({
        links: Effect.succeed([]),
        hubs: Effect.gen(function* () {
          const hub = yield* Deferred.await(hubReady)
          const host = yield* hostIdOf
          const up: OtherHost = {
            id: Context.get(hub, Identity).hostId,
            name: "desktop",
            call: (c): Effect.Effect<ToolOutcome> => {
              asked.up.push(c)
              return on(hub)(
                Effect.flatMap(HostTools, (tools) => tools.takeUp(host, via, { profile: c.profile, tool: c.tool, args: c.args, call_id: c.call_id ?? "none" })),
              )
            },
          }
          return [up]
        }),
      }),
    )
    const hubCtx = yield* Layer.build(board("desktop", hubOthers))
    const hostCtx = yield* Layer.build(board("homeserver", hostOthers))
    yield* Deferred.succeed(hubReady, hubCtx)
    yield* Deferred.succeed(hostReady, hostCtx)
    const hostId = LinkId.make(Context.get(hostCtx, Identity).hostId)
    // The hub's link to the host.
    yield* on(hubCtx)(
      Effect.flatMap(LinkRepo, (repo) => repo.upsert({ id: hostId, name: "homeserver", mode, url: "http://homeserver:7879", token: "t", ssh: null, now: AT })),
    )
    const out: Boards = { hub: on(hubCtx), host: on(hostCtx), hubId: Context.get(hubCtx, Identity).hostId, hostId, asked }
    return out
  })

/** The old `boards()`: personal (its assistant on the host) and work on the hub, with a task each; personal on the host. */
const boards = (mode?: LinkMode, via?: "dialled" | "dial-in") =>
  Effect.gen(function* () {
    const b = yield* linked(mode, via)
    const onHub = yield* b.hub(
      Effect.gen(function* () {
        const personal = yield* profile("personal")
        yield* placeAssistant(personal, b.hostId)
        const work = yield* profile("work")
        const hubTask = yield* task(yield* project(personal, "hub-p", "HUB"), "On the hub")
        const workTask = yield* task(yield* project(work, "hub-w", "WRK"), "Work only")
        return { personal, work, hubTask, workTask }
      }),
    )
    const me = yield* b.host(
      Effect.gen(function* () {
        const mine = yield* profile("personal")
        yield* task(yield* project(mine, "host-p", "LAP"), "On the host")
        return yield* agentOf(mine)
      }),
    )
    return { ...b, ...onHub, me }
  })

const placeAssistant = (p: Profile, host: LinkId | null) =>
  Effect.flatMap(Profiles, (profiles) => profiles.update(p.id, { assistant_host: host })).pipe(Effect.orDie)

const letIn = (b: { readonly hub: Boards["hub"]; readonly hostId: LinkId }, uplink: boolean) =>
  b.hub(Effect.flatMap(LinkRepo, (repo) => repo.setUplink(b.hostId, uplink)))

const countTasks = (title?: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    title === undefined
      ? sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`
      : sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE title = ${title}`,
  ).pipe(
    Effect.map((rows) => rows[0]?.n ?? 0),
    Effect.orDie,
  )

const projectKeys = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => rows.map((r) => String(r["key"])).toSorted()

const value = (o: ToolOutcome) => (o._tag === "Ok" ? o.value : assert.fail(`it failed: ${o._tag === "Err" ? o.message : (o.why ?? "off")}`))
const failure = (o: ToolOutcome) => (o._tag === "Err" ? o.message : assert.fail(`it didn't fail: ${o._tag}`))

const SWITCH = `the user can switch on "Let this host's agents use this board" for homeserver in Settings → Hosts there`

describe("board tools up a link", () => {
  it.effect("a host's agents use the hub's board only when it lets them", () =>
    Effect.gen(function* () {
      const b = yield* boards()
      const { host, me } = b
      // Off by default: not found, saying why it may be.
      let e = err(yield* host(call(me, "get_task", { task_id: "HUB-1" })))
      assert.isTrue(e.startsWith("not found") && e.includes("desktop doesn't let this host's agents use its board"), e)
      assert.include(e, SWITCH)
      assert.deepStrictEqual(projectKeys(list(yield* host(call(me, "list_projects", {})))), ["LAP"])

      yield* letIn(b, true)
      const t = ok(yield* host(call(me, "get_task", { task_id: "HUB-1" })))
      assert.deepStrictEqual([t["key"], t["id"]], ["HUB-1", b.hubTask.id])
      // By id too, and its own tasks are still its own.
      assert.strictEqual(ok(yield* host(call(me, "get_task", { task_id: b.hubTask.id })))["key"], "HUB-1")
      assert.strictEqual(ok(yield* host(call(me, "get_task", { task_id: "LAP-1" })))["title"], "On the host")
      // It creates and changes tasks there.
      const made = ok(yield* host(call(me, "create_task", { project_id: "HUB", title: "From the assistant", model: "fable", effort: "low", start: false })))
      const hubAgent = yield* b.hub(agentOf(b.personal))
      const there = ok(yield* b.hub(call(hubAgent, "get_task", { task_id: str(made, "id") })))
      assert.deepStrictEqual([there["title"], there["model"], there["effort"]], ["From the assistant", "fable", "low"])
      assert.strictEqual(yield* host(countTasks("From the assistant")), 0)
      ok(yield* host(call(me, "update_task", { task_id: "HUB-1", title: "Renamed", effort: "medium" })))
      assert.strictEqual(ok(yield* host(call(me, "get_task", { task_id: "HUB-1" })))["title"], "Renamed")
      // Every board it can reach, each project once.
      assert.deepStrictEqual(projectKeys(list(yield* host(call(me, "list_projects", {})))), ["HUB", "LAP"])
      // With `host`, the hub's board by its name.
      assert.strictEqual(list(yield* host(call(me, "list_tasks", { project_id: "HUB", host: "desktop" }))).length, 2)

      // The work board doesn't let personal agents in: not by key, by id, or in lists.
      for (const r of ["WRK-1", b.workTask.id]) {
        for (const [tool, args] of [
          ["get_task", { task_id: r }],
          ["update_task", { task_id: r, title: "Mine now" }],
          ["send_to_task", { task_id: r, message: "hi" }],
        ] as const) {
          e = err(yield* host(call(me, tool, args)))
          assert.isTrue(e.startsWith("not found"), `${tool} ${r}: ${e}`)
        }
      }
      assert.isTrue(err(yield* host(call(me, "create_task", { project_id: "WRK", title: "Sneaky" }))).startsWith("not found"))
      assert.notInclude(yield* toJson(list(yield* host(call(me, "list_tasks", { project_id: "all" })))), "Work only")
      assert.strictEqual(yield* b.hub(countTasks("Sneaky")), 0)
      // Until it does.
      yield* b.hub(grant(b.work, ["personal"]))
      assert.strictEqual(ok(yield* host(call(me, "get_task", { task_id: "work:WRK-1" })))["title"], "Work only")

      // Switched off again, it's refused at once.
      yield* letIn(b, false)
      assert.include(err(yield* host(call(me, "get_task", { task_id: "HUB-1" }))), "doesn't let this host's agents use its board")
    }).pipe(Effect.scoped),
  )

  it.effect("calls up a link run once, and never go back down or further up", () =>
    Effect.gen(function* () {
      const b = yield* boards()
      yield* letIn(b, true)
      const up = (callId: string, tool: string, args: unknown, host: LinkId = b.hostId) =>
        b.hub(Effect.flatMap(HostTools, (tools) => tools.takeUp(host, "dialled", { call_id: callId, tool, profile: "personal", args })))
      const idOf = (o: ToolOutcome) => {
        const v = value(o)
        return typeof v === "object" && v !== null && "id" in v ? String(v.id) : assert.fail("no id")
      }
      // Delivered twice, at once and again after: one task.
      const before = yield* b.hub(countTasks())
      const once = { project_id: "HUB", title: "Once", start: false }
      const [first, second] = yield* Effect.all([up("dup", "create_task", once), up("dup", "create_task", once)], { concurrency: "unbounded" })
      const again = yield* up("dup", "create_task", once)
      assert.deepStrictEqual([idOf(first), idOf(second)], [idOf(again), idOf(again)])
      assert.strictEqual(yield* b.hub(countTasks()), before + 1)
      // The same call id from another host is another call (that host is let in too).
      const elsewhere = LinkId.make("elsewhere")
      yield* b.hub(
        Effect.gen(function* () {
          const repo = yield* LinkRepo
          yield* repo.upsert({ id: elsewhere, name: "elsewhere", mode: "outbound", url: "http://elsewhere", token: "t", ssh: null, now: AT })
          yield* repo.setUplink(elsewhere, true)
          yield* placeAssistant(b.personal, elsewhere)
        }),
      )
      assert.notStrictEqual(idOf(yield* up("dup", "create_task", once, elsewhere)), idOf(again))
      assert.strictEqual(yield* b.hub(countTasks()), before + 2)
      yield* b.hub(placeAssistant(b.personal, b.hostId))

      // The host's own task isn't looked for back on the host (hub → host → hub would go round).
      const asked = b.asked.down.length
      assert.isTrue(failure(yield* up("back", "get_task", { task_id: "LAP-1" })).startsWith("not found"))
      // Nor are its lists asked of it again.
      assert.notInclude(yield* toJson(value(yield* up("list", "list_projects", {}))), "LAP")
      assert.strictEqual(b.asked.down.length, asked)
      // Nor is it sent back down when it names the host (by the hub's name for it, or its id).
      for (const h of ["homeserver", b.hostId]) {
        assert.strictEqual(
          failure(yield* up(`named-${h}`, "get_task", { task_id: "LAP-1", host: h })),
          `${h} is the host this call came up from (homeserver), and desktop doesn't pass calls back down: leave out host to use that host's own board`,
        )
      }
      // Nor does the hub pass it up a link of its own: it has none here, and asked none.
      assert.strictEqual(b.asked.up.length, 0)
      // Tools for the agent's own thread stay on its own host.
      for (const tool of ["wait", "request_user_input", "submit_review", "track_work"]) {
        assert.strictEqual(failure(yield* up(`t-${tool}`, tool, {})), `${tool} only works on the host the agent runs on`)
      }
      // A profile the hub doesn't have, which nothing there lets in, isn't let in by the hub's checks at all.
      const stranger = yield* b.hub(
        Effect.flatMap(HostTools, (tools) => tools.takeUp(b.hostId, "dialled", { call_id: "x", tool: "list_projects", profile: "stranger", args: {} })),
      )
      assert.strictEqual(stranger._tag, "Off")
      // A change that needs the user's approval: there is no thread on the hub to ask in.
      assert.strictEqual(
        failure(yield* up("del", "delete_task", { task_id: "HUB-1" })),
        "deleting HUB-1 needs the user's approval, which only an agent on the task's own host can ask for; ask the user to delete it on the board",
      )
    }).pipe(Effect.scoped),
  )

  it.effect("calls that come another way than the host is linked aren't taken", () =>
    Effect.gen(function* () {
      // The hub dials the host, and the calls came on a connection that dialled in under its id.
      const b = yield* boards("outbound", "dial-in")
      yield* letIn(b, true)
      const before = yield* b.hub(countTasks())
      for (const [tool, args] of [
        ["create_task", { project_id: "HUB", title: "Planted", start: true }],
        ["get_task", { task_id: "HUB-1" }],
      ] as const) {
        const e = err(yield* b.host(call(b.me, tool, args)))
        assert.include(e, "desktop links homeserver itself, and this call came another way, so it isn't taken", tool)
      }
      // A list leaves out the hub that didn't take it.
      assert.deepStrictEqual(projectKeys(list(yield* b.host(call(b.me, "list_projects", {})))), ["LAP"])
      assert.strictEqual(yield* b.hub(countTasks()), before)
      // The other way round: a host linked as one that dials in, whose calls came on a connection the hub dialled.
      const c = yield* boards("inbound", "dialled")
      yield* letIn(c, true)
      assert.include(
        err(yield* c.host(call(c.me, "get_task", { task_id: "HUB-1" }))),
        "desktop links homeserver as a host that dials in, and this call came another way",
      )
      // Linked as it dials in, the calls taken from it.
      const d = yield* boards("inbound")
      yield* letIn(d, true)
      assert.strictEqual(ok(yield* d.host(call(d.me, "get_task", { task_id: "HUB-1" })))["title"], "On the hub")
    }).pipe(Effect.scoped),
  )

  it.effect("only the profiles whose assistant runs on a host use the hub from it", () =>
    Effect.gen(function* () {
      const b = yield* boards()
      yield* letIn(b, true)
      // A work profile made on the host, with an agent of its own: whoever controls the host can name any profile.
      const sneaky = yield* b.host(Effect.flatMap(profile("work"), agentOf))
      for (const [tool, args] of [
        ["get_task", { task_id: "WRK-1" }],
        ["get_task", { task_id: b.workTask.id }],
        ["send_to_task", { task_id: "WRK-1", message: "hi" }],
        ["create_task", { project_id: "WRK", title: "Planted" }],
      ] as const) {
        const e = err(yield* b.host(call(sneaky, tool, args)))
        assert.isTrue(e.startsWith("not found") && e.includes("only in the profiles whose assistant runs on homeserver, and work isn't one"), `${tool}: ${e}`)
      }
      const listed = yield* toJson(list(yield* b.host(call(sneaky, "list_projects", {}))))
      assert.isTrue(!listed.includes("WRK") && !listed.includes("HUB"), listed)
      assert.strictEqual(yield* b.hub(countTasks("Planted")), 0)
      // Nor is a profile of the right name whose assistant runs elsewhere (or on the hub) let in.
      yield* b.hub(placeAssistant(b.personal, null))
      assert.include(err(yield* b.host(call(b.me, "get_task", { task_id: "HUB-1" }))), "personal isn't one")
      // Placed there, it is, and only it: work stays out.
      yield* b.hub(placeAssistant(b.personal, b.hostId))
      assert.strictEqual(ok(yield* b.host(call(b.me, "get_task", { task_id: "HUB-1" })))["key"], "HUB-1")
      assert.strictEqual(yield* b.host(call(sneaky, "get_task", { task_id: "WRK-1" })).pipe(Effect.map((r) => r._tag)), "Err")
    }).pipe(Effect.scoped),
  )

  it.effect("a hub's agents reach a linked host's board, and a host that has it but refuses says why", () =>
    Effect.gen(function* () {
      const b = yield* boards()
      const hubAgent = yield* b.hub(agentOf(b.personal))
      // Down: the host's task, by key, as the host's profile of the caller's name; `host` is taken out on the way.
      const t = ok(yield* b.hub(call(hubAgent, "get_task", { task_id: "LAP-1" })))
      assert.strictEqual(t["title"], "On the host")
      assert.strictEqual(ok(yield* b.hub(call(hubAgent, "get_task", { task_id: "LAP-1", host: "HomeServer" })))["title"], "On the host")
      assert.isTrue(b.asked.down.every((c) => c.profile === "personal" && c.call_id === null))
      assert.isFalse(b.asked.down.some((c) => typeof c.args === "object" && c.args !== null && "host" in c.args))
      // Lists cover both.
      assert.deepStrictEqual(keys(list(yield* b.hub(call(hubAgent, "list_projects", {}))), "key").toSorted(), ["personal:HUB", "personal:LAP"])
      // Deleting the host's task needs approval, which the host can't ask for: its reason, not "not found".
      assert.strictEqual(
        err(yield* b.hub(call(hubAgent, "delete_task", { task_id: "LAP-1" }))),
        "deleting LAP-1 needs the user's approval, which only an agent on the task's own host can ask for; ask the user to delete it on the board",
      )
      // A thread tool never goes down: a wait watches only this host's tasks.
      assert.include(err(yield* b.hub(call(hubAgent, "wait", { reason: "r", tasks: ["LAP-1"] }))), "not found on this host")
      // What's nowhere is not found, here.
      assert.strictEqual(err(yield* b.hub(call(hubAgent, "get_task", { task_id: "NOPE-1" }))), "not found: task NOPE-1")
      // A host with no profile of the caller's name, which nothing there lets in.
      const stranger = yield* b.hub(Effect.flatMap(profile("stranger"), agentOf))
      assert.strictEqual(err(yield* b.hub(call(stranger, "get_task", { task_id: "LAP-1" }))), "not found: task LAP-1")
      const told = yield* b.host(
        Effect.flatMap(ToolCalls, (calls) => calls.remote({ profile: "stranger", tool: "get_task", args: { task_id: "LAP-1" }, call_id: null })),
      )
      assert.deepStrictEqual(told, {
        _tag: "Err",
        message: "not found: homeserver has no profile named stranger, and no profile there lets its agents in",
        not_found: true,
      })
      assert.deepStrictEqual(
        yield* b.host(Effect.flatMap(ToolCalls, (calls) => calls.remote({ profile: "personal", tool: "finish_work", args: {}, call_id: null }))),
        { _tag: "Err", message: "finish_work only works on the host the agent runs on", not_found: false },
      )
    }).pipe(Effect.scoped),
  )
})
