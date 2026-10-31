import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
let task;
let wt;
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const lines = (n, f = (i) => `export const line${i} = ${i};`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("");
const log = () => (existsSync(`${server.dataDir}/fake-claude.log`) ? readFileSync(`${server.dataDir}/fake-claude.log`, "utf8") : "");
/** The prompts the (fake) agent was given, a reviewer's left out: they quote the thread. */
const prompts = () =>
  log()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).prompt)
    .filter((p) => !p.startsWith("Review the work on"));

before(async () => {
  server = startServer("--fake-claude");
  const repo = `${server.dataDir}/shop`;
  mkdirSync(`${repo}/src`, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  writeFileSync(`${repo}/src/app.ts`, lines(30));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const [profile] = await server.api("GET", "/profiles");
  const project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" });
  task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Edit the app" });
  task = await server.api("POST", `/tasks/${task.id}/worktree/setup`);
  wt = task.worktree_path;
  // A commit on the branch (line 10), and an uncommitted change (line 3).
  writeFileSync(`${wt}/src/app.ts`, lines(30, (i) => (i === 10 ? "export const ten = 10;" : `export const line${i} = ${i};`)));
  git(wt, "commit", "-qam", "Name ten");
  writeFileSync(`${wt}/src/app.ts`, lines(30, (i) => (i === 3 ? "export const three = 3;" : i === 10 ? "export const ten = 10;" : `export const line${i} = ${i};`)));
});
after(() => server?.stop());

const DRAFT = "What should the agent know";
/** Into app.ts's unstaged diff (its folder is the first row), with the cursor on its first change. */
const openFile = () => [`goto /t/${task.id}`, "click changes", "wait app.ts", "press j", "press Enter", "wait Unstaged changes"];
/** A commit's patch comes a little after its subject is listed, as it can from a slow host. */
const slowPatches = (ui) =>
  ui.page.route("**/git/show?*", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
/**
 * The rows of the commit's diff of app.ts (its index and text), once its patch has come: its subject is in the
 * Commits list before then, so it's waited for by a line only the patch has.
 */
async function commitRows(ui) {
  const lines = ui.page.locator('[data-diff="src/app.ts"] [data-i]');
  await lines.filter({ hasText: "export const ten" }).first().waitFor();
  const rows = await lines.evaluateAll((els) => els.map((e) => [e.dataset.i, e.textContent]));
  return (re) => {
    const row = rows.find(([, t]) => re.test(t));
    assert.ok(row, `no row of the commit's diff matches ${re}: ${JSON.stringify(rows)}`);
    return row[0];
  };
}

// HA-10: lines picked in a file's diff and in a commit's, each with a note, go to the agent as one message.
test("comments on a file's lines and a commit's reach the agent in one message", async () => {
  await withBrowser(server, {}, async (ui) => {
    // The cursor's line (the removed line 3): n, a note, Enter.
    await ui.run([...openFile(), "press n", `wait ${DRAFT}`, "type Name it after its value.", "press Enter", `gone ${DRAFT}`, "wait Comment for the agent on removed line 3"]);
    // The commit's lines 10 (removed and added), picked by their numbers: a click, then a shift-click.
    await slowPatches(ui);
    await ui.run(["press 3", "press Enter"]);
    const row = (i) => ui.page.locator(`[data-diff="src/app.ts"] [data-i="${i}"] > span`).first();
    const at = await commitRows(ui);
    await row(at(/^10\s*-export const line10/)).click();
    await row(at(/^\s*10\s*\+export const ten/)).click({ modifiers: ["Shift"] });
    await ui.run(["press n", `wait ${DRAFT}`, "type Keep the old name too.", "press Enter", `gone ${DRAFT}`, "wait 2 comments for the agent"]);
    await ui.run(["click Send to the agent", "gone 2 comments for the agent"]);
    await waitFor(() => prompts().some((p) => p.includes("Keep the old name too.")));
    const prompt = prompts().find((p) => p.includes("Keep the old name too."));
    assert.match(prompt, /2 comments on the diff:/);
    assert.match(prompt, /\*\*src\/app\.ts\*\*, removed line 3 \(unstaged changes\):\n```diff\n-export const line3 = 3;\n```\nName it after its value\./);
    assert.match(prompt, /\*\*src\/app\.ts\*\*, line 10 \(commit [0-9a-f]{8}\):\n```diff\n-export const line10 = 10;\n\+export const ten = 10;\n```\nKeep the old name too\./);
  });
});

test("unsent comments and drafts survive switching tabs and a reload, and show in the composer", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([...openFile(), "press n", `wait ${DRAFT}`, "type Half a thought"]);
    // Away to the thread and back: the draft's still there.
    await ui.run(["click thread", "click changes", "wait Half a thought"]);
    // A reload: still there. Finished and added.
    await ui.run([`goto /t/${task.id}`, "click changes", "wait Half a thought", "click Half a thought", "press End", "type , finished.", "press Enter", "wait Half a thought, finished."]);
    await ui.run(["wait 1 comment for the agent"]);
    // In the thread's composer, which can take it off again.
    await ui.run(["click thread", "wait A comment on the diff, sent with this message", "wait app.ts:3", "click Remove the comment", "gone app.ts:3"]);
    // Back in the Changes tab (on the folder's diff, as it opens on its first row): gone there too.
    await ui.run(["click changes", "wait app.ts", "wait export const three", "gone 1 comment for the agent", "gone Half a thought"]);
  });
});

