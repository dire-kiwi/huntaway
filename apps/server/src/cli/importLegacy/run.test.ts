import { NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { makeLegacyBoard } from "@huntaway/testing"
import { importLegacy } from "./run.ts"

// The importer's skeleton (docs/plan/11-migration.md, The importer): an old folder made from the old schema, imported.

const options = (from: string, dataDir: string) => ({ from, dataDir, check: true, force: false, rehearsal: false, database: Option.none<string>() })

/** An old board with one profile named `name`, and the host id `hostId`. */
const oldBoardWith = (root: string, hostId: string, name: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const old = yield* makeLegacyBoard(root, { hostId })
      yield* old.insert("profiles", { id: `p-${hostId}`, name, created_at: "2026-01-01T00:00:00.000Z" })
    }),
  )

/** `statement` on the board in `dataDir`, with its foreign keys off. */
const onBoard = <A extends object>(dataDir: string, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`PRAGMA foreign_keys = OFF`)
      return yield* sql.unsafe<A>(statement)
    }).pipe(Effect.provide(Layer.orDie(SqliteClient.layer({ filename: `${dataDir}/board.db` })))),
  ).pipe(Effect.orDie)

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

  it.effect("an import whose files fail to copy leaves neither a board.db nor an import.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(makeLegacyBoard(`${tmp}/old`))
      yield* fs.makeDirectory(`${tmp}/old/attachments/a1`, { recursive: true })
      yield* fs.writeFileString(`${tmp}/old/attachments/a1/file.txt`, "x")
      // A file where the attachments folder goes: copying it fails.
      yield* fs.makeDirectory(`${tmp}/new`)
      yield* fs.writeFileString(`${tmp}/new/attachments`, "in the way")
      const exit = yield* Effect.exit(importLegacy(options(`${tmp}/old`, `${tmp}/new`)))
      expect(exit._tag).toBe("Failure")
      expect(yield* fs.exists(`${tmp}/new/board.db`)).toBe(false)
      expect(yield* fs.exists(`${tmp}/new/board.db.partial`)).toBe(false)
      expect(yield* fs.exists(`${tmp}/new/import.json`)).toBe(false)
      // So a new try is not refused for a board.db, once what was in the way is gone.
      yield* fs.remove(`${tmp}/new/attachments`)
      const again = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(again.passes).toBe(true)
      expect(yield* fs.exists(`${tmp}/new/import.json`)).toBe(true)
      expect(yield* fs.readFileString(`${tmp}/new/attachments/a1/file.txt`)).toBe("x")
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
      expect(error._tag === "StartupError" ? error.reason : error.message).toContain("has a board.db already")
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
          yield* old.insert("messages", { task_id: "t1", kind: "user", data: '{"text":"hi"}', created_at: "2026-01-01T00:00:00.000Z" })
        }),
      )
      const error = yield* Effect.flip(importLegacy(options(`${tmp}/old`, `${tmp}/new`)))
      expect(error._tag === "StartupError" ? error.reason : error.message).toContain("PRJ-7")
      expect(yield* fs.exists(`${tmp}/new/board.db`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
  it.effect("imports a task not yet moved onto items that has no messages: there is nothing to convert", () =>
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
      const result = yield* importLegacy(options(`${tmp}/old`, `${tmp}/new`))
      expect(result.report.tables["tasks"]).toEqual({ old: 1, written: 1, withheld: 0 })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("--replace sets the board already there aside and imports in its place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoardWith(`${tmp}/a`, "host-a", "Board A")
      yield* oldBoardWith(`${tmp}/b`, "host-b", "Board B")
      yield* importLegacy(options(`${tmp}/a`, `${tmp}/new`))
      // What the replaced board leaves in place: its worktrees, registered in their repositories by path.
      yield* fs.makeDirectory(`${tmp}/new/projects/j1/worktrees/1-x`, { recursive: true })
      yield* fs.makeDirectory(`${tmp}/new/runs/r1`, { recursive: true })
      const result = yield* importLegacy({ ...options(`${tmp}/b`, `${tmp}/new`), replace: true })
      expect(result.passes).toBe(true)
      expect(result.checkOnly).toBe(false)
      expect((yield* fs.readFileString(`${tmp}/new/host_id`)).trim()).toBe("host-b")
      const profiles = yield* onBoard<{ readonly name: string }>(`${tmp}/new`, `SELECT name FROM profiles`)
      expect(profiles.map((p) => p.name)).toEqual(["Board B"])
      expect(yield* fs.exists(`${tmp}/new/projects/j1/worktrees/1-x`)).toBe(true)
      expect(yield* fs.exists(`${tmp}/new/runs/r1`)).toBe(false)
      // The replaced board, whole, in replaced-<time>/.
      const aside = result.replaced
      expect(aside).not.toBeNull()
      if (aside === null) return
      expect(aside.startsWith(`${yield* fs.realPath(`${tmp}/new`)}/replaced-`)).toBe(true)
      expect((yield* fs.readFileString(`${aside}/host_id`)).trim()).toBe("host-a")
      expect(yield* fs.readFileString(`${aside}/import.json`)).toContain('"old_host_id":"host-a"')
      expect(yield* fs.exists(`${aside}/runs/r1`)).toBe(true)
      const before = yield* onBoard<{ readonly name: string }>(aside, `SELECT name FROM profiles`)
      expect(before.map((p) => p.name)).toEqual(["Board A"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("--replace on a folder with no board imports as usual", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoardWith(`${tmp}/b`, "host-b", "Board B")
      const result = yield* importLegacy({ ...options(`${tmp}/b`, `${tmp}/new`), replace: true })
      expect(result.passes).toBe(true)
      expect(result.replaced).toBeNull()
      expect((yield* fs.readDirectory(`${tmp}/new`)).filter((n) => n.startsWith("replaced-"))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("--replace puts the board back as it was when the import fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoardWith(`${tmp}/a`, "host-a", "Board A")
      yield* oldBoardWith(`${tmp}/b`, "host-b", "Board B")
      yield* importLegacy(options(`${tmp}/a`, `${tmp}/new`))
      yield* fs.makeDirectory(`${tmp}/new/runs/r1`, { recursive: true })
      const failing = { name: "failing", reads: [], writes: [], run: () => Effect.die("a family failed") }
      const exit = yield* Effect.exit(importLegacy({ ...options(`${tmp}/b`, `${tmp}/new`), replace: true }, [failing]))
      expect(exit._tag).toBe("Failure")
      expect((yield* fs.readFileString(`${tmp}/new/host_id`)).trim()).toBe("host-a")
      expect(yield* fs.readFileString(`${tmp}/new/import.json`)).toContain('"old_host_id":"host-a"')
      expect(yield* fs.exists(`${tmp}/new/runs/r1`)).toBe(true)
      expect(yield* fs.exists(`${tmp}/new/board.db.partial`)).toBe(false)
      expect((yield* fs.readDirectory(`${tmp}/new`)).filter((n) => n.startsWith("replaced-"))).toEqual([])
      const profiles = yield* onBoard<{ readonly name: string }>(`${tmp}/new`, `SELECT name FROM profiles`)
      expect(profiles.map((p) => p.name)).toEqual(["Board A"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("--replace refuses a board with live runs, unless --force", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* fs.makeTempDirectoryScoped()
      yield* oldBoardWith(`${tmp}/a`, "host-a", "Board A")
      yield* oldBoardWith(`${tmp}/b`, "host-b", "Board B")
      yield* importLegacy(options(`${tmp}/a`, `${tmp}/new`))
      yield* onBoard(`${tmp}/new`, `INSERT INTO runs (id, task_id, status, created_at) VALUES ('live-run', 't1', 'running', '2026-01-01T00:00:00.000Z')`)
      const error = yield* Effect.flip(importLegacy({ ...options(`${tmp}/b`, `${tmp}/new`), replace: true }))
      expect(error._tag === "StartupError" ? error.reason : error.message).toContain("live-run")
      expect((yield* fs.readFileString(`${tmp}/new/host_id`)).trim()).toBe("host-a")
      const forced = yield* importLegacy({ ...options(`${tmp}/b`, `${tmp}/new`), replace: true, force: true })
      expect(forced.passes).toBe(true)
      expect((yield* fs.readFileString(`${tmp}/new/host_id`)).trim()).toBe("host-b")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
