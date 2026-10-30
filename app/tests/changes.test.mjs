import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileRows, linesPatch, parseDiff, unquote } from "../src/changes.ts";

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
  ].join("\n");
  const [a, n, r, img] = parseDiff(patch);
  assert.equal(a.path, "src/a.ts");
  assert.deepEqual([a.adds, a.dels, a.hunks.length], [2, 1, 2]);
  assert.equal(a.hunks[0].heading, " function f() {");
  assert.deepEqual(
    a.hunks[0].lines.map((l) => [l.kind, l.text, l.old, l.new]),
    [[" ", "one", 1, 1], ["-", "two", 2, undefined], ["+", "TWO", undefined, 2], [" ", "three", 3, 3]],
  );
  assert.deepEqual(a.hunks[1].lines.map((l) => [l.kind, l.noEol]), [[" ", false], ["+", true]]);
  assert.deepEqual([n.path, n.oldPath, n.newPath, n.hunks[0].oldCount, n.hunks[0].newCount], ["new file", null, "new file", 0, 1]);
  assert.deepEqual([r.path, r.oldPath, r.hunks.length], ["renamed", "old", 0]);
  assert.deepEqual([img.path, img.newPath, img.binary], ["img.png", null, true]);
  // A truncated patch stops where it stops.
  assert.equal(parseDiff(patch.slice(0, patch.indexOf("+TWO")))[0].hunks[0].lines.length, 2);
});

