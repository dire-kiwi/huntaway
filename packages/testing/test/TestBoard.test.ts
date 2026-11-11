import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { About } from "huntaway-server/src/settings/About.ts"
import { git, gitRepo } from "../src/git.ts"
import { TestBoard } from "../src/TestBoard.ts"

describe("TestBoard", () => {
  it.effect("builds the whole server on an in-memory database and a temp data folder", () =>
    Effect.gen(function* () {
      const about = yield* About
      const info = yield* about.info
      assert.strictEqual(info.read_only, false)
      assert.isTrue(info.data_dir.includes("huntaway-test-"))
    }).pipe(Effect.provide(TestBoard()), Effect.scoped),
  )

  it.effect("gitRepo is a repository with a commit on main, removed with its scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* gitRepo
          assert.strictEqual(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main")
          return repo
        }),
      )
      assert.isFalse(yield* fs.exists(dir))
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
