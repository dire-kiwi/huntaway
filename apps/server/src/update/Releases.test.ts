import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Effect, FileSystem, Layer, Queue, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { BoardEvent, ReleaseStatus } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Events } from "../platform/Events.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { readInstalled, writeInstalled } from "./releases/appDir.ts"
import { emptyInstalled } from "./releases/installed.ts"
import type { Installed } from "./releases/installed.ts"
import { Releases } from "./Releases.ts"
import { Restarts } from "./Restarts.ts"
import { NOT_SUPERVISED, Supervisor } from "./Supervisor.ts"
import type { ExecCall } from "./Supervisor.ts"

// The old update/release/tests.test.ts's cases that need the service: checks against a fake GitHub (an `HttpClient`
// layer), downloads into a temp data folder with the real `tar` and a smoke test, Update and Roll back as restart jobs
// whose exec a test `Supervisor` records (a test isn't run by the launcher, so the exec then fails, as it did).

const Json = Schema.fromJsonString(Schema.Unknown)
const json = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.orDie)

/** How the fake serves a file: whole; half of it, then the connection breaks; or whole once the test lets it go. */
type Serve = "whole" | "cut" | Deferred.Deferred<void>

interface Fake {
  releases: ReadonlyArray<unknown>
  etag: string
  fail: readonly [number, Record<string, string>] | null
  manifestFail: readonly [number, Record<string, string>] | null
  notModified: number
  manifests: number
  downloads: number
  readonly files: Map<string, { bytes: Uint8Array; serve: Serve }>
}

const fakeOf = (releases: ReadonlyArray<unknown> = []): Fake => ({
  releases,
  etag: '"one"',
  fail: null,
  manifestFail: null,
  notModified: 0,
  manifests: 0,
  downloads: 0,
  files: new Map(),
})

/** GitHub's API and downloads at `http://gh`, as `fake` says. */
const github = (fake: Fake) =>
  HttpClient.make((request, url) => {
    const respond = (body: ConstructorParameters<typeof Response>[0], init: ConstructorParameters<typeof Response>[1]) =>
      HttpClientResponse.fromWeb(request, new Response(body, init))
    return Effect.gen(function* () {
      const failure = ([status, headers]: readonly [number, Record<string, string>]) =>
        respond('{"message":"nope"}', { status, headers: { "content-type": "application/json", ...headers } })
      if (url.pathname === "/repos/o/r/releases") {
        if (fake.fail !== null) return failure(fake.fail)
        if (request.headers["if-none-match"] === fake.etag) {
          fake.notModified++
          return respond(null, { status: 304 })
        }
        return respond(yield* json(fake.releases), { status: 200, headers: { etag: fake.etag } })
      }
      const name = decodeURIComponent(url.pathname.replace(/^\/download\//, ""))
      const file = fake.files.get(name)
      if (file !== undefined) {
        fake.downloads++
        const length = String(file.bytes.length)
        if (file.serve === "cut") {
          const half = file.bytes.slice(0, Math.floor(file.bytes.length / 2))
          const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(half)
              controller.error(new Error("connection reset"))
            },
          })
          return respond(body, { status: 200, headers: { "content-length": length } })
        }
        if (file.serve !== "whole") yield* Deferred.await(file.serve)
        return respond(file.bytes, { status: 200, headers: { "content-length": length } })
      }
      if (name.endsWith("-release.json")) fake.manifests++
      if (fake.manifestFail !== null) return failure(fake.manifestFail)
      const v = name.replace(/^huntaway-/, "").replace(/-release\.json$/, "")
      return respond(yield* json({ version: v, shell: `shell-${v}`, electron: "38.0.0" }), { status: 200 })
    })
  })

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const asset = (name: string, digest: string | null) => ({ name, browser_download_url: `http://gh/download/${name}`, size: 42, digest })

const release = (tag: string, prerelease = false) => {
  const v = tag.replace(/^v+/, "")
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    published_at: "2026-10-01T00:00:00Z",
    body: `notes for ${v}`,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [
      asset(`huntaway-server-${v}-linux-x64.tar.gz`, DIGEST),
      asset(`huntaway-${v}-linux-x64.pacman`, DIGEST),
      asset(`huntaway-${v}-release.json`, DIGEST),
    ],
  }
}

