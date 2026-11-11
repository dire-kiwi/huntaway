import { assert, it as test } from "@effect/vitest"
import { parseDiff } from "../../../src/components/changes/diffs"
import { highlightable, langFor, MAX_LINES, sidesOf } from "../../../src/components/changes/highlight"

// The old tests/highlight.test.ts, every case.

/** A patch's first file, which the case knows is there. */
const first = (patch: string) => {
  const f = parseDiff(patch)[0]
  if (!f) throw new Error(`no file in\n${patch}`)
  return f
}

test("a file's language, by extension or name", () => {
  assert.strictEqual(langFor("app/src/components/Changes.tsx"), "tsx")
  assert.strictEqual(langFor("server/src/main.rs"), "rust")
  assert.strictEqual(langFor("Dockerfile"), "docker")
  assert.strictEqual(langFor("deploy/Dockerfile.dev"), "docker")
  assert.strictEqual(langFor("server/Cargo.lock"), "toml")
  assert.strictEqual(langFor("README.MD"), "markdown")
  assert.strictEqual(langFor(".env.local"), "dotenv")
  assert.strictEqual(langFor("LICENSE"), null)
  assert.strictEqual(langFor("photo.png"), null)
  assert.strictEqual(langFor(".gitignore"), null)
})

test("each hunk's old and new sides, and where each line is in them", () => {
  const f = first(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-let b = 2;",
      "+const b = 2;",
      " export { a };",
      "@@ -9 +9 @@",
      "-x",
      "+y",
      "",
    ].join("\n"),
  )
  const s = sidesOf(f)
  assert.deepStrictEqual(s.texts, ["const a = 1;\nlet b = 2;\nexport { a };", "const a = 1;\nconst b = 2;\nexport { a };", "x", "y"])
  // Context from the new side.
  assert.deepStrictEqual(s.at, [
    [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
    [
      [2, 0],
      [3, 0],
    ],
  ])
  assert.strictEqual(sidesOf(f), s)
})

test("files that aren't highlighted: no language, binary, or too big", () => {
  const big = first(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      `@@ -0,0 +1,${MAX_LINES + 1} @@`,
      ...Array.from({ length: MAX_LINES + 1 }, (_, i) => `+line ${i}`),
      "",
    ].join("\n"),
  )
  assert.strictEqual(highlightable(big), null)
  const bin = first(["diff --git a/a.ts b/a.ts", "Binary files a/a.ts and b/a.ts differ", ""].join("\n"))
  assert.strictEqual(highlightable(bin), null)
  const txt = first(["diff --git a/notes b/notes", "--- a/notes", "+++ b/notes", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"))
  assert.strictEqual(highlightable(txt), null)
  const ts = first(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"))
  assert.strictEqual(highlightable(ts), "typescript")
})
