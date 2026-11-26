/// <reference types="node" />
import { assert, it as test } from "@effect/vitest"
import { parseDiff, unquote } from "../../../src/components/changes/diffs"

// The old tests/diffs.test.ts's cases of reading diffs (HE-96: staging by line went with the lazygit-style view).

/** The thing at `i`, which the case knows is there. */
const nth = <T>(list: ReadonlyArray<T>, i = 0): T => {
  const x = list[i]
  if (x === undefined) throw new Error(`nothing at ${i}`)
  return x
}

test("reads files, hunks and line numbers", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@ function f() {",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10 +10,2 @@",
    " ten",
    "+eleven",
    "\\ No newline at end of file",
    "diff --git a/new file b/new file",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new file",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/old b/renamed",
    "similarity index 90%",
    "rename from old",
    "rename to renamed",
    "diff --git a/img.png b/img.png",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "Binary files a/img.png and /dev/null differ",
    "",
  ].join("\n")
  const all = parseDiff(patch)
  const [a, n, r, img] = [nth(all, 0), nth(all, 1), nth(all, 2), nth(all, 3)]
  assert.strictEqual(a.path, "src/a.ts")
  assert.deepStrictEqual([a.adds, a.dels, a.hunks.length], [2, 1, 2])
  assert.strictEqual(nth(a.hunks).heading, " function f() {")
  assert.deepStrictEqual(
    nth(a.hunks).lines.map((l) => [l.kind, l.text, l.old, l.new]),
    [
      [" ", "one", 1, 1],
      ["-", "two", 2, undefined],
      ["+", "TWO", undefined, 2],
      [" ", "three", 3, 3],
    ],
  )
  assert.deepStrictEqual(
    nth(a.hunks, 1).lines.map((l) => [l.kind, l.noEol]),
    [
      [" ", false],
      ["+", true],
    ],
  )
  assert.deepStrictEqual([n.path, n.oldPath, n.newPath, nth(n.hunks).oldCount, nth(n.hunks).newCount], ["new file", null, "new file", 0, 1])
  assert.deepStrictEqual([r.path, r.oldPath, r.hunks.length], ["renamed", "old", 0])
  assert.deepStrictEqual([img.path, img.newPath, img.binary], ["img.png", null, true])
  // A truncated patch stops where it stops.
  assert.strictEqual(nth(nth(parseDiff(patch.slice(0, patch.indexOf("+TWO")))).hunks).lines.length, 2)
})

test("reads quoted paths and conflicts", () => {
  assert.strictEqual(unquote('"a/caf\\303\\251 \\"x\\"\\ty"'), 'a/café "x"\ty')
  const q = nth(parseDiff('diff --git "a/caf\\303\\251" "b/caf\\303\\251"\n--- "a/caf\\303\\251"\n+++ "b/caf\\303\\251"\n@@ -1 +1 @@\n-a\n+b\n'))
  assert.strictEqual(q.path, "café")
  const c = nth(
    parseDiff("diff --cc both\nindex 1,2..3\n--- a/both\n+++ b/both\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< ours\n +a\n++=======\n+ b\n++>>>>>>> theirs\n"),
  )
  assert.strictEqual(c.combined, true)
  assert.strictEqual(c.path, "both")
  assert.strictEqual(c.raw.length, 6)
})
