import { Cause, DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import type { PlatformError } from "effect"
import { Digest } from "effect/crypto"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Auth, RequiredScope } from "@huntaway/contracts"
import { compareVersions, packageName } from "../shared/versions.ts"
import type { UpdateKind } from "../shared/versions.ts"

// Updating the desktop app's own package (HA-68), for a release whose frame (boot.cjs and Electron) changed, which the
// server's release updates can't install: an AppImage replaces its own file, and the pacman package is installed with
// `pkexec pacman -U`. The main process then relaunches the app. Mac installs keep the instruction the board shows.
//
// Nothing here comes from the page, which shows agent-written HTML in frames: the version is the one the server's
// release check picked (its `admin.status`, which honours "Include prereleases"), and the package and its digest come
// from GitHub's API for that release's tag.

/** Why the app didn't update itself, in words for the user. */
export class ShellUpdateFailed extends Schema.TaggedError<ShellUpdateFailed, { readonly brand: unique symbol }>()("ShellUpdateFailed", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new ShellUpdateFailed({ message }))

/** What the update reports as it goes. Download events come with `bytes` and `total` (0 when unknown). */
export interface Progress {
  readonly phase: "checking" | "downloading" | "installing" | "restarting"
  readonly version?: string
  readonly bytes?: number
  readonly total?: number
}

// The server's release status, as much of `admin.status` as this needs (docs/plan/05-protocol.md: `admin.status` is in
// the stable core). Any other field is left alone.
const ReleaseView = Schema.Struct({
  latest: Schema.optionalKey(Schema.NullOr(Schema.Struct({ version: Schema.String }))),
  shell: Schema.optionalKey(Schema.NullOr(Schema.Struct({ outdated: Schema.Boolean }))),
})
const AdminStatus = Schema.Struct({ release: Schema.optionalKey(Schema.NullOr(ReleaseView)) })

/** The one call the shell makes to its board: the release status, with the board token. */
export const ShellRpcs = RpcGroup.make(Rpc.make("admin.status", { success: AdminStatus }).annotate(RequiredScope, "admin")).middleware(Auth)

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? "message" in error && typeof error.message === "string" && error.message !== ""
      ? error.message
      : error._tag
    : String(error)

/** The server's release status, as `admin.status` has it. */
export type ReleaseStatus = typeof AdminStatus.Type

/**
 * The release to install, from the server's release status: its version, the latest release the server's check found,
 * once that release's shell differs from this app's and it is newer than this app (`current`). Otherwise why there is
 * nothing to install: an older package (a check that skips the prerelease this app came from) would downgrade it.
 */
export const shellReleaseOf = (status: ReleaseStatus, current: string): { readonly version: string } | { readonly nothing: string } => {
  const release = status.release ?? null
  const version = release?.latest?.version
  if (release === null || version === undefined) return { nothing: "The server hasn't found a release yet. Check for updates in Settings → Server first." }
  if (release.shell?.outdated !== true) return { nothing: `This app already has v${version}'s shell, so there's nothing to install.` }
  if (current !== "" && !(compareVersions(version, current) > 0))
    return { nothing: `This app (v${current}) isn't older than v${version}, so there's nothing to install.` }
  return { version }
}

