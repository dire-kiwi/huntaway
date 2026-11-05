// Port of the tests in server/src/disk.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as db from "./db.ts";
import * as testing from "./testing.ts";
import { path_str } from "./util.ts";
import * as runs from "./agent/runs.ts";
import { dir_size, measure, plan, read, type Report } from "./disk.ts";
import { in_worker } from "./worker.ts";

function write(p: string, bytes: number) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, "x"));
}

/** A linked worktree of `repo` at `dir`, as `git worktree add` leaves it, holding `bytes`. */
function fake_worktree(repo: string, dir: string, bytes: number) {
  const name = basename(dir);
  const admin = join(repo, ".git/worktrees", name);
  write(join(admin, "commondir"), 0);
  writeFileSync(join(admin, "commondir"), "../..\n");
  write(join(dir, "file"), bytes);
  writeFileSync(join(dir, ".git"), `gitdir: ${path_str(admin)}\n`);
}

test("sizes_skip_nested_folders_and_count_hard_links_once", () => {
  const tmp = testing.temp_dir();
  const root = join(tmp, "r");
  write(join(root, "a"), 10_000);
  write(join(root, "sub/b"), 10_000);
  write(join(root, "skipme/c"), 50_000);
  linkSync(join(root, "a"), join(root, "sub/a-link"));
  const all = dir_size(root, [])!;
  const part = dir_size(root, [join(root, "skipme")])!;
  assert.equal(all.files, 3);
  assert.equal(part.files, 2);
  assert.ok(part.bytes >= 20_000 && part.bytes < all.bytes, `${JSON.stringify(part)} ${JSON.stringify(all)}`);
  assert.equal(dir_size(join(tmp, "missing"), []), null);
  rmSync(tmp, { recursive: true });
});

test("reports_repos_worktrees_and_stray_folders", async () => {
  const s = testing.state();
  const tmp = testing.temp_dir();
  const repo = join(tmp, "repo");
  write(join(repo, "src/main.rs"), 8_000);
  write(join(repo, ".git/objects/pack"), 40_000);
  const c = s.db();
  const profile = db.insert_profile(c, "me", [], null).id;
  const wts = join(tmp, "data/projects/p1/worktrees");
  db.insert_project(c, {
    id: "p1",
    profile_id: profile,
    name: "Proj",
    key: "PRJ",
    repo_path: path_str(repo),
    scratch_path: path_str(join(tmp, "data/projects/p1/scratch")),
    worktrees_root: path_str(wts),
    base_branch: null,
    use_worktrees: true,
  });
  write(join(wts, "1-one/big"), 100_000);
  fake_worktree(repo, join(wts, "old"), 20_000);
  // Not a worktree, so not the project's to clear up.
  write(join(wts, "notes/todo"), 1_000);
  write(join(tmp, "data/projects/p1/scratch/notes"), 4_000);
  db.run(
    c,
    `INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path, last_activity_at, created_at, updated_at)
       VALUES ('t1', ?1, 'p1', 'task', 1, 'One', 'done', ?2, '', '', ''), ('t2', ?1, 'p1', 'task', 2, 'Gone', 'todo', ?3, '', '', '')`,
    profile,
    path_str(join(wts, "1-one")),
    path_str(join(wts, "2-gone")),
  );
  // Runs of its tasks, and of a scratch task in no project.
  db.run(
    c,
    `INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, last_activity_at, created_at, updated_at)
       VALUES ('t3', ?1, NULL, 'scratch', 3, 'Chat', 'todo', '', '', '')`,
    profile,
  );
  db.run(
    c,
    `INSERT INTO runs (id, task_id, kind, status, created_at) VALUES ('r1', 't1', 'prompt', 'exited', ''),
       ('r2', 't1', 'prompt', 'exited', ''), ('r3', 't3', 'prompt', 'exited', ''), ('r4', 't2', 'prompt', 'exited', '')`,
  );
  write(join(tmp, "data/runs/r1/out.jsonl"), 30_000);
  write(join(tmp, "data/runs/r2/out.jsonl"), 1_000);
  write(join(tmp, "data/runs/r2/err.log"), 1_000);
  write(join(tmp, "data/runs/r3/out.jsonl"), 5_000);
  const r = measure(plan(read(s.db(), profile), join(tmp, "data")), join(tmp, "data"));
  assert.equal(r.projects.length, 1);
  const p = r.projects[0];
  assert.equal(p.repo!.files, 3);
  // The pack, and the stray worktree's commondir.
  assert.equal(p.git!.files, 2);
  assert.ok(p.git!.bytes >= 40_000);
  assert.deepEqual(
    p.worktrees.map((w) => [w.task_id, w.size.files]),
    [
      ["t1", 1],
      [null, 2],
    ],
  );
  assert.ok(p.worktrees[0].size.bytes >= 100_000);
  assert.equal(p.other.files, 1);
  // r4's folder is gone.
  assert.equal(p.runs.files, 3);
  assert.ok(p.runs.bytes >= 32_000);
  assert.equal(r.runs.files, 1);
  assert.deepEqual([r.runs_kept_days, r.database], [runs.KEEP_DAYS, null]);
  // The API's report, made in a worker thread (HA-183), is the same.
  const from_worker = await in_worker<Report>(new URL("./disk.ts", import.meta.url), "report", [read(s.db(), profile), join(tmp, "data")]);
  assert.deepEqual({ ...from_worker, elapsed_ms: 0, filesystem: null }, { ...r, elapsed_ms: 0, filesystem: null });
  rmSync(tmp, { recursive: true });
});

