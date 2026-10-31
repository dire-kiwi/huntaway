import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "../src/changes.ts";
import { highlightable, langFor, MAX_LINES, sidesOf } from "../src/highlight.ts";

test("a file's language, by extension or name", () => {
  assert.equal(langFor("app/src/components/Changes.tsx"), "tsx");
  assert.equal(langFor("server/src/main.rs"), "rust");
  assert.equal(langFor("Dockerfile"), "docker");
  assert.equal(langFor("deploy/Dockerfile.dev"), "docker");
  assert.equal(langFor("server/Cargo.lock"), "toml");
  assert.equal(langFor("README.MD"), "markdown");
  assert.equal(langFor(".env.local"), "dotenv");
  assert.equal(langFor("LICENSE"), null);
  assert.equal(langFor("photo.png"), null);
  assert.equal(langFor(".gitignore"), null);
});

test("each hunk's old and new sides, and where each line is in them", () => {
  const [f] = parseDiff(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " const a = 1;", "-let b = 2;", "+const b = 2;", " export { a };", "@@ -9 +9 @@", "-x", "+y", ""].join("\n"),
  );
  const s = sidesOf(f);
  assert.deepEqual(s.texts, ["const a = 1;\nlet b = 2;\nexport { a };", "const a = 1;\nconst b = 2;\nexport { a };", "x", "y"]);
  // Context from the new side.
  assert.deepEqual(s.at, [
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
  ]);
  assert.equal(sidesOf(f), s);
});

test("files that aren't highlighted: no language, binary, or too big", () => {
  const big = parseDiff(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", `@@ -0,0 +1,${MAX_LINES + 1} @@`, ...Array.from({ length: MAX_LINES + 1 }, (_, i) => `+line ${i}`), ""].join("\n"),
  )[0];
  assert.equal(highlightable(big), null);
  const [bin] = parseDiff(["diff --git a/a.ts b/a.ts", "Binary files a/a.ts and b/a.ts differ", ""].join("\n"));
  assert.equal(highlightable(bin), null);
  const [txt] = parseDiff(["diff --git a/notes b/notes", "--- a/notes", "+++ b/notes", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
  assert.equal(highlightable(txt), null);
  const [ts] = parseDiff(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
  assert.equal(highlightable(ts), "typescript");
});