/** The release to install, as the server this app uses (`base`, `token`) reports it (`shellReleaseOf`). */
export const latestShellRelease = Effect.fn("shellUpdate.latest")(function* (options: {
  readonly base: string
  readonly token: string
  readonly current: string
}) {
  const layer = Layer.mergeAll(
    RpcClient.layerProtocolHttp({ url: `${options.base.replace(/\/+$/, "")}/api/rpc` }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    RpcMiddleware.layerClient(Auth, ({ next, request }) =>
      next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${options.token}`) }),
    ),
  )
  const asking = "Couldn't ask the server which release is the latest"
  const status = yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      const client = yield* RpcClient.make(ShellRpcs, { flatten: true }).pipe(Effect.provideContext(context))
      return yield* client("admin.status", undefined)
    }),
  ).pipe(
    Effect.catchCause((cause) => fail(`${asking}: ${describe(Cause.squash(cause))}`)),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => fail(`${asking}: it didn't answer in time.`) }),
  )
  const found = shellReleaseOf(status, options.current)
  return "version" in found ? found.version : yield* fail(found.nothing)
})

const GitHubRelease = Schema.Struct({
  assets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
        size: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
const GitHubMessage = Schema.Struct({ message: Schema.optionalKey(Schema.String) })

/** A package of a release: its asset's name, download URL, size and sha256 (hex). */
export interface Package {
  readonly name: string
  readonly url: string
  readonly size: number
  readonly sha256: string
}

/** What GitHub answered when it wasn't a success: the rate limit, or its message. */
const refusal = (response: HttpClientResponse.HttpClientResponse, what: string) =>
  Effect.gen(function* () {
    if ((response.status === 403 || response.status === 429) && response.headers["x-ratelimit-remaining"] === "0") {
      const reset = Number(response.headers["x-ratelimit-reset"])
      const at = reset > 0 ? ` until ${DateTime.formatLocal(DateTime.makeUnsafe(reset * 1000), { timeStyle: "medium" })}` : ""
      return yield* fail(`GitHub's rate limit for this address is used up${at}.`)
    }
    const body = yield* HttpClientResponse.schemaBodyJson(GitHubMessage)(response).pipe(Effect.option)
    const message = Option.match(body, { onNone: () => "", onSome: (b) => b.message ?? "" })
    return yield* fail(`${what}: GitHub answered ${response.status}${message === "" ? "" : `: ${message}`}`)
  })

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "huntaway-desktop" }

/**
 * The package for `kind` in release `version` of `repo`, from GitHub's API at `api`. It must have a sha256 digest, which
 * the download is checked against.
 */
export const findPackage = Effect.fn("shellUpdate.findPackage")(function* (options: {
  readonly api: string
  readonly repo: string
  readonly version: string
  readonly kind: UpdateKind
  readonly platform: string
}) {
  const client = yield* HttpClient.HttpClient
  const { version } = options
  const name = packageName(options.kind, version, options.platform)
  let release: typeof GitHubRelease.Type | null = null
  // Release tags have a v; one without would be found too.
  for (const tag of [`v${version}`, version]) {
    const response = yield* client
      .execute(HttpClientRequest.get(`${options.api}/repos/${options.repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: GITHUB_HEADERS }))
      .pipe(
        Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => fail(`Couldn't reach GitHub for release v${version}: it didn't answer in time.`) }),
        Effect.catchTag("HttpClientError", (error) => fail(`Couldn't reach GitHub for release v${version}: ${error.message}`)),
      )
    if (response.status === 404) continue
    if (response.status < 200 || response.status >= 300) return yield* refusal(response, `Couldn't read release v${version}`)
    release = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response).pipe(
      Effect.catch(() => fail(`Couldn't read release v${version}: GitHub's answer isn't a release.`)),
    )
    break
  }
  if (release === null) return yield* fail(`GitHub has no release v${version} in ${options.repo}.`)
  const asset = (release.assets ?? []).find((a) => a.name === name)
  if (asset === undefined) return yield* fail(`Release v${version} has no ${name}.`)
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase()
  if (sha256 === undefined) return yield* fail(`GitHub gives no sha256 digest for ${name}, so its download can't be checked.`)
  return { name, url: asset.browser_download_url, size: asset.size ?? 0, sha256 } satisfies Package
})

/**
 * Download `url` into `file` (created here, never through something already at that path: a link would have its target
 * overwritten), then check its sha256 against `sha256`. Reports `onProgress(bytes, total)` (total 0 when unknown). On a
 * failure the file is removed.
 */
export const download = Effect.fn("shellUpdate.download")(function* (options: {
  readonly url: string
  readonly file: string
  readonly sha256: string
  readonly size?: number
  readonly onProgress?: (bytes: number, total: number) => Effect.Effect<void>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const client = yield* HttpClient.HttpClient
  const digest = yield* Digest.Digest
  const name = path.basename(options.file)
  const report = options.onProgress ?? (() => Effect.void)
  const where = path.dirname(options.file)
  const cutOff = (why: string) => fail(`The download of ${path.basename(options.url)} was cut off: ${why}`)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const out = yield* fs
        .open(options.file, { flag: "wx", mode: 0o644 })
        .pipe(Effect.catch((error) => fail(`Couldn't save the download in ${where}: ${error.message}`)))
      // From here on the file is this download's: a failure removes it.
      yield* Effect.gen(function* () {
        const response = yield* client
          .execute(HttpClientRequest.get(options.url, { headers: { "user-agent": "huntaway-desktop" } }))
          .pipe(Effect.catchTag("HttpClientError", (error) => fail(`Couldn't download ${name}: ${error.message}`)))
        if (response.status < 200 || response.status >= 300) return yield* fail(`Couldn't download the package: ${options.url} answered ${response.status}.`)
        const total = Number(response.headers["content-length"]) || (options.size ?? 0)
        let bytes = 0
        yield* report(0, total)
        yield* response.stream.pipe(
          Stream.runForEach((chunk) =>
            out.writeAll(chunk).pipe(
              Effect.catch((error) => fail(`Couldn't save the download in ${where}: ${error.message}`)),
              Effect.andThen(
                Effect.suspend(() => {
                  bytes += chunk.length
                  return report(bytes, total)
                }),
              ),
            ),
          ),
          Effect.catchTag("HttpClientError", (error) => cutOff(error.message)),
        )
        if (total > 0 && bytes < total) return yield* cutOff(`${bytes} of ${total} bytes.`)
        const contents = yield* fs.readFile(options.file).pipe(Effect.catch((error) => fail(`Couldn't read the download back: ${error.message}`)))
        const got = yield* digest.digestHex(Digest.sha256, contents)
        if (got !== options.sha256) {
          return yield* fail(`The download of ${path.basename(options.url)} doesn't match its sha256 digest (got ${got}, expected ${options.sha256}).`)
        }
        return yield* Effect.void
      }).pipe(
        Effect.timeoutOrElse({ duration: "30 minutes", orElse: () => cutOff("it took more than 30 minutes.") }),
        Effect.tapError(() => fs.remove(options.file, { force: true }).pipe(Effect.ignore)),
      )
    }),
  )
})

/**
 * Replace the AppImage `appimage` with the package: downloaded beside it into a new private folder (the same file system,
 * for the rename, and no name in a shared folder is written through), made executable, then renamed over it, so that a
 * cut-off download leaves the old one in place. The running app keeps its open file.
 */
export const updateAppImage = Effect.fn("shellUpdate.appImage")(function* (options: {
  readonly appimage: string
  readonly pkg: Package
  readonly onProgress?: (bytes: number, total: number) => Effect.Effect<void>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.dirname(options.appimage)
  const base = path.basename(options.appimage)
  const yourself = "Download the new AppImage and put it in place yourself."
  yield* fs.access(dir, { writable: true }).pipe(Effect.catch(() => fail(`The app can't replace itself: ${dir} isn't writable by you. ${yourself}`)))
  const stage = yield* fs
    .makeTempDirectory({ directory: dir, prefix: `.${base}.update-` })
    .pipe(Effect.catch((error) => fail(`The app can't replace itself: ${error.message}. ${yourself}`)))
  yield* Effect.gen(function* () {
    const tmp = path.join(stage, base)
    yield* download({
      url: options.pkg.url,
      file: tmp,
      sha256: options.pkg.sha256,
      size: options.pkg.size,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    })
    // It keeps its mode, and is executable; one moved away meanwhile is written anew.
    const mode = yield* fs.stat(options.appimage).pipe(
      Effect.map((info) => info.mode & 0o7777),
      Effect.orElseSucceed(() => 0o755),
    )
    yield* fs.chmod(tmp, mode | 0o111).pipe(
      Effect.andThen(fs.rename(tmp, options.appimage)),
      Effect.catch((error) => fail(`The app couldn't replace ${options.appimage}: ${error.message}. ${yourself}`)),
    )
  }).pipe(Effect.ensuring(fs.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore)))
})

/** All of a command's output on one stream, as text. */
const textOf = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** The last few lines of a command's output, for its error. */
const tail = (text: string, lines = 6) => text.trim().split("\n").slice(-lines).join("\n")

/**
 * Install the pacman package: download it into a new temp folder, then `pkexec pacman -U --noconfirm <file>`, which asks
 * for the password in polkit's dialog. `pkexec` is the program to run it with (a stand-in, in tests).
 */
export const updatePacman = Effect.fn("shellUpdate.pacman")(function* (options: {
  readonly pkg: Package
  readonly tmpdir: string
  readonly pkexec?: string
  readonly onProgress?: (bytes: number, total: number) => Effect.Effect<void>
  readonly onInstalling?: Effect.Effect<void>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const instead = "Install it with the sudo pacman command instead."
  const dir = yield* fs
    .makeTempDirectory({ directory: options.tmpdir, prefix: "huntaway-update-" })
    .pipe(Effect.catch((error) => fail(`Couldn't make a folder for the download: ${error.message}`)))
  yield* Effect.gen(function* () {
    const file = path.join(dir, options.pkg.name)
    yield* download({
      url: options.pkg.url,
      file,
      sha256: options.pkg.sha256,
      size: options.pkg.size,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    })
    yield* options.onInstalling ?? Effect.void
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(options.pkexec ?? "pkexec", ["pacman", "-U", "--noconfirm", file], { stdin: "ignore" }))
        const [out, err, code] = yield* Effect.all([textOf(handle.stdout), textOf(handle.stderr), handle.exitCode], { concurrency: 3 })
        return { code: Number(code), output: out + err }
      }),
    ).pipe(Effect.result)
    if (ran._tag === "Failure") {
      const error = ran.failure
      if (error._tag === "PlatformError" && error.reason._tag === "NotFound") {
        return yield* fail(`pkexec isn't installed, so the app can't ask for the password to install the package. ${instead}`)
      }
      return yield* fail(`Couldn't run pkexec: ${describe(error)}. ${instead}`)
    }
    const { code, output } = ran.success
    // pkexec: 126 when the password dialog was dismissed (or the user isn't allowed), 127 when it couldn't ask at all.
    if (code === 126) return yield* fail(`The password prompt was cancelled, so nothing was installed. ${instead}`)
    if (code === 127) {
      const why = /authentication agent/i.test(output)
        ? "there's no polkit agent running to ask for the password"
        : `pkexec couldn't ask for the password${output.trim() === "" ? "" : ` (${tail(output, 2)})`}`
      return yield* fail(`The package wasn't installed: ${why}. ${instead}`)
    }
    if (code !== 0) return yield* fail(`pacman couldn't install the package (exit ${code})${output.trim() === "" ? "." : `:\n${tail(output)}`}`)
    return yield* Effect.void
  }).pipe(Effect.ensuring(fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)))
})

