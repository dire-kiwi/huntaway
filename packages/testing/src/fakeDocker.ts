import { Effect, FileSystem, Schema } from "effect"
import { REPO_ROOT } from "./fakeAgent.ts"
import { tempDir } from "./TestBoard.ts"

// A fake Docker CLI for tests (HE-37, packages/testing): bin/fake-docker, which keeps its containers in a folder, logs
// what it was asked and runs nothing. `fakeDocker` makes a folder for one test and the CLI to give the server
// (`ServerConfig.dockerBin`).

/** bin/fake-docker. */
export const FAKE_DOCKER = `${REPO_ROOT}packages/testing/bin/fake-docker`

const Calls = Schema.Array(Schema.fromJsonString(Schema.Array(Schema.String)))
const Files = Schema.fromJsonString(
  Schema.Struct({ containers: Schema.Record(Schema.String, Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) })) }),
)

export interface FakeDocker {
  /** The CLI to give the server (`ServerConfig.dockerBin`): a script that runs bin/fake-docker over this folder. */
  readonly bin: string
  /** Every command it was given (its arguments), in order. */
  readonly calls: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  /** The files written into container `name`'s home, by path. */
  readonly files: (name: string) => Effect.Effect<Readonly<Record<string, string>>>
  /** The port every container's spacesd is on (a `fakeSpacesd`'s). */
  readonly setSpacesdPort: (port: number) => Effect.Effect<void>
  /** Make the engine unreachable, or reachable again. */
  readonly setDown: (down: boolean) => Effect.Effect<void>
}

/** A fake Docker in a temp folder of the scope's. */
export const fakeDocker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* tempDir
  const bin = `${dir}/docker`
  yield* fs.writeFileString(bin, `#!/bin/sh\nHUNTAWAY_FAKE_DOCKER_DIR='${dir}' exec '${FAKE_DOCKER}' "$@"\n`).pipe(Effect.orDie)
  yield* fs.chmod(bin, 0o755).pipe(Effect.orDie)
  const docker: FakeDocker = {
    bin,
    calls: fs.readFileString(`${dir}/calls.jsonl`).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) => Schema.decodeEffect(Calls)(text.split("\n").filter((l) => l !== ""))),
      Effect.orDie,
    ),
    files: (name) =>
      fs.readFileString(`${dir}/state.json`).pipe(
        Effect.flatMap((text) => Schema.decodeEffect(Files)(text)),
        Effect.map((s) => s.containers[name]?.files ?? {}),
        Effect.orDie,
      ),
    setSpacesdPort: (port) => fs.writeFileString(`${dir}/spacesd-port`, `${port}`).pipe(Effect.orDie),
    setDown: (down) => (down ? fs.writeFileString(`${dir}/down`, "") : fs.remove(`${dir}/down`, { force: true })).pipe(Effect.orDie),
  }
  return docker
})
