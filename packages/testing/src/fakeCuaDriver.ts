import { Effect, FileSystem, Schema } from "effect"
import { REPO_ROOT } from "./fakeAgent.ts"
import { tempDir } from "./TestBoard.ts"

// A fake Cua Driver for tests (6.10, docs/plan/10-testing.md, packages/testing): bin/fake-cua-driver, which answers the
// board's driver calls with canned results, logs what it was called with, and never touches the desktop. `fakeCuaDriver`
// makes a folder for one test and the driver to give the server (`ServerConfig.cuaDriver`).

/** bin/fake-cua-driver. */
export const FAKE_CUA_DRIVER = `${REPO_ROOT}packages/testing/bin/fake-cua-driver`

/** A call the fake driver was given. */
export const FakeCuaCall = Schema.Struct({ tool: Schema.String, args: Schema.Record(Schema.String, Schema.Unknown) })
export type FakeCuaCall = typeof FakeCuaCall.Type

const Calls = Schema.Array(Schema.fromJsonString(FakeCuaCall))

export interface FakeCuaDriver {
  /** The driver to give the server (`ServerConfig.cuaDriver`): a script that runs bin/fake-cua-driver over this folder. */
  readonly bin: string
  /** Every tool call the driver was given, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<FakeCuaCall>>
  /** Make the driver's `tool` fail from now on (null: none). */
  readonly fail: (tool: string | null) => Effect.Effect<void>
}

/** A fake driver in a temp folder of the scope's. */
export const fakeCuaDriver = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* tempDir
  const bin = `${dir}/cua-driver`
  yield* fs.writeFileString(bin, `#!/bin/sh\nHUNTAWAY_FAKE_CUA_DIR='${dir}' exec '${FAKE_CUA_DRIVER}' "$@"\n`).pipe(Effect.orDie)
  yield* fs.chmod(bin, 0o755).pipe(Effect.orDie)
  const driver: FakeCuaDriver = {
    bin,
    calls: fs.readFileString(`${dir}/calls.jsonl`).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) => Schema.decodeEffect(Calls)(text.split("\n").filter((l) => l !== ""))),
      Effect.orDie,
    ),
    fail: (tool) => (tool === null ? fs.remove(`${dir}/fail`, { force: true }) : fs.writeFileString(`${dir}/fail`, tool)).pipe(Effect.orDie),
  }
  return driver
})