test("shared_worktrees_folders_only_count_unowned_worktrees_of_the_repo_as_stray", () => {
  const s = testing.state();
  const tmp = testing.temp_dir();
  // One folder holds both repos and both projects' worktrees.
  const shared = join(tmp, "code");
  const repo_a = join(shared, "a"), repo_b = join(shared, "b");
  write(join(repo_a, ".git/HEAD"), 10);
  write(join(repo_b, ".git/HEAD"), 10);
  fake_worktree(repo_a, join(shared, "a-1"), 1_000);
  fake_worktree(repo_b, join(shared, "b-1"), 1_000);
  fake_worktree(repo_a, join(shared, "a-old"), 1_000);
  const c = s.db();
  const profile_a = db.insert_profile(c, "me", [], null).id;
  const profile_b = db.insert_profile(c, "work", [], null).id;
  for (const [id, profile, repo, key] of [
    ["pa", profile_a, repo_a, "A"],
    ["pb", profile_b, repo_b, "B"],
  ]) {
    db.insert_project(c, {
      id,
      profile_id: profile,
      name: key,
      key,
      repo_path: path_str(repo),
      scratch_path: path_str(join(tmp, "data/projects", id, "scratch")),
      worktrees_root: path_str(shared),
      base_branch: null,
      use_worktrees: true,
    });
  }
  db.run(
    c,
    `INSERT INTO tasks (id, profile_id, project_id, kind, number, title, status, worktree_path, last_activity_at, created_at, updated_at)
       VALUES ('ta', ?1, 'pa', 'task', 1, 'A one', 'in_progress', ?3, '', '', ''), ('tb', ?2, 'pb', 'task', 1, 'B one', 'in_progress', ?4, '', '', '')`,
    profile_a,
    profile_b,
    path_str(join(shared, "a-1")),
    path_str(join(shared, "b-1")),
  );
  const r = measure(plan(read(s.db(), profile_a), join(tmp, "data")), join(tmp, "data"));
  const wts = r.projects[0].worktrees.map((w) => [w.task_id, w.path] as [string | null, string]);
  wts.sort((x, y) => (x[0] === y[0] ? 0 : x[0] === null ? -1 : y[0] === null ? 1 : x[0] < y[0] ? -1 : 1));
  assert.deepEqual(wts, [
    [null, path_str(join(shared, "a-old"))],
    ["ta", path_str(join(shared, "a-1"))],
  ]);
  rmSync(tmp, { recursive: true });
});
