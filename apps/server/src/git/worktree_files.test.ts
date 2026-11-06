// Port of the tests in server/src/git/worktree_files.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as api from "../api.ts";
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import { path_str } from "../util.ts";
import { remove_if_merged, remove_merged, setup, teardown } from "./worktree.ts";
import { bring_in, check, check_pattern, INCLUDE_FILE, link_path, literal_matches, relink } from "./worktree_files.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function sh(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new Error(`git ${JSON.stringify(args)}: ${e.stderr}`);
  }
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const is_symlink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const exists_l = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/** A repository with ignored files and folders, a folder outside it, and a project on it. */
interface Fixture {
  root: string;
  repo: string;
  outside: string;
  project_id: string;
}

async function fixture(s: AppState, copy_files: string, link_folders: string): Promise<Fixture> {
  const root = testing.temp_dir();
  const repo = join(root, "repo"),
    outside = join(root, "outside");
  mkdirSync(repo, { recursive: true });
  write(join(outside, "passwd"), "outside");
  sh(repo, ["init", "-q", "-b", "master"]);
  write(join(repo, ".gitignore"), ".env\nnode_modules/\ncache/\nbuild/\n*.local.json\nleak\nout-dir\nlinked-file\n");
  write(join(repo, "README"), "readme");
  write(join(repo, "config/app.local.json"), "tracked");
  write(join(repo, INCLUDE_FILE), "# from the repository\n/config/*.local.json\n");
  sh(repo, ["add", "."]);
  sh(repo, ["add", "-f", "config/app.local.json"]);
  sh(repo, ["commit", "-qm", "init"]);
  // Ignored, untracked: copied or linked.
  write(join(repo, ".env"), "secret");
  write(join(repo, "sub/.env"), "sub secret");
  write(join(repo, "config/dev.local.json"), "dev");
  write(join(repo, "build/out.txt"), "built");
  write(join(repo, "node_modules/pkg/index.js"), "module");
  write(join(repo, "cache/model.bin"), "weights");
  // The tracked file, changed in the repository folder: the worktree keeps its own.
  write(join(repo, "config/app.local.json"), "changed");
  // Untracked but not ignored: never copied.
  write(join(repo, "notes.txt"), "notes");
  // Ignored symlinks leading out of the repository.
  symlinkSync(join(outside, "passwd"), join(repo, "leak"));
  symlinkSync(outside, join(repo, "out-dir"));
  const profile = db.insert_profile(s.db(), "p", [], null);
  const p = await api.create_project_inner(s, profile.id, { name: "x", repo_path: path_str(repo), key: "X", base_branch: "master", use_worktrees: null });
  db.update_project(s.db(), p.id, [
    ["copy_files", copy_files],
    ["link_folders", link_folders],
  ]);
  return { root, repo, outside, project_id: p.id };
}

async function new_task(s: AppState, f: Fixture, title: string): Promise<[Task, string]> {
  let t = api.create_task_inner(s, f.project_id, { ...api.CreateTask_default(), title });
  t = await setup(s, t.id);
  return [t, t.worktree_path!];
}

function events(s: AppState, task_id: string): any[] {
  return testing
    .messages(s.db(), task_id)
    .filter((m) => m.kind === "event")
    .map((m) => m.data);
}

/** The originals the worktree's links lead to are all still there. */
function originals_intact(f: Fixture) {
  assert.equal(read(join(f.repo, "node_modules/pkg/index.js")), "module");
  assert.equal(read(join(f.repo, "cache/model.bin")), "weights");
  assert.equal(read(join(f.repo, ".env")), "secret");
  assert.equal(read(join(f.outside, "passwd")), "outside");
}

const COPY = ".env\n# a comment\nbuild/out.txt\nleak\nnotes.txt\nREADME\nmissing.txt\n../escape\n";
const LINK = "node_modules\n./cache/\nmissing-dir\n.env\nout-dir\nREADME\n/etc\n";