test("the composer sends the comments with what's typed", async () => {
  await waitIdle();
  await withBrowser(server, {}, async (ui) => {
    await ui.run([...openFile(), "press n", `wait ${DRAFT}`, "type Use a better name.", "press Enter", "wait 1 comment for the agent"]);
    await ui.run(["click thread", "wait app.ts:3", "click Add a message to the comment", "type Two things:", "press Enter", "gone app.ts:3"]);
    await waitFor(() => prompts().some((p) => p.includes("Use a better name.")));
    const prompt = prompts().find((p) => p.includes("Use a better name."));
    assert.match(prompt, /Two things:\n\nA comment on the diff:\n\n\*\*src\/app\.ts\*\*, removed line 3 \(unstaged changes\):/);
  });
});

test("a line's comment button comments on that line, or on the lines picked if it's one of them", async () => {
  await withBrowser(server, {}, async (ui) => {
    await slowPatches(ui);
    await ui.run([`goto /t/${task.id}`, "click changes", "wait app.ts", "press 3", "press Enter"]);
    const diff = '[data-diff="src/app.ts"]';
    const at = await commitRows(ui);
    const button = async (i) => {
      await ui.page.locator(`${diff} [data-i="${i}"]`).hover();
      await ui.page.locator(`${diff} button[title^="Comment for the agent"]`).click();
    };
    // Outside what's picked: just its line.
    await ui.page.locator(`${diff} [data-i="${at(/^\s*8\s*8\s/)}"] > span`).first().click();
    await button(at(/^\s*12\s*12\s/));
    await ui.run([`wait ${DRAFT}`, "wait Comment for the agent on line 12", "click Discard", `gone ${DRAFT}`]);
    // In it: all of them (lines 8 to 12, the removed line 10 too).
    await ui.page.locator(`${diff} [data-i="${at(/^\s*8\s*8\s/)}"] > span`).first().click();
    await ui.page.locator(`${diff} [data-i="${at(/^\s*12\s*12\s/)}"] > span`).first().click({ modifiers: ["Shift"] });
    await button(at(/^\s*10\s*-/));
    await ui.run([`wait ${DRAFT}`, "wait Comment for the agent on lines 8–12", "type All of these.", "press Enter", "wait 1 comment for the agent"]);
    const draft = await ui.page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("ia.review."))[1]));
    assert.deepEqual(draft.comments[0].lines, [
      " export const line8 = 8;",
      " export const line9 = 9;",
      "-export const line10 = 10;",
      "+export const ten = 10;",
      " export const line11 = 11;",
      " export const line12 = 12;",
    ]);
  });
});

test("diffs are highlighted, and the split layout is remembered", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([...openFile()]);
    // Coloured runs, once the worker has the grammar.
    await waitFor(async () => (await ui.page.locator('[data-diff="src/app.ts"] span[style*="color"]').count()) > 0, 10000);
    const keyword = await ui.page.locator('[data-diff="src/app.ts"] span[style*="color"]', { hasText: /^export$/ }).first().evaluate((e) => getComputedStyle(e).color);
    const name = await ui.page.locator('[data-diff="src/app.ts"] span[style*="color"]', { hasText: /^line3$/ }).first().evaluate((e) => getComputedStyle(e).color);
    assert.notEqual(keyword, name);
    // Side by side: the removed line on the left, the added one on the right, in one row.
    await ui.run(["press |"]);
    const pair = ui.page.locator('[data-diff="src/app.ts"] > div.flex:has(> div.w-1\\/2)', { hasText: "export const three" });
    await pair.waitFor();
    assert.match(await pair.textContent(), /line3 = 3;.*three = 3;/);
    await ui.run([`goto /t/${task.id}`, "click changes", "wait app.ts", "press j", "press Enter", "wait Unstaged changes"]);
    await ui.page.locator('[data-diff="src/app.ts"] > div.flex:has(> div.w-1\\/2)', { hasText: "export const three" }).waitFor();
  });
});

async function waitIdle() {
  await waitFor(async () => !(await server.api("GET", `/tasks/${task.id}`)).task.running, 15000);
}

async function waitFor(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return;
  assert.ok(await check(), `timed out waiting for ${check}`);
}