/** A release's files in `dir`: `huntaway` (a script that runs `script`), `ia-shim` and `ui/index.html`. */
const serverFiles = (dir: string, script: string, ui = true) => {
  mkdirSync(`${dir}/ui`, { recursive: true })
  writeFileSync(`${dir}/huntaway`, `#!/bin/sh\n${script}\n`)
  chmodSync(`${dir}/huntaway`, 0o755)
  writeFileSync(`${dir}/ia-shim`, "shim")
  if (ui) writeFileSync(`${dir}/ui/index.html`, "<html>")
  else rmSync(`${dir}/ui`, { recursive: true })
}

/** A server tarball for `v` (`huntaway-server-<v>-linux-x64/…`) whose `huntaway` runs `script`, with `tar`'s extra entries. */
const tarball = (
  v: string,
  options: { readonly script?: string; readonly extra?: ReadonlyArray<string>; readonly link?: boolean; readonly ui?: boolean } = {},
) => {
  const dir = mkdtempSync(`${tmpdir()}/huntaway-tarball-`)
  try {
    const top = `huntaway-server-${v}-linux-x64`
    serverFiles(`${dir}/${top}`, options.script ?? `echo 'huntaway ${v}'`, options.ui ?? true)
    if (options.link === true) symlinkSync("/etc", `${dir}/${top}/etc`)
    writeFileSync(`${dir}/evil`, "outside")
    execFileSync("tar", ["-czPf", "out.tar.gz", top, ...(options.extra ?? [])], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] })
    return new Uint8Array(readFileSync(`${dir}/out.tar.gz`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A release of `tag` whose linux-x64 tarball is `bytes`, served as `serve`. */
const served = (fake: Fake, tag: string, bytes: Uint8Array, serve: Serve = "whole") => {
  const r = release(tag)
  const name = r.assets[0]?.name ?? ""
  fake.files.set(name, { bytes, serve })
  return { ...r, assets: [{ ...asset(name, `sha256:${createHash("sha256").update(bytes).digest("hex")}`), size: bytes.length }, ...r.assets.slice(1)] }
}

/** Change what the fake lists, with a new ETag. */
const relist = (fake: Fake, releases: ReadonlyArray<unknown>) => {
  fake.releases = releases
  fake.etag = `"${fake.etag.length}-${releases.length}-${Math.floor(fake.downloads)}-${fake.manifests}"`
}

/** The desktop app's environment in the old tests' config. */
const DESKTOP = {
  releaseRepo: "o/r",
  releaseApi: "http://gh",
  platform: "linux-x64",
  desktopVersion: "0.1.0",
  desktopShell: "shell-0.2.0",
  desktopInstall: "pacman",
  bundledServer: "/opt/Huntaway/resources/huntaway",
}

/**
 * The release services on a board in `dataDir` (a temp folder by default), checking `fake`, with `config` on top, and
 * the execs that would have happened.
 */
const host = (fake: Fake, config: Partial<ServerConfigShape> = {}, dataDir?: string) =>
  Effect.gen(function* () {
    const dir = dataDir ?? (yield* tempDir)
    const execs = yield* Ref.make<ReadonlyArray<ExecCall & { readonly state: Installed }>>([])
    const onExec = (call: ExecCall) =>
      readInstalled(`${dir}/app`).pipe(
        Effect.flatMap((state) => Ref.update(execs, (all) => [...all, { ...call, state }])),
        Effect.provide(NodeServices.layer),
      )
    const layer = Layer.fresh(Releases.layer).pipe(
      Layer.provideMerge(Layer.fresh(Restarts.layer)),
      Layer.provideMerge(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, github(fake)), Supervisor.layerTest(onExec))),
      Layer.provideMerge(TestBoard({ version: "0.1.0", exe: "/usr/lib/huntaway/huntaway", ...DESKTOP, ...config, dataDir: dir })),
    )
    const context = yield* Layer.build(layer)
    return { context, releases: Context.get(context, Releases), dir, app: `${dir}/app`, execs }
  })

type Host = Effect.Success<ReturnType<typeof host>>

/** The board's events from now on, for the scope. */
const events = (h: Host) =>
  Effect.gen(function* () {
    const bus = Context.get(h.context, Events)
    const watch = yield* bus.watch(undefined)
    const queue = yield* Queue.unbounded<BoardEvent>()
    yield* watch.live.pipe(
      Stream.runForEach((e) => Queue.offer(queue, e)),
      Effect.forkScoped,
    )
    return queue
  })

