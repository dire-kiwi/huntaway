import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { BoardEvent, UpdateRequest } from "@huntaway/contracts"
import { randomBytes } from "node:crypto"
import type { ChildProcessSpawner } from "effect/process"
import { git, tempDir, TestBoard } from "@huntaway/testing"
import { Events } from "../platform/Events.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Releases } from "./Releases.ts"
import { Restarts } from "./Restarts.ts"
import { Service } from "./Service.ts"
import { Supervisor } from "./Supervisor.ts"
import { Systemd } from "./Systemd.ts"
import { buildsShim, pnpmCommand, Updater } from "./Updater.ts"

// The old update/admin.test.ts's cases for a checkout host: what a hub bundles, following a deployment
// (`--update-from`, whose `/api/health` is an `HttpClient` layer here), a hub's push and its refusals, and the build's
// helpers. Git runs for real in temp folders. A rebuild in a test fails at its first step (there's no pnpm on the
// test config's empty PATH), which is the "a failed build keeps the old server" case.

const Json = Schema.fromJsonString(Schema.Unknown)
const json = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.orDie)

/** Where the deployment the host follows answers; `commits` says what its `/api/health` reports, by host. */
const DEPLOYED = "http://127.0.0.1:1/deployed"

const deployment = (commit: () => string | null) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      return HttpClientResponse.fromWeb(request, new Response(yield* json({ ok: true, commit: commit() }), { status: 200 }))
    }),
  )

const commit = (dir: string, message: string) =>
  Effect.gen(function* () {
    yield* git(dir, ["commit", "-q", "--allow-empty", "-m", message])
    return yield* git(dir, ["rev-parse", "HEAD"])
  })

/** An origin with one commit, cloned as the source checkout. */
const checkout = Effect.gen(function* () {
  const root = yield* tempDir
  const origin = `${root}/origin`
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(origin)
  yield* git(origin, ["init", "-q", "-b", "master"])
  const first = yield* commit(origin, "first")
  yield* git(root, ["clone", "-q", origin, "src"])
  // The clone commits as the tests' git user too.
  for (const [k, v] of [
    ["user.name", "t"],
    ["user.email", "t@example.com"],
  ] as const)
    yield* git(`${root}/src`, ["config", k, v])
  return { origin, src: `${root}/src`, first }
})

/** The updater of a host running `src`'s HEAD and following the deployment that reports `deployed()`. */
const host = (src: string, deployed: () => string | null = () => null, config: Partial<ServerConfigShape> = {}) =>
  Effect.gen(function* () {
    const layer = Layer.fresh(Updater.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Layer.fresh(Releases.layer), Layer.fresh(Service.layer))),
      Layer.provideMerge(Layer.fresh(Restarts.layer)),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, deployment(deployed)),
          Supervisor.layerTest(() => Effect.void),
          Systemd.layerTest({ booted: false }),
        ),
      ),
      Layer.provideMerge(TestBoard({ sourceDir: src, updateFrom: DEPLOYED, path: "", ...config })),
    )
    const context = yield* Layer.build(layer)
    return { updater: Context.get(context, Updater), context }
  })

const live = <A, E>(name: string, test: () => Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>) =>
  it.live(name, () => test().pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)

describe("following a deployment", () => {
  live("offers_the_commits_a_deployment_runs_ahead_of_this_host", () =>
    Effect.gen(function* () {
      const { origin, src } = yield* checkout
      yield* commit(origin, "second")
      const ahead = yield* commit(origin, "third")
      const { updater } = yield* host(src, () => ahead)
      yield* updater.checkDeployed
      const s = yield* updater.status
      assert.deepStrictEqual([s.deployed?.commit, s.deployed?.error, s.update_from, s.updates_from], [ahead, null, DEPLOYED, "checkout"])
      // Fetched from origin, so the status lists what it adds.
      assert.deepStrictEqual(
        s.deployed_commits?.map((c) => c.slice(c.indexOf(" ") + 1)),
        ["third", "second"],
      )
    }),
  )

  live("offers_nothing_for_a_deployment_behind_or_beside_this_host", () =>
    Effect.gen(function* () {
      const { origin, src, first } = yield* checkout
      // This host is ahead of what's deployed.
      yield* commit(src, "local")
      const behind = (yield* host(src, () => first)).updater
      yield* behind.checkDeployed
      let s = yield* behind.status
      assert.deepStrictEqual([s.deployed?.commit, s.deployed_commits], [first, []])
      // Diverged: the deployment runs a commit beside this host's.
      const beside = yield* commit(origin, "elsewhere")
      const { updater } = yield* host(src, () => beside)
      yield* updater.checkDeployed
      s = yield* updater.status
      assert.deepStrictEqual([s.deployed?.commit, s.deployed?.error, s.deployed_commits], [beside, null, []])
    }),
  )

  live("keeps_the_last_commit_when_a_check_fails", () =>
    Effect.gen(function* () {
      const { origin, src } = yield* checkout
      const ahead = yield* commit(origin, "second")
      let reports: string | null = ahead
      const { updater } = yield* host(src, () => reports)
      yield* updater.checkDeployed
      for (const [c, why] of [
        [null, "doesn't say which commit"],
        ["0".repeat(40), "isn't on this checkout's origin"],
      ] as const) {
        reports = c
        yield* updater.checkDeployed
        const d = (yield* updater.status).deployed
        assert.strictEqual(d?.commit, ahead)
        assert.include(d?.error ?? "", why)
      }
      assert.strictEqual((yield* updater.status).deployed_commits?.length, 1)
    }),
  )
})

