import { assert, it as test } from "@effect/vitest"
import { pieces, splitLines } from "../../../src/components/code/lines"
import { ancestors, buildTree, findFiles, rows } from "../../../src/components/code/tree"

// HE-79: the Code tab's tree, finder and lines.

const PATHS = ["README.md", "src/a/b/deep.ts", "src/main.ts", "src/util/x.ts", "src/util/y.ts", "web/src/App.tsx", "web/package.json", "Cargo.toml"]
const shown = (open: ReadonlyArray<string>, root: string | null = null) =>
  rows(buildTree(PATHS, root), new Set(open)).map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? (r.open ? "v " : "> ") : ""}${r.name}`)

test("the tree: folders first, by name, a folder of one folder on one row", () => {
  assert.deepStrictEqual(shown([]), ["> src", "> web", "Cargo.toml", "README.md"])
  assert.deepStrictEqual(shown(["src"]), ["v src", "  > a/b", "  > util", "  main.ts", "> web", "Cargo.toml", "README.md"])
  // The row of `a/b` is the folder `src/a/b`.
  assert.deepStrictEqual(shown(["src", "src/a/b"]).slice(0, 3), ["v src", "  v a/b", "    deep.ts"])
  // From the project's folder, when it's part of the repository.
  assert.deepStrictEqual(shown(["web/src"], "web/"), ["v src", "  App.tsx", "package.json"])
  assert.deepStrictEqual(ancestors("src/a/b/deep.ts"), ["src", "src/a", "src/a/b"])
  assert.deepStrictEqual(ancestors("README.md"), [])
})

test("the finder: in the name first, then across folders, then scattered", () => {
  assert.deepStrictEqual(findFiles(PATHS, "main"), ["src/main.ts"])
  assert.deepStrictEqual(findFiles(PATHS, "x.ts").slice(0, 1), ["src/util/x.ts"])
  assert.deepStrictEqual(findFiles(PATHS, "utilx"), ["src/util/x.ts"])
  assert.deepStrictEqual(findFiles(PATHS, "src app"), ["web/src/App.tsx"])
  assert.deepStrictEqual(findFiles(PATHS, "TS").slice(0, 2), ["src/main.ts", "src/util/x.ts"])
  assert.deepStrictEqual(findFiles(PATHS, ""), [])
  assert.deepStrictEqual(findFiles(PATHS, "zzz"), [])
})

test("a line's pieces: its runs, cut at the symbol's uses", () => {
  const text = "const foo = foo2(foo)"
  // const·, foo·=·, foo2(foo)
  const runs: Array<[number, number]> = [
    [6, 1],
    [6, 0],
    [9, 2],
  ]
  const p = pieces(text, runs, "foo")
  assert.deepStrictEqual(
    p.map((x) => [x.text, x.style, x.mark]),
    [
      ["const ", 1, false],
      ["foo", 0, true],
      [" = ", 0, false],
      ["foo2(", 2, false],
      ["foo", 2, true],
      [")", 2, false],
    ],
  )
  assert.strictEqual(p.map((x) => x.text).join(""), text)
  assert.deepStrictEqual(
    pieces("a b", undefined, null).map((x) => [x.text, x.style, x.mark]),
    [["a b", 0, false]],
  )
  // Runs that stop short of the line's end leave the rest plain.
  assert.deepStrictEqual(
    pieces("abcdef", [[3, 4]], null).map((x) => [x.text, x.style]),
    [
      ["abc", 4],
      ["def", 0],
    ],
  )
  assert.deepStrictEqual(pieces("", undefined, "x"), [])
  assert.deepStrictEqual(splitLines("a\r\nb\n"), ["a", "b"])
  assert.deepStrictEqual(splitLines(""), [""])
  assert.deepStrictEqual(splitLines("a\n\n"), ["a", ""])
})