/** Wait for the download to finish (staged: null; failed: its error). Call with the events subscribed before the check. */
const finished = (queue: Queue.Queue<BoardEvent>, version?: string) =>
  Effect.gen(function* () {
    for (;;) {
      const e = yield* Queue.take(queue)
      if (e.type !== "release_download") continue
      if (e.download === null) return { phase: "staged" as const, error: null }
      if (e.download.phase === "failed" && (version === undefined || e.download.version === version))
        return { phase: "failed" as const, error: e.download.error }
    }
  })

/** The restart job's phases until it fails, and its error. */
const jobFails = (queue: Queue.Queue<BoardEvent>) =>
  Effect.gen(function* () {
    const phases: Array<string> = []
    for (;;) {
      const e = yield* Queue.take(queue)
      if (e.type !== "restart") continue
      if (phases.at(-1) !== e.phase) phases.push(e.phase)
      if (e.phase === "failed") return { phases, error: e.error ?? "" }
    }
  })

const status = (h: Host) => Effect.map(h.releases.status, (s): ReleaseStatus => s ?? assert.fail("release updates are off"))

const entries = (h: Host) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.readDirectory(h.app).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).toSorted((a, b) => a.localeCompare(b))
  })

const state = (h: Host) => readInstalled(h.app)
const write = (h: Host, s: Partial<Installed>) => writeInstalled(h.app, { ...emptyInstalled, ...s })
const setPrereleases = (h: Host, on: boolean) => Context.get(h.context, SettingsRepo).set("release_prereleases", on ? "true" : null)

/** Check, then wait for the download that follows. */
const checkAndWait = (h: Host, version?: string) =>
  Effect.gen(function* () {
    const queue = yield* events(h)
    yield* h.releases.check
    return yield* finished(queue, version)
  })

const live = <A, E>(name: string, test: () => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
  it.live(name, () => test().pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)

describe("release checks", () => {
  live("picks_the_highest_version_with_a_server_for_this_platform", () =>
    Effect.gen(function* () {
      const h = yield* host(fakeOf([release("v0.1.0"), release("0.10.0"), release("v0.2.0")]))
      yield* h.releases.check
      const r = yield* status(h)
      assert.deepStrictEqual(
        [r.error, r.latest?.version, r.latest?.notes, r.latest?.asset.name, r.latest?.newer, r.running],
        [null, "0.10.0", "notes for 0.10.0", "huntaway-server-0.10.0-linux-x64.tar.gz", true, "0.1.0"],
      )
      assert.strictEqual(r.latest?.asset.sha256, DIGEST.slice(7))
      assert.strictEqual(r.shell?.package?.name, "huntaway-0.10.0-linux-x64.pacman")
      assert.deepStrictEqual([r.staged, r.bad], [null, []])
    }),
  )

  live("a_304_keeps_the_last_list", () =>
    Effect.gen(function* () {
      const fake = fakeOf([release("v0.3.0-rc.1", true), release("v0.2.0")])
      const h = yield* host(fake)
      yield* h.releases.check
      // GitHub has more now, but says the list hasn't changed: the last one stands.
      fake.releases = [release("v0.9.0")]
      yield* h.releases.check
      assert.strictEqual(fake.notModified, 1)
      assert.deepStrictEqual([(yield* status(h)).latest?.version, (yield* status(h)).error], ["0.2.0", null])
      // And it is picked from again, for a changed setting.
      yield* setPrereleases(h, true)
      yield* h.releases.check
      assert.deepStrictEqual([fake.notModified, (yield* status(h)).latest?.version], [2, "0.3.0-rc.1"])
      // A new ETag brings the new list.
      fake.etag = '"two"'
      yield* h.releases.check
      assert.strictEqual((yield* status(h)).latest?.version, "0.9.0")
    }),
  )

  live("a_failed_check_keeps_the_last_result", () =>
    Effect.gen(function* () {
      const fake = fakeOf([release("v0.2.0")])
      const h = yield* host(fake)
      yield* h.releases.check
      fake.fail = [500, {}]
      yield* h.releases.check
      let r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.error, r.rate_limit_reset], ["0.2.0", "GitHub answered 500 Internal Server Error: nope", null])
      // The rate limit says so, with when it resets.
      fake.fail = [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793491200" }]
      yield* h.releases.check
      r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.rate_limit_reset], ["0.2.0", "2026-11-01T00:00:00Z"])
      assert.include(r.error ?? "", "rate limit")
      // A 403 that isn't the rate limit is just an error.
      fake.fail = [403, { "x-ratelimit-remaining": "12" }]
      yield* h.releases.check
      r = yield* status(h)
      assert.deepStrictEqual([r.error, r.rate_limit_reset], ["GitHub answered 403 Forbidden: nope", null])
      // Recovering clears the error.
      fake.fail = null
      yield* h.releases.check
      assert.isNull((yield* status(h)).error)
    }),
  )

  live("a_manifest_that_cant_be_read_fails_the_check", () =>
    Effect.gen(function* () {
      const fake = fakeOf([release("v0.3.0")])
      const h = yield* host(fake)
      yield* h.releases.check
      assert.deepStrictEqual([(yield* status(h)).latest?.version, (yield* status(h)).shell?.outdated], ["0.3.0", true])
      relist(fake, [release("v0.4.0"), release("v0.3.0")])
      fake.manifestFail = [500, {}]
      yield* h.releases.check
      let r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.shell?.outdated], ["0.3.0", true])
      assert.strictEqual(r.error, "reading huntaway-0.4.0-release.json: GitHub answered 500 Internal Server Error: nope")
      fake.manifestFail = [429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793491200" }]
      yield* h.releases.check
      r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.rate_limit_reset], ["0.3.0", "2026-11-01T00:00:00Z"])
      // Once it can be read, the check goes through (the list is asked for again, not taken from a 304), and the
      // manifest is read once per release.
      fake.manifestFail = null
      yield* h.releases.check
      yield* h.releases.check
      r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.shell?.outdated, r.error, r.rate_limit_reset], ["0.4.0", true, null, null])
      assert.strictEqual(fake.manifests, 4)
    }),
  )

  live("the_prerelease_setting_checks_again", () =>
    Effect.gen(function* () {
      const fake = fakeOf([release("v0.3.0-beta.1", true), release("v0.2.0")])
      const h = yield* host(fake)
      yield* h.releases.check
      assert.strictEqual((yield* status(h)).latest?.version, "0.2.0")
      const queue = yield* events(h)
      yield* Context.get(h.context, HostSettings).update({ release_prereleases: true })
      for (;;) if ((yield* Queue.take(queue)).type === "release_checked") break
      assert.strictEqual((yield* status(h)).latest?.version, "0.3.0-beta.1")
      assert.strictEqual(fake.notModified, 1)
    }),
  )

  live("off_without_the_flag", () =>
    Effect.gen(function* () {
      const h = yield* host(fakeOf(), { releaseRepo: null })
      assert.isNull(yield* h.releases.status)
      const refused = yield* Effect.flip(h.releases.check)
      assert.strictEqual(refused._tag, "Unavailable")
    }),
  )
})

