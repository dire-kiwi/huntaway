import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

let server;
let project;
let tasks;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  // Three tasks from one prompt, each with work in its worktree: committed, and in the last one left uncommitted too.
  tasks = [];
  for (const [i, model] of ["opus", "sonnet", "haiku"].entries()) {
    const t = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Add a health check", model, fanout_id: "fan-1", use_worktree: true });
    const { worktree_path: wt } = await server.api("POST", `/tasks/${t.id}/worktree/setup`);
    writeFileSync(`${wt}/health-${model}.txt`, `ok from ${model}\n`);
    execFileSync("git", ["-C", wt, "add", "-A"]);
    execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `Health check (${model})`]);
    if (i === 2) writeFileSync(`${wt}/draft.txt`, "not committed\n");
    tasks.push({ ...t, wt });
  }
});
after(() => server?.stop());

const task = (t) => server.api("GET", `/tasks/${t.id}`).then((r) => r.task);

// HA-51: the tasks made from one prompt, compared side by side or one at a time, and one of them picked.
test("compares the tasks from one prompt, and picking one completes the others but keeps uncommitted work", async () => {
  const [opus, sonnet, haiku] = tasks;
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      // The model badge on a card opens it.
      `click css=[data-task="${opus.id}"] >> button:has-text("opus")`,
      "wait [data-compare] >> text=Compare 3 tasks from one prompt",
      `wait [data-sibling="${haiku.id}"] >> text=health-haiku.txt`,
      `wait [data-sibling="${sonnet.id}"] >> text=ok from sonnet`,
      "wait [data-compare] >> text=4 files changed between them",
      // One at a time: the arrow keys go through them, and a file in the overview goes to its diff.
      "click css=[data-compare] button:has-text('One at a time')",
      "press ArrowRight",
      "wait [role=tab][aria-selected=true] >> text=sonnet",
      `click css=[data-compare] button[title="SHOP-3: go to its diff of draft.txt"]`,
      "wait [role=tab][aria-selected=true] >> text=haiku",
      `wait [data-sibling="${haiku.id}"] [data-file="draft.txt"]`,
      // Escape closes it, and leaves the task open beside the board.
      "press Escape",
      "gone [data-compare]",
      `assert location.search === '?task=${opus.id}'`,
      // From the task's details too.
      "click Details",
      "click Compare all 3",
      "wait [data-compare] >> text=Pick this one",
      "press ArrowRight",
      "wait [role=tab][aria-selected=true] >> text=sonnet",
      "click css=[data-compare] button:has-text('Pick this one')",
      "wait Pick SHOP-2 (sonnet)?",
      "wait 1 uncommitted change in its worktree: draft.txt",
      "wait SHOP-3 keeps its worktree with the changes in",
      "click Pick SHOP-2",
      // What wasn't done as asked is said.
      "wait Picked SHOP-2 (sonnet)",
      "wait Kept its worktree",
      "click css=[role=dialog] button:text-is('Done')",
      "gone Picked SHOP-2 (sonnet)",
      "wait [data-compare] >> text=Picked",
    ]);
  });
  const [o, s, h] = await Promise.all(tasks.map(task));
  assert.deepEqual([o.status, o.resolution, o.worktree_state], ["done", "not_done", "none"]);
  assert.deepEqual([s.status, s.resolution ?? null, s.worktree_state], [sonnet.status, null, "ready"]);
  assert.deepEqual([h.status, h.resolution, h.worktree_state], ["done", "not_done", "ready"]);
  assert.ok(existsSync(`${haiku.wt}/draft.txt`));

  // Asked again to discard it, it goes.
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}?task=${sonnet.id}&compare`,
      `wait [data-sibling="${sonnet.id}"]`,
      `click css=[data-compare] section[aria-label="SHOP-2"] button:has-text('Pick this one')`,
      "wait Discard their uncommitted changes",
      "click Discard their uncommitted changes",
      "wait The uncommitted changes in SHOP-3 are lost.",
      "click Pick SHOP-2",
      "gone Pick SHOP-2 (sonnet)?",
    ]);
  });
  assert.equal((await task(haiku)).worktree_state, "none");
  assert.ok(!existsSync(haiku.wt));
});
