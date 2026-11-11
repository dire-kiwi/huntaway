import { Clock, Context, Deferred, Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect"
import { Digest } from "effect/crypto"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { DesktopInstall } from "@huntaway/contracts"
import { nowTimestamp } from "../platform/columns.ts"
import { Proc } from "../platform/Proc.ts"
import { CuaDriver } from "./CuaDriver.ts"
import { unsafeArchivePath } from "./cua.ts"
import type { CuaRelease } from "./cua.ts"

// Installing Cua Driver on this host (huntaway's desktop/install.ts): a release archive downloaded (GitHub's, or the
// fake one a test gives), its size and SHA-256 checked, unpacked beside the others (into a folder of its own first,
// then renamed into place), so a failed or interrupted install leaves nothing half-written where the driver is looked
// for. Older versions go once the new one is in place, and the driver is stopped so the new one takes over from the
// next call. The latest install's progress is kept for the host's page until the next.

/** An install failed: why, as the host's page shows it. */
export class InstallError extends Schema.TaggedError<InstallError, { readonly brand: unique symbol }>()("InstallError", {
  reason: Schema.String,
}) {}

export interface CuaInstallShape {
  /** The latest install, which the host's page shows until the next. */
  readonly current: Effect.Effect<DesktopInstall | null>
  /** Waits until the install going (if any) has ended, and says how it went. */
  readonly settled: Effect.Effect<DesktopInstall | null>
  /** Start installing `release` in the background (or keep the install that's going), and say how it's going. */
  readonly start: (release: CuaRelease) => Effect.Effect<DesktopInstall>
  /** Download, check and unpack `release` into `<root>/<version>`, now (`start` runs this). */
  readonly install: (release: CuaRelease) => Effect.Effect<void, InstallError>
  /** Remove every installed version (and forget the latest install). */
  readonly uninstall: Effect.Effect<void>
}

const fail = (reason: string) => Effect.fail(new InstallError({ reason }))
const fsError = (what: string) => (e: { readonly message: string }) => new InstallError({ reason: `${what}: ${e.message}` })

const going = (job: DesktopInstall | null): job is DesktopInstall => job !== null && job.phase !== "done" && job.phase !== "failed"

export class CuaInstall extends Context.Service<CuaInstall, CuaInstallShape>()("huntaway-server/desktop/CuaInstall") {
  static readonly layer = Layer.effect(
    CuaInstall,
    Effect.gen(function* () {
      const driver = yield* CuaDriver
      const fs = yield* FileSystem.FileSystem
      const proc = yield* Proc
      const client = yield* HttpClient.HttpClient
      const digest = yield* Digest.Digest
      const scope = yield* Effect.scope
      const job = yield* Ref.make<DesktopInstall | null>(null)
      /** Done when the latest install has ended. */
      const ended = yield* Ref.make(yield* Deferred.make<void>())
      const root = driver.installRoot

      const progress = (change: Partial<DesktopInstall>) => Ref.update(job, (j): DesktopInstall | null => (j === null ? j : Object.assign({}, j, change)))

      /** The archive's bytes, refused once they pass the release's size. */
      const download = (release: CuaRelease) =>
        Effect.gen(function* () {
          const response = yield* client
            .execute(HttpClientRequest.get(release.url))
            .pipe(Effect.mapError((e) => new InstallError({ reason: `downloading ${release.url}: ${e.message}` })))
          if (response.status < 200 || response.status >= 300) return yield* fail(`downloading ${release.url}: HTTP ${response.status}`)
          const chunks: Array<Uint8Array> = []
          let received = 0
          yield* response.stream.pipe(
            Stream.mapError((e) => new InstallError({ reason: `downloading ${release.url}: ${e.message}` })),
            Stream.runForEach((chunk) => {
              received += chunk.byteLength
              if (received > release.bytes) return fail(`the download is bigger than the release's ${release.bytes} bytes`)
              chunks.push(chunk)
              return progress({ received })
            }),
          )
          const all = new Uint8Array(received)
          let at = 0
          for (const c of chunks) {
            all.set(c, at)
            at += c.byteLength
          }
          return all
        })

      const install = Effect.fn("CuaInstall.install")(function* (release: CuaRelease) {
        const dest = `${root}/${release.version}`
        const work = `${root}/.install-${release.version}-${process.pid}-${yield* Clock.currentTimeMillis}`
        yield* fs.makeDirectory(work, { recursive: true }).pipe(Effect.mapError(fsError("making the install's folder")))
        yield* Effect.gen(function* () {
          const archive = `${work}/archive.tar.gz`
          const bytes = yield* download(release)
          yield* fs.writeFile(archive, bytes).pipe(Effect.mapError(fsError("saving the download")))
          yield* progress({ phase: "verifying" })
          if (bytes.byteLength !== release.bytes) return yield* fail(`downloaded ${bytes.byteLength} bytes, but the release is ${release.bytes}`)
          const sum = yield* digest.digestHex(Digest.sha256, bytes)
          if (sum !== release.sha256) return yield* fail(`the download's SHA-256 is ${sum}, not the release's ${release.sha256}`)
          yield* progress({ phase: "unpacking" })
          const files = `${work}/files`
          yield* fs.makeDirectory(files).pipe(Effect.mapError(fsError("unpacking the archive")))
          // Refuse archives with absolute paths or `..` in them, before tar writes anything.
          const list = yield* proc.run("tar", ["-tzf", archive]).pipe(Effect.mapError((e) => new InstallError({ reason: `reading the archive: ${e.message}` })))
          if (list.code !== 0) return yield* fail(`reading the archive: ${list.stderr.trim()}`)
          const bad = unsafeArchivePath(list.stdout)
          if (bad !== undefined) return yield* fail(`the archive has an unsafe path: ${bad}`)
          const x = yield* proc
            .run("tar", ["-xzf", archive, "-C", files, "--no-same-owner"])
            .pipe(Effect.mapError((e) => new InstallError({ reason: `unpacking the archive: ${e.message}` })))
          if (x.code !== 0) return yield* fail(`unpacking the archive: ${x.stderr.trim()}`)
          const exe = yield* fs.stat(`${files}/cua-driver`).pipe(Effect.option)
          if (exe._tag === "None" || exe.value.type !== "File") return yield* fail("the archive has no cua-driver at its top")
          yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.mapError(fsError("removing the old copy")))
          return yield* fs.rename(files, dest).pipe(Effect.mapError(fsError("putting the driver in place")))
        }).pipe(Effect.ensuring(fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore)))
        // Older versions go once the new one is in place.
        const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        for (const v of names) {
          if (v !== release.version && !v.startsWith(".")) yield* fs.remove(`${root}/${v}`, { recursive: true, force: true }).pipe(Effect.ignore)
        }
      })

      const start = Effect.fn("CuaInstall.start")(function* (release: CuaRelease) {
        const now = yield* nowTimestamp
        const fresh: DesktopInstall = {
          version: release.version,
          phase: "downloading",
          received: 0,
          total: release.bytes,
          error: null,
          started_at: now,
          finished_at: null,
        }
        const [began, current] = yield* Ref.modify(job, (j): readonly [readonly [boolean, DesktopInstall], DesktopInstall | null] =>
          going(j) ? [[false, j], j] : [[true, fresh], fresh],
        )
        if (!began) return current
        const done = yield* Deferred.make<void>()
        yield* Ref.set(ended, done)
        yield* install(release).pipe(
          // The new version takes over from the next call.
          Effect.andThen(Effect.flatMap(nowTimestamp, (at) => progress({ phase: "done", finished_at: at }))),
          Effect.andThen(driver.stop),
          Effect.catch((e) =>
            Effect.flatMap(nowTimestamp, (at) => progress({ phase: "failed", error: e.reason, finished_at: at })).pipe(
              Effect.andThen(Effect.logError(`installing Cua Driver ${release.version} failed: ${e.reason}`)),
            ),
          ),
          Effect.ensuring(Deferred.succeed(done, undefined)),
          Effect.forkIn(scope),
        )
        return current
      })

      return CuaInstall.of({
        current: Ref.get(job),
        settled: Effect.gen(function* () {
          if (!going(yield* Ref.get(job))) return yield* Ref.get(job)
          yield* Deferred.await(yield* Ref.get(ended))
          return yield* Ref.get(job)
        }),
        start,
        install,
        uninstall: fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore, Effect.andThen(Ref.set(job, null))),
      })
    }),
  )
}