/** Stage a release of these bytes and expect it to fail with `error`, leaving nothing in `app/`. */
const refused = (bytes: Uint8Array, error: string, options: { readonly serve?: Serve; readonly digest?: string } = {}) =>
  Effect.gen(function* () {
    const fake = fakeOf()
    const r = served(fake, "v0.2.0", bytes, options.serve)
    fake.releases = [options.digest === undefined ? r : { ...r, assets: [{ ...r.assets[0], digest: options.digest }] }]
    const h = yield* host(fake)
    const d = yield* checkAndWait(h)
    assert.strictEqual(d.phase, "failed")
    assert.include(d.error ?? "", error)
    assert.deepStrictEqual(yield* entries(h), [])
    const s = yield* status(h)
    assert.deepStrictEqual([s.download?.phase, s.staged, s.download?.error], ["failed", null, d.error])
    return { fake, h }
  })

describe("staging", () => {
  live("a_newer_release_is_staged_in_the_background", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      const queue = yield* events(h)
      yield* h.releases.check
      assert.deepStrictEqual(yield* finished(queue), { phase: "staged", error: null })
      assert.deepStrictEqual(yield* entries(h), ["0.2.0", "state.json"])
      assert.strictEqual((yield* state(h)).staged, "0.2.0")
      const r = yield* status(h)
      assert.deepStrictEqual([r.staged, r.download], ["0.2.0", null])
      // Checking again doesn't download it again.
      yield* h.releases.check
      assert.strictEqual(fake.downloads, 1)
    }),
  )

  live("a_wrong_digest_leaves_nothing_behind_and_is_tried_again", () =>
    Effect.gen(function* () {
      const bytes = tarball("0.2.0")
      const { fake, h } = yield* refused(bytes, "has sha256", { digest: DIGEST })
      relist(fake, [served(fake, "v0.2.0", bytes)])
      assert.strictEqual((yield* checkAndWait(h)).phase, "staged")
    }),
  )

  live("a_cut_off_download_leaves_nothing_behind", () => refused(tarball("0.2.0"), "cut off", { serve: "cut" }))

  live("entries_outside_the_folder_are_refused", () => refused(tarball("0.2.0", { extra: ["huntaway-server-0.2.0-linux-x64/../evil"] }), "outside its folder"))

  live("links_are_refused", () => refused(tarball("0.2.0", { link: true }), "isn't a file or a folder"))

  live("a_server_that_fails_its_smoke_test_is_refused", () =>
    Effect.gen(function* () {
      yield* refused(tarball("0.2.0", { script: "echo broken >&2; exit 3" }), "--version failed with exit status: 3: broken")
      yield* refused(tarball("0.2.0", { script: "echo huntaway 0.1.9" }), 'printed "huntaway 0.1.9", not 0.2.0')
      yield* refused(tarball("0.2.0", { ui: false }), "doesn't have huntaway, ia-shim and ui/index.html")
    }),
  )

  live("one_download_at_a_time", () =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<void>()
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"), go)]
      const h = yield* host(fake)
      const queue = yield* events(h)
      yield* h.releases.check
      yield* h.releases.check
      yield* h.releases.check
      const r = yield* status(h)
      assert.deepStrictEqual([r.download?.version, r.download?.phase, r.staged], ["0.2.0", "downloading", null])
      yield* Deferred.succeed(go, undefined)
      assert.strictEqual((yield* finished(queue)).phase, "staged")
      assert.strictEqual(fake.downloads, 1)
    }),
  )

  live("a_release_found_during_a_download_is_downloaded_after_it", () =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<void>()
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"), go)]
      const h = yield* host(fake)
      const queue = yield* events(h)
      yield* h.releases.check
      relist(fake, [served(fake, "v0.3.0", tarball("0.3.0"))])
      yield* h.releases.check
      assert.strictEqual((yield* status(h)).download?.version, "0.2.0")
      yield* Deferred.succeed(go, undefined)
      yield* finished(queue)
      yield* finished(queue)
      assert.strictEqual((yield* status(h)).staged, "0.3.0")
      assert.deepStrictEqual(yield* entries(h), ["0.3.0", "state.json"])
    }),
  )

  live("a_staged_prerelease_is_unstaged_once_prereleases_are_off", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [{ ...served(fake, "v0.3.0-rc.1", tarball("0.3.0-rc.1")), prerelease: true }, served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      yield* setPrereleases(h, true)
      assert.strictEqual((yield* checkAndWait(h)).phase, "staged")
      assert.strictEqual((yield* status(h)).staged, "0.3.0-rc.1")
      yield* setPrereleases(h, false)
      // The release it does pick is downloaded instead.
      yield* checkAndWait(h)
      const r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.staged], ["0.2.0", "0.2.0"])
      assert.deepStrictEqual(yield* entries(h), ["0.2.0", "state.json"])
    }),
  )

  live("a_staged_release_taken_down_is_unstaged_but_not_on_a_failed_check", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      assert.strictEqual((yield* checkAndWait(h)).phase, "staged")
      fake.fail = [500, {}]
      yield* h.releases.check
      assert.strictEqual((yield* status(h)).staged, "0.2.0", "a failed check says nothing about the release")
      fake.fail = null
      relist(fake, [])
      yield* h.releases.check
      assert.isNull((yield* status(h)).staged)
      assert.deepStrictEqual(yield* entries(h), ["state.json"])
    }),
  )

  live("a_newer_release_replaces_an_unused_staged_one", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      yield* checkAndWait(h)
      relist(fake, [served(fake, "v0.3.0", tarball("0.3.0")), served(fake, "v0.2.0", tarball("0.2.0"))])
      assert.strictEqual((yield* checkAndWait(h)).phase, "staged")
      assert.deepStrictEqual(yield* entries(h), ["0.3.0", "state.json"])
      assert.strictEqual((yield* status(h)).staged, "0.3.0")
    }),
  )

  live("a_bad_version_isnt_offered_or_staged", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.3.0", tarball("0.3.0")), served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      yield* write(h, { bad: ["0.3.0"] })
      yield* checkAndWait(h)
      const r = yield* status(h)
      assert.deepStrictEqual([r.latest?.version, r.staged, r.bad], ["0.2.0", "0.2.0", ["0.3.0"]])
      const refusedUpdate = yield* Effect.flip(h.releases.update("0.3.0"))
      assert.strictEqual(refusedUpdate._tag, "Invalid")
    }),
  )
})