/**
 * Install the latest release's package for `kind` ("appimage", with `appimage` its file, or "pacman"), as the server at
 * `base` reports it, reporting `checking`, `downloading` and `installing`. Succeeds with the version once it is
 * installed (the caller relaunches). `current` is this app's version: an older release is not installed.
 */
export const updateShell = Effect.fn("shellUpdate")(function* (options: {
  readonly kind: UpdateKind
  readonly appimage: string | null
  readonly base: string
  readonly token: string
  readonly current: string
  readonly api: string
  readonly repo: string
  readonly platform: string
  readonly tmpdir: string
  readonly pkexec?: string
  readonly onProgress: (progress: Progress) => Effect.Effect<void>
}) {
  yield* options.onProgress({ phase: "checking" })
  const version = yield* latestShellRelease(options)
  const pkg = yield* findPackage({ api: options.api, repo: options.repo, version, kind: options.kind, platform: options.platform })
  const downloading = (bytes: number, total: number) => options.onProgress({ phase: "downloading", version, bytes, total })
  if (options.kind === "appimage") {
    if (options.appimage === null) return yield* fail("This app isn't running as an AppImage.")
    yield* updateAppImage({ appimage: options.appimage, pkg, onProgress: downloading })
  } else {
    yield* updatePacman({
      pkg,
      tmpdir: options.tmpdir,
      onProgress: downloading,
      onInstalling: options.onProgress({ phase: "installing", version }),
      ...(options.pkexec === undefined ? {} : { pkexec: options.pkexec }),
    })
  }
  return version
})
