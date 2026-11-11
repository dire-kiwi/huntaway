import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { HostId, PROTOCOL } from "@huntaway/contracts"
import type { ApprovalRule, HostSettingsPatch, NewProfile, ProfileId, ProfilePatch, SyncEntry } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { ApprovalRulesRepo } from "../agents/ApprovalRulesRepo.ts"
import { Profiles } from "../profiles/Profiles.ts"
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
      if (sw !== false) yield* host.write("settings_sync", "true")
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

  it.effect("a profile's settings go by its name, and wait for a host that has no profile of that name yet", () =>
    Effect.gen(function* () {
      const t = yield* board()
      const pa = yield* t.a.profile({ name: "work" })
      const other = yield* t.a.profile({ name: "personal" })
      const pb = yield* t.b.profile({ name: "work" })
      assert.notStrictEqual(pa.id, pb.id)
      yield* t.settle()
      yield* t.a.patch(pa.id, { limit_wait: true, default_model: "opus", agent_access: ["personal"] })
      yield* t.a.patch(other.id, { merge_approval: true })
      const rules: ReadonlyArray<ApprovalRule> = [{ tool: "Bash", decision: "never" }]
      yield* t.a.setRules(pa.id, rules, 5)
      yield* t.settle()
      const work = yield* Effect.orDie(t.b.profiles.get(pb.id))
      assert.deepStrictEqual([work.limit_wait, work.default_model, work.agent_access], [true, "opus", ["personal"]])
      assert.deepStrictEqual(yield* t.b.saved(pb.id), { rules, expiry_minutes: 5 })
      // What belongs to the host stays: its configs and folders aren't entries at all.
      assert.isFalse((yield* t.b.sync.entries).some((e) => /claude_config|clone_dir|asana|assistant_host/.test(e.name)))

      // b gets a "personal" later: what a's has is waiting for it. Renamed on a, it's a profile of its own from then on.
      const made = yield* t.b.profile({ name: "personal" })
      yield* t.b.sync.observe
      assert.isTrue((yield* Effect.orDie(t.b.profiles.get(made.id))).merge_approval)
      yield* t.settle()
      assert.deepStrictEqual(
        (yield* t.hub.sync.entries).filter((e) => e.lost.length > 0),
        [],
      )
      yield* t.a.patch(other.id, { name: "home", merge_approval: false })
      yield* t.settle()
      assert.isTrue((yield* Effect.orDie(t.b.profiles.get(made.id))).merge_approval)
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

  it.effect("a host says whether sync is on, and once on its entries are its values from before sync", () =>
    Effect.gen(function* () {
      const h = yield* boardAs("h")
      assert.deepStrictEqual(yield* h.sync.status, { enabled: false, host_id: HostId.make("h"), entries: [] })
      yield* h.set({ settings_sync: true })
      const got = yield* h.sync.status
      assert.isTrue(got.enabled)
      assert.include(
        got.entries.map((e) => e.name),
        "global/default_permission_mode",
      )
      assert.isTrue(got.entries.every((e) => e.changed_at === "" && e.vv["h"] === 1))
      // Off again: nothing to merge into, and its entries are not given out.
      yield* h.set({ settings_sync: false })
      assert.deepStrictEqual((yield* h.sync.status).entries, [])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(h.sync.resolve("global/default_model", Option.none()))))
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
