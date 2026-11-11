import { Context, DateTime, Effect, FileSystem, Layer, Option, Ref, Result, Schedule, Schema, Stream } from "effect"
import type { Duration } from "effect"
import { SecureRandom } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { Conflict, Deployed, ServerStatus, UpdateRequest, UpdateResult, UpdatesFrom } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { About } from "../settings/About.ts"
import { Releases } from "./Releases.ts"
import { JobFailed, Restarts } from "./Restarts.ts"
import { Service } from "./Service.ts"

// Updating a host that runs from a source checkout (docs/plan/inventory/05-hosts-update.md, 2.6 and section 9; the old
// admin.ts): rebuild and restart in place, follow a deployment (`--update-from`), take a hub's push (a git bundle of the
// commits this host lacks, or a commit fetched from its own origin, or a release version), and build the body a hub
// sends a linked host (`bodyFor`). Also the server's status, which `admin.status` gives (the stable core).

/** How often `--update-from`'s deployment is asked which commit it runs. */
const DEPLOYED_EVERY = "5 minutes"
const DEPLOYED_TIMEOUT = "15 seconds"
const FETCH_TIMEOUT = "120 seconds"
/** A build step may take this long. */
const STEP_TIMEOUT = "30 minutes"

const HealthCommit = Schema.fromJsonString(Schema.Struct({ commit: Schema.optional(Schema.NullOr(Schema.String)) }))

/** This host can't take the update as it is (no checkout, a dirty one, another branch…). */
const refuse = (reason: string) => new Unavailable({ what: "update", reason })

/** The lines of git's output (Rust's `str::lines`). */
const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"))

/** Whether `program` is a file in one of `path`'s folders. */
export const onPath = (path: string, program: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const dir of path.split(":").filter((d) => d !== "")) {
      if (
        yield* fs.stat(`${dir}/${program}`).pipe(
          Effect.map((i) => i.type === "File"),
          Effect.orElseSucceed(() => false),
        )
      )
        return true
    }
    return false
  })

/**
 * Whether a rebuild builds ia-shim with cargo: unless there's no cargo on `path` and `serverDir` (apps/server) has a
 * prebuilt one in `bin/`, as an install on a machine without Rust has. The shim seldom changes.
 */
export const buildsShim = (path: string, serverDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (yield* onPath(path, "cargo")) return true
    return !(yield* fs.stat(`${serverDir}/bin/ia-shim`).pipe(
      Effect.map((i) => i.type === "File"),
      Effect.orElseSucceed(() => false),
    ))
  })

const PackageManager = Schema.fromJsonString(Schema.Struct({ packageManager: Schema.optional(Schema.String) }))

