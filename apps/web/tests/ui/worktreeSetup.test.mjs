import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
let profile;
before(async () => {
  server = startServer();
  [profile] = await server.api("GET", "/profiles");
});
after(() => server?.stop());

const project = async (name, key) => {
  const dir = `${server.dataDir}/${name.toLowerCase()}`;
  mkdirSync(dir);
  return [await server.api("POST", `/profiles/${profile.id}/projects`, { name, repo_path: dir, key }), dir];
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

// HA-20: a project whose tasks would wait for worktrees shows a thread that helps get its folder ready instead of its board,
// until the folder is a git repository with a commit.
test("a folder that isn't ready for worktrees shows its setup thread until it is", async () => {
  const [notes, dir] = await project("Notes", "NOTE");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${notes.id}`, "wait isn't a git repository yet", "wait Start setup thread", "gone Search tasks"]);
    await ui.run(["type Call the branch trunk", "press Control+Enter", "gone Start setup thread", "wait Call the branch trunk"]);
    const p = await server.api("GET", `/projects/${notes.id}`);
    assert.ok(p.setup_task_id);
    const t = (await server.api("GET", `/tasks/${p.setup_task_id}`)).task;
    assert.deepEqual([t.project_id, t.use_worktree], [notes.id, false]);
    // A repository with no commits has nothing for a worktree to branch from yet.
    git(dir, "init", "-q", "-b", "main");
    await ui.run(["wait is a git repository with no commits yet", "wait Call the branch trunk"]);
    // The board comes back by itself, with the setup thread's task on it.
    git(dir, "commit", "-q", "--allow-empty", "-m", "first");
    await ui.run(["gone Use without worktrees", "wait Search tasks", `wait NOTE-${t.number}`]);
  });
  // Asked again, it's the same thread.
  assert.equal((await server.api("POST", `/projects/${notes.id}/setup-thread`, {})).id, (await server.api("GET", `/projects/${notes.id}`)).setup_task_id);
});

test("a project can be used without worktrees instead", async () => {
  const [plain] = await project("Plain", "PLN");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${plain.id}`, "click Use without worktrees", "gone Start setup thread", "wait Search tasks"]);
  });
  const p = await server.api("GET", `/projects/${plain.id}`);
  assert.deepEqual([p.use_worktrees, p.setup_task_id ?? null], [false, null]);
  assert.deepEqual(await server.api("GET", `/projects/${plain.id}/tasks`), []);
});
