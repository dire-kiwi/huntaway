import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Ref } from "effect"
import type { StartupStep } from "@huntaway/contracts"
import { Backup } from "./Backup.ts"
import { DataDir } from "./DataDir.ts"
import { Db } from "./Db.ts"
import { ServerConfig } from "./ServerConfig.ts"
import { StartupProgress } from "./StartupProgress.ts"

describe("Backup", () => {
  it.effect("says which file it copies the database to, and how big the copy will be, before it starts (HUNTAWAY_PROGRESS)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const steps = yield* Ref.make<ReadonlyArray<StartupStep>>([])
      const record = (step: StartupStep) => Ref.update(steps, (all) => [...all, step])
      yield* Effect.gen(function* () {
        const sql = (yield* Db).sql
        yield* sql`CREATE TABLE t (x BLOB)`
        yield* sql`INSERT INTO t VALUES (zeroblob(100000))`
        yield* (yield* Backup).beforeMigrate("2026-01-01-a", "2026-01-02-b")
      }).pipe(
        Effect.provideService(StartupProgress, record),
        Effect.provide(
          Backup.layer.pipe(
            Layer.provideMerge(Db.layerMemory),
            Layer.provide(Layer.succeed(DataDir, DataDir.make(root))),
            Layer.provide(ServerConfig.layerTest({ dataDir: root })),
          ),
        ),
      )
      const [step, ...more] = yield* Ref.get(steps)
      assert.strictEqual(more.length, 0)
      assert.strictEqual(step?.step, "backup")
      assert.isTrue((step?.total ?? 0) > 100_000)
      assert.match(step?.file ?? "", /\/backups\/board-2026-01-01-a-to-2026-01-02-b-.*Z\.db$/)
      assert.isTrue(yield* fs.exists(step?.file ?? ""))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