/** A bundle's size in bytes. */
const size = (b: UpdateRequest) => Base64.decode(b.bundle ?? "").pipe((r) => (r._tag === "Success" ? r.success.length : -1))

describe("a hub's Update", () => {
  live("a_hub_bundles_only_the_commits_a_host_lacks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { src } = yield* checkout
      yield* fs.writeFile(`${src}/big.bin`, new Uint8Array(randomBytes(3 << 20)))
      yield* git(src, ["add", "big.bin"])
      const hostRuns = yield* commit(src, "big")
      const hostDir = `${yield* tempDir}/host`
      yield* git(src, ["clone", "-q", src, hostDir])
      yield* commit(src, "second")
      const head = yield* commit(src, "third")
      const { updater } = yield* host(src)

      const thin = yield* updater.bodyFor(hostRuns)
      assert.deepStrictEqual([thin.branch, thin.commit, thin.version], ["master", head, "0.1.0"])
      assert.isBelow(size(thin), 64 << 10)
      // The host has what it needs to fetch it, and fast-forwards to the hub's commit.
      const file = `${hostDir}/../in.bundle`
      const bytes = Base64.decode(thin.bundle ?? "")
      if (bytes._tag === "Success") yield* fs.writeFile(file, bytes.success)
      yield* git(hostDir, ["fetch", "-q", file, "refs/heads/master:refs/remotes/hub/master"])
      yield* git(hostDir, ["merge", "-q", "--ff-only", head])
      assert.strictEqual(yield* git(hostDir, ["rev-parse", "HEAD"]), head)
      // The whole branch without a commit to start from, or one the branch is at, or one it lacks or that isn't on it.
      const beside = yield* git(src, ["commit-tree", "-m", "beside", `${hostRuns}^{tree}`])
      for (const since of [null, head, "0123456789abcdef0123456789abcdef01234567", beside, "not a commit"]) {
        assert.isAbove(size(yield* updater.bodyFor(since)), 3 << 20, `since ${since}`)
      }
    }),
  )

  live("a hub without a checkout sends its commit, and a release hub its version", () =>
    Effect.gen(function* () {
      const deployedHub = yield* host("/nonexistent", () => null, { sourceDir: null, commit: "abc" })
      assert.deepStrictEqual(yield* deployedHub.updater.bodyFor(null), { commit: "abc", version: "0.1.0" })
      const releaseHub = yield* host("/nonexistent", () => null, { sourceDir: null, commit: null, releaseRepo: "o/r" })
      assert.deepStrictEqual(yield* releaseHub.updater.bodyFor(null), { version: "0.1.0" })
      const neither = yield* host("/nonexistent", () => null, { sourceDir: null, commit: null })
      assert.strictEqual((yield* Effect.flip(neither.updater.bodyFor(null)))._tag, "Unavailable")
    }),
  )

  live("a_checkout_host_needs_the_hubs_commit", () =>
    Effect.gen(function* () {
      // Neither a checkout nor a release install.
      const bare = yield* host("/nonexistent", () => null, { sourceDir: null })
      const e1 = yield* Effect.flip(bare.updater.update({ commit: "abc", version: "0.2.0" }))
      assert.include(e1._tag === "Unavailable" ? e1.reason : "", "isn't running from a source checkout")
      // A hub that runs a release can't update a checkout.
      const { src } = yield* checkout
      const { updater } = yield* host(src)
      const e2 = yield* Effect.flip(updater.update({ version: "0.2.0" }))
      assert.include(e2._tag === "Invalid" ? e2.reason : "", "runs a release rather than a checkout")
      // A release host: the hub's version, without which it can't.
      const release = yield* host("/nonexistent", () => null, { sourceDir: null, releaseRepo: "o/r" })
      assert.deepStrictEqual(yield* release.updater.update({ commit: "abc", version: "0.1.0" }), { ok: true, up_to_date: true })
      assert.strictEqual((yield* Effect.flip(release.updater.update({ commit: "abc" })))._tag, "Invalid")
    }),
  )

  live("a host's checkout refuses what it can't fast-forward to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { origin, src, first } = yield* checkout
      const { updater } = yield* host(src)
      // Its own commit is up to date.
      assert.deepStrictEqual(yield* updater.update({ commit: first }), { ok: true, up_to_date: true })
      // A commit not on origin/master.
      const elsewhere = yield* git(origin, ["commit-tree", "-m", "elsewhere", `${first}^{tree}`])
      const e1 = yield* Effect.flip(updater.update({ commit: elsewhere }))
      assert.include(e1._tag === "Unavailable" ? e1.reason : "", "isn't on origin/master")
      // Another branch's bundle.
      const e2 = yield* Effect.flip(updater.update({ commit: elsewhere, branch: "main", bundle: "" }))
      assert.include(e2._tag === "Unavailable" ? e2.reason : "", "on master, the hub's on main")
      // Uncommitted changes.
      yield* fs.writeFileString(`${src}/tracked`, "one")
      yield* git(src, ["add", "tracked"])
      yield* commit(src, "tracked")
      yield* fs.writeFileString(`${src}/tracked`, "two")
      const ahead = yield* commit(origin, "ahead")
      const e3 = yield* Effect.flip(updater.update({ commit: ahead }))
      assert.include(e3._tag === "Unavailable" ? e3.reason : "", "uncommitted changes")
    }),
  )

  live("a host fast-forwards to a hub's commit, and a failed build keeps the old server", () =>
    Effect.gen(function* () {
      const { origin, src } = yield* checkout
      const ahead = yield* commit(origin, "ahead")
      const { updater, context } = yield* host(src)
      const bus = Context.get(context, Events)
      const watch = yield* bus.watch(undefined)
      const queue = yield* Queue.unbounded<BoardEvent>()
      yield* watch.live.pipe(
        Stream.runForEach((e) => Queue.offer(queue, e)),
        Effect.forkScoped,
      )
      assert.deepStrictEqual(yield* updater.update({ commit: ahead }), { ok: true, commit: ahead })
      assert.strictEqual(yield* git(src, ["rev-parse", "HEAD"]), ahead)
      // The rebuild's first step can't run (no pnpm on this test's PATH): the job fails, and nothing is exec'd.
      const phases: Array<string> = []
      for (;;) {
        const e = yield* Queue.take(queue)
        if (e.type !== "restart") continue
        phases.push(e.phase)
        if (e.phase === "failed") {
          assert.include(e.error ?? "", "failed to run npx")
          break
        }
      }
      assert.deepStrictEqual(phases, ["building_ui", "failed"])
      // Another job may start now.
      const restarts = Context.get(context, Restarts)
      assert.strictEqual((yield* restarts.current)?.phase, "failed")
    }),
  )
})

