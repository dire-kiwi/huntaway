import { Effect, FileSystem, Option, Schema } from "effect"
import { fromRecord, toRecord } from "./installed.ts"
import type { Installed } from "./installed.ts"
import { emptyInstalled } from "./installed.ts"
import { parseVersion } from "./semver.ts"
import { RELEASE_FILES } from "./tarball.ts"

// The per-user install folder release updates use, `<data dir>/app/` (docs/plan/inventory/05-hosts-update.md, 3.7):
// `<v>/` a release unpacked, `<v>.partial/` one being downloaded, `state.json` (shared with the desktop app). Reading
// and writing it; what changes is decided in installed.ts.

const StateJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** `app/<v>`, for a `v` that is a version (so it can't lead out of `app/`). */
export const versionDir = (app: string, v: string): string | null => (parseVersion(v) === null ? null : `${app}/${v}`)

/** Whether `dir` has what a server needs: itself, the shim its agents run under, and the UI it serves. */
export const complete = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = yield* Effect.forEach(
      RELEASE_FILES,
      (f) =>
        fs.stat(`${dir}/${f}`).pipe(
          Effect.map((i) => i.type === "File"),
          Effect.orElseSucceed(() => false),
        ),
      {
        concurrency: 1,
      },
    )
    return files.every(Boolean)
  })

/** `app/state.json`, or the default when there's none or it can't be read. */
export const readInstalled = (app: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${app}/state.json`).pipe(Effect.option)
    if (Option.isNone(text)) return emptyInstalled
    return yield* Schema.decodeEffect(StateJson)(text.value).pipe(
      Effect.map(fromRecord),
      Effect.catch((e) => Effect.logWarning(`ignoring ${app}/state.json: ${e.message}`).pipe(Effect.as(emptyInstalled))),
    )
  })

/** Write `app/state.json` through a temp file and a rename, so the desktop app never reads half of it. */
export const writeInstalled = (app: string, s: Installed) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* Schema.encodeEffect(StateJson)(toRecord(s)).pipe(Effect.orDie)
    const tmp = `${app}/state.json.${process.pid}.tmp`
    yield* fs.makeDirectory(app, { recursive: true })
    yield* fs.writeFileString(tmp, `${text}\n`)
    yield* fs.rename(tmp, `${app}/state.json`).pipe(Effect.tapError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)))
  })

/** The version this server runs from `app/`, when its launcher (`exe`) is `<app>/<v>/huntaway`. */
export const runningFromApp = (app: string, exe: string | null) =>
  Effect.gen(function* () {
    if (exe === null) return null
    const fs = yield* FileSystem.FileSystem
    const real = yield* fs.realPath(exe).pipe(Effect.orElseSucceed(() => null))
    const root = yield* fs.realPath(app).pipe(Effect.orElseSucceed(() => null))
    if (real === null || root === null || !real.endsWith("/huntaway")) return null
    const dir = real.slice(0, -"/huntaway".length)
    const v = dir.slice(dir.lastIndexOf("/") + 1)
    return dir.slice(0, dir.lastIndexOf("/")) === root && parseVersion(v) !== null ? v : null
  })
