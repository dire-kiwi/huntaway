import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { tempDir, TestBoard } from "@huntaway/testing"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { expandTilde, Folders, parentOf } from "./Folders.ts"

describe("Folders", () => {
  it.effect("lists subfolders sorted whatever their case, hidden ones and repositories flagged, files left out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDir
      for (const sub of ["b", "A", ".hidden", "repo/.git"]) yield* fs.makeDirectory(`${dir}/${sub}`, { recursive: true })
      yield* fs.writeFileString(`${dir}/file.txt`, "x")
      const listing = yield* (yield* Folders).list(dir)
      assert.deepStrictEqual(
        listing.entries.map((e) => [e.name, e.is_git, e.hidden]),
        [
          [".hidden", false, true],
          ["A", false, false],
          ["b", false, false],
          ["repo", true, false],
        ],
      )
      assert.deepStrictEqual([listing.path, listing.exists, listing.is_git, listing.parent], [dir, true, false, parentOf(dir)])
      assert.strictEqual(listing.entries[3]?.path, `${dir}/repo`)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("lists a missing absolute folder as empty, home for none, and refuses a missing relative one", () =>
    Effect.gen(function* () {
      const folders = yield* Folders
      const home = (yield* ServerConfig).home
      const missing = yield* folders.list("/nowhere/at/all")
      assert.deepStrictEqual(missing, { path: "/nowhere/at/all", parent: "/nowhere/at", exists: false, is_git: false, entries: [] })
      assert.strictEqual((yield* folders.list(undefined)).path, home)
      assert.strictEqual((yield* folders.list("  ")).path, home)
      assert.strictEqual((yield* folders.list("~")).path, home)
      const e = yield* Effect.flip(folders.list("no/such/folder"))
      assert.strictEqual(e.field, "path")
    }).pipe(Effect.provide(TestBoard())),
  )

  it("expands ~ and finds parents as Rust's Path::parent", () => {
    assert.strictEqual(expandTilde(" ~/src ", "/home/me"), "/home/me/src")
    assert.strictEqual(expandTilde("~work", "/home/me"), "~work")
    assert.deepStrictEqual(["/", "", "/a", "/a/b/", "a"].map(parentOf), [null, null, "/", "/a", ""])
  })
})
