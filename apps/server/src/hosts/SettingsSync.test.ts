import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { HostId, ProfileId, PROTOCOL } from "@huntaway/contracts"
import type { ApprovalRule, HostSettingsPatch, NewProfile, ProfilePatch, SyncEntry } from "@huntaway/contracts"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import { AgentTools } from "../agents/AgentTools.ts"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "../agents/ApprovalRulesRepo.ts"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { SettingsSync } from "./SettingsSync.ts"
import { exchangeWith, takesPart } from "./SettingsSyncExchange.ts"
import type { SyncPeer } from "./SettingsSyncExchange.ts"

// Settings sync between hosts (the old settings_sync.test.ts, "a hub and two hosts"): three whole boards on the test
// clock, a hub and hosts `a` and `b`, the hub's exchange run with the other two as its peers in process.

/** A board with its own host id. */
const boardAs = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDir = yield* tempDir
    yield* fs.writeFileString(`${dataDir}/host_id`, `${id}\n`).pipe(Effect.orDie)
    const context = yield* Layer.build(TestBoard({ dataDir, name: id }))
    const sync = Context.get(context, SettingsSync)
    const settings = Context.get(context, HostSettings)
    const repo = Context.get(context, SettingsRepo)
    const profiles = Context.get(context, Profiles)
    const rules = Context.get(context, ApprovalRules)
    const rulesRepo = Context.get(context, ApprovalRulesRepo)
    const tools = Context.get(context, AgentTools)
    const tasks = Context.get(context, Tasks)
    const configs = Context.get(context, AgentConfigs)
    const folders = Context.get(context, DataDir)
    const peer: SyncPeer = { id, name: id, get: sync.status, merge: (entries) => Effect.ignore(sync.merge(entries)) }
    return {
      id,
      sync,
      peer,
      profiles,
      /** A setting changed as the board does it, noted as the observer would; changes made in one millisecond tie. */
      set: (patch: HostSettingsPatch) =>
        Effect.gen(function* () {
          yield* Effect.orDie(settings.update(patch))
          yield* sync.observe
          yield* TestClock.adjust("3 millis")
        }),
      get: (key: string) => repo.get(key),
      /** A setting written as from inside the server: no event, nothing noted. */
      write: (key: string, value: string | null) => repo.set(key, value),
      entry: (name: string) => Effect.map(sync.entries, (all) => all.find((e) => e.name === name)),
      profile: (input: NewProfile) => Effect.orDie(profiles.create(input)),
      patch: (profile: ProfileId, patch: ProfilePatch) =>
        Effect.gen(function* () {
          yield* Effect.orDie(profiles.update(profile, patch))
          yield* sync.observe
          yield* TestClock.adjust("3 millis")
        }),
      setRules: (profile: ProfileId, list: ReadonlyArray<ApprovalRule>, expiry: number) =>
        Effect.andThen(Effect.orDie(rules.set(profile, { rules: list, expiry_minutes: expiry })), sync.observe),
      saved: (profile: ProfileId) => rulesRepo.saved(profile),
      configs,
      /** Its skill sources' clones. */
      clones: folders.file("skill-sources"),
      /** A scratch task in `profile`: something of the profile's on this host. */
      task: (profile: string) => Effect.orDie(tasks.create({ profile_id: ProfileId.make(profile), title: "Notes" }, Actor.user)),
      /** The host's global skills and servers, changed as the board does it and noted. */
      tools,
      noted: <A, E>(change: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const out = yield* Effect.orDie(change)
          yield* sync.observe
          yield* TestClock.adjust("3 millis")
          return out
        }),
      skills: Effect.map(tools.global, (g) => g.skills.map((x) => [x.name, x.content, x.enabled])),
      servers: Effect.map(tools.global, (g) => g.mcp_servers.map((x) => [x.name, x.config.url ?? null, x.auto_allow])),
    }
  })