/** An Update of a server that has 0.2.0 staged in `app/`: the environment it would exec it with. */
const updateFromApp = (config: Partial<ServerConfigShape>) =>
  Effect.gen(function* () {
    const h = yield* host(fakeOf(), config)
    serverFiles(`${h.app}/0.2.0`, "echo huntaway 0.2.0")
    yield* write(h, { staged: "0.2.0" })
    const queue = yield* events(h)
    yield* h.releases.update("0.2.0")
    yield* jobFails(queue)
    return (yield* Ref.get(h.execs))[0]?.env
  })

describe("Update", () => {
  live("update_restarts_onto_a_staged_version", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      yield* checkAndWait(h)
      const queue = yield* events(h)
      yield* h.releases.update("0.2.0")
      // One at a time.
      assert.strictEqual((yield* Effect.flip(h.releases.update("0.2.0")))._tag, "Conflict")
      const { phases, error } = yield* jobFails(queue)
      assert.deepStrictEqual(phases, ["restarting", "failed"])
      assert.strictEqual(error, `failed to exec ${h.app}/0.2.0/huntaway: ${NOT_SUPERVISED}`)
      const [exec] = yield* Ref.get(h.execs)
      assert.strictEqual(exec?.state.trying, "0.2.0", "trying is set for the exec")
      // It failed, so this server carries on as it was.
      const s = yield* state(h)
      assert.deepStrictEqual([s.trying, s.staged], [null, "0.2.0"])
    }),
  )

  live("a_tarball_servers_update_passes_itself_for_roll_back", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* updateFromApp({ bundledServer: null }), [["HUNTAWAY_BUNDLED_SERVER", "/usr/lib/huntaway/huntaway"]])
      // The desktop app's server, or one given HUNTAWAY_BUNDLED_SERVER: it carries over as it is.
      assert.deepStrictEqual(yield* updateFromApp({}), [])
    }),
  )

  live("update_waits_for_the_background_download", () =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<void>()
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"), go)]
      const h = yield* host(fake)
      yield* h.releases.check
      const queue = yield* events(h)
      yield* h.releases.update("0.2.0")
      yield* Deferred.succeed(go, undefined)
      const { phases, error } = yield* jobFails(queue)
      assert.deepStrictEqual(phases, ["downloading", "verifying", "installing", "restarting", "failed"])
      assert.isTrue(error.endsWith(`0.2.0/huntaway: ${NOT_SUPERVISED}`), error)
      assert.strictEqual(fake.downloads, 1, "the job didn't start another")
      const restarts = Context.get(h.context, Restarts)
      const log = (yield* restarts.current)?.log ?? ""
      assert.isTrue(log.includes("Downloading 0.2.0") && log.includes("Checking its sha256"), log)
    }),
  )

  live("update_downloads_first_when_the_background_download_failed", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"), "cut")]
      const h = yield* host(fake)
      assert.strictEqual((yield* checkAndWait(h)).phase, "failed")
      const queue = yield* events(h)
      yield* h.releases.update("0.2.0")
      let job = yield* jobFails(queue)
      assert.deepStrictEqual(job.phases, ["downloading", "failed"])
      assert.include(job.error, "cut off")
      for (const file of fake.files.values()) file.serve = "whole"
      yield* h.releases.update("v0.2.0")
      job = yield* jobFails(queue)
      assert.deepStrictEqual(job.phases, ["downloading", "verifying", "installing", "restarting", "failed"])
      assert.strictEqual(fake.downloads, 3)
      assert.strictEqual((yield* state(h)).staged, "0.2.0")
    }),
  )

  live("update_refuses_what_it_cant_update_to", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      // Before a check, nothing is known.
      assert.strictEqual((yield* Effect.flip(h.releases.update("0.2.0")))._tag, "Invalid")
      yield* checkAndWait(h)
      for (const [v, why] of [
        ["0.1.0", "isn't older"],
        ["0.0.1", "isn't older"],
        ["0.9.0", "isn't the latest"],
        ["nope", "isn't a version"],
      ] as const) {
        const e = yield* Effect.flip(h.releases.update(v))
        assert.include(e._tag === "Invalid" ? e.reason : e._tag, why, v)
      }
    }),
  )

  live("a_hubs_update_checks_for_its_version_and_restarts_onto_it", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      const queue = yield* events(h)
      // No check yet, so 0.2.0 isn't known: the hub's Update checks first.
      assert.deepStrictEqual(yield* h.releases.updateFromHub("0.2.0"), { ok: true, version: "0.2.0" })
      const { phases, error } = yield* jobFails(queue)
      assert.isTrue(phases.includes("restarting"), String(phases))
      assert.isTrue(error.endsWith(`0.2.0/huntaway: ${NOT_SUPERVISED}`), error)
    }),
  )

  live("a_hubs_update_refuses_what_a_release_host_cant_go_to", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.3.0", tarball("0.3.0")), release("v0.2.0")]
      const h = yield* host(fake)
      // The same version is up to date, without a check.
      assert.deepStrictEqual(yield* h.releases.updateFromHub("0.1.0"), { ok: true, up_to_date: true })
      assert.isNull((yield* status(h)).checked_at)
      for (const [v, why] of [
        ["0.0.9", "newer than the board's 0.0.9"],
        ["nope", "isn't a version"],
        // A newer release than the hub's is out: this host doesn't go to the older one.
        ["0.2.0", "the latest release is 0.3.0"],
      ] as const) {
        const e = yield* Effect.flip(h.releases.updateFromHub(v))
        assert.include(e._tag === "Invalid" ? e.reason : e._tag, why, v)
      }
      const restarts = Context.get(h.context, Restarts)
      assert.isNull(yield* restarts.current, "nothing restarted")
    }),
  )

  live("an_update_that_cant_back_up_the_database_doesnt_go_ahead", () =>
    Effect.gen(function* () {
      const fake = fakeOf()
      fake.releases = [served(fake, "v0.2.0", tarball("0.2.0"))]
      const h = yield* host(fake)
      yield* checkAndWait(h)
      // Where backups go is a file, so none can be made.
      writeFileSync(`${h.dir}/backups`, "")
      const queue = yield* events(h)
      yield* h.releases.update("0.2.0")
      const { phases, error } = yield* jobFails(queue)
      assert.deepStrictEqual(phases, ["failed"])
      assert.isTrue(error.startsWith("couldn't back up the database before switching to 0.2.0, so it didn't go ahead: "), error)
      const s = yield* state(h)
      assert.deepStrictEqual([s.trying, s.staged, s.current], [null, "0.2.0", null])
    }),
  )
})

