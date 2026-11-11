import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { asObject, markBad } from "../shared/versions.ts"

// `<data dir>/app/state.json`, shared with the server's `Releases` service (shared/versions.ts has the protocol). Read as
// an object with every key kept; written through a temp file and a rename, so that the server never reads half of it.

const Json = Schema.fromJsonString(Schema.Unknown)
/** As both writers write it: two-space indented. */
const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })

/** A JSON file's object, or `{}` when there is none, it does not parse, or it is not an object. */
export const readJsonObject = Effect.fn("appState.readJson")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file).pipe(Effect.option)
  if (Option.isNone(text)) return asObject(undefined)
  return asObject(Option.getOrUndefined(yield* Schema.decodeEffect(Json)(text.value).pipe(Effect.option)))
})

/** `app/state.json`, or `{}` when there is none (no version downloaded yet) or it can't be read. */
export const readAppState = Effect.fn("appState.read")(function* (appDir: string) {
  const path = yield* Path.Path
  return yield* readJsonObject(path.join(appDir, "state.json"))
})

/** Write `value` as JSON to `file`, through `<file>.<pid>.tmp` and a rename. */
export const writeJsonFile = Effect.fn("appState.writeJson")(function* (file: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* Schema.encodeEffect(PrettyJson)(value).pipe(Effect.orDie)
  const tmp = `${file}.${process.pid}.tmp`
  yield* fs.writeFileString(tmp, `${text}\n`)
  yield* fs.rename(tmp, file)
})

/** Add `version` to state.json's `bad` (and clear `trying` if it is that one), keeping every other key. */
export const markVersionBad = Effect.fn("appState.markBad")(function* (appDir: string, version: string) {
  const path = yield* Path.Path
  const state = yield* readAppState(appDir)
  yield* writeJsonFile(path.join(appDir, "state.json"), markBad(state, version))
})
