import { Clock, Context, DateTime, Effect, FiberSet, FileSystem, Layer, Option, Ref, Schedule, Schema, Semaphore, Sink, Stream, SubscriptionRef } from "effect"
import { Digest } from "effect/crypto"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { Conflict } from "@huntaway/contracts"
import type { ReleaseDownload, ReleaseStatus, RestartPhase, UpdateResult } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Events } from "../platform/Events.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { complete, readInstalled, runningFromApp, versionDir, writeInstalled } from "./releases/appDir.ts"
import { assetJson, GhMessage, GhReleases, Manifest, offered, pick, rateLimit, shellStatus, statusText, tagVersion, toAsset } from "./releases/github.ts"
import type { Asset, GhAsset, GhRelease, Latest } from "./releases/github.ts"
import { chooseAtStartup, isBad, notRolledBack, rolledBack, sameInstalled, settled, superseded, toPrune } from "./releases/installed.ts"
import type { Installed } from "./releases/installed.ts"
import { compare, olderThan, parseLoose, parseVersion, versionString } from "./releases/semver.ts"
import { checkEntries, checkTypes, printsVersion } from "./releases/tarball.ts"
import { JobFailed, Restarts } from "./Restarts.ts"
import { quoted, Supervisor } from "./Supervisor.ts"

// Updates for release installs (docs/plan/inventory/05-hosts-update.md, 2.6 and section 9; the old release.ts and
// staging.ts): with `--release-updates OWNER/REPO`, check that repository's GitHub releases, download the newest this
// server could run into `<data dir>/app/<v>/` in the background (sha256, the tarball's safety rules, a smoke test),
// restart onto it on Update, settle it as current once it is up, and roll back. `app/state.json` is shared with the
// desktop shell.

const FIRST_CHECK = "30 seconds"
const CHECK_EVERY = "6 hours"
const REQUEST_TIMEOUT = "30 seconds"
/** How long a download may go without a byte before it is given up on. */
const STALLED = "60 seconds"
/** A download's progress event goes at most this often. */
const PROGRESS_EVERY_MS = 500
const TAR_TIMEOUT = "300 seconds"
const SMOKE_TIMEOUT = "30 seconds"

const OFF = "this server doesn't update from releases (start it with --release-updates OWNER/REPO)"

/** What the checks found. The list is kept with its ETag, so a 304 can be picked from again. */
interface Checked {
  readonly etag: string | null
  readonly releases: ReadonlyArray<GhRelease> | null
  readonly latest: Latest | null
  readonly checkedAt: string | null
  readonly error: string | null
  readonly rateLimitReset: string | null
}

const NOT_CHECKED: Checked = { etag: null, releases: null, latest: null, checkedAt: null, error: null, rateLimitReset: null }

/** The download in progress, or the last one: `staged` once it's done (reported as no download). */
interface Download extends Omit<ReleaseDownload, "phase"> {
  readonly phase: ReleaseDownload["phase"] | "staged"
}

const downloading = (d: Download | null): boolean => d !== null && (d.phase === "downloading" || d.phase === "verifying" || d.phase === "installing")

const reported = (d: Download | null): ReleaseDownload | null => (d === null || d.phase === "staged" ? null : { ...d, phase: d.phase })

/** The restart job's phase while it follows a download. */
const restartPhaseOf = (phase: Download["phase"]): RestartPhase => (phase === "verifying" || phase === "installing" ? phase : "downloading")

/** A check that failed:why, and when GitHub's rate limit resets if it was that. */
class CheckFailed extends Schema.TaggedError<CheckFailed, { readonly brand: unique symbol }>()("CheckFailed", {
  reason: Schema.String,
  rateLimitReset: Schema.NullOr(Schema.String),
}) {}

const checkFailed = (reason: string, rateLimitReset: string | null = null) => new CheckFailed({ reason, rateLimitReset })

const lowerHeaders = (res: HttpClientResponse.HttpClientResponse): Readonly<Record<string, string | undefined>> => res.headers

/** The error for a response that isn't what was asked for: the rate limit, or GitHub's message. */
const refused = (res: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const limited = rateLimit(res.status, lowerHeaders(res))
    if (limited !== null) {
      return checkFailed(
        limited.reset === null
          ? "GitHub's rate limit for release checks is used up"
          : `GitHub's rate limit for release checks is used up until ${limited.reset}`,
        limited.reset,
      )
    }
    const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""))
    const body = yield* Schema.decodeEffect(GhMessage)(text).pipe(Effect.option)
    return checkFailed(Option.isSome(body) ? `GitHub answered ${statusText(res.status)}: ${body.value.message}` : `GitHub answered ${statusText(res.status)}`)
  })

