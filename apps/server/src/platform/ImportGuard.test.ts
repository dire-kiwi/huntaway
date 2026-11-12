import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { importedFolder, tempDir } from "@huntaway/testing"
import { ImportGuard } from "./ImportGuard.ts"
import { ServerConfig } from "./ServerConfig.ts"

// The guard (docs/plan/11-migration.md, The guard): a folder that was not imported starts as usual, a rehearsal's
// read-only, and a switch's not while a process has the old database open.

const guardOn = (dataDir: string) =>
  Effect.service(ImportGuard).pipe(Effect.provide(ImportGuard.layer.pipe(Layer.provide(ServerConfig.layerTest({ dataDir })))))

/** A process that has `file` open for the scope: it says so once it has. */
const holdOpen = (file: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", 'exec 3<"$1"; echo open; exec sleep 600', "sh", file]))
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "open"),
      Stream.runHead,
    )
    return handle.pid
  })

describe("ImportGuard", () => {
  it.live("a folder with no import.json starts as usual", () =>
    Effect.gen(function* () {
      const guard = yield* guardOn(yield* tempDir)
      assert.deepStrictEqual([guard.record, guard.readOnly], [null, false])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("a rehearsal's starts read-only, even while the old board's database is open", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: true })
      yield* holdOpen(`${folder.oldDir}/huntaway-2.db`)
      const guard = yield* guardOn(folder.dataDir)
      assert.deepStrictEqual([guard.readOnly, guard.record?.from], [true, folder.oldDir])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("a switch's refuses to start while a process has the old database open, and starts once none has", () =>
    Effect.gen(function* () {
      const folder = yield* importedFolder({ rehearsal: false })
      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          const pid = yield* holdOpen(`${folder.oldDir}/huntaway-2.db`)
          return [pid, yield* Effect.flip(guardOn(folder.dataDir))] as const
        }),
      )
      assert.strictEqual(refused[1]._tag, "StartupError")
      assert.include(refused[1].reason, `process ${refused[0]}`)
      assert.include(refused[1].reason, "stop the old server")
      const guard = yield* guardOn(folder.dataDir)
      assert.deepStrictEqual([guard.readOnly, guard.record?.rehearsal], [false, false])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.live("an import.json that doesn't read refuses to start", () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDir
      yield* (yield* FileSystem.FileSystem).writeFileString(`${dataDir}/import.json`, '{"rehearsal": tru').pipe(Effect.orDie)
      const refused = yield* Effect.flip(guardOn(dataDir))
      assert.include(refused.reason, "import.json")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
