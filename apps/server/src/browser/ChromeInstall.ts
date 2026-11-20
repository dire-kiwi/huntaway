import { Clock, Context, Deferred, Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect"
import { Digest } from "effect/crypto"
import { HttpClient, HttpClientRequest } from "effect/http"
import { unsafeArchivePath } from "../desktop/cua.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import type { ChromeReleaseConfig } from "../platform/ServerConfig.ts"

// The Chrome the tasks' browser runs (HE-62), as T3 Code does it: Google's chrome-headless-shell from Chrome for
// Testing, one pinned build, downloaded the first time a task opens a page (about 120 MB), its size and SHA-256
// checked, unpacked into a folder of its own and renamed into place under `<data>/browser/chrome/<version>`, so an
// interrupted install leaves nothing half-written where the program is looked for. Older versions go once the new one
// is in place. `HUNTAWAY_CHROME` names a Chrome or Chromium to run instead, and nothing is downloaded.

/** The browser can't run on this host: why, as the agent and the pane are told. */
export class ChromeUnavailable extends Schema.TaggedError<ChromeUnavailable, { readonly brand: unique symbol }>()("ChromeUnavailable", {
  reason: Schema.String,
}) {}

/** The pinned build: update the version, sizes and hashes from Chrome for Testing's chrome-headless-shell zips. */
export const CHROME_VERSION = "157.0.8103.78"
const ARCHIVES: Readonly<Record<string, { readonly platform: string; readonly bytes: number; readonly sha256: string }>> = {
  "linux-x64": { platform: "linux64", bytes: 127_965_683, sha256: "f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a" },
  "linux-arm64": { platform: "linux-arm64", bytes: 128_047_138, sha256: "912fbf877e53de34d7b3cca5104f3b95607d41bd35412ccc6cd2a599ff0c0dbf" },
  "mac-arm64": { platform: "mac-arm64", bytes: 104_822_985, sha256: "17bf66d53c1b1104dcb641c5b331cd4ac5d200c778f5feed0934a0b92deaf8d6" },
  "mac-x64": { platform: "mac-x64", bytes: 110_132_547, sha256: "f1a6a9561eaf1f409849538de663695d36d72fbf1ebca4d42e47c7b5f2a157f3" },
}

/** The pinned build for `<os>-<arch>` (`ServerConfig.platform`), or null where Chrome for Testing has none. */
export const pinnedRelease = (platform: string): ChromeReleaseConfig | null => {
  const a = ARCHIVES[platform]
  if (a === undefined) return null
  return {
    version: CHROME_VERSION,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${a.platform}/chrome-headless-shell-${a.platform}.zip`,
    bytes: a.bytes,
    sha256: a.sha256,
    program: `chrome-headless-shell-${a.platform}/chrome-headless-shell`,
  }
}

/** How a download is going, for the pane and the agent while they wait. */
export interface ChromeInstalling {
  readonly phase: "downloading" | "verifying" | "unpacking"
  readonly received: number
  readonly total: number
}

export interface ChromeInstallShape {
  /** The program to run: `HUNTAWAY_CHROME`'s, else the installed build, installed first if it isn't (waiting for one going). */
  readonly executable: Effect.Effect<string, ChromeUnavailable>
  /** The download going, if one is. */
  readonly installing: Effect.Effect<ChromeInstalling | null>
}

const fail = (reason: string) => Effect.fail(new ChromeUnavailable({ reason }))
const fsError = (what: string) => (e: { readonly message: string }) => new ChromeUnavailable({ reason: `${what}: ${e.message}` })

export class ChromeInstall extends Context.Service<ChromeInstall, ChromeInstallShape>()("huntaway-server/browser/ChromeInstall") {
  static readonly layer = Layer.effect(
    ChromeInstall,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const proc = yield* Proc
      const client = yield* HttpClient.HttpClient
      const digest = yield* Digest.Digest
      const root = `${config.dataDir}/browser/chrome`
      const release = config.chromeRelease ?? pinnedRelease(config.platform)
      const progress = yield* Ref.make<ChromeInstalling | null>(null)
      const at = (p: ChromeInstalling | null) => Ref.set(progress, p)
      /** The install going, which later callers wait for rather than start another. */
      const going = yield* Ref.make<Deferred.Deferred<string, ChromeUnavailable> | null>(null)

      const download = (r: ChromeReleaseConfig, to: string) =>
        Effect.gen(function* () {
          const response = yield* client
            .execute(HttpClientRequest.get(r.url))
            .pipe(Effect.mapError((e) => new ChromeUnavailable({ reason: `downloading Chrome: ${e.message}` })))
          if (response.status < 200 || response.status >= 300) return yield* fail(`downloading ${r.url}: HTTP ${response.status}`)
          let received = 0
          yield* response.stream.pipe(
            Stream.mapError((e) => new ChromeUnavailable({ reason: `downloading Chrome: ${e.message}` })),
            Stream.tap((chunk) => {
              received += chunk.byteLength
              return received > r.bytes ? fail(`the download is bigger than Chrome's ${r.bytes} bytes`) : at({ phase: "downloading", received, total: r.bytes })
            }),
            Stream.run(fs.sink(to)),
            Effect.mapError((e) => (e._tag === "ChromeUnavailable" ? e : new ChromeUnavailable({ reason: `saving the download: ${e.message}` }))),
          )
          return received
        })

      const install = (r: ChromeReleaseConfig) =>
        Effect.gen(function* () {
          const dest = `${root}/${r.version}`
          const work = `${root}/.install-${r.version}-${yield* Clock.currentTimeMillis}`
          yield* fs.makeDirectory(work, { recursive: true }).pipe(Effect.mapError(fsError("making the install's folder")))
          yield* Effect.gen(function* () {
            const archive = `${work}/chrome.zip`
            yield* at({ phase: "downloading", received: 0, total: r.bytes })
            const got = yield* download(r, archive)
            yield* at({ phase: "verifying", received: got, total: r.bytes })
            if (got !== r.bytes) return yield* fail(`downloaded ${got} bytes of Chrome, not ${r.bytes}`)
            const sum = yield* digest.digestHex(Digest.sha256, yield* fs.readFile(archive).pipe(Effect.mapError(fsError("reading the download"))))
            if (sum !== r.sha256) return yield* fail(`the download's SHA-256 is ${sum}, not ${r.sha256}`)
            yield* at({ phase: "unpacking", received: got, total: r.bytes })
            const list = yield* proc
              .run("unzip", ["-Z1", archive])
              .pipe(Effect.mapError((e) => new ChromeUnavailable({ reason: `reading the archive: ${e.message}` })))
            if (list.code !== 0) return yield* fail(`reading the archive (is unzip installed?): ${list.stderr.trim()}`)
            const bad = unsafeArchivePath(list.stdout)
            if (bad !== undefined) return yield* fail(`the archive has an unsafe path: ${bad}`)
            const files = `${work}/files`
            const x = yield* proc
              .run("unzip", ["-q", archive, "-d", files])
              .pipe(Effect.mapError((e) => new ChromeUnavailable({ reason: `unpacking Chrome: ${e.message}` })))
            if (x.code !== 0) return yield* fail(`unpacking Chrome: ${x.stderr.trim()}`)
            const exe = yield* fs.stat(`${files}/${r.program}`).pipe(Effect.option)
            if (exe._tag === "None" || exe.value.type !== "File") return yield* fail(`the archive has no ${r.program}`)
            yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.mapError(fsError("removing the old copy")))
            return yield* fs.rename(files, dest).pipe(Effect.mapError(fsError("putting Chrome in place")))
          }).pipe(Effect.ensuring(Effect.andThen(fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore), at(null))))
          for (const v of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))) {
            if (v !== r.version && !v.startsWith(".")) yield* fs.remove(`${root}/${v}`, { recursive: true, force: true }).pipe(Effect.ignore)
          }
          return `${dest}/${r.program}`
        })

      const installed = Effect.gen(function* () {
        if (release === null)
          return yield* fail(`Chrome for Testing has no headless Chrome for ${config.platform}: set HUNTAWAY_CHROME to a Chrome or Chromium.`)
        const path = `${root}/${release.version}/${release.program}`
        if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return path
        // One install at a time: a caller while one is going waits for it.
        const mine = yield* Deferred.make<string, ChromeUnavailable>()
        const theirs = yield* Ref.modify(going, (g) => (g === null ? [null, mine] : [g, g]))
        if (theirs !== null) return yield* Deferred.await(theirs)
        return yield* install(release).pipe(
          Effect.onExit((exit) => Effect.andThen(Deferred.done(mine, exit), Ref.set(going, null))),
          Effect.tapError((e) => Effect.logError(`installing Chrome ${release.version} failed: ${e.reason}`)),
        )
      })

      return ChromeInstall.of({
        executable: config.chromeBin === null ? installed : Effect.succeed(config.chromeBin),
        installing: Ref.get(progress),
      })
    }),
  )
}