/** How a rebuild runs pnpm: `pnpm` on `path`, else the version the checkout pins (`packageManager`), through npx. */
export const pnpmCommand = (path: string, src: string) =>
  Effect.gen(function* () {
    if (yield* onPath(path, "pnpm")) return ["pnpm", []] as const
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${src}/package.json`).pipe(Effect.option)
    const pinned = Option.isNone(text)
      ? undefined
      : (yield* Schema.decodeEffect(PackageManager)(text.value).pipe(Effect.option)).pipe(Option.getOrUndefined)?.packageManager
    return ["npx", ["--yes", (pinned ?? "pnpm").split("+")[0] ?? "pnpm"]] as const
  })

export interface UpdaterShape {
  /** `admin.status`: this process, its restart job, and what it could update to. */
  readonly status: Effect.Effect<ServerStatus>
  /** Restart in place; with `rebuild`, after rebuilding from the source checkout (a failed build keeps this server). */
  readonly restart: (rebuild: boolean) => Effect.Effect<void, Conflict | Unavailable>
  /** A hub's Update (`admin.update`): its bundle, a commit from this host's origin, or the release it runs. */
  readonly update: (request: UpdateRequest) => Effect.Effect<UpdateResult, Conflict | Invalid | Unavailable>
  /**
   * What this host, as a hub, sends a linked host that runs `hostCommit` to update it: its branch, commit and the
   * commits after `hostCommit` as a bundle (a checkout); its commit (a deployment); and always its version.
   */
  readonly bodyFor: (hostCommit: string | null) => Effect.Effect<UpdateRequest, Unavailable>
  /** Ask `--update-from`'s deployment which commit it runs, and fetch it from origin (every 5 minutes, and for tests). */
  readonly checkDeployed: Effect.Effect<void>
}

export class Updater extends Context.Service<Updater, UpdaterShape>()("huntaway-server/update/Updater") {
  static readonly layer = Layer.effect(
    Updater,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const dataDir = yield* DataDir
      const fs = yield* FileSystem.FileSystem
      const proc = yield* Proc
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const http = yield* HttpClient.HttpClient
      const about = yield* About
      const runs = yield* RunRepo
      const restarts = yield* Restarts
      const releases = yield* Releases
      const service = yield* Service
      const random = yield* SecureRandom.SecureRandom
      const bootId = yield* random.uuidV4()
      const startedAt = DateTime.formatIso(yield* DateTime.now)
      const src = config.sourceDir
      const running = (yield* about.info).commit
      const updatesFrom: UpdatesFrom | null = src !== null ? "checkout" : config.releaseRepo !== null ? "releases" : null
      const deployed = yield* Ref.make<Deployed | null>(null)

      const git = (dir: string, args: ReadonlyArray<string>, timeout: Duration.Input = "60 seconds") =>
        proc.run("git", args, { cwd: dir, timeout }).pipe(
          Effect.map((r) => ({ ok: r.code === 0, stdout: r.stdout, stderr: r.stderr })),
          Effect.catch((e) => Effect.succeed({ ok: false, stdout: "", stderr: e.reason })),
        )
      const line = (dir: string, args: ReadonlyArray<string>) => Effect.map(git(dir, args), (o) => (o.ok ? o.stdout.trim() : null))
      const head = (dir: string) => line(dir, ["rev-parse", "HEAD"])
      const branchOf = (dir: string) => line(dir, ["symbolic-ref", "--short", "HEAD"])
      const dirty = (dir: string) => Effect.map(git(dir, ["status", "--porcelain", "--untracked-files=no"]), (o) => o.stdout.trim() !== "")
      const hasCommit = (dir: string, commit: string) => Effect.map(git(dir, ["cat-file", "-e", `${commit}^{commit}`]), (o) => o.ok)
      const isAncestor = (dir: string, a: string, b: string) => Effect.map(git(dir, ["merge-base", "--is-ancestor", a, b]), (o) => o.ok)

      const status = Effect.gen(function* () {
        const base = {
          boot_id: bootId,
          started_at: startedAt,
          version: config.version,
          updates_from: updatesFrom,
          source_dir: src,
          running_commit: running,
          running_agents: (yield* runs.active).length,
          restart: yield* restarts.current,
        }
        const release = yield* releases.status
        const unit = yield* service.status
        const extra = { ...(release === null ? {} : { release }), ...(unit === null ? {} : { service: unit }) }
        if (src === null) return { ...base, ...extra } satisfies ServerStatus
        const now = yield* head(src)
        const newCommits =
          running !== null && now !== null && running !== now
            ? lines((yield* git(src, ["log", "--format=%h %s", "-n", "30", `${running}..${now}`])).stdout)
            : []
        const checkout = { source_commit: now, source_branch: yield* branchOf(src), dirty: yield* dirty(src), new_commits: newCommits }
        if (config.updateFrom === null) return { ...base, ...checkout, ...extra } satisfies ServerStatus
        // Its commits this server doesn't run: only when it is ahead (not for a checkout that has moved on or diverged).
        const d = yield* Ref.get(deployed)
        const commit = d?.commit ?? null
        const ahead = running !== null && commit !== null && running !== commit && (yield* isAncestor(src, running, commit))
        const deployedCommits = ahead ? lines((yield* git(src, ["log", "--format=%h %s", "-n", "30", `${running}..${commit}`])).stdout) : []
        return { ...base, ...checkout, update_from: config.updateFrom, deployed: d, deployed_commits: deployedCommits, ...extra } satisfies ServerStatus
      })

      const checkDeployed = Effect.gen(function* () {
        const url = config.updateFrom
        if (url === null || src === null) return
        const previous = yield* Ref.get(deployed)
        const checkedAt = DateTime.formatIso(yield* DateTime.now)
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const res = yield* http.execute(HttpClientRequest.get(`${url}/api/health`)).pipe(
              Effect.mapError((e) => e.message),
              Effect.timeoutOrElse({ duration: DEPLOYED_TIMEOUT, orElse: () => Effect.fail("timed out") }),
            )
            if (res.status < 200 || res.status >= 300) return yield* Effect.fail(`HTTP status ${res.status} for url (${url}/api/health)`)
            const text = yield* res.text.pipe(Effect.mapError((e) => e.message))
            const health = yield* Schema.decodeEffect(HealthCommit)(text).pipe(Effect.mapError((e) => e.message))
            const c = health.commit?.trim() ?? ""
            if (c === "") return yield* Effect.fail(`${url} doesn't say which commit it runs (HUNTAWAY_COMMIT, without a checkout)`)
            if (running !== c && !(yield* hasCommit(src, c))) {
              const fetched = yield* git(src, ["fetch", "--quiet", "origin"], FETCH_TIMEOUT)
              if (!fetched.ok) return yield* Effect.fail(`git fetch origin failed: ${fetched.stderr.trim()}`)
              if (!(yield* hasCommit(src, c))) return yield* Effect.fail(`${url} runs ${c.slice(0, 7)}, which isn't on this checkout's origin`)
            }
            return c
          }),
        )
        if (Result.isFailure(result)) yield* Effect.logWarning(`checking ${url} for updates: ${result.failure}`)
        yield* Ref.set(
          deployed,
          Result.isSuccess(result)
            ? { commit: result.success, checked_at: checkedAt, error: null }
            : { commit: previous?.commit ?? null, checked_at: checkedAt, error: result.failure },
        )
      })

      /** Run a build step in `dir`, its output into the restart log. */
      const step = (dir: string, program: string, args: ReadonlyArray<string>, path: string) =>
        Effect.gen(function* () {
          const command = `${program} ${args.join(" ")}`
          yield* restarts.log(`$ ${command}`)
          const failed = (e: { readonly message: string }) => new JobFailed({ reason: `failed to run ${program}: ${e.message}` })
          const handle = yield* spawner
            .spawn(ChildProcess.make(program, args, { cwd: dir, env: { PATH: path }, extendEnv: true, stdin: "ignore" }))
            .pipe(Effect.mapError(failed))
          const toLog = (stream: typeof handle.stdout) =>
            stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(restarts.log), Effect.mapError(failed))
          const [, , code] = yield* Effect.all([toLog(handle.stdout), toLog(handle.stderr), Effect.mapError(handle.exitCode, failed)], { concurrency: 3 })
          if (Number(code) !== 0) return yield* new JobFailed({ reason: `\`${command}\` failed with exit status: ${Number(code)}` })
          return yield* Effect.void
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({ duration: STEP_TIMEOUT, orElse: () => Effect.fail(new JobFailed({ reason: `${program} took too long` })) }),
        )

      const rebuildAndRestart = (rebuild: boolean) =>
        Effect.gen(function* () {
          let exe = config.exe
          if (rebuild) {
            if (src === null) return yield* new JobFailed({ reason: "source checkout not found" })
            // Servers started from a desktop session may not have ~/.cargo/bin on PATH.
            const cargoBin = `${config.home}/.cargo/bin`
            const hasCargoBin = yield* fs.exists(cargoBin).pipe(Effect.orElseSucceed(() => false))
            const path = hasCargoBin && !config.path.split(":").includes(cargoBin) ? [config.path, cargoBin].filter((p) => p !== "").join(":") : config.path
            yield* restarts.phase("building_ui")
            const [pnpm, pre] = yield* pnpmCommand(path, src)
            // --frozen-lockfile, so the build never rewrites the tracked pnpm-lock.yaml: a hub's Update refuses a
            // checkout with uncommitted changes, so that would stop the next one.
            yield* step(src, pnpm, [...pre, "install", "--frozen-lockfile", "--filter", "huntaway-server...", "--filter", "huntaway-web..."], path)
            yield* step(src, pnpm, [...pre, "--filter", "huntaway-web", "run", "build"], path)
            yield* restarts.phase("building_server")
            // The server runs from its sources: what's left to build is the ia-shim its agents run under.
            const server = `${src}/apps/server`
            if (yield* buildsShim(path, server)) yield* step(src, "cargo", ["build", "--release", "-p", "ia-shim"], path)
            else yield* restarts.log("no cargo on PATH: using the prebuilt ia-shim in apps/server/bin/")
            exe = `${server}/bin/huntaway`
          }
          if (exe === null) return yield* new JobFailed({ reason: "not started by bin/huntaway, which execs for this server" })
          return yield* restarts.restartInto(exe)
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs))

      const restart = Effect.fn("Updater.restart")(function* (rebuild: boolean) {
        if (rebuild && src === null) return yield* new Unavailable({ what: "rebuild", reason: "source checkout not found; start the server with --source-dir" })
        return yield* restarts.begin(rebuildAndRestart(rebuild))
      })

      const noCheckout = new Unavailable({ what: "update", reason: "this host isn't running from a source checkout; update it by hand" })
      /** A job running already: say so before the checkout changes. */
      const notBusy = Effect.gen(function* () {
        const job = yield* restarts.current
        if (job !== null && job.phase !== "failed") return yield* restarts.begin(Effect.void)
        return yield* Effect.void
      })

      const updateFromBundle = (dir: string, branch: string, commit: string, bundle: string) =>
        Effect.gen(function* () {
          const current = (yield* branchOf(dir)) ?? ""
          if (current !== branch) return yield* refuse(`this host's checkout is on ${current}, the hub's on ${branch}`)
          if ((yield* head(dir)) === commit && running === commit) return { ok: true as const, up_to_date: true }
          yield* notBusy
          if (yield* dirty(dir)) return yield* refuse("this host's checkout has uncommitted changes")
          const bytes = Base64.decode(bundle.trim())
          if (Result.isFailure(bytes)) return yield* new Invalid({ field: "bundle", reason: `bad bundle: ${bytes.failure.message}` })
          const path = dataDir.file("incoming.bundle")
          yield* fs.writeFile(path, bytes.success).pipe(Effect.mapError((e) => refuse(`writing ${path}: ${e.message}`)))
          const fetched = yield* git(dir, ["fetch", "--quiet", path, `refs/heads/${branch}:refs/remotes/hub/${branch}`]).pipe(
            Effect.ensuring(fs.remove(path, { force: true }).pipe(Effect.ignore)),
          )
          if (!fetched.ok) return yield* new Invalid({ field: "bundle", reason: `fetching the hub's bundle failed: ${fetched.stderr.trim()}` })
          const merged = yield* git(dir, ["merge", "--ff-only", commit])
          if (!merged.ok) return yield* refuse(`can't fast-forward to the hub's ${branch}: ${merged.stderr.trim()}`)
          yield* restart(true)
          return { ok: true as const, commit }
        })

      const updateFromOrigin = (dir: string, commit: string) =>
        Effect.gen(function* () {
          if (running === commit) return { ok: true as const, up_to_date: true }
          const branch = yield* branchOf(dir)
          if (branch === null) return yield* refuse("this host's checkout isn't on a branch")
          yield* notBusy
          if (yield* dirty(dir)) return yield* refuse("this host's checkout has uncommitted changes")
          const fetched = yield* git(dir, ["fetch", "--quiet", "origin"], FETCH_TIMEOUT)
          if (!fetched.ok) return yield* refuse(`git fetch origin failed: ${fetched.stderr.trim()}`)
          const upstream = `origin/${branch}`
          if (!(yield* isAncestor(dir, commit, upstream)))
            return yield* refuse(`${commit.slice(0, 7)} isn't on ${upstream}; push it, or update this host by hand`)
          if ((yield* head(dir)) !== commit) {
            const merged = yield* git(dir, ["merge", "--ff-only", commit])
            if (!merged.ok) return yield* refuse(`can't fast-forward ${branch}: ${merged.stderr.trim()}`)
          }
          yield* restart(true)
          return { ok: true as const, commit }
        })

      const update = Effect.fn("Updater.update")(function* (request: UpdateRequest) {
        if (updatesFrom === "releases") {
          if (request.version === undefined) {
            return yield* new Invalid({ field: "version", reason: "this host updates from releases, and the board didn't say which version it runs" })
          }
          return yield* releases.updateFromHub(request.version)
        }
        const commit = request.commit?.trim() ?? ""
        if (commit === "") {
          if (src === null) return yield* noCheckout
          return yield* new Invalid({
            field: "commit",
            reason: "the board runs a release rather than a checkout, so it can't say which commit to update this host to",
          })
        }
        if (src === null) return yield* noCheckout
        if (request.bundle !== undefined && request.branch !== undefined) return yield* updateFromBundle(src, request.branch, commit, request.bundle)
        return yield* updateFromOrigin(src, commit)
      })

      /** The checkout's branch and commit, as a git bundle (base64) of the commits after `since` when it's an ancestor. */
      const bundleSince = (dir: string, since: string | null) =>
        Effect.gen(function* () {
          const branch = yield* branchOf(dir)
          if (branch === null) return yield* new Unavailable({ what: "update", reason: "the hub's checkout isn't on a branch" })
          const commit = yield* head(dir)
          if (commit === null) return yield* new Unavailable({ what: "update", reason: "can't read the hub's commit" })
          const revs = [branch]
          // Not one the branch is at (git won't make an empty bundle), nor one this checkout lacks or has elsewhere.
          if (since !== null && /^[0-9a-f]{40}$/.test(since) && since !== commit && (yield* isAncestor(dir, since, commit))) revs.push(`^${since}`)
          const path = dataDir.file("outgoing.bundle")
          const made = yield* git(dir, ["bundle", "create", path, ...revs])
          if (!made.ok) return yield* new Unavailable({ what: "update", reason: `git bundle failed: ${made.stderr.trim()}` })
          const bytes = yield* fs.readFile(path).pipe(
            Effect.ensuring(fs.remove(path, { force: true }).pipe(Effect.ignore)),
            Effect.mapError((e) => new Unavailable({ what: "update", reason: `reading ${path}: ${e.message}` })),
          )
          return { branch, commit, bundle: Base64.encode(bytes) }
        })

      const bodyFor = Effect.fn("Updater.bodyFor")(function* (hostCommit: string | null) {
        // A hub with a checkout sends its code; one deployed without (a container) its commit, which the host fetches
        // from its own origin; a release install only its version, which only a release host can go by.
        if (src !== null) return { ...(yield* bundleSince(src, hostCommit)), version: config.version }
        if (running !== null) return { commit: running, version: config.version }
        if (updatesFrom === "releases") return { version: config.version }
        return yield* new Unavailable({ what: "update", reason: "this hub doesn't know which commit it runs (set HUNTAWAY_COMMIT)" })
      })

      if (config.updateFrom !== null) {
        if (src === null) yield* Effect.logWarning("--update-from needs a source checkout to update; ignoring it")
        else {
          yield* Effect.logInfo(`following the commit deployed at ${config.updateFrom}`)
          yield* checkDeployed.pipe(Effect.repeat(Schedule.spaced(DEPLOYED_EVERY)), Effect.forkScoped)
        }
      }

      return Updater.of({ status, restart, update, bodyFor, checkDeployed })
    }).pipe(Effect.annotateLogs({ module: "update" })),
  )
}