test("reads quoted paths and conflicts", () => {
  assert.equal(unquote('"a/caf\\303\\251 \\"x\\"\\ty"'), 'a/café "x"\ty');
  const [q] = parseDiff('diff --git "a/caf\\303\\251" "b/caf\\303\\251"\n--- "a/caf\\303\\251"\n+++ "b/caf\\303\\251"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(q.path, "café");
  const [c] = parseDiff("diff --cc both\nindex 1,2..3\n--- a/both\n+++ b/both\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< ours\n +a\n++=======\n+ b\n++>>>>>>> theirs\n");
  assert.equal(c.combined, true);
  assert.equal(c.path, "both");
  assert.equal(c.raw.length, 6);
  assert.equal(linesPatch(c, () => true, false), null);
});

test("lists changed files as a tree, folders that only hold a folder run together", () => {
  const f = (path, x = " ", y = "M") => ({ path, orig_path: null, x, y });
  const files = [f("src/components/b.tsx"), f("src/components/a.tsx"), f("README.md"), f("src/x.ts"), f("deep/er/still/z")];
  const rows = (collapsed = new Set()) => fileRows(files, true, collapsed).map((r) => `${"  ".repeat(r.depth)}${r.name}${r.file ? "" : ` (${r.files.length})`}`);
  assert.deepEqual(rows(), ["deep/er/still (1)", "  z", "src (3)", "  components (2)", "    a.tsx", "    b.tsx", "  x.ts", "README.md"]);
  assert.deepEqual(rows(new Set(["src/components/"])), ["deep/er/still (1)", "  z", "src (3)", "  components (2)", "  x.ts", "README.md"]);
  assert.deepEqual(
    fileRows(files, false, new Set()).map((r) => r.name),
    ["README.md", "deep/er/still/z", "src/components/a.tsx", "src/components/b.tsx", "src/x.ts"],
  );
});

// Against git itself: random files and edits, random lines chosen, and what git makes of the patch
// compared with what choosing those lines means.

const dir = mkdtempSync(join(tmpdir(), "ia-changes-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { encoding: "utf8" });
const apply = (patch, ...flags) => {
  const r = spawnSync("git", ["-C", dir, "apply", "--whitespace=nowarn", ...flags, "-"], { input: patch, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git apply ${flags.join(" ")} failed: ${r.stderr}\n${patch}`);
};
git("init", "-q", "-b", "main");

// A small PRNG, so a failure can be run again.
let seed = 42;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const text = (lines, eol) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "");
const randomLines = (n) => Array.from({ length: n }, () => "abcdefgh"[rand(8)]);
const edit = (old) => {
  const out = [];
  for (const l of old) {
    const r = rand(10);
    if (r < 6) out.push(l);
    else if (r < 8) out.push(l + l);
    if (rand(6) === 0) out.push(...randomLines(1 + rand(3)));
  }
  if (rand(4) === 0) out.unshift(...randomLines(1 + rand(2)));
  return out;
};

/** What the file is after choosing some changes: the one side (base), with the chosen changes made (or undone, in reverse). */
function expected(base, file, chosen, reverse) {
  const lines = base.lines.slice();
  const out = [];
  let at = 0;
  let last = null;
  const flagLast = (noEol) => (last = noEol);
  file.hunks.forEach((h, hi) => {
    const start = (reverse ? h.newStart : h.oldStart) - ((reverse ? h.newCount : h.oldCount) ? 1 : 0);
    while (at < start) {
      out.push(lines[at++]);
      flagLast(at === lines.length && !base.eol);
    }
    h.lines.forEach((l, li) => {
      const c = chosen(hi, li);
      const keep = l.kind === " " || (reverse ? (l.kind === "-") === c : (l.kind === "+") === c);
      if (l.kind !== (reverse ? "-" : "+")) at++;
      if (keep) {
        out.push(l.text);
        flagLast(l.noEol);
      }
    });
  });
  while (at < lines.length) {
    out.push(lines[at++]);
    flagLast(at === lines.length && !base.eol);
  }
  return out.length ? out.join("\n") + (last ? "" : "\n") : "";
}

const choose = (file, odds) => {
  const picks = new Set();
  file.hunks.forEach((h, hi) => h.lines.forEach((l, li) => l.kind !== " " && rand(odds) === 0 && picks.add(`${hi}:${li}`)));
  return (hi, li) => picks.has(`${hi}:${li}`);
};
const index = (path) => git("show", `:${path}`);
const every = (file, chosen) => file.hunks.every((h, hi) => h.lines.every((l, li) => l.kind === " " || chosen(hi, li)));
const lines = (s) => ({ lines: s ? s.replace(/\n$/, "").split("\n") : [], eol: s.endsWith("\n") });

test("staging and unstaging chosen lines does what choosing them means", () => {
  for (let run = 0; run < 120; run++) {
    const old = randomLines(rand(14));
    const neu = edit(old);
    const [oldEol, newEol] = [rand(4) !== 0, rand(4) !== 0];
    const [before, now] = [text(old, oldEol), text(neu, newEol)];
    if (before === now) continue;
    writeFileSync(join(dir, "f"), before);
    git("add", "f");
    git("commit", "-q", "--allow-empty", "-m", `run ${run}`);
    writeFileSync(join(dir, "f"), now);
    // Staging from the working tree's diff.
    const [file] = parseDiff(git("diff", "--no-color", "--no-renames", "--", "f"));
    const chosen = choose(file, 2);
    const patch = linesPatch(file, chosen, false);
    if (patch) {
      apply(patch, "--cached");
      assert.equal(index("f"), expected(lines(before), file, chosen, false), `run ${run}: staging\n${patch}`);
    }
    // Unstaging from the index's diff (all of it staged first).
    git("add", "f");
    const [staged] = parseDiff(git("diff", "--cached", "--no-color", "--no-renames", "--", "f"));
    const unchosen = choose(staged, 2);
    const back = linesPatch(staged, unchosen, true);
    if (back) {
      apply(back, "--cached", "-R");
      assert.equal(index("f"), expected(lines(now), staged, unchosen, true), `run ${run}: unstaging\n${back}`);
    }
    // Discarding from the working tree's diff.
    git("reset", "-q", "--", "f");
    const [unstaged] = parseDiff(git("diff", "--no-color", "--no-renames", "--", "f"));
    const dropped = choose(unstaged, 2);
    const discard = linesPatch(unstaged, dropped, true);
    if (discard) {
      apply(discard, "-R");
      assert.equal(readFileSync(join(dir, "f"), "utf8"), expected(lines(now), unstaged, dropped, true), `run ${run}: discarding\n${discard}`);
    }
    git("checkout", "-q", "--", "f");
  }
});

test("part of a new or deleted file leaves it there, changed; all of it adds or removes it", () => {
  for (let run = 0; run < 40; run++) {
    const content = text(randomLines(1 + rand(8)), rand(3) !== 0);
    const all = run % 4 === 0;
    const pick = (f) => (all ? () => true : choose(f, 2));
    // Staging some of an untracked file's lines.
    writeFileSync(join(dir, "n"), content);
    const r = spawnSync("git", ["-C", dir, "diff", "--no-color", "--no-index", "--", "/dev/null", "n"], { encoding: "utf8" });
    const [file] = parseDiff(r.stdout);
    assert.equal(file.oldPath, null);
    let chosen = pick(file);
    const patch = linesPatch(file, chosen, false);
    if (patch) {
      apply(patch, "--cached");
      assert.equal(index("n"), expected({ lines: [], eol: true }, file, chosen, false), `run ${run}: staging new\n${patch}`);
    }
    // Unstaging some of a new file's.
    git("add", "n");
    const [added] = parseDiff(git("diff", "--cached", "--no-color", "--", "n"));
    chosen = pick(added);
    const back = linesPatch(added, chosen, true);
    if (back) {
      apply(back, "--cached", "-R");
      const left = expected(lines(content), added, chosen, true);
      if (every(added, chosen)) assert.equal(git("ls-files", "--", "n"), "", `run ${run}: unstaging all of a new file`);
      else assert.equal(index("n"), left, `run ${run}: unstaging new\n${back}`);
    }
    // Discarding some of an untracked file's.
    git("rm", "-q", "--cached", "--ignore-unmatch", "--", "n");
    chosen = pick(file);
    const discard = linesPatch(file, chosen, true);
    if (discard) {
      apply(discard, "-R");
      if (every(file, chosen)) assert.equal(existsSync(join(dir, "n")), false, `run ${run}: discarding all of a new file`);
      else assert.equal(readFileSync(join(dir, "n"), "utf8"), expected(lines(content), file, chosen, true), `run ${run}: discarding new\n${discard}`);
    }
    if (existsSync(join(dir, "n"))) unlinkSync(join(dir, "n"));
    // Staging some of a deleted file's removals, then unstaging some of a staged deletion.
    writeFileSync(join(dir, "d"), content);
    git("add", "d");
    git("commit", "-q", "-m", `d ${run}`);
    unlinkSync(join(dir, "d"));
    const [deleted] = parseDiff(git("diff", "--no-color", "--", "d"));
    assert.equal(deleted.newPath, null);
    chosen = pick(deleted);
    const del = linesPatch(deleted, chosen, false);
    if (del) {
      apply(del, "--cached");
      if (every(deleted, chosen)) assert.equal(git("ls-files", "--", "d"), "", `run ${run}: staging all of a deletion`);
      else assert.equal(index("d"), expected(lines(content), deleted, chosen, false), `run ${run}: staging deleted\n${del}`);
    }
    git("rm", "-q", "--cached", "--ignore-unmatch", "--", "d");
    const [gone] = parseDiff(git("diff", "--cached", "--no-color", "--", "d"));
    chosen = pick(gone);
    const undo = linesPatch(gone, chosen, true);
    if (undo) {
      apply(undo, "--cached", "-R");
      assert.equal(index("d"), expected({ lines: [], eol: true }, gone, chosen, true), `run ${run}: unstaging deleted\n${undo}`);
    }
    git("rm", "-q", "--cached", "--ignore-unmatch", "--", "d");
    git("commit", "-q", "--allow-empty", "-m", `d gone ${run}`);
  }
});
