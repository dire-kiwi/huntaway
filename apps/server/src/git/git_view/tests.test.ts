// Port of server/src/git/git_view/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../../api.ts";
import * as db from "../../db.ts";
import type { Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import * as testing from "../../testing.ts";
import { path_str } from "../../util.ts";
import * as worktree from "../worktree.ts";
import { apply, check_path, check_rev, commit, diff, discard, parse_status, reset, show, stage, stash, status, unstage } from "../git_view.ts";

function sh(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new Error(`git ${JSON.stringify(args)}: ${e.stderr}`);
  }
}

function req(id: string, o: { query?: Record<string, string>; body?: any } = {}): Req {
  return { method: "GET", path: "", params: { id }, query: o.query ?? {}, query_string: "", headers: {}, body: o.body ?? {}, raw: Buffer.alloc(0) };
}

/** The status code an API call fails with. */
async function fails(p: Promise<any>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e: any) {
    return { status: e.status, message: e.message };
  }
  assert.fail("expected an error");
}

test("reads_the_porcelain_status", () => {
  const out =
    "# branch.oid 0123abcd\0# branch.head ia/x-1\0# branch.upstream origin/ia/x-1\0# branch.ab +2 -1\0" +
    "1 .M N... 100644 100644 100644 aa aa src/a b.rs\0" +
    "2 R. N... 100644 100644 100644 aa aa R100 new name\0old name\0" +
    "u UU N... 100644 100644 100644 100644 aa bb cc both\0" +
    "? new dir/x\0";
  const st = parse_status(out);
  assert.deepEqual([st.head, st.branch, st.upstream], ["0123abcd", "ia/x-1", "origin/ia/x-1"]);
  assert.deepEqual([st.ahead, st.behind, st.truncated], [2, 1, false]);
  const f = (path: string, orig: string | null, x: string, y: string) => ({ path, orig_path: orig, x, y });
  assert.deepEqual(st.files, [f("src/a b.rs", null, " ", "M"), f("new name", "old name", "R", " "), f("both", null, "U", "U"), f("new dir/x", null, "?", "?")]);
  // Before the first commit, and detached.
  const st2 = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
  assert.deepEqual([st2.head, st2.branch, st2.files.length], [null, null, 0]);
});

test("checks_paths_and_hashes", () => {
  for (const ok of ["a", "a/b c", "./a", ".hidden/x"]) assert.doesNotThrow(() => check_path(ok), ok);
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x"]) assert.throws(() => check_path(bad), bad);
  assert.doesNotThrow(() => check_rev("0123abcdef"));
  for (const bad of ["--hard", "HEAD", "abc", "0123abcz", "a".repeat(65)]) assert.throws(() => check_rev(bad), bad);
});

const lines20 = () => Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("");

/**
 * A task with a worktree on a branch with one commit ("branch work"), in a repository whose master has `f.txt` (20
 * numbered lines) and `gone.txt`: the task and its worktree.
 */
async function task_repo(s: AppState): Promise<[string, string]> {
  const profile = db.insert_profile(s.db(), "p", [], null);
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  sh(repo, ["config", "user.name", "t"]);
  sh(repo, ["config", "user.email", "t@t"]);
  writeFileSync(join(repo, "f.txt"), lines20());
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  const b = { name: "x", repo_path: path_str(repo), key: "X", base_branch: "master", use_worktrees: null };
  const p = await api.create_project_inner(s, profile.id, b as any);
  const t0 = api.create_task_inner(s, p.id, { title: "Do it" } as any);
  const t = await worktree.setup(s, t0.id);
  const wt = t.worktree_path!;
  writeFileSync(join(wt, "b.txt"), "b\n");
  sh(wt, ["add", "b.txt"]);
  sh(wt, ["commit", "-qm", "branch work"]);
  return [t.id, wt];
}

const get_status = async (s: AppState, id: string) => await status(s, req(id));

async function get_diff(s: AppState, id: string, path: string, staged: boolean, untracked: boolean): Promise<string> {
  return (await diff(s, req(id, { query: { path, staged: String(staged), untracked: String(untracked) } }))).patch;
}

const paths = (p: string[]) => ({ paths: p });

