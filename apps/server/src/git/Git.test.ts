import { assert, describe, it as test, layer } from "@effect/vitest"
import { Effect } from "effect"
import { git, gitRepo, tempDir, TestBoard } from "@huntaway/testing"
import { Git } from "./Git.ts"
import { lines, pathStartsWith, samePath, stripPathPrefix } from "./paths.ts"

describe("paths", () => {
  test("compare by whole components", () => {
    assert.isTrue(pathStartsWith("/a/b/c", "/a/b"))
    assert.isTrue(pathStartsWith("/a/b/", "/a//b"))
    assert.isFalse(pathStartsWith("/a/bc", "/a/b"))
    assert.isTrue(pathStartsWith("/x", "/"))
    assert.strictEqual(stripPathPrefix("/a/b/c/d", "/a/b"), "c/d")
    assert.strictEqual(stripPathPrefix("/a/b", "/a/b/"), "")
    assert.strictEqual(stripPathPrefix("/a/bc", "/a/b"), null)
    assert.isTrue(samePath("/a//b/", "/a/b"))
    assert.deepStrictEqual(lines("a\r\nb\n\nc\n"), ["a", "b", "", "c"])
  })
})

layer(TestBoard())("Git", (it) => {
  it.effect("runs git in a folder, with its failures typed", () =>
    Effect.gen(function* () {
      const g = yield* Git
      const repo = yield* gitRepo
      assert.isTrue(yield* g.isRepo(repo))
      assert.isFalse(yield* g.isRepo(yield* tempDir))
      assert.strictEqual(yield* g.currentBranch(repo), "main")
      const head = yield* g.commit(repo, "HEAD")
      assert.match(head ?? "", /^[0-9a-f]{40}$/)
      assert.strictEqual(yield* g.commit(repo, "nope"), null)
      yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "two"])
      const two = yield* g.commit(repo, "HEAD")
      assert.isTrue(yield* g.isAncestor(repo, head ?? "", two ?? ""))
      assert.isFalse(yield* g.isAncestor(repo, two ?? "", head ?? ""))
      const failed = yield* Effect.flip(g.ok(repo, ["rev-parse", "--verify", "nope"]))
      assert.strictEqual(failed._tag, "GitFailed")
      assert.strictEqual(failed.command, "git rev-parse --verify nope")
      assert.strictEqual(failed.code, 128)
      // Its stdin, and a non-zero exit as a result.
      const hashed = yield* g.run(repo, ["hash-object", "--stdin"], { stdin: "hello\n" })
      assert.strictEqual(hashed.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a")
      assert.isFalse((yield* g.run(repo, ["merge-base", "--is-ancestor", "nope", "HEAD"])).ok)
    }),
  )

  it.effect("knows its worktrees and branch names", () =>
    Effect.gen(function* () {
      const g = yield* Git
      const repo = yield* gitRepo
      const other = `${yield* tempDir}/wt`
      yield* git(repo, ["worktree", "add", "-q", "-b", "side", other])
      assert.strictEqual(yield* g.checkedOutIn(repo, "refs/heads/side"), yield* g.canonicalize(other))
      assert.strictEqual(yield* g.checkedOutIn(repo, "refs/heads/nope"), null)
      assert.isTrue(yield* g.isWorktreeOf(repo, other))
      assert.isTrue(yield* g.isWorktreeOf(repo, repo))
      assert.isFalse(yield* g.isWorktreeOf(repo, yield* tempDir))
      assert.isTrue(yield* g.validBranchName("ia/he-1-thing"))
      assert.isFalse(yield* g.validBranchName("a..b"))
      assert.isFalse(yield* g.validBranchName("@{-1}"))
      // Bytes, cut at the cap.
      const out = yield* g.bytes(repo, ["log", "--format=%H"], { maxBytes: 10 })
      assert.isTrue(out.truncated)
      assert.strictEqual(out.stdout.length, 10)
    }),
  )
})
