import { beforeEach, assert, it as test } from "@effect/vitest"
import { parseDiff } from "../../../src/components/changes/diffs"

/** A patch's first file, which the case knows is there. */
const parseFirst = (patch: string) => {
  const f = parseDiff(patch)[0]
  if (!f) throw new Error(`no file in\n${patch}`)
  return [f] as const
}

// The old tests/lineComments.test.ts, every case. The review is kept in the browser's localStorage (through
// state/drafts.ts's atom): a stand-in for Node, set up before the module is loaded.

const store = new Map<string, string>()
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    addEventListener: () => {},
  },
})
const {
  commentLines: picked,
  editComment,
  getReview,
  lineRange,
  openDraft,
  removeComments,
  reviewMessage,
  saveDraft,
  setDraftNote,
  withComments,
  clearReview,
} = await import("../../../src/components/changes/lineComments")

/** `commentLines`, for lines the case knows are there. */
const commentLines = (...args: Parameters<typeof picked>) => {
  const c = picked(...args)
  if (!c) throw new Error("no lines")
  return c
}

const [file] = parseFirst(
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,4 @@ function f() {",
    " one",
    "-two",
    "+TWO",
    " three",
    " four",
    "@@ -10,3 +10,2 @@",
    " ten",
    "-eleven",
    " twelve",
    "",
  ].join("\n"),
)
const src = { key: "unstaged", label: "unstaged changes" }
const at = (hunk: number, ...lines: number[]) => lines.map((line) => ({ hunk, line }))

test("a comment's lines: numbered in the new file, or the old one when they were all removed", () => {
  const c = commentLines(file, src, at(0, 1, 2, 3))
  assert.deepStrictEqual(c, {
    where: "unstaged",
    source: "unstaged changes",
    path: "src/a.ts",
    side: "new",
    start: 2,
    end: 3,
    at: { side: "new", line: 3 },
    lines: ["-two", "+TWO", " three"],
  })
  assert.strictEqual(lineRange(c), "lines 2–3")
  const removed = commentLines(file, src, at(1, 1))
  assert.deepStrictEqual([removed.side, removed.start, removed.end, removed.at], ["old", 11, 11, { side: "old", line: 11 }])
  assert.strictEqual(lineRange(removed), "removed line 11")
  assert.strictEqual(picked(file, src, []), null)
})

test("lines across hunks have the next hunk's header between them", () => {
  const c = commentLines(file, src, [...at(0, 4), ...at(1, 0, 1)])
  assert.deepStrictEqual(c.lines, [" four", "@@ -10,3 +10,2 @@", " ten", "-eleven"])
  assert.deepStrictEqual([c.start, c.end, c.at], [4, 10, { side: "old", line: 11 }])
})

test("the message for the agent: each comment's file, lines, diff and note, in one", () => {
  const msg = reviewMessage([
    { ...commentLines(file, src, at(0, 1, 2)), id: "a", note: "Why upper case?" },
    { ...commentLines(file, { key: "commit:abc", label: "commit abc12345" }, at(1, 1)), id: "b", note: "  Keep this one.\n" },
  ])
  assert.strictEqual(
    msg,
    [
      "2 comments on the diff:",
      "",
      "**src/a.ts**, line 2 (unstaged changes):",
      "```diff",
      "-two",
      "+TWO",
      "```",
      "Why upper case?",
      "",
      "**src/a.ts**, removed line 11 (commit abc12345):",
      "```diff",
      "-eleven",
      "```",
      "Keep this one.",
    ].join("\n"),
  )
  assert.strictEqual(withComments("  Please fix these.  ", []), "Please fix these.")
  assert.match(
    withComments("Please fix these.", [{ ...commentLines(file, src, at(0, 1)), id: "a", note: "x" }]),
    /^Please fix these\.\n\nA comment on the diff:\n\n\*\*src/,
  )
})

test("a fence longer than the backticks in the lines", () => {
  const [md] = parseFirst(["diff --git a/r.md b/r.md", "--- a/r.md", "+++ b/r.md", "@@ -1 +1 @@", "-```sh", "+````sh", ""].join("\n"))
  const msg = reviewMessage([{ ...commentLines(md, src, at(0, 0, 1)), id: "a", note: "n" }])
  assert.match(msg, /^`{5}diff\n-```sh\n\+````sh\n`{5}\nn$/m)
})

beforeEach(() => clearReview("h", "t"))

test("drafts: opened once per line, saved with a note, edited in place, kept in localStorage", () => {
  const lines = commentLines(file, src, at(0, 2))
  const d = openDraft("h", "t", lines)
  // The same line again: the same draft, with the lines picked now.
  assert.strictEqual(openDraft("h", "t", commentLines(file, src, at(0, 1, 2))), d)
  assert.strictEqual(getReview("h", "t").drafts.length, 1)
  assert.deepStrictEqual(getReview("h", "t").drafts[0]?.lines, ["-two", "+TWO"])
  // No note, not added.
  assert.strictEqual(saveDraft("h", "t", d), false)
  setDraftNote("h", "t", d, " Upper case? ")
  assert.include(store.get("ia.review.h:t") ?? "", '"note":" Upper case? "')
  assert.strictEqual(saveDraft("h", "t", d), true)
  let r = getReview("h", "t")
  assert.deepStrictEqual([r.drafts.length, r.comments.length, r.comments[0]?.note], [0, 1, "Upper case?"])
  const id = r.comments[0]?.id ?? ""
  // Edited: a draft of it, which replaces it when saved.
  const e = editComment("h", "t", id) ?? ""
  assert.strictEqual(editComment("h", "t", id), e)
  setDraftNote("h", "t", e, "Lower case.")
  saveDraft("h", "t", e)
  r = getReview("h", "t")
  assert.deepStrictEqual(
    r.comments.map((c) => [c.id, c.note]),
    [[id, "Lower case."]],
  )
  // Sent (or deleted): gone, with any draft changing it.
  editComment("h", "t", id)
  removeComments("h", "t", [id])
  assert.deepStrictEqual(getReview("h", "t"), { comments: [], drafts: [] })
  assert.strictEqual(store.has("ia.review.h:t"), false)
})