/**
 * A host whose server is `app/<running>/huntaway` in its data folder, with these versions in `app/` and `initial` as
 * its state.json, before it starts (its startup settles, as a server's does).
 */
const hostAt = (
  config: Partial<ServerConfigShape>,
  running: string,
  versions: ReadonlyArray<string>,
  initial: Partial<Installed>,
  prepare?: (app: string) => void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.realPath(yield* tempDir)
    for (const v of [...versions, running]) serverFiles(`${dir}/app/${v}`, `echo huntaway ${v}`)
    yield* writeInstalled(`${dir}/app`, { ...emptyInstalled, ...initial })
    prepare?.(`${dir}/app`)
    return yield* host(fakeOf(), { version: running, exe: `${dir}/app/${running}/huntaway`, ...config }, dir)
  })

describe("running from app/", () => {
  live("rollback_goes_back_to_the_previous_version", () =>
    Effect.gen(function* () {
      const h = yield* hostAt({}, "0.2.0", ["0.1.5"], { current: "0.2.0", previous: "0.1.5" })
      const r = yield* status(h)
      assert.deepStrictEqual([r.exe, r.rollback_to, r.previous], [`${h.app}/0.2.0/huntaway`, "0.1.5", "0.1.5"])
      const queue = yield* events(h)
      yield* h.releases.rollback
      const { phases, error } = yield* jobFails(queue)
      assert.deepStrictEqual(phases, ["restarting", "failed"])
      assert.strictEqual(error, `failed to exec ${h.app}/0.1.5/huntaway: ${NOT_SUPERVISED}`)
      const [exec] = yield* Ref.get(h.execs)
      assert.deepStrictEqual([exec?.state.current, exec?.state.previous, exec?.state.bad], ["0.1.5", null, ["0.2.0"]])
      // The exec failed, so it is as it was.
      const after = yield* state(h)
      assert.deepStrictEqual([after.current, after.previous, after.bad], ["0.2.0", "0.1.5", []])
    }),
  )

  live("a_rollback_that_cant_back_up_the_database_doesnt_go_ahead", () =>
    Effect.gen(function* () {
      const h = yield* hostAt({}, "0.2.0", ["0.1.5"], { current: "0.2.0", previous: "0.1.5" })
      rmSync(`${h.dir}/backups`, { recursive: true, force: true })
      writeFileSync(`${h.dir}/backups`, "")
      const queue = yield* events(h)
      yield* h.releases.rollback
      const { phases, error } = yield* jobFails(queue)
      assert.deepStrictEqual(phases, ["failed"])
      assert.isTrue(error.startsWith("couldn't back up the database before switching to 0.1.5"), error)
      assert.deepStrictEqual((yield* state(h)).current, "0.2.0")
    }),
  )

  live("rollback_without_a_previous_version_starts_the_bundled_server", () =>
    Effect.gen(function* () {
      const bundled = `${yield* tempDir}/huntaway`
      writeFileSync(bundled, "")
      // A previous version missing its files doesn't count.
      let h = yield* hostAt({ bundledServer: bundled }, "0.2.0", [], { current: "0.2.0", previous: "0.1.5" })
      assert.strictEqual((yield* status(h)).rollback_to, "bundled")
      const queue = yield* events(h)
      yield* h.releases.rollback
      assert.strictEqual((yield* jobFails(queue)).error, `failed to exec ${bundled}: ${NOT_SUPERVISED}`)
      const [exec] = yield* Ref.get(h.execs)
      assert.deepStrictEqual([exec?.state.current, exec?.state.bad], [null, ["0.2.0"]])
      // Without a bundled server either, there's nothing to roll back to.
      h = yield* hostAt({ bundledServer: null }, "0.2.0", [], { current: "0.2.0" })
      assert.isNull((yield* status(h)).rollback_to)
      assert.strictEqual((yield* Effect.flip(h.releases.rollback))._tag, "Unavailable")
      // Nor for a server that isn't running from app/.
      const other = yield* host(fakeOf(), { bundledServer: bundled })
      assert.strictEqual((yield* Effect.flip(other.releases.rollback))._tag, "Unavailable")
    }),
  )

  live("rollback_doesnt_go_back_past_the_apps_own_server", () =>
    Effect.gen(function* () {
      const bundled = `${yield* tempDir}/huntaway`
      writeFileSync(bundled, "")
      // state.json says 0.2.0 was before 0.5.0, but the app is 0.4.0: it starts its own server over 0.2.0.
      const config = { desktopVersion: "0.4.0", bundledServer: bundled }
      let h = yield* hostAt(config, "0.5.0", ["0.2.0"], { current: "0.5.0", previous: "0.2.0" })
      assert.strictEqual((yield* status(h)).rollback_to, "bundled")
      // One at least as new as the app's still counts.
      h = yield* hostAt(config, "0.5.0", ["0.4.5"], { current: "0.5.0", previous: "0.4.5" })
      assert.strictEqual((yield* status(h)).rollback_to, "0.4.5")
    }),
  )

  live("settling_makes_it_current_and_prunes_app", () =>
    Effect.gen(function* () {
      const h = yield* hostAt({}, "0.2.0", ["0.1.0", "0.1.5", "0.3.0"], {}, (app) => {
        mkdirSync(`${app}/0.4.0.partial`)
        writeFileSync(`${app}/state.json.123.tmp`, "{")
        writeFileSync(`${app}/notes.txt`, "the desktop app's")
        // An Update from 0.1.0 onto 0.2.0, with a key the desktop app wrote.
        writeFileSync(`${app}/state.json`, '{"current":"0.1.0","previous":"0.1.5","staged":"0.2.0","trying":"0.2.0","bad":["0.0.9"],"shell":{"x":1}}')
      })
      // It settled as it started; settling again changes nothing.
      assert.strictEqual(yield* h.releases.settle, "0.2.0")
      const s = yield* state(h)
      assert.deepStrictEqual([s.current, s.previous, s.staged, s.trying, s.bad, s.other], ["0.2.0", "0.1.0", null, null, ["0.0.9"], { shell: { x: 1 } }])
      assert.deepStrictEqual(yield* entries(h), ["0.1.0", "0.2.0", "notes.txt", "state.json"])
    }),
  )

  live("a_server_not_running_from_app_leaves_it_alone_but_forgets_older_versions", () =>
    Effect.gen(function* () {
      const h = yield* host(fakeOf(), { version: "0.1.0" })
      serverFiles(`${h.app}/0.0.5`, "true")
      mkdirSync(`${h.app}/0.3.0.partial`)
      yield* write(h, { current: "0.0.5", previous: "0.0.1", bad: ["0.0.3"] })
      assert.isNull(yield* h.releases.settle)
      const s = yield* state(h)
      assert.deepStrictEqual([s.current, s.previous, s.bad], [null, null, ["0.0.3"]])
      assert.deepStrictEqual(yield* entries(h), ["0.0.5", "0.3.0.partial", "state.json"])
    }),
  )
})