export interface ReleasesShape {
  /** `admin.status`'s `release`, with release updates on. */
  readonly status: Effect.Effect<ReleaseStatus | null>
  /** Ask GitHub now, then download the newest release in the background. A failed check keeps the last result. */
  readonly check: Effect.Effect<void, Unavailable>
  /** Restart onto `version` (a restart job): at once if staged, after its download otherwise. */
  readonly update: (version: string) => Effect.Effect<void, Invalid | Unavailable | Conflict>
  /** A hub's Update for a release install: restart onto the release the hub runs. */
  readonly updateFromHub: (version: string) => Effect.Effect<UpdateResult, Invalid | Unavailable | Conflict>
  /** Mark the running release bad and restart onto the one before it (or the bundled server). */
  readonly rollback: Effect.Effect<void, Unavailable | Conflict>
  /** Startup step 5: a server running from `app/<v>` makes `v` current and prunes `app/`. The version, if it runs from there. */
  readonly settle: Effect.Effect<string | null>
}

export class Releases extends Context.Service<Releases, ReleasesShape>()("huntaway-server/update/Releases") {
  static readonly layer = Layer.effect(
    Releases,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const proc = yield* Proc
      const events = yield* Events
      const settings = yield* HostSettings
      const restarts = yield* Restarts
      const digest = yield* Digest.Digest
      const app = dataDir.file("app")
      const repo = config.releaseRepo
      const running = parseVersion(config.version) ?? { major: 0, minor: 0, patch: 0, pre: [], build: "" }
      const exe = config.exe
      const last = yield* Ref.make<Checked>(NOT_CHECKED)
      const checking = yield* Semaphore.make(1)
      const staging = yield* Semaphore.make(1)
      /** `app/state.json` is changed one change at a time in this server. */
      const stateLock = yield* Semaphore.make(1)
      /** The download, numbered so a waiter can wait for the next change. */
      const download = yield* SubscriptionRef.make<{ readonly d: Download | null; readonly n: number }>({ d: null, n: 0 })
      const background = yield* FiberSet.make()
      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

      const read = readInstalled(app).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      const isComplete = (dir: string) => complete(dir).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      const fromApp = runningFromApp(app, exe).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      /** Change `app/state.json`; returns it as it was and as it is. */
      const change = (f: (s: Installed) => Installed) =>
        Semaphore.withPermits(
          stateLock,
          1,
        )(
          Effect.gen(function* () {
            const old = yield* read
            const next = f(old)
            if (!sameInstalled(next, old)) {
              yield* writeInstalled(app, next).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.mapError((e) => new JobFailed({ reason: `writing ${app}/state.json: ${e.message}` })),
              )
            }
            return [old, next] as const
          }),
        )
      const removeDir = (dir: string) =>
        fs.remove(dir, { recursive: true, force: true }).pipe(Effect.catch((e) => Effect.logWarning(`removing ${dir}: ${e.message}`)))

      /** The staged version, if it has all its files and isn't bad. */
      const stagedOf = (s: Installed) =>
        Effect.gen(function* () {
          const v = s.staged
          if (v === null || isBad(s, v)) return null
          const dir = versionDir(app, v)
          return dir !== null && (yield* isComplete(dir)) ? v : null
        })
      const isStaged = (v: string) => Effect.flatMap(read, stagedOf).pipe(Effect.map((s) => s === v))

      const prereleases = Effect.map(settings.get, (s) => s.release_prereleases)

      // ---------- checks ----------

