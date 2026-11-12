import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Option } from "effect"
import { makeLegacyBoard } from "@huntaway/testing"
import { importLegacy } from "./run.ts"

// The importer's skeleton (docs/plan/11-migration.md, The importer): an old folder made from the old schema, imported.

const options = (from: string, dataDir: string) => ({ from, dataDir, check: true, force: false, rehearsal: false, database: Option.none<string>() })

describe("import-legacy", () => {
  it.effect("imports an empty old board, copies its identity, and writes import.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(makeLegacyBoard(`${tmp}/old`, { hostId: "old-host-1" }))
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.passes).toBe(true)
      expect((yield* fs.readFileString(`${tmp}/new/host_id`)).trim()).toBe("old-host-1")
      expect(yield* fs.readFileString(`${tmp}/new/import.json`)).toContain('"old_host_id":"old-host-1"')
      expect(yield* fs.exists(`${tmp}/new/board.db`)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("refuses a folder that already has a board.db", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(makeLegacyBoard(`${tmp}/old`))
      yield* fs.makeDirectory(`${tmp}/new`)
      yield* fs.writeFileString(`${tmp}/new/board.db`, "")
      const error = yield* Effect.flip(importLegacy(options(`${tmp}/old`, `${tmp}/new`)))
      expect(error.reason).toContain("has a board.db already")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("refuses an old board with threads not yet items, listing them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* makeLegacyBoard(`${tmp}/old`)
          yield* old.insert("profiles", { id: "p1", name: "Me", created_at: "2026-01-01T00:00:00.000Z" })
          yield* old.insert("projects", {
            id: "j1",
            profile_id: "p1",
            name: "Proj",
            key: "PRJ",
            repo_path: "/nonexistent/repo",
            scratch_path: "/nonexistent/scratch",
            worktrees_root: "/nonexistent/wt",
            created_at: "2026-01-01T00:00:00.000Z",
          })
          yield* old.insert("tasks", {
            id: "t1",
            profile_id: "p1",
            project_id: "j1",
            number: 7,
            title: "Old",
            thread_source: "messages",
            last_activity_at: "2026-01-01T00:00:00.000Z",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          })
        }),
      )
      const error = yield* Effect.flip(importLegacy(options(`${tmp}/old`, `${tmp}/new`)))
      expect(error.reason).toContain("PRJ-7")
      expect(yield* fs.exists(`${tmp}/new/board.db`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