test("copies_ignored_files_and_links_ignored_folders_before_the_setup_script", async () => {
  const s = testing.state();
  const f = await fixture(s, COPY, LINK);
  // The setup script sees them.
  db.run(s.db(), "UPDATE projects SET setup_script='cat .env node_modules/pkg/index.js > seen' WHERE id=?1", f.project_id);
  let t = api.create_task_inner(s, f.project_id, { ...api.CreateTask_default(), title: "Do it" });
  try {
    await setup(s, t.id);
  } catch (e) {
    assert.fail(`${e.message}\n${JSON.stringify(events(s, t.id), null, 2)}`);
  }
  t = db.get_task(s.db(), t.id)!;
  const wt = t.worktree_path!;
  assert.equal(read(join(wt, "seen")), "secretmodule");
  unlinkSync(join(wt, "seen"));

  // Ignored files matching the patterns, at any depth unless anchored, and from .worktreeinclude.
  assert.equal(read(join(wt, ".env")), "secret");
  assert.equal(read(join(wt, "sub/.env")), "sub secret");
  assert.equal(read(join(wt, "build/out.txt")), "built");
  assert.equal(read(join(wt, "config/dev.local.json")), "dev");
  // Not tracked files (the branch's own is kept), not untracked ones git doesn't ignore, and nothing from outside the
  // repository.
  assert.equal(read(join(wt, "config/app.local.json")), "tracked");
  for (const not of ["notes.txt", "leak", "out-dir", "missing.txt", "missing-dir"]) assert.ok(!exists_l(join(wt, not)), not);
  // The folders are links to the repository's.
  assert.equal(readlinkSync(join(wt, "node_modules")), join(f.repo, "node_modules"));
  assert.equal(readlinkSync(join(wt, "cache")), join(f.repo, "cache"));
  assert.equal(read(join(wt, "cache/model.bin")), "weights");
  // None of it is a change to commit: the links are excluded, since `node_modules/` doesn't ignore a symlink.
  assert.equal(sh(wt, ["status", "--porcelain", "--untracked-files=all"]), "");
  const exclude = read(join(f.repo, ".git/info/exclude"));
  assert.ok(exclude.includes("\n/node_modules\n/cache\n"), exclude);

  const evs = events(s, t.id);
  const e = evs.find((e) => e.text.includes("from the repository"));
  assert.ok(e, "an event for the files");
  assert.deepEqual([e.level, e.text], ["warn", "Copied 4 files and linked 2 folders from the repository (10 left out)"]);
  const detail: string = e.detail;
  for (const line of [
    "Read .worktreeinclude",
    "copied .env",
    "copied sub/.env",
    "copied config/dev.local.json",
    `linked node_modules -> ${join(f.repo, "node_modules")}`,
    "left out: leak: a symbolic link",
    "left out: 1 matching file git doesn't ignore (only ignored files are copied): notes.txt",
    "left out: README: tracked by git, not copied",
    "left out: missing.txt: not in the repository",
    "left out: ../escape: patterns are relative to the repository, without ..",
    "left out: missing-dir: not in the repository",
    "left out: .env: not a folder",
    "left out: out-dir: a symbolic link",
    "left out: README: not a folder",
    "left out: /etc: folders are relative to the repository",
  ]) {
    assert.ok(detail.split("\n").includes(line), `${JSON.stringify(line)} not in:\n${detail}`);
  }
  // Before the setup script ran.
  const at = (text: string) => evs.findIndex((e) => e.text.startsWith(text));
  assert.ok(at("Copied") < at("Running setup script"));

  // Writing through a link changes the original (that's what linking is for).
  write(join(wt, "node_modules/pkg/new.js"), "new");
  assert.equal(read(join(f.repo, "node_modules/pkg/new.js")), "new");

  // A second task adds no second exclude line.
  const [, wt2] = await new_task(s, f, "Another");
  assert.ok(is_symlink(join(wt2, "node_modules")));
  assert.equal(read(join(f.repo, ".git/info/exclude")).split("/node_modules\n").length - 1, 1);
});