      const request = (url: string, headers: Record<string, string> = {}) =>
        http.execute(HttpClientRequest.get(url, { headers: { "user-agent": `huntaway/${config.version}`, ...headers } })).pipe(
          Effect.mapError((e) => checkFailed(`asking ${url}: ${e.message}`)),
          Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(checkFailed(`asking ${url}: timed out`)) }),
        )

      const readManifest = (asset: GhAsset) =>
        Effect.gen(function* () {
          const res = yield* request(asset.browser_download_url)
          if (res.status < 200 || res.status >= 300) return yield* yield* refused(res)
          const text = yield* res.text.pipe(Effect.mapError((e) => checkFailed(e.message)))
          return yield* Schema.decodeEffect(Manifest)(text).pipe(Effect.mapError((e) => checkFailed(e.message)))
        })

      /** The list (asked for again, or the last one on a 304) and the release picked from it. */
      const checkWith = (from: Checked) =>
        Effect.gen(function* () {
          if (repo === null) return yield* checkFailed(OFF)
          const pre = yield* prereleases
          const bad = (yield* read).bad
          const url = `${config.releaseApi}/repos/${repo}/releases?per_page=20`
          const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
          // Only with the list it goes with: a 304 means "the list you have".
          if (from.etag !== null && from.releases !== null) headers["if-none-match"] = from.etag
          const res = yield* request(url, headers)
          let etag: string | null
          let releases: ReadonlyArray<GhRelease>
          if (res.status === 304) {
            if (from.releases === null) return yield* checkFailed("GitHub said the releases hadn't changed, but there's no earlier list")
            etag = from.etag
            releases = from.releases
          } else if (res.status >= 200 && res.status < 300) {
            etag = lowerHeaders(res)["etag"] ?? null
            const text = yield* res.text.pipe(Effect.mapError((e) => checkFailed(`reading the releases: ${e.message}`)))
            releases = yield* Schema.decodeEffect(GhReleases)(text).pipe(Effect.mapError((e) => checkFailed(`reading the releases: ${e.message}`)))
          } else {
            return yield* yield* refused(res)
          }
          const picked = pick(releases, config.platform, pre, bad)
          if (picked === null) return { etag, releases, latest: null }
          // The manifest only changes with the release, so one read before is kept.
          const name = `huntaway-${tagVersion(picked.release.tag_name)}-release.json`
          const manifestAsset = (picked.release.assets ?? []).find((a) => a.name === name)
          const before = from.latest
          const kept =
            before !== null && compare(before.version, picked.version) === 0 && before.release.tag_name === picked.release.tag_name ? before.manifest : null
          const manifest =
            manifestAsset === undefined
              ? null
              : (kept ?? (yield* readManifest(manifestAsset).pipe(Effect.mapError((e) => checkFailed(`reading ${name}: ${e.reason}`, e.rateLimitReset)))))
          return { etag, releases, latest: { ...picked, manifest } }
        })

      /** The versions the last check would offer under the settings as they are now; none until a check has succeeded. */
      const offeredNow = Effect.gen(function* () {
        const checked = yield* Ref.get(last)
        if (repo === null || checked.checkedAt === null || checked.error !== null) return null
        const pre = yield* prereleases
        const bad = (yield* read).bad
        return offered(checked.releases ?? [], config.platform, pre, bad).map((o) => o.version)
      })

      /** Unstage a staged version the last check no longer offers (prereleases turned off, the release taken down). */
      const unstageUnpicked = Effect.gen(function* () {
        const still = yield* offeredNow
        if (still === null) return
        const [old, next] = yield* change((s) => {
          const v = s.staged
          if (v === null) return s
          const sv = parseVersion(v)
          return sv !== null && still.some((o) => compare(o, sv) === 0) ? s : { ...s, staged: null }
        })
        const v = old.staged
        if (v === null || next.staged !== null) return
        yield* Effect.logInfo(`unstaging release ${v}, which the last check didn't offer`)
        const dir = versionDir(app, v)
        if (dir !== null && ![next.current, next.previous, next.trying].includes(v)) yield* removeDir(dir)
      }).pipe(Effect.catch((e) => Effect.logWarning(`unstaging a release: ${e.reason}`)))

      /** An error if a check since has withdrawn `v`. */
      const stillOffered = (v: string) =>
        Effect.gen(function* () {
          const version = parseVersion(v)
          if (version === null) return yield* new JobFailed({ reason: `${quoted(v)} isn't a version` })
          const offers = yield* offeredNow
          if (offers !== null && !offers.some((o) => compare(o, version) === 0)) {
            return yield* new JobFailed({ reason: `${v} isn't offered any more (prereleases were turned off, or the release was taken down)` })
          }
          return yield* Effect.void
        })

      // ---------- downloads ----------

      const setDownload = (f: (d: Download | null) => Download | null) =>
        SubscriptionRef.updateAndGet(download, ({ d, n }) => ({ d: f(d), n: n + 1 })).pipe(
          Effect.flatMap(({ d }) => events.emit({ type: "release_download", download: reported(d) })),
        )
      const setPhase = (phase: Download["phase"], error: string | null = null) => setDownload((d) => (d === null ? d : { ...d, phase, error }))

      /** Stream `asset` to `file`. Returns its sha256 (hex). */
      const fetchTo = (asset: Asset, file: string) =>
        Effect.gen(function* () {
          const res = yield* http.execute(HttpClientRequest.get(asset.url, { headers: { "user-agent": `huntaway/${config.version}` } })).pipe(
            Effect.mapError((e) => new JobFailed({ reason: e.message })),
            Effect.timeoutOrElse({ duration: STALLED, orElse: () => Effect.fail(new JobFailed({ reason: "no answer" })) }),
          )
          if (res.status < 200 || res.status >= 300) return yield* new JobFailed({ reason: `${asset.url} answered ${statusText(res.status)}` })
          const length = lowerHeaders(res)["content-length"]
          const total = length !== undefined && /^\d+$/.test(length) ? Number(length) : asset.size > 0 ? asset.size : null
          yield* setDownload((d) => (d === null ? d : { ...d, total }))
          const bytes = yield* Ref.make(0)
          const emitted = yield* Ref.make(yield* Clock.currentTimeMillis)
          const cutOff = Effect.flatMap(Ref.get(bytes), (n) => Effect.fail(new JobFailed({ reason: `it was cut off at ${n} bytes` })))
          yield* res.stream.pipe(
            Stream.mapError(() => new JobFailed({ reason: "" })),
            Stream.catch(() => Stream.fromEffect(cutOff)),
            Stream.timeoutOrElse({
              duration: STALLED,
              orElse: () => Stream.fromEffect(Effect.flatMap(Ref.get(bytes), (n) => Effect.fail(new JobFailed({ reason: `it stalled at ${n} bytes` })))),
            }),
            Stream.tap((chunk) =>
              Effect.gen(function* () {
                const n = yield* Ref.updateAndGet(bytes, (b) => b + chunk.length)
                const at = yield* Clock.currentTimeMillis
                const before = yield* Ref.get(emitted)
                if (at - before > PROGRESS_EVERY_MS) {
                  yield* Ref.set(emitted, at)
                  yield* setDownload((d) => (d === null ? d : { ...d, bytes: n }))
                } else {
                  yield* SubscriptionRef.update(download, ({ d, n: k }) => ({ d: d === null ? d : { ...d, bytes: n }, n: k }))
                }
              }),
            ),
            Stream.run(fs.sink(file).pipe(Sink.mapError((e) => new JobFailed({ reason: `writing ${file}: ${e.message}` })))),
          )
          const got = yield* Ref.get(bytes)
          if (total !== null && total !== got) return yield* new JobFailed({ reason: `it was cut off at ${got} of ${total} bytes` })
          const data = yield* fs.readFile(file).pipe(Effect.mapError((e) => new JobFailed({ reason: e.message })))
          return yield* digest.digestHex(Digest.sha256, data)
        })

      const tar = (args: ReadonlyArray<string>) =>
        proc.run("tar", args, { timeout: TAR_TIMEOUT }).pipe(
          Effect.mapError((e) => new JobFailed({ reason: e.reason })),
          Effect.flatMap((r) =>
            r.code === 0 ? Effect.succeed(r.stdout) : Effect.fail(new JobFailed({ reason: `tar ${args[0]} failed: ${r.stderr.trim()}` })),
          ),
        )

      /** `huntaway --version` must succeed and print `version`. */
      const smokeTest = (bin: string, version: string) =>
        Effect.gen(function* () {
          const r = yield* proc
            .run(bin, ["--version"], { timeout: SMOKE_TIMEOUT, stdin: "" })
            .pipe(Effect.mapError((e) => new JobFailed({ reason: `running ${bin} --version: ${e.reason}` })))
          if (r.code !== 0) return yield* new JobFailed({ reason: `huntaway --version failed with exit status: ${r.code}: ${r.stderr.trim()}` })
          if (!printsVersion(r.stdout, version))
            return yield* new JobFailed({ reason: `huntaway --version printed ${quoted(r.stdout.trim())}, not ${version}` })
          return yield* Effect.void
        })

      const stageInto = (partial: string, version: string, asset: Asset) =>
        Effect.gen(function* () {
          const dest = versionDir(app, version)
          if (dest === null) return yield* new JobFailed({ reason: `${quoted(version)} isn't a version` })
          if ((yield* fromApp) === version) return yield* new JobFailed({ reason: `${version} is the version running` })
          // There's one download at a time, so any other `.partial` is one a restart cut off.
          const entries = yield* fs.readDirectory(app).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          yield* Effect.forEach(
            entries.filter((e) => e.endsWith(".partial")),
            (e) => removeDir(`${app}/${e}`),
            { concurrency: 1, discard: true },
          )
          yield* fs.makeDirectory(partial, { recursive: true }).pipe(Effect.mapError((e) => new JobFailed({ reason: `making ${partial}: ${e.message}` })))
          const tarball = `${partial}/download.tar.gz`
          const sha256 = yield* fetchTo(asset, tarball).pipe(Effect.mapError((e) => new JobFailed({ reason: `downloading ${asset.name}: ${e.reason}` })))
          yield* setPhase("verifying")
          if (sha256.toLowerCase() !== asset.sha256.toLowerCase()) {
            return yield* new JobFailed({ reason: `${asset.name} has sha256 ${sha256}, not the ${asset.sha256} GitHub lists for it` })
          }
          const why = checkEntries(yield* tar(["-tzf", tarball])) ?? checkTypes(yield* tar(["-tvzf", tarball]))
          if (why !== null) return yield* new JobFailed({ reason: `${asset.name} can't be unpacked: ${why}` })
          yield* setPhase("installing")
          yield* tar(["-xzf", tarball, "-C", partial, "--strip-components=1", "--no-same-owner"])
          yield* fs.remove(tarball).pipe(Effect.ignore)
          if (!(yield* isComplete(partial))) return yield* new JobFailed({ reason: `${asset.name} doesn't have huntaway, ia-shim and ui/index.html` })
          yield* smokeTest(`${partial}/huntaway`, version)
          // The folder and `staged` change under the state's lock, so a version that's staged is always there.
          const [old, next] = yield* Semaphore.withPermits(
            stateLock,
            1,
          )(
            Effect.gen(function* () {
              yield* fs.remove(dest, { recursive: true, force: true })
              yield* fs.rename(partial, dest)
              const s = yield* read
              const staged = { ...s, staged: version }
              yield* writeInstalled(app, staged).pipe(Effect.provideService(FileSystem.FileSystem, fs))
              return [s, staged] as const
            }).pipe(Effect.mapError((e) => new JobFailed({ reason: `staging ${dest}: ${e.message}` }))),
          )
          // A newer release replaces one that was never used.
          const replaced = old.staged
          if (replaced !== null && replaced !== version && ![next.current, next.previous, next.trying].includes(replaced)) {
            const dir = versionDir(app, replaced)
            if (dir !== null) {
              yield* Effect.logInfo(`removing ${dir}, which ${version} replaces`)
              yield* removeDir(dir)
            }
          }
          return yield* Effect.logInfo(`release ${version} is staged`)
        })

      /** Download, check and unpack `version` in the background, then stage it, unless a download runs already. */
      const startDownload = (version: string, asset: Asset) =>
        Effect.gen(function* () {
          if (!(yield* Semaphore.takeIfAvailable(staging, 1))) return "Busy" as const
          if (yield* isStaged(version)) {
            yield* Semaphore.release(staging, 1)
            return "Staged" as const
          }
          yield* setDownload(() => ({ version, phase: "downloading", bytes: 0, total: asset.size > 0 ? asset.size : null, error: null }))
          const partial = `${app}/${version}.partial`
          yield* FiberSet.run(
            background,
            stageInto(partial, version, asset).pipe(
              Effect.matchEffect({
                onSuccess: () => setPhase("staged"),
                onFailure: (e) =>
                  Effect.logWarning(`staging release ${version}: ${e.reason}`).pipe(
                    Effect.andThen(removeDir(partial)),
                    Effect.andThen(setPhase("failed", e.reason)),
                  ),
              }),
              Effect.ensuring(Semaphore.release(staging, 1)),
              Effect.andThen(downloaded(version)),
            ),
          )
          return "Started" as const
        })

      /** Download the latest release, if it is newer than this server and not staged yet. */
      const stageLatest: Effect.Effect<void> = Effect.gen(function* () {
        const latest = (yield* Ref.get(last)).latest
        if (latest === null || compare(latest.version, running) <= 0) return
        const asset = toAsset(latest.asset)
        if (asset === null) return
        const version = versionString(latest.version)
        if ((yield* startDownload(version, asset)) === "Started") yield* Effect.logInfo(`downloading release ${version}`)
      })

      /** After a download of `version`: a check meanwhile may have stopped picking it, or found a newer one. */
      const downloaded = (version: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* unstageUnpicked
          const latest = (yield* Ref.get(last)).latest
          if (latest !== null && versionString(latest.version) !== version) yield* stageLatest
        })

      const check = Semaphore.withPermits(
        checking,
        1,
      )(
        Effect.gen(function* () {
          const from = yield* Ref.get(last)
          const checkedAt = yield* now
          const result = yield* Effect.result(checkWith(from))
          const next: Checked =
            result._tag === "Success"
              ? { ...result.success, checkedAt, error: null, rateLimitReset: null }
              : { ...from, checkedAt, error: result.failure.reason, rateLimitReset: result.failure.rateLimitReset }
          if (result._tag === "Failure") yield* Effect.logWarning(`checking ${repo} for releases: ${result.failure.reason}`)
          yield* Ref.set(last, next)
          yield* unstageUnpicked
          yield* events.emit({ type: "release_checked" })
          yield* stageLatest
        }),
      )

      // ---------- Update and Roll back ----------

      /** Room for the backup the next server makes before it migrates, or the switch doesn't go ahead. */
      const beforeSwitch = (to: string | null) =>
        Effect.gen(function* () {
          const target = to ?? "unknown"
          const why = yield* Effect.gen(function* () {
            yield* fs.makeDirectory(dataDir.backups, { recursive: true, mode: 0o700 }).pipe(Effect.mapError((e) => e.message))
            const size = yield* fs.stat(dataDir.database).pipe(
              Effect.map((i) => Number(i.size)),
              Effect.orElseSucceed(() => 0),
            )
            const df = yield* proc.run("df", ["-Pk", dataDir.backups], { timeout: "10 seconds" }).pipe(Effect.option)
            const free = Option.isSome(df) && df.value.code === 0 ? Number(df.value.stdout.trim().split("\n")[1]?.trim().split(/\s+/)[3]) * 1024 : Number.NaN
            if (Number.isFinite(free) && free < size)
              return yield* Effect.fail(`not enough room in ${dataDir.backups} for a copy of the database (${size} bytes)`)
            return yield* Effect.void
          }).pipe(Effect.flip, Effect.option)
          if (Option.isNone(why)) return yield* Effect.void
          if (config.skipDbBackup)
            return yield* Effect.logWarning(`couldn't make room for a backup before switching to ${target}, going on (--skip-db-backup): ${why.value}`)
          return yield* new JobFailed({
            reason: `couldn't back up the database before switching to ${target}, so it didn't go ahead: ${why.value}; start with --skip-db-backup to go on without one`,
          })
        })

      /** What an Update adds for the version it execs: a tarball's server passes itself, so Roll back can come back to it. */
      const bundledEnv = Effect.gen(function* () {
        if (repo === null || config.bundledServer !== null || exe === null || (yield* fromApp) !== null) return []
        return [["HUNTAWAY_BUNDLED_SERVER", exe] as const]
      })

      /** Set `trying` and exec `app/<v>/huntaway`; when that fails, `trying` is put back. */
      const restartOnto = (v: string) =>
        Effect.gen(function* () {
          const dir = versionDir(app, v)
          if (dir === null) return yield* new JobFailed({ reason: "not a version" })
          yield* beforeSwitch(v)
          const [old] = yield* change((s) => ({ ...s, trying: v }))
          const failed = yield* Effect.flip(restarts.restartInto(`${dir}/huntaway`, yield* bundledEnv))
          yield* change((s) => (s.trying === v ? { ...s, trying: old.trying } : s))
          return yield* failed
        })

      /** Until `v` is staged: follow its download (starting one if none runs) in the job's phases and log. */
      const waitForStaging = (v: string, asset: Asset | null) =>
        Effect.gen(function* () {
          let started = false
          let logged: readonly [string, number] | null = null
          for (;;) {
            if (yield* isStaged(v)) return yield* Effect.void
            const { d, n: seen } = yield* SubscriptionRef.get(download)
            const ours = d !== null && d.version === v ? d : null
            if (ours !== null && downloading(ours)) {
              const tenth = ours.total !== null && ours.total > 0 ? Math.floor((ours.bytes * 10) / ours.total) : 0
              if (logged === null || logged[0] !== ours.phase) {
                yield* restarts.phase(restartPhaseOf(ours.phase))
                yield* restarts.log(
                  ours.phase === "downloading"
                    ? `Downloading ${v}${ours.total === null ? "" : ` (${(ours.total / 1e6).toFixed(1)} MB)`}`
                    : ours.phase === "verifying"
                      ? "Checking its sha256 and what it holds"
                      : `Unpacking it into ${app}/${v}, and checking that it runs`,
                )
              } else if (logged[1] !== tenth && ours.total !== null) {
                yield* restarts.log(`${tenth}0% (${(ours.bytes / 1e6).toFixed(1)} MB of ${(ours.total / 1e6).toFixed(1)} MB)`)
              }
              logged = [ours.phase, tenth]
              yield* SubscriptionRef.changes(download).pipe(
                Stream.filter((x) => x.n > seen),
                Stream.runHead,
              )
              continue
            }
            if (ours !== null && started) return yield* new JobFailed({ reason: ours.error ?? `${v} wasn't staged` })
            // Its download finished but was unstaged, or it's about to be downloaded again: only while it's still offered.
            yield* stillOffered(v)
            if (asset === null) return yield* new JobFailed({ reason: `${v} isn't staged any more; check for releases again` })
            const r = yield* startDownload(v, asset)
            if (r === "Started") started = true
            else if (r === "Staged") return yield* Effect.void
            else {
              const other = (yield* SubscriptionRef.get(download)).d
              if (other === null || !downloading(other) || other.version !== v) {
                if (other !== null && downloading(other)) yield* restarts.log(`Waiting for the download of ${other.version} to finish`)
                yield* Semaphore.withPermits(staging, 1)(Effect.void)
              }
            }
          }
        })

      const off = new Unavailable({ what: "release updates", reason: OFF })

      const update = Effect.fn("Releases.update")(function* (version: string) {
        if (repo === null) return yield* off
        const parsed = parseLoose(version)
        if (parsed === null) return yield* new Invalid({ field: "version", reason: `${quoted(version)} isn't a version` })
        if (compare(parsed, running) <= 0) {
          return yield* new Invalid({ field: "version", reason: `this server runs ${config.version}, which isn't older than ${versionString(parsed)}` })
        }
        const v = versionString(parsed)
        if (isBad(yield* read, v))
          return yield* new Invalid({ field: "version", reason: `${v} was rolled back from or didn't start, so it isn't offered again` })
        // The asset, in case it has to be downloaded: only the latest release's is known.
        const latest = (yield* Ref.get(last)).latest
        const asset = latest !== null && compare(latest.version, parsed) === 0 ? toAsset(latest.asset) : null
        if (asset === null && !(yield* isStaged(v)))
          return yield* new Invalid({ field: "version", reason: `${v} isn't the latest release; check for releases again` })
        return yield* restarts.begin(waitForStaging(v, asset).pipe(Effect.andThen(restartOnto(v))))
      })

      const updateFromHub = Effect.fn("Releases.updateFromHub")(function* (version: string) {
        const target = parseLoose(version)
        if (target === null) return yield* new Invalid({ field: "version", reason: `the board's version ${quoted(version)} isn't a version` })
        const c = compare(target, running)
        if (c === 0) return { ok: true as const, up_to_date: true }
        if (c < 0)
          return yield* new Invalid({ field: "version", reason: `this host runs ${config.version}, which is newer than the board's ${versionString(target)}` })
        const v = versionString(target)
        const latestVersion = Effect.map(Ref.get(last), (l) => l.latest?.version ?? null)
        const isLatest = (l: ReturnType<typeof parseVersion>) => l !== null && compare(l, target) === 0
        // The hub may run a release published since the last check.
        if (!isLatest(yield* latestVersion) && !(yield* isStaged(v))) {
          yield* check
          const newer = yield* latestVersion
          if (newer !== null && compare(newer, target) > 0 && !(yield* isStaged(v))) {
            return yield* new Invalid({
              field: "version",
              reason: `the latest release is ${versionString(newer)}, newer than the board's ${v}: update the board first, or this host from its own board`,
            })
          }
        }
        yield* update(v)
        return { ok: true as const, version: v }
      })

      /** What Roll back would exec, and its version (null for the bundled server). Only for a server running from `app/`. */
      const rollbackTarget = Effect.gen(function* () {
        const current = yield* fromApp
        if (current === null || repo === null) return null
        const s = yield* read
        const desktop = config.desktopVersion === null ? null : parseLoose(config.desktopVersion)
        // As the desktop app does, not back past the app's own server (a newer package's server takes over from it).
        const atLeastTheApps = (p: string) => desktop === null || !olderThan(p, desktop)
        const p = s.previous
        if (p !== null && p !== current && !isBad(s, p) && parseVersion(p) !== null && atLeastTheApps(p)) {
          const dir = versionDir(app, p)
          if (dir !== null && (yield* isComplete(dir))) return { exe: `${dir}/huntaway`, version: p }
        }
        const bundled = config.bundledServer
        if (bundled === null) return null
        const isFile = yield* fs.stat(bundled).pipe(
          Effect.map((i) => i.type === "File"),
          Effect.orElseSucceed(() => false),
        )
        return isFile ? { exe: bundled, version: null } : null
      })

      const rollback = Effect.gen(function* () {
        if (repo === null) return yield* off
        const current = yield* fromApp
        if (current === null)
          return yield* new Unavailable({ what: "rollback", reason: "this server isn't an installed release, so there's nothing to roll back" })
        if ((yield* rollbackTarget) === null) return yield* new Unavailable({ what: "rollback", reason: "there's no earlier version to roll back to" })
        return yield* restarts.begin(
          Effect.gen(function* () {
            const target = yield* rollbackTarget
            if (target === null) return yield* new JobFailed({ reason: "there's no earlier version to roll back to" })
            yield* restarts.log(`Rolling back from ${current} to ${target.version ?? "the server this host was installed as"}`)
            yield* beforeSwitch(target.version ?? (config.desktopVersion === null ? null : config.desktopVersion.trim().replace(/^v+/, "")))
            const [old] = yield* change((s) => rolledBack(s, current, target.version))
            const failed = yield* Effect.flip(restarts.restartInto(target.exe))
            // Only what the rollback changed is put back: a download may have staged a version meanwhile.
            yield* change((s) => notRolledBack(s, old, current, target.version))
            return yield* failed
          }),
        )
      }).pipe(Effect.withSpan("Releases.rollback"))

      const settle = Effect.gen(function* () {
        const v = yield* fromApp
        if (v === null) {
          // The desktop app's own server, maybe from a package newer than the versions downloaded before it.
          if (repo === null) return null
          const [old, next] = yield* change((s) => superseded(s, running))
          if (!sameInstalled(old, next))
            yield* Effect.logInfo(`this server (${config.version}) is newer than the releases installed in app/ before it; forgetting them`)
          return null
        }
        const [, next] = yield* change((s) => settled(s, v))
        yield* Effect.logInfo(`running release ${v} (previous ${next.previous ?? "none"})`)
        const entries = yield* fs.readDirectory(app).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const typed = yield* Effect.forEach(
          entries,
          (name) =>
            fs.stat(`${app}/${name}`).pipe(
              Effect.map((i) => ({ name, dir: i.type === "Directory" })),
              Effect.orElseSucceed(() => ({ name, dir: false })),
            ),
          { concurrency: 1 },
        )
        yield* Effect.forEach(toPrune(typed, next), (name) => Effect.logInfo(`removing ${app}/${name}`).pipe(Effect.andThen(removeDir(`${app}/${name}`))), {
          concurrency: 1,
          discard: true,
        })
        return v
      }).pipe(
        Effect.catch((e) => Effect.logWarning(`settling the release this server runs: ${e.reason}`).pipe(Effect.as(null))),
        Effect.withSpan("Releases.settle"),
      )

      const status = Effect.gen(function* () {
        if (repo === null) return null
        const pre = yield* prereleases
        const checked = yield* Ref.get(last)
        const s = yield* read
        const l = checked.latest
        const target = yield* rollbackTarget
        const desktop = { version: config.desktopVersion, shell: config.desktopShell, install: config.desktopInstall, platform: config.platform }
        return {
          repo,
          running: config.version,
          exe,
          latest:
            l === null
              ? null
              : {
                  version: versionString(l.version),
                  prerelease: l.release.prerelease === true,
                  published_at: l.release.published_at ?? null,
                  notes: l.release.body ?? null,
                  url: l.release.html_url ?? "",
                  asset: assetJson(l.asset),
                  newer: compare(l.version, running) > 0,
                },
          prereleases: pre,
          checked_at: checked.checkedAt,
          error: checked.error,
          rate_limit_reset: checked.rateLimitReset,
          shell: shellStatus(desktop, l),
          bundled_server: config.bundledServer,
          staged: yield* stagedOf(s),
          download: reported((yield* SubscriptionRef.get(download)).d),
          previous: s.previous,
          bad: s.bad,
          rollback_to: target === null ? null : (target.version ?? "bundled"),
        } satisfies ReleaseStatus
      })

      if (repo !== null) {
        yield* Effect.logInfo(`checking ${repo}'s GitHub releases for updates`)
        yield* check.pipe(Effect.delay(FIRST_CHECK), Effect.andThen(check.pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY)))), Effect.forkScoped)
        // "Include prereleases" changed: check again (from the last list).
        const watch = yield* events.watch(undefined)
        const seen = yield* Ref.make((yield* settings.get).release_prereleases)
        yield* watch.live.pipe(
          Stream.runForEach((event) =>
            event.type !== "settings_changed"
              ? Effect.void
              : Ref.getAndSet(seen, event.settings.release_prereleases).pipe(
                  Effect.flatMap((was) => (was === event.settings.release_prereleases ? Effect.void : FiberSet.run(background, check).pipe(Effect.asVoid))),
                ),
          ),
          Effect.forkScoped,
        )
      }

      return Releases.of({
        status,
        check: repo === null ? Effect.fail(off) : check,
        update,
        updateFromHub,
        rollback,
        settle,
      })
    }).pipe(Effect.annotateLogs({ module: "release" })),
  )

  /**
   * Startup step 1, before the identity and the database: a server with release updates that the desktop app didn't
   * start (a tarball host's, started again by its supervisor) execs the release in `app/` it last updated to, when that
   * is newer than itself, passing itself as `HUNTAWAY_BUNDLED_SERVER` so Roll back can come back to it. A `trying`
   * still set never came up and is marked bad. Returns when there's nothing to start, or the exec failed.
   */
  static readonly execInstalled = Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const supervisor = yield* Supervisor
      if (config.releaseRepo === null || config.desktopVersion !== null || supervisor.pid === null || config.exe === null) return
      const app = dataDir.file("app")
      if ((yield* runningFromApp(app, config.exe)) !== null) return
      const running = parseVersion(config.version)
      if (running === null) return
      const old = yield* readInstalled(app)
      const completeness = yield* Effect.forEach(
        [old.current, old.previous, old.trying],
        (v) => (v === null ? Effect.succeed(false) : complete(`${app}/${v}`)),
        {
          concurrency: 1,
        },
      )
      const ok = new Set([old.current, old.previous, old.trying].filter((v, i): v is string => v !== null && completeness[i] === true))
      const { next, pick: chosen, failed } = chooseAtStartup(old, running, (v) => ok.has(v) && versionDir(app, v) !== null)
      if (failed !== null) yield* Effect.logWarning(`release ${failed} didn't start last time, so it isn't started or offered again`)
      if (!sameInstalled(next, old)) yield* writeInstalled(app, next)
      if (chosen === null) return
      const bin = `${app}/${chosen}/huntaway`
      yield* Effect.logInfo(`starting release ${chosen}, which this host last updated to, from ${bin}`)
      const env: ReadonlyArray<readonly [string, string]> = config.bundledServer === null ? [["HUNTAWAY_BUNDLED_SERVER", config.exe]] : []
      const failure = yield* Effect.flip(supervisor.exec(bin, config.args, env))
      yield* Effect.logWarning(`starting ${bin}: ${failure.message}; running ${config.version} instead`)
      const s = yield* readInstalled(app)
      if (s.trying === chosen) yield* writeInstalled(app, { ...s, trying: null, bad: isBad(s, chosen) ? s.bad : [...s.bad, chosen] })
    }).pipe(
      Effect.catch((e) => Effect.logWarning(`choosing a release in app/ to start: ${e.message}`)),
      Effect.annotateLogs({ module: "release" }),
    ),
  )
}
