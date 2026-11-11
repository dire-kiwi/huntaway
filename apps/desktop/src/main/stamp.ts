import { Effect, FileSystem, Path } from "effect"
import { Digest } from "effect/crypto"

// The desktop app's stamps. The shell stamp is a hash of the running shell's folder (dist/) and the Electron that runs
// it: the main process relaunches an app run from a checkout when it changes on disk. The frame stamp covers only what a
// release can't update in place (boot.cjs, see src/boot/boot.ts, and Electron): the release workflow puts a release's
// in its manifest (`huntaway-<v>-release.json`, from `pnpm --filter huntaway-desktop run stamp`), so that the server can
// tell whether a newer release needs a new package or only changes the server, the UI and the rest of the shell. The
// same files give the same stamp from a checkout and from inside a packaged app's app.asar, as the old stamp.cjs had it.

/** The files an installed app can't take from a release: boot.cjs loads the rest from the release's own electron/. */
export const FRAME_FILES: ReadonlyArray<string> = ["boot.cjs"]

const encoder = new TextEncoder()

/** sha256 (hex) over each of `files` of `dir` (its name, then its contents), then `electronVersion`. */
const stampOf = Effect.fn("stamp")(function* (dir: string, files: ReadonlyArray<string>, electronVersion: string | null) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const digest = yield* Digest.Digest
  const parts = yield* Effect.forEach(files, (file) => Effect.map(fs.readFile(path.join(dir, file)), (contents) => [encoder.encode(file), contents]), {
    concurrency: 1,
  })
  const chunks = [...parts.flat(), ...(electronVersion === null ? [] : [encoder.encode(electronVersion)])]
  const all = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.length
  }
  return yield* digest.digestHex(Digest.sha256, all)
})

/** The stamp of every file in `dir`, sorted by name, and `electronVersion`. */
export const shellStamp = Effect.fn("shellStamp")(function* (dir: string, electronVersion: string | null) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(dir)
  return yield* stampOf(dir, names.toSorted(), electronVersion)
})

/** The stamp of the frame in `dir` (its boot.cjs) and `electronVersion`: what a release's manifest records. */
export const frameStamp = (dir: string, electronVersion: string | null) => stampOf(dir, FRAME_FILES, electronVersion)