type Board = Effect.Success<ReturnType<typeof boardAs>>

/** A hub and hosts `a` and `b` (or `bId`), syncing unless `on` says otherwise; `before` runs before sync starts. */
const board = (on: { hub?: boolean; a?: boolean; b?: boolean; bId?: string } = {}, before?: (hub: Board, a: Board, b: Board) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const hub = yield* boardAs("hub")
    const a = yield* boardAs("a")
    const b = yield* boardAs(on.bId ?? "b")
    if (before !== undefined) yield* before(hub, a, b)
    // As servers that start with sync on (or off).
    for (const [host, sw] of [
      [hub, on.hub],
      [a, on.a],
      [b, on.b],
    ] as const) {
      yield* host.write("settings_sync", sw === false ? "false" : null)
      yield* host.sync.observe
    }
    const linked = new Set([a, b])
    /** One exchange of the hub's. */
    const exchange = Effect.suspend(() =>
      exchangeWith(
        hub.sync,
        [...linked].map((h) => h.peer),
      ),
    )
    /** Exchanges until nothing moves, and checks that the hosts that sync then have the same entries. */
    const settle = (hosts: ReadonlyArray<Board> = [hub, a, b]) =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) yield* exchange
        const [first, ...rest] = hosts
        if (first === undefined) return
        const theirs = yield* first.sync.entries
        for (const h of rest) assert.deepStrictEqual(yield* h.sync.entries, theirs, `${h.id} and ${first.id}`)
      })
    return {
      hub,
      a,
      b,
      exchange,
      settle,
      unlink: (h: Board) => Effect.sync(() => linked.delete(h)),
      link: (h: Board) => Effect.sync(() => linked.add(h)),
    }
  })

const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)

const lostOf = (e: SyncEntry | undefined) => (e?.lost ?? []).map((l) => [l.value, l.by, l.at])