test("removing_a_worktree_removes_its_links_not_what_they_lead_to", async () => {
  const s = testing.state();
  const f = await fixture(s, ".env\n", "node_modules\ncache\n");

  // Plain teardown (git's own check, then `git worktree remove`).
  let [t, wt] = await new_task(s, f, "Plain");
  assert.ok(is_symlink(join(wt, "node_modules")));
  await teardown(s, t.id, false, false);
  assert.ok(!existsSync(wt));
  originals_intact(f);

  // Forced teardown.
  [t, wt] = await new_task(s, f, "Forced");
  write(join(wt, "uncommitted"), "u");
  await teardown(s, t.id, true, true);
  assert.ok(!existsSync(wt));
  originals_intact(f);

  // Removed by hand when git won't (a locked worktree), from another working directory.
  [t, wt] = await new_task(s, f, "Locked");
  sh(f.repo, ["worktree", "lock", path_str(wt)]);
  await teardown(s, t.id, true, false);
  assert.ok(!existsSync(wt));
  originals_intact(f);

  // Remove merged worktrees: copied files and links don't count as work that would be lost.
  [t, wt] = await new_task(s, f, "Merged");
  write(join(wt, "a"), "a");
  sh(wt, ["add", "a"]);
  sh(wt, ["commit", "-qm", "a"]);
  sh(f.repo, ["merge", "-q", "--no-ff", "-m", "merge", t.branch!]);
  db.update_task(s.db(), t.id, [["status", "done"]]);
  const results = await remove_merged(s, f.project_id);
  assert.deepEqual([results[0].removed, results[0].detail], [true, "merged into master"], JSON.stringify(results));
  assert.ok(!existsSync(wt));
  originals_intact(f);

  // And when merged on its own.
  [t, wt] = await new_task(s, f, "Merged too");
  db.update_task(s.db(), t.id, [["status", "done"]]);
  assert.deepEqual(await remove_if_merged(s, t.id, false), { Removed: "master" });
  assert.ok(!existsSync(wt));
  originals_intact(f);
  assert.ok(lstatSync(join(f.repo, "node_modules")).isDirectory() && !is_symlink(join(f.repo, "node_modules")));
});

test("never_overwrites_or_writes_through_a_symlink_in_the_worktree", async () => {
  const s = testing.state();
  const f = await fixture(s, ".env\nbuild/\n", "node_modules\n");
  const [, wt] = await new_task(s, f, "Do it");
  const project = db.get_project(s.db(), f.project_id)!;
  // Changed in the worktree, and the link replaced by a folder of its own.
  write(join(wt, ".env"), "mine");
  unlinkSync(join(wt, "node_modules"));
  write(join(wt, "node_modules/own.js"), "own");
  // A symlink in the worktree where a copy would go.
  rmSync(join(wt, "build"), { recursive: true });
  symlinkSync(f.outside, join(wt, "build"));
  const report = await bring_in(project, wt);
  assert.equal(read(join(wt, ".env")), "mine");
  assert.ok(!is_symlink(join(wt, "node_modules")));
  assert.ok(!existsSync(join(f.outside, "out.txt")));
  assert.ok(report.copied.length === 0 && report.linked.length === 0, JSON.stringify(report));
  assert.deepEqual(report.existing, [".env", "config/dev.local.json", "sub/.env", "node_modules"]);
  assert.deepEqual(report.skipped, ["build/out.txt: build in the worktree isn't a folder"]);
});

test("a_task_branch_that_doesnt_ignore_a_file_doesnt_get_it", async () => {
  const s = testing.state();
  const f = await fixture(s, ".env\n", "");
  sh(f.repo, ["checkout", "-q", "-b", "old"]);
  write(join(f.repo, ".gitignore"), "node_modules/\n");
  sh(f.repo, ["commit", "-qam", "unignore"]);
  sh(f.repo, ["checkout", "-q", "master"]);
  let t = api.create_task_inner(s, f.project_id, { ...api.CreateTask_default(), title: "Old" });
  db.update_task(s.db(), t.id, [["base_branch", "old"]]);
  t = await setup(s, t.id);
  const wt = t.worktree_path!;
  assert.ok(!existsSync(join(wt, ".env")));
  assert.equal(sh(wt, ["status", "--porcelain"]), "");
});

test("a_repository_with_nothing_to_bring_in_logs_nothing", async () => {
  const s = testing.state();
  const f = await fixture(s, "", "");
  unlinkSync(join(f.repo, INCLUDE_FILE));
  const [t] = await new_task(s, f, "Do it");
  assert.ok(!events(s, t.id).some((e) => e.text.includes("from the repository")));
});

test("checks_what_the_settings_name", () => {
  assert.deepEqual(link_path("./models/cache/"), { ok: "models/cache" });
  for (const bad of ["/etc", "~/x", "../x", "a/../../x", ".", ".git", "a/.git/hooks"]) assert.ok("err" in link_path(bad), bad);
  assert.equal(check_pattern("!/config/*.json"), null);
  assert.ok(check_pattern("a/../b") !== null && check_pattern("!../b") !== null);
  assert.doesNotThrow(() => check("copy_files", ".env\n# ../comment\n"));
  assert.throws(
    () => check("link_folders", "models\n/abs\n"),
    (e: any) => e.message.includes("link_folders: /abs"),
  );
  assert.throws(() => check("copy_files", "x\n".repeat(201)));
});