test("stages_lines_and_files_and_discards_them", async () => {
  const s = testing.state();
  const [id, wt] = await task_repo(s);
  const at = (body: any) => req(id, { body });
  const f = Array.from({ length: 20 }, (_, k) => k + 1).map((i) => (i === 2 ? "two\n" : i === 15 ? "fifteen\n" : `${i}\n`)).join("");
  writeFileSync(join(wt, "f.txt"), f);
  unlinkSync(join(wt, "gone.txt"));
  mkdirSync(join(wt, "new"), { recursive: true });
  writeFileSync(join(wt, "new/u.txt"), "u1\nu2\n");

  const st = await get_status(s, id);
  const files = st.files.map((f: any) => `${f.x}${f.y} ${f.path}`);
  assert.deepEqual(files, [" M f.txt", " D gone.txt", "?? new/u.txt"]);
  assert.deepEqual([st.base, st.branch], ["master", sh(wt, ["branch", "--show-current"]).trim()]);
  const commits = st.commits.map((c: any) => [c.subject, c.on_branch]);
  assert.deepEqual(commits, [["branch work", true], ["init", false]]);

  // Two hunks: staging a patch of the first stages just that.
  const patch = await get_diff(s, id, "f.txt", false, false);
  assert.equal(patch.split("\n@@ ").length - 1, 2, patch);
  const first = patch.slice(0, patch.lastIndexOf("\n@@ ") + 1);
  await apply(s, at({ patch: first, cached: true, reverse: false }));
  const staged = await get_diff(s, id, "f.txt", true, false);
  assert.ok(staged.includes("+two\n") && !staged.includes("fifteen"), staged);
  // …and its reverse unstages it again.
  await apply(s, at({ patch: staged, cached: true, reverse: true }));
  assert.equal(await get_diff(s, id, "f.txt", true, false), "");
  // A patch that no longer fits is refused, with git's reason.
  const err = await fails(apply(s, at({ patch: first.replace("-2\n", "-3\n"), cached: true, reverse: false })));
  assert.equal(err.status, 409, err.message);

  // An untracked file's diff is as if it were added.
  const u = await get_diff(s, id, "new/u.txt", false, true);
  assert.ok(u.includes("new file mode") && u.includes("+++ b/new/u.txt") && u.includes("+u2\n"), u);
  assert.equal((await fails(diff(s, req(id, { query: { path: "../x", staged: "false", untracked: "true" } })))).status, 400);

  // Whole files, and everything.
  await stage(s, at(paths(["gone.txt"])));
  assert.equal((await get_status(s, id)).files[1].x, "D");
  await stage(s, at(paths([])));
  const xy = (await get_status(s, id)).files.map((f: any) => `${f.x}${f.y}`);
  assert.deepEqual(xy, ["M ", "D ", "A "]);
  await unstage(s, at(paths(["f.txt"])));
  assert.equal((await get_status(s, id)).files[0].x, " ");
  await unstage(s, at(paths([])));
  assert.equal(await get_diff(s, id, ".", true, false), "");

  // Discarding what isn't staged goes back to the index; with `staged`, to HEAD.
  sh(wt, ["add", "new/u.txt"]);
  writeFileSync(join(wt, "new/u.txt"), "changed\n");
  await discard(s, at({ paths: ["gone.txt", "new/u.txt"], staged: false }));
  assert.equal(readFileSync(join(wt, "gone.txt"), "utf8"), "bye\n");
  assert.equal(readFileSync(join(wt, "new/u.txt"), "utf8"), "u1\nu2\n");
  sh(wt, ["add", "f.txt"]);
  writeFileSync(join(wt, "untracked.txt"), "x\n");
  await discard(s, at({ paths: ["f.txt", "new/u.txt", "untracked.txt"], staged: true }));
  assert.deepEqual((await get_status(s, id)).files, []);
  assert.ok(!existsSync(join(wt, "new/u.txt")) && !existsSync(join(wt, "untracked.txt")));
  assert.equal(readFileSync(join(wt, "f.txt"), "utf8"), lines20());
});