describe("settings sync between a hub and two hosts", () => {
  it.effect("a change on one host reaches the others, and one made while a host was away isn't a conflict", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      yield* t.a.set({ default_model: "sonnet" })
      yield* t.settle()
      assert.strictEqual(yield* t.b.get("default_model"), "sonnet")
      assert.strictEqual(yield* t.hub.get("default_model"), "sonnet")
      const e = yield* t.b.entry("global/default_model")
      assert.deepStrictEqual([e?.value, e?.changed_by, e?.lost], ["sonnet", "a", []])

      // b is away while a changes it twice, and changes something else itself.
      yield* t.unlink(t.b)
      yield* t.a.set({ default_model: "haiku" })
      yield* t.a.set({ default_model: "fable" })
      yield* t.b.set({ default_effort: "low" })
      yield* t.settle([t.hub, t.a])
      assert.strictEqual(yield* t.b.get("default_model"), "sonnet")
      yield* t.link(t.b)
      yield* t.settle()
      assert.strictEqual(yield* t.b.get("default_model"), "fable")
      assert.strictEqual(yield* t.a.get("default_effort"), "low")
      assert.deepStrictEqual(
        (yield* t.hub.sync.entries).filter((x) => x.lost.length > 0),
        [],
      )
      // Clearing a setting syncs too.
      yield* t.b.set({ default_model: null })
      yield* t.settle()
      assert.strictEqual(yield* t.a.get("default_model"), null)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("the same setting changed on two hosts while apart: the later wins everywhere, and the other value can be picked", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.a.set({ default_model: "sonnet" })
      yield* t.settle()
      yield* t.unlink(t.b)
      yield* t.b.set({ default_model: "haiku" })
      yield* t.a.set({ default_model: "fable" })
      yield* t.settle([t.hub, t.a])
      yield* t.link(t.b)
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) assert.strictEqual(yield* h.get("default_model"), "fable")
      const e = yield* t.b.entry("global/default_model")
      assert.deepStrictEqual(
        e?.lost.map((l) => [l.value, l.by]),
        [["haiku", "b"]],
      )
      assert.strictEqual(e?.vv["a"], 3)
      assert.strictEqual(e?.vv["b"], 2)

      // Picked on a host that isn't the one that set it.
      yield* t.a.sync.resolve("global/default_model", Option.some("haiku"))
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) assert.strictEqual(yield* h.get("default_model"), "haiku")
      assert.deepStrictEqual((yield* t.hub.entry("global/default_model"))?.lost, [])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("dismissing a lost value keeps the winner and clears it on every host", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      yield* t.unlink(t.b)
      yield* t.a.set({ default_effort: "low" })
      yield* t.b.set({ default_effort: "max" })
      yield* t.link(t.b)
      yield* t.settle()
      assert.deepStrictEqual(
        lostOf(yield* t.a.entry("global/default_effort")).map(([value, by]) => [value, by]),
        [["low", "a"]],
      )
      yield* t.hub.sync.resolve("global/default_effort", Option.none())
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        assert.strictEqual(yield* h.get("default_effort"), "max")
        assert.deepStrictEqual((yield* h.entry("global/default_effort"))?.lost, [])
      }
      // A value no host can take isn't one to pick.
      assert.strictEqual(yield* failure(t.a.sync.resolve("global/default_effort", Option.some("enormous"))), "Invalid")
      assert.strictEqual(yield* failure(t.a.sync.resolve("global/nothing", Option.none())), "Invalid")
      assert.strictEqual(yield* t.a.get("default_effort"), "max")
      assert.strictEqual((yield* t.a.entry("global/default_effort"))?.value, "max")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a host that joins with settings of its own takes the board's, and its own are kept as lost", () =>
    Effect.gen(function* () {
      const t = yield* board({ b: false })
      yield* t.settle([t.hub, t.a])
      yield* t.b.set({ default_model: "haiku", default_effort: "low" })
      yield* t.a.set({ default_model: "sonnet" })
      yield* t.settle([t.hub, t.a])
      // Off: nothing of b's moved, and it keeps no entries.
      assert.strictEqual(yield* t.b.get("default_model"), "haiku")
      assert.strictEqual(yield* t.a.get("default_effort"), null)
      assert.deepStrictEqual(yield* t.b.sync.entries, [])
      assert.strictEqual(yield* failure(t.b.sync.merge(yield* t.a.sync.entries)), "Unavailable")

      yield* t.b.set({ settings_sync: true })
      yield* t.settle()
      // The board's value was set after it began to sync; b's is from before, and has no time.
      assert.strictEqual(yield* t.b.get("default_model"), "sonnet")
      assert.deepStrictEqual(lostOf(yield* t.a.entry("global/default_model")), [["haiku", "b", ""]])
      // Neither side had changed this one since syncing: the board's stays, as its hosts were syncing first.
      for (const h of [t.hub, t.a, t.b]) assert.strictEqual(yield* h.get("default_effort"), null)
      assert.deepStrictEqual(lostOf(yield* t.a.entry("global/default_effort")), [["low", "b", ""]])
      // What's the host's own never moves.
      yield* t.a.set({ public_url: "https://a.example.com" })
      yield* t.settle()
      assert.strictEqual(yield* t.b.get("public_url"), null)
      assert.isFalse((yield* t.a.sync.entries).some((e) => /public_url|scratch_host|settings_sync|telemetry|vapid/.test(e.name)))
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // A review of HA-398: values from before sync have no time, and went by host id, so a joiner whose id sorted last
  // replaced the whole board's settings with its own.
  it.effect("a joining host whose id sorts last still takes the board's values, set before anyone synced", () =>
    Effect.gen(function* () {
      const rules: ReadonlyArray<ApprovalRule> = [{ tool: "Bash", decision: "never" }]
      const t = yield* board({ b: false, bId: "zz" }, (hub, a, b) =>
        Effect.gen(function* () {
          for (const h of [hub, a]) {
            yield* h.write("default_permission_mode", "plan")
            const work = yield* h.profile({ name: "work" })
            yield* h.setRules(work.id, rules, 5)
          }
          yield* b.write("default_permission_mode", "bypassPermissions")
          yield* b.write("default_model", "haiku")
          yield* b.profile({ name: "work" })
        }),
      )
      yield* t.settle([t.hub, t.a])
      yield* TestClock.adjust("3 millis")
      yield* t.b.set({ settings_sync: true })
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        assert.strictEqual(yield* h.get("default_permission_mode"), "plan")
        assert.strictEqual(yield* h.get("default_model"), null)
        const [work] = yield* h.profiles.list
        assert.deepStrictEqual(work === undefined ? null : yield* h.saved(work.id), { rules, expiry_minutes: 5 })
      }
      assert.deepStrictEqual(lostOf(yield* t.hub.entry("global/default_permission_mode")), [["bypassPermissions", "zz", ""]])
      assert.deepStrictEqual(lostOf(yield* t.hub.entry("global/default_model")), [["haiku", "zz", ""]])
      // Its own value is there to pick, and picking it is a change like any other.
      yield* t.b.sync.resolve("global/default_model", Option.some("haiku"))
      yield* t.settle()
      assert.strictEqual(yield* t.hub.get("default_model"), "haiku")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // A review of HA-398: a change made while sync was off was stamped with the time sync came back on, and beat the
  // board's later change.
  it.effect("a setting changed while sync was off doesn't win over the board when sync comes back on", () =>
    Effect.gen(function* () {
      const t = yield* board({ bId: "zz" })
      yield* t.a.set({ default_model: "sonnet" })
      yield* t.settle()
      yield* t.b.set({ settings_sync: false })
      yield* t.b.set({ default_model: "haiku", default_effort: "low" })
      yield* t.a.set({ default_model: "fable" })
      yield* t.settle([t.hub, t.a])
      assert.strictEqual(yield* t.b.get("default_model"), "haiku")
      yield* t.b.set({ settings_sync: true })
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        // Changed on the board meanwhile, and not: the board's either way.
        assert.strictEqual(yield* h.get("default_model"), "fable")
        assert.strictEqual(yield* h.get("default_effort"), null)
      }
      assert.deepStrictEqual(lostOf(yield* t.a.entry("global/default_model")), [["haiku", "zz", ""]])
      assert.deepStrictEqual(lostOf(yield* t.a.entry("global/default_effort")), [["low", "zz", ""]])
      // Back on, a change there is a change again.
      yield* t.b.set({ default_effort: "max" })
      yield* t.settle()
      assert.strictEqual(yield* t.a.get("default_effort"), "max")
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  // A review of HA-398: a host that had sync on alone, then off, kept the time of that first go on its entries, and so
  // counted as syncing before a hub that turned it on in between.
  it.effect("a host that synced alone, switched it off and joins later takes the board's values", () =>
    Effect.gen(function* () {
      const t = yield* board({ hub: false, a: false, b: false, bId: "zz" }, (_hub, _a, b) =>
        Effect.andThen(b.write("default_permission_mode", "bypassPermissions"), b.write("default_model", "haiku")),
      )
      yield* t.b.set({ settings_sync: true })
      // A change while it's alone has a time, but no host was there to take it.
      yield* t.b.set({ default_effort: "low" })
      yield* t.exchange
      yield* t.b.set({ settings_sync: false })
      yield* t.hub.set({ settings_sync: true })
      yield* t.a.set({ settings_sync: true })
      yield* t.settle([t.hub, t.a])
      yield* t.b.set({ settings_sync: true })
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        assert.strictEqual(yield* h.get("default_permission_mode"), null)
        assert.strictEqual(yield* h.get("default_model"), null)
        assert.strictEqual(yield* h.get("default_effort"), null)
      }
      assert.deepStrictEqual(lostOf(yield* t.hub.entry("global/default_permission_mode")), [["bypassPermissions", "zz", ""]])
      assert.deepStrictEqual(lostOf(yield* t.hub.entry("global/default_model")), [["haiku", "zz", ""]])
      assert.deepStrictEqual(lostOf(yield* t.hub.entry("global/default_effort")), [["low", "zz", ""]])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a hub with sync off exchanges nothing, and only hosts with the capability on this protocol take part", () =>
    Effect.gen(function* () {
      const off = yield* board({ hub: false })
      yield* off.a.set({ default_model: "sonnet" })
      yield* off.exchange
      assert.strictEqual(yield* off.b.get("default_model"), null)
      assert.strictEqual(yield* off.hub.get("default_model"), null)

      const hello = { host_id: HostId.make("b"), name: "b", protocol: PROTOCOL, version: "1", commit: null, agents: true, updates_from: null }
      assert.isTrue(takesPart({ ...hello, capabilities: ["settings_sync"] }))
      assert.isFalse(takesPart({ ...hello, capabilities: [] }))
      assert.isFalse(takesPart({ ...hello, protocol: PROTOCOL + 1, capabilities: ["settings_sync"] }))
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a profile's settings go by its name, and a profile one host has is made on the others (HE-46)", () =>
    Effect.gen(function* () {
      const t = yield* board()
      const pa = yield* t.a.profile({ name: "work" })
      const other = yield* t.a.profile({ name: "personal" })
      const pb = yield* t.b.profile({ name: "work" })
      assert.notStrictEqual(pa.id, pb.id)
      yield* t.settle()
      yield* t.a.patch(pa.id, { limit_wait: true, default_model: "opus", agent_access: ["personal"], tint: "#7c7cf8" })
      yield* t.a.patch(other.id, { merge_approval: true })
      const rules: ReadonlyArray<ApprovalRule> = [{ tool: "Bash", decision: "never" }]
      yield* t.a.setRules(pa.id, rules, 5)
      yield* t.settle()
      const work = yield* Effect.orDie(t.b.profiles.get(pb.id))
      assert.deepStrictEqual([work.limit_wait, work.default_model, work.agent_access, work.tint], [true, "opus", ["personal"], "#7c7cf8"])
      assert.deepStrictEqual(yield* t.b.saved(pb.id), { rules, expiry_minutes: 5 })
      // What belongs to the host stays: its configs' ids and folders, its Asana login, where its assistant runs.
      assert.isFalse((yield* t.b.sync.entries).some((e) => /claude_config_ids|clone_dir|asana_token|asana_user|assistant_host/.test(e.name)))

      // "personal", which only a had, is on every host now, with its settings.
      for (const h of [t.hub, t.b]) {
        const made = (yield* h.profiles.list).find((p) => p.name === "personal")
        assert.isTrue(made?.merge_approval, h.id)
      }
      assert.deepStrictEqual(
        (yield* t.hub.sync.entries).filter((e) => e.lost.length > 0),
        [],
      )
      // Renamed on a: "home" everywhere, and "personal" gone where it holds nothing.
      yield* t.a.patch(other.id, { name: "home", merge_approval: false })
      yield* t.settle()
      for (const h of [t.hub, t.b]) {
        const names = (yield* h.profiles.list).map((p) => p.name).toSorted()
        assert.deepStrictEqual(names, ["home", "work"], h.id)
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a profile removed on one host is removed on the others, but never where it holds work (HE-46)", () =>
    Effect.gen(function* () {
      const t = yield* board()
      const pa = yield* t.a.profile({ name: "side" })
      yield* t.settle()
      const onB = (yield* t.b.profiles.list).find((p) => p.name === "side")
      assert.isDefined(onB)
      // b has a task in it; the hub has nothing.
      yield* t.b.task(onB?.id ?? "")
      yield* Effect.orDie(t.a.profiles.delete(pa.id))
      yield* t.a.sync.observe
      yield* t.settle([t.hub, t.a])
      assert.isFalse((yield* t.hub.profiles.list).some((p) => p.name === "side"))
      assert.isTrue((yield* t.b.profiles.list).some((p) => p.name === "side"))
      // It doesn't come back to the others from b, which keeps it until it holds nothing.
      yield* t.b.sync.observe
      yield* t.settle([t.hub, t.a])
      assert.isFalse((yield* t.a.profiles.list).some((p) => p.name === "side"))
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a change the server makes itself is a change, and a value a host can't take stays out of its settings", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      // No event, as a write from inside the server.
      yield* t.a.write("default_model", "sonnet")
      yield* t.settle()
      assert.strictEqual(yield* t.b.get("default_model"), "sonnet")

      // From a newer host: an effort this one doesn't know.
      const e = Option.getOrThrow(Option.fromNullishOr(yield* t.a.entry("global/default_effort")))
      const newer: SyncEntry = {
        name: e.name,
        value: "galactic",
        vv: { ...e.vv, z: 1, a: 5 },
        changed_at: "2030-01-01T00:00:00.000Z",
        changed_by: "z",
        since: e.since,
        lost: e.lost,
      }
      assert.strictEqual(yield* t.a.sync.merge([newer]), 1)
      assert.strictEqual(yield* t.a.get("default_effort"), null)
      // It's kept and passed on as it is, not taken for a change back made here.
      yield* t.settle()
      assert.deepStrictEqual(yield* t.b.entry("global/default_effort"), newer)
      // And a change here afterwards is one.
      yield* t.a.set({ default_effort: "low" })
      yield* t.settle()
      assert.strictEqual(yield* t.b.get("default_effort"), "low")
      const after = yield* t.b.entry("global/default_effort")
      assert.deepStrictEqual([after?.vv["z"], after?.vv["a"]], [1, 6])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("a host says whether sync is on (unless switched off), and once on its entries are its values from before sync", () =>
    Effect.gen(function* () {
      const h = yield* boardAs("h")
      assert.isTrue((yield* h.sync.status).enabled)
      yield* h.set({ settings_sync: false })
      assert.deepStrictEqual(yield* h.sync.status, { enabled: false, host_id: HostId.make("h"), entries: [] })
      yield* h.set({ settings_sync: true })
      const got = yield* h.sync.status
      assert.isTrue(got.enabled)
      assert.include(
        got.entries.map((e) => e.name),
        "global/default_permission_mode",
      )
      // Its own values, from before it synced (again): no time, and only its own counter.
      assert.isTrue(got.entries.every((e) => e.changed_at === "" && Object.keys(e.vv).join() === "h"))
      // Off again: nothing to merge into, and its entries are not given out.
      yield* h.set({ settings_sync: false })
      assert.deepStrictEqual((yield* h.sync.status).entries, [])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(h.sync.resolve("global/default_model", Option.none()))))
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})

const skill = (name: string, body = "Do it this way.") => `---\nname: ${name}\ndescription: ${name} for the fleet.\n---\n\n${body}\n`

describe("settings sync of the hosts' global skills and MCP servers (HE-46)", () => {
  it.effect("a skill or server added, changed or removed on one host is the same on the others", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      const added = yield* t.a.noted(t.a.tools.addSkill(null, { content: skill("deploy") }))
      yield* t.b.noted(t.b.tools.addServer(null, { name: "docs", config: { type: "http", url: "https://docs.example.com/mcp" } }))
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        assert.deepStrictEqual(yield* h.skills, [["deploy", skill("deploy"), true]], h.id)
        assert.deepStrictEqual(yield* h.servers, [["docs", "https://docs.example.com/mcp", false]], h.id)
      }

      yield* t.b.noted(
        t.b.tools.updateSkill(null, (yield* t.b.tools.global).skills[0]?.id ?? "", { content: skill("deploy", "Use the script."), enabled: false }),
      )
      yield* t.settle()
      assert.deepStrictEqual(yield* t.a.skills, [["deploy", skill("deploy", "Use the script."), false]])

      yield* t.a.noted(t.a.tools.removeSkill(null, added.id))
      const docs = (yield* t.hub.tools.global).mcp_servers[0]?.id ?? ""
      yield* t.hub.noted(t.hub.tools.updateServer(null, docs, { auto_allow: true }))
      yield* t.settle()
      for (const h of [t.hub, t.a, t.b]) {
        assert.deepStrictEqual(yield* h.skills, [], h.id)
        assert.deepStrictEqual(yield* h.servers, [["docs", "https://docs.example.com/mcp", true]], h.id)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a host's skills and servers from before it synced join the others', and nothing it lacks is taken for removed", () =>
    Effect.gen(function* () {
      // Each host has its own before sync starts; the same skill on two of them with different text.
      const t = yield* board({ b: false }, (hub, a, b) =>
        Effect.gen(function* () {
          yield* hub.tools.addSkill(null, { content: skill("review") })
          yield* a.tools.addSkill(null, { content: skill("release") })
          yield* b.tools.addSkill(null, { content: skill("release", "Theirs.") })
          yield* b.tools.addServer(null, { name: "local", config: { command: "local-mcp" } })
        }).pipe(Effect.orDie),
      )
      yield* t.settle([t.hub, t.a])
      assert.deepStrictEqual(
        (yield* t.a.skills).map((x) => x[0]),
        ["release", "review"],
      )
      // b doesn't sync: nothing of the others' reaches it, nor its own them.
      assert.deepStrictEqual(
        (yield* t.b.skills).map((x) => x[0]),
        ["release"],
      )
      assert.deepStrictEqual(yield* t.hub.servers, [])

      yield* TestClock.adjust("1 second")
      yield* t.b.write("settings_sync", null)
      yield* t.b.sync.observe
      yield* t.settle()
      // The hosts that synced first keep their text; what only b had, it brings.
      for (const h of [t.hub, t.a, t.b]) {
        assert.deepStrictEqual(
          yield* h.skills,
          [
            ["release", skill("release"), true],
            ["review", skill("review"), true],
          ],
          h.id,
        )
        assert.deepStrictEqual(
          (yield* h.servers).map((x) => x[0]),
          ["local"],
          h.id,
        )
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a skill a host can't take stays as it is there, and one it lacks isn't made from nothing", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      const at = "2026-11-16T00:00:00.000Z"
      const entry = (name: string, value: unknown): SyncEntry => ({
        name,
        value,
        vv: { x: 1 },
        changed_at: at,
        changed_by: HostId.make("x"),
        since: "",
        lost: [],
      })
      // A skill whose text names another skill than its field's, and a server with no command or URL: kept, not applied.
      yield* t.b.sync.merge([
        entry("skill/deploy", { content: skill("other"), enabled: true }),
        entry("mcp_server/odd", { config: {}, enabled: true, auto_allow: false }),
      ])
      assert.deepStrictEqual(yield* t.b.skills, [])
      assert.deepStrictEqual(yield* t.b.servers, [])
      // A skill removed elsewhere that this host never had stays removed, with no entry of its own made for it.
      yield* t.a.sync.merge([entry("skill/gone", null)])
      assert.strictEqual((yield* t.a.entry("skill/gone"))?.changed_by, "x")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

/** A git repository in a temp folder with one skill, committed. */
const skillRepo = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = `${yield* tempDir}/repo`
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
    yield* git(dir, ["init", "-q", "-b", "main"])
    yield* fs.writeFileString(`${dir}/SKILL.md`, skill(name)).pipe(Effect.orDie)
    yield* git(dir, ["add", "-A"])
    yield* git(dir, ["commit", "-q", "-m", "init"])
    return dir
  })

describe("settings sync of the rest of the board (HE-46)", () => {
  it.effect("a skill source is cloned on every host, and its clone goes with it", () =>
    Effect.gen(function* () {
      const t = yield* board()
      yield* t.settle()
      const fs = yield* FileSystem.FileSystem
      const repo = yield* skillRepo("lint-rules")
      const added = yield* t.a.noted(t.a.tools.addSource({ url: repo }))
      yield* t.settle()
      // b takes what to clone, and clones it itself.
      const waiting = (yield* t.b.tools.global).skill_sources
      assert.deepStrictEqual(
        waiting.map((x) => [x.url, x.commit]),
        [[repo, ""]],
      )
      yield* t.b.tools.catchUp
      const onB = yield* t.b.tools.global
      assert.deepStrictEqual(
        onB.skills.map((x) => x.name),
        ["lint-rules"],
      )
      assert.notStrictEqual(onB.skill_sources[0]?.commit, "")
      const clone = `${t.b.clones}/${onB.skill_sources[0]?.id}`
      assert.isTrue(yield* fs.exists(clone))
      // Its skill is the source's: no field of its own.
      assert.isUndefined(yield* t.b.entry("skill/lint-rules"))

      yield* t.a.noted(t.a.tools.removeSource(added.source.id))
      yield* t.settle()
      assert.deepStrictEqual((yield* t.b.tools.global).skill_sources, [])
      yield* t.b.tools.catchUp
      assert.isFalse(yield* fs.exists(clone))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a profile's configs, reviewers and skill switches go by name; a config's options by its name", () =>
    Effect.gen(function* () {
      const t = yield* board()
      // Each host has a config called "main", at its own folder.
      const mainA = yield* Effect.orDie(t.a.configs.create({ name: "main", config_dir: "/a/claude" }))
      const mainB = yield* Effect.orDie(t.b.configs.create({ name: "main", config_dir: "/b/claude" }))
      yield* Effect.orDie(t.hub.configs.create({ name: "other", config_dir: "/hub/claude" }))
      const work = yield* t.a.profile({ name: "work", claude_config_ids: [mainA.id] })
      const x = yield* t.a.noted(t.a.tools.addSkill(null, { content: skill("deploy") }))
      yield* t.settle()
      yield* t.a.patch(work.id, { reviewers: [{ claude_config_id: mainA.id, model: "opus", effort: null }] })
      yield* t.a.noted(t.a.tools.setSwitch({ scope: "profile", scope_id: work.id, item_id: x.id, enabled: true }))
      yield* t.a.noted(t.a.configs.update(mainA.id, { show_usage: false, restart_window: true }))
      yield* t.settle()

      const onB = (yield* t.b.profiles.list).find((p) => p.name === "work")
      assert.deepStrictEqual(onB?.claude_config_ids, [mainB.id])
      assert.deepStrictEqual(
        onB?.reviewers?.map((r) => [r.claude_config_id, r.model]),
        [[mainB.id, "opus"]],
      )
      const xOnB = (yield* t.b.tools.global).skills.find((k) => k.name === "deploy")
      assert.deepStrictEqual((yield* t.b.tools.global).profile_switches[onB?.id ?? ""], { [xOnB?.id ?? ""]: true })
      const bMain = (yield* Effect.orDie(t.b.configs.list)).find((c) => c.id === mainB.id)
      assert.deepStrictEqual([bMain?.show_usage, bMain?.restart_window, bMain?.config_dir], [false, true, "/b/claude"])

      // The hub has no config of that name: its "work" waits with none, and doesn't send that back as a change.
      const onHub = (yield* t.hub.profiles.list).find((p) => p.name === "work")
      assert.deepStrictEqual(onHub?.claude_config_ids, [])
      assert.deepStrictEqual((yield* t.a.profiles.list).find((p) => p.name === "work")?.claude_config_ids, [mainA.id])
      assert.deepStrictEqual(
        (yield* t.a.sync.entries).filter((e) => e.lost.length > 0),
        [],
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
