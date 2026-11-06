import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
let task;
let wt;
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("");

beforeAll(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  writeFileSync(`${repo}/app.txt`, lines(30));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const [profile] = await server.api("GET", "/profiles");
  const project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" });
  task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Edit the app" });
  task = await server.api("POST", `/tasks/${task.id}/worktree/setup`);
  wt = task.worktree_path;
});
afterAll(() => server?.stop());
// Nothing staged for the next test, even when one fails (else it fails the next one too).
afterEach(() => wt && git(wt, "reset", "-q"));

// HA-4: the Changes tab stages the lines picked in a file's diff, and only those.
test("stages and unstages chosen lines from the keyboard", async () => {
  // Two changes far apart: lines 3 and 25.
  writeFileSync(`${wt}/app.txt`, lines(30, (i) => (i === 3 ? "three" : i === 25 ? "twenty-five" : `line ${i}`)));
  writeFileSync(`${wt}/new.txt`, "a\nb\n");
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click changes", "wait new.txt"]);
    // app.txt is first. Into its diff: the cursor is on "-line 3"; down twice is "-line 25", which space stages.
    await ui.run(["press Enter", "wait Unstaged changes", "press j", "press j", "press Space"]);
    await waitFor(() => git(wt, "diff", "--cached").includes("-line 25"));
    const staged = git(wt, "diff", "--cached", "--no-color");
    assert.match(staged, /^-line 25$/m);
    assert.doesNotMatch(staged, /twenty-five|three|line 3$/m);
    // In the staged changes (tab) space unstages it again.
    await ui.run(["wait Staged changes", "press Tab", "press Space"]);
    await waitFor(() => git(wt, "diff", "--cached") === "");
    // Escape goes back to the files rather than closing the task.
    await ui.run(["press Escape", "press j", "press Space"]);
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n");
    assert.match(ui.page.url(), /task=/);
  });
});

// HA-169: a key that came before what the one before it did was rendered (a slow machine) was taken against the old
// state: after an Escape back to the files, `j` moved the cursor in the diff that was left and space staged app.txt.
// Keys sent at once, with no render between them, are the same at any speed.
test("keys pressed before the last one's change is shown wait for it", async () => {
  writeFileSync(`${wt}/app.txt`, lines(30, (i) => (i === 3 ? "three" : i === 25 ? "twenty-five" : `line ${i}`)));
  writeFileSync(`${wt}/new.txt`, "a\nb\n");
  await withBrowser(server, {}, async (ui) => {
    // Into app.txt's diff, staging its lines ("Select range" is only offered there).
    await ui.run([`goto /t/${task.id}`, "click changes", "wait new.txt", "press Enter", "wait Select range"]);
    await ui.page.evaluate(() => {
      for (const key of ["Escape", "j", " "]) document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n");
    assert.match(ui.page.url(), /task=/);
  });
});

// Enter on a file before its diff had loaded didn't go into it, so the Escape after it closed the task.
test("Escape after Enter on a file still loading goes back to the files", async () => {
  await withBrowser(server, {}, async (ui) => {
    // Slow diffs, so the keys come before new.txt's.
    await ui.page.route("**/git/diff?*", async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await ui.run([`goto /p/${task.project_id}?task=${task.id}`, "click changes", "wait new.txt", "sleep 700", "press j", "press Enter", "press Escape", "sleep 800"]);
    assert.match(ui.page.url(), /task=/);
    // Back in the files: space stages new.txt.
    await ui.run(["press Space"]);
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n");
  });
});

// A dialog opened from a menu (stash options, then its message) had nothing to give the focus back to, so keys
// went nowhere once it closed.
test("keys still work after a dialog opened from a menu", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click changes", "wait new.txt", "press S", "wait Stash staged changes", "press a", "wait Message (optional)", "type wip"]);
    await ui.run(["press Enter", "gone Message (optional)"]);
    await waitFor(() => git(wt, "stash", "list").includes("wip"));
    await ui.run(["press 4", "press g", "wait Apply and then drop", "press Enter", "gone Apply and then drop"]);
    await waitFor(() => git(wt, "stash", "list") === "" && git(wt, "status", "--short").includes("new.txt"));
  });
});

async function waitFor(check, ms = 5000) {
  // A check that throws hasn't passed yet: `git stash list` can fail with "bad revision 'refs/stash'" while the
  // server's stash or drop is half done.
  const passes = () => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (passes()) return;
  assert.ok(check(), `timed out waiting for ${check}`);
}