test("commits_stashes_and_resets", async () => {
  const s = testing.state();
  const [id, wt] = await task_repo(s);
  const at = (body: any) => req(id, { body });
  const subjects = async (): Promise<string[]> => (await get_status(s, id)).commits.map((c: any) => c.subject);
  const commit_with = (message: string, amend: boolean, reword: boolean) => commit(s, at({ message, amend, reword }));

  assert.equal((await fails(commit_with(" ", false, false))).status, 400);
  writeFileSync(join(wt, "c.txt"), "c\n");
  await stage(s, at(paths([])));
  await commit_with("add c\n\nwith a body", false, false);
  assert.deepEqual(await subjects(), ["add c", "branch work", "init"]);
  // Amending keeps the message; rewording leaves what's staged.
  writeFileSync(join(wt, "c.txt"), "cc\n");
  await stage(s, at(paths([])));
  await commit_with("", true, false);
  assert.deepEqual(await subjects(), ["add c", "branch work", "init"]);
  assert.equal(sh(wt, ["show", "HEAD:c.txt"]), "cc\n");
  writeFileSync(join(wt, "c.txt"), "ccc\n");
  await stage(s, at(paths([])));
  await commit_with("reworded", true, true);
  assert.deepEqual(await subjects(), ["reworded", "branch work", "init"]);
  assert.deepEqual([sh(wt, ["show", "HEAD:c.txt"]), sh(wt, ["show", ":c.txt"])], ["cc\n", "ccc\n"]);

  // A commit's message and changes.
  const head: string = (await get_status(s, id)).commits[0].sha;
  const shown = await show(s, req(id, { query: { rev: head, stash: "false" } }));
  assert.deepEqual([shown.message, shown.sha], ["reworded", head]);
  assert.ok(shown.patch.includes("+cc\n"));

  // Stash everything (untracked files too), then pop it, given the stash's commit.
  writeFileSync(join(wt, "u.txt"), "u\n");
  await stash(s, at({ action: "push", mode: null, message: "wip", index: null, sha: null }));
  let st = await get_status(s, id);
  assert.deepEqual(st.files, []);
  const sha: string = st.stashes[0].sha;
  assert.ok(st.stashes[0].subject.endsWith(": wip"));
  const stashed = await show(s, req(id, { query: { rev: sha, stash: "true" } }));
  assert.ok(stashed.patch.includes("+u\n"), JSON.stringify(stashed));
  const pop = (sha: string) => ({ action: "pop", mode: null, message: "", index: 0, sha });
  assert.equal((await fails(stash(s, at(pop(head))))).status, 409);
  await stash(s, at(pop(sha)));
  st = await get_status(s, id);
  assert.deepEqual([st.files.length, st.stashes.length], [2, 0]);

  // A soft reset keeps the undone commit's changes staged.
  const work: string = (await get_status(s, id)).commits[1].sha;
  assert.equal((await fails(reset(s, at({ rev: work, mode: "sideways" })))).status, 400);
  await reset(s, at({ rev: work, mode: "soft" }));
  assert.deepEqual(await subjects(), ["branch work", "init"]);
  assert.equal(sh(wt, ["diff", "--cached", "--name-only"]), "c.txt\n");
});

// HA-42: a project folder inside a bigger repository (a home folder kept as a dotfiles repository) staged, stashed and
// reset that whole repository.
test("a_folder_inside_a_bigger_repository_is_all_that_is_touched", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const home = testing.temp_dir();
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  sh(home, ["init", "-q", "-b", "master"]);
  sh(home, ["config", "user.name", "t"]);
  sh(home, ["config", "user.email", "t@t"]);
  writeFileSync(join(home, ".bashrc"), "rc\n");
  writeFileSync(join(proj, "a.txt"), "a\n");
  sh(home, ["add", "."]);
  sh(home, ["commit", "-qm", "dotfiles"]);
  writeFileSync(join(home, ".bashrc"), "rc\nmine\n");
  sh(home, ["commit", "-qam", "outside only"]);
  const b = { name: "x", repo_path: path_str(proj), key: "X", base_branch: null, use_worktrees: false };
  const p = await api.create_project_inner(s, profile.id, b as any);
  const id = api.create_task_inner(s, p.id, { title: "Do it" } as any).id;
  const at = (body: any) => req(id, { body });
  writeFileSync(join(home, ".bashrc"), "rc\nmine\nmore\n");
  writeFileSync(join(proj, "a.txt"), "a\nb\n");

  // Only the folder's files and commits.
  const st = await get_status(s, id);
  assert.equal(st.folder, "proj/");
  assert.deepEqual(st.files.map((f: any) => f.path), ["proj/a.txt"]);
  assert.deepEqual(st.commits.map((c: any) => c.subject), ["dotfiles"]);
  // Staging everything stages the folder's; files outside it can't be named.
  await stage(s, at(paths([])));
  assert.equal(sh(home, ["diff", "--cached", "--name-only"]), "proj/a.txt\n");
  assert.equal((await fails(stage(s, at(paths([".bashrc"]))))).status, 400);
  assert.equal((await fails(discard(s, at({ paths: [".bashrc"], staged: true })))).status, 400);
  const rc = sh(home, ["diff", "--", ".bashrc"]);
  const err = await fails(apply(s, at({ patch: rc, cached: true, reverse: false })));
  assert.equal(err.status, 400, err.message);
  const renamed = "diff --git a/proj/a.txt b/.profile\nsimilarity index 100%\nrename from proj/a.txt\nrename to .profile\n";
  assert.equal((await fails(apply(s, at({ patch: renamed, cached: true, reverse: false })))).status, 400);
  // What would act on the whole repository is refused.
  const head = sh(home, ["rev-parse", "HEAD"]).trim();
  const first = sh(home, ["rev-parse", "HEAD~"]).trim();
  assert.equal((await fails(reset(s, at({ rev: first, mode: "hard" })))).status, 409);
  assert.equal((await fails(stash(s, at({ action: "push", mode: null, message: "", index: null, sha: null })))).status, 409);
  assert.equal((await fails(commit(s, at({ message: "", amend: true, reword: false })))).status, 409);
  // A commit would take what's staged outside the folder too.
  sh(home, ["add", ".bashrc"]);
  const c = await fails(commit(s, at({ message: "a", amend: false, reword: false })));
  assert.ok(c.status === 409 && c.message.includes(".bashrc"), c.message);
  sh(home, ["reset", "-q", "--", ".bashrc"]);
  await commit(s, at({ message: "a", amend: false, reword: false }));
  assert.equal(sh(home, ["show", "--name-only", "--format=", "HEAD"]), "proj/a.txt\n");
  assert.equal(sh(home, ["rev-parse", "HEAD~"]).trim(), head);
  assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), "rc\nmine\nmore\n");
  rmSync(home, { recursive: true, force: true });
});