test("literal_patterns_match_as_git_would", () => {
  const m = literal_matches;
  assert.ok(m(".env", ".env") && m(".env", "a/b/.env") && m("build/", "build/x") && m("build", "a/build/x"));
  assert.ok(m("/.env", ".env") && !m("/.env", "a/.env") && m("a/b", "a/b/c") && !m("a/b", "x/a/b"));
  assert.ok(!m(".env", ".env.local") && !m("build", "builder/x"));
});

test("relinks_folders_after_the_repository_moves", async () => {
  const root = testing.temp_dir();
  const wt = join(root, "wt");
  mkdirSync(join(wt, "a"), { recursive: true });
  symlinkSync(join(root, "old/models"), join(wt, "models"));
  symlinkSync(join(root, "elsewhere"), join(wt, "a/b"));
  const map = (p: string) => (p === join(root, "old") || p.startsWith(join(root, "old") + "/") ? join(root, "new", p.slice(join(root, "old").length)) : null);
  await relink(wt, "models\na/b\n", map);
  assert.equal(readlinkSync(join(wt, "models")), join(root, "new/models"));
  assert.equal(readlinkSync(join(wt, "a/b")), join(root, "elsewhere"));
});

// HA-52 review: the git checks were of a symlink's own (ignored, untracked) path, while the copy or link led to tracked
// files or the repository's .git.
test("symlinks_in_the_repository_are_neither_copied_nor_linked", async () => {
  const s = testing.state();
  const f = await fixture(s, "alias-file\nvia/x.env\n", "alias-dir\ngit-alias\nvia/inner\n");
  write(join(f.repo, "src/app.txt"), "tracked app");
  write(join(f.repo, "src/inner/x.env"), "tracked env");
  write(join(f.repo, "src/x.env"), "tracked env");
  sh(f.repo, ["add", "src"]);
  sh(f.repo, ["commit", "-qm", "src"]);
  for (const [name, to] of [
    ["alias-file", "src/app.txt"],
    ["alias-dir", "src"],
    ["git-alias", ".git"],
    ["via", "src"],
  ]) {
    symlinkSync(join(f.repo, to), join(f.repo, name));
  }
  writeFileSync(join(f.repo, ".git/info/exclude"), "alias-file\nalias-dir\ngit-alias\nvia\n");
  const [t, wt] = await new_task(s, f, "Do it");
  for (const name of ["alias-file", "alias-dir", "git-alias", "via"]) assert.ok(!exists_l(join(wt, name)), name);
  const detail: string = events(s, t.id).find((e) => typeof e.detail === "string" && e.detail.includes("left out"))!.detail;
  for (const line of [
    "left out: alias-file: a symbolic link",
    "left out: alias-dir: a symbolic link",
    "left out: git-alias: a symbolic link",
    "left out: via/inner: via is a symbolic link",
  ]) {
    assert.ok(detail.split("\n").includes(line), `${JSON.stringify(line)} not in:\n${detail}`);
  }
  assert.equal(read(join(f.repo, "src/app.txt")), "tracked app");
});

test("a_worktreeinclude_that_is_a_symlink_isnt_read", async () => {
  const s = testing.state();
  const f = await fixture(s, "", "");
  write(join(f.outside, "private"), "CANARY-SECRET\n");
  unlinkSync(join(f.repo, INCLUDE_FILE));
  symlinkSync(join(f.outside, "private"), join(f.repo, INCLUDE_FILE));
  const [t, wt] = await new_task(s, f, "Do it");
  const evs = JSON.stringify(events(s, t.id));
  assert.ok(!evs.includes("CANARY"), evs);
  assert.ok(evs.includes("left out: .worktreeinclude: a symbolic link, not read"), evs);
  // Nor is it copied from the folder it leads to.
  assert.ok(!existsSync(join(wt, "config/dev.local.json")));
});

test("links_are_moved_with_the_repository_even_once_out_of_the_setting", async () => {
  const s = testing.state();
  const f = await fixture(s, "", "node_modules\n");
  const [, wt] = await new_task(s, f, "Do it");
  assert.equal(readlinkSync(join(wt, "node_modules")), join(f.repo, "node_modules"));
  await api.update_project_inner(s, f.project_id, { link_folders: "" });
  const moved = join(f.root, "moved");
  await api.update_project_inner(s, f.project_id, { repo_path: path_str(moved), move_repo: true });
  assert.equal(readlinkSync(join(wt, "node_modules")), join(moved, "node_modules"));
  assert.equal(read(join(wt, "node_modules/pkg/index.js")), "module");
});
