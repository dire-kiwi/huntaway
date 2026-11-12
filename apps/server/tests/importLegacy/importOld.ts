import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer, Option } from "effect"
import { makeLegacyBoard } from "@huntaway/testing"
import type { LegacyBoard } from "@huntaway/testing"
import { importLegacy } from "../../src/cli/importLegacy/run.ts"
import { Db } from "../../src/platform/Db.ts"

// For the importer's family tests (apps/server/src/cli/importLegacy/families/*.test.ts): an old folder with a profile,
// a project and a task to point at (written by `parents.ts`), imported, and the new board to read back through the
// server's repositories.

export const AT = "2026-01-01T00:00:00.000Z"

/** Profile `p1`, its project `j1` (key PRJ) and task `t1` (PRJ-1) in the old database. */
export const seedParents = (old: LegacyBoard) =>
  Effect.gen(function* () {
    yield* old.insert("profiles", { id: "p1", name: "Me", created_at: AT })
    yield* old.insert("projects", {
      id: "j1",
      profile_id: "p1",
      name: "Proj",
      key: "PRJ",
      repo_path: "/nonexistent/repo",
      scratch_path: "/nonexistent/scratch",
      worktrees_root: "/nonexistent/wt",
      created_at: AT,
    })
    yield* old.insert("tasks", {
      id: "t1",
      profile_id: "p1",
      project_id: "j1",
      number: 1,
      title: "Old",
      thread_source: "items",
      last_activity_at: AT,
      created_at: AT,
      updated_at: AT,
    })
  })

/**
 * An old folder in a temp folder with the parents and what `fill` puts in, imported (`rehearsal` or not) into a new
 * one. The import's result, and the new board's folder.
 */
export const importOld = <E, R>(fill: (old: LegacyBoard) => Effect.Effect<void, E, R>, options: { readonly rehearsal?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmp = yield* fs.makeTempDirectoryScoped()
    yield* Effect.scoped(
      Effect.gen(function* () {
        const old = yield* makeLegacyBoard(`${tmp}/old`)
        yield* seedParents(old)
        yield* fill(old)
      }),
    )
    const dataDir = `${tmp}/new`
    const result = yield* importLegacy({
      from: `${tmp}/old`,
      dataDir,
      check: false,
      force: false,
      rehearsal: options.rehearsal ?? false,
      database: Option.none(),
    })
    return { ...result, dataDir }
  })

/** `Db` over the new board's `board.db`, for the repositories that read it. */
const boardAt = (dataDir: string) => Layer.provideMerge(Db.layerOver, Layer.orDie(SqliteClient.layer({ filename: `${dataDir}/board.db` })))

/** `layer` (the repositories a test reads with) over the new board. */
export const onBoard = <ROut, E, RIn>(dataDir: string, layer: Layer.Layer<ROut, E, RIn>) => Layer.provide(layer, boardAt(dataDir))