test("unstages_before_the_first_commit", async () => {
  const s = testing.state();
  const profile = db.insert_profile(s.db(), "p", [], null);
  const repo = testing.temp_dir();
  sh(repo, ["init", "-q", "-b", "master"]);
  const b = { name: "x", repo_path: path_str(repo), key: "X", base_branch: null, use_worktrees: false };
  const p = await api.create_project_inner(s, profile.id, b as any);
  const id = api.create_task_inner(s, p.id, { title: "Do it" } as any).id;
  const at = (body: any) => req(id, { body });
  writeFileSync(join(repo, "a"), "a\n");
  writeFileSync(join(repo, "b"), "b\n");
  await stage(s, at(paths([])));
  const st = await get_status(s, id);
  assert.deepEqual([st.head, st.commits, st.files[0].x], [null, [], "A"]);
  await unstage(s, at(paths(["a"])));
  assert.equal(sh(repo, ["diff", "--cached", "--name-only"]), "b\n");
  await unstage(s, at(paths([])));
  assert.equal(sh(repo, ["diff", "--cached", "--name-only"]), "");
});

// A patch made from a lossily decoded diff wrote U+FFFD into the index in place of a Latin-1 byte.
test("files_not_in_utf8_are_staged_whole_not_by_line", async () => {
  const s = testing.state();
  const [id, wt] = await task_repo(s);
  const raw = (rev: string) => execFileSync("git", ["-C", wt, "show", rev]);
  const get = (path: string, staged: boolean, untracked: boolean) =>
    diff(s, req(id, { query: { path, staged: String(staged), untracked: String(untracked) } }));
  // A Latin-1 line added to f.txt, and an untracked Latin-1 file.
  const f = Buffer.concat([readFileSync(join(wt, "f.txt")), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])]);
  writeFileSync(join(wt, "f.txt"), f);
  const latin = Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);
  writeFileSync(join(wt, "latin.txt"), latin);
  for (const [path, untracked, line] of [["f.txt", false, "+caf�\n"], ["latin.txt", true, "+na�ve\n"]] as const) {
    const d = await get(path, false, untracked);
    assert.deepEqual([d.patch, d.not_utf8], ["", true], `${path}: ${JSON.stringify(d)}`);
    assert.ok(d.preview.includes(line), `${path}: ${JSON.stringify(d)}`);
  }
  // Staged whole, their bytes are kept; and the staged diff isn't for staging by line either.
  await stage(s, req(id, { body: paths(["f.txt", "latin.txt"]) }));
  assert.deepEqual([raw(":f.txt"), raw(":latin.txt")], [f, latin]);
  assert.equal((await get("f.txt", true, false)).not_utf8, true);
  // UTF-8 text that isn't ASCII is staged by line as before.
  writeFileSync(join(wt, "utf8.txt"), "café\n");
  const d = await get("utf8.txt", false, true);
  assert.ok(d.patch.includes("+café\n") && d.not_utf8 === undefined, JSON.stringify(d));
});