describe("the rebuild's helpers", () => {
  live("a_rebuild_without_cargo_keeps_a_prebuilt_ia_shim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const server = yield* tempDir
      const cargoDir = yield* tempDir
      yield* fs.writeFileString(`${cargoDir}/cargo`, "")
      const empty = yield* tempDir
      // No prebuilt shim: cargo builds it (and the step fails without cargo, saying so).
      assert.isTrue(yield* buildsShim(empty, server))
      yield* fs.makeDirectory(`${server}/bin`)
      yield* fs.writeFileString(`${server}/bin/ia-shim`, "")
      assert.isFalse(yield* buildsShim(empty, server), "no cargo: the release's shim is kept")
      assert.isFalse(yield* buildsShim("", server))
      assert.isTrue(yield* buildsShim(`${empty}:${cargoDir}`, server), "with cargo, the checkout's own shim is built")
    }),
  )

  live("a_rebuild_runs_pnpm_from_path_else_the_pinned_one_through_npx", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const src = yield* tempDir
      const bin = yield* tempDir
      const empty = yield* tempDir
      yield* fs.writeFileString(`${src}/package.json`, '{"packageManager":"pnpm@10.34.9+sha512.abc"}')
      assert.deepStrictEqual(yield* pnpmCommand(empty, src), ["npx", ["--yes", "pnpm@10.34.9"]])
      yield* fs.writeFileString(`${bin}/pnpm`, "")
      assert.deepStrictEqual(yield* pnpmCommand(`${empty}:${bin}`, src), ["pnpm", []])
      assert.deepStrictEqual(yield* pnpmCommand(empty, empty), ["npx", ["--yes", "pnpm"]], "no package.json: the latest pnpm")
    }),
  )
})
