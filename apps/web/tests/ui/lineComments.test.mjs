import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, startServer, withBrowser } from "./harness.mjs"

// Comments on a diff's lines for the agent (the old lineComments.test.mjs), on a test server whose agent is the fake
// `claude`, which logs the prompts it is given. The old reviewer-prompt filter is gone with reviews (M4). HE-96: the
// Changes tab shows the branch's changes (uncommitted ones too), whose lines are picked by their numbers.

let server
let task
let wt
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
const lines = (n, f = (i) => `export const line${i} = ${i};`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("")
const log = () => (existsSync(`${server.dataDir}/fake-claude.log`) ? readFileSync(`${server.dataDir}/fake-claude.log`, "utf8") : "")
/** The prompts the (fake) agent was given. */
const prompts = () =>
  log()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).prompt)
const waitFor = (check, ms = 5000) => eventually(async () => assert.ok(await check(), `timed out waiting for ${check}`), ms)

beforeAll(async () => {
  server = startServer("--fake-claude")
  const repo = `${server.dataDir}/shop`
  mkdirSync(`${repo}/src`, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/src/app.ts`, lines(30))
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  const dir = join(server.dataDir, "claude-config")
  mkdirSync(dir, { recursive: true })
  const config = await server.rpc("configs.create", { config: { name: "test", config_dir: dir } })
  const profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [config.id] } })
  const project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" } })
  task = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Edit the app" } })
  task = await server.rpc("git.setupWorktree", { id: task.id })
  wt = task.worktree_path
  // A commit on the branch (line 10), and an uncommitted change (line 3).
  writeFileSync(
    `${wt}/src/app.ts`,
    lines(30, (i) => (i === 10 ? "export const ten = 10;" : `export const line${i} = ${i};`)),
  )
  git(wt, "commit", "-qam", "Name ten")
  writeFileSync(
    `${wt}/src/app.ts`,
    lines(30, (i) => (i === 3 ? "export const three = 3;" : i === 10 ? "export const ten = 10;" : `export const line${i} = ${i};`)),
  )
})
afterAll(() => server?.stop())

const DRAFT = "What should the agent know"
const BRANCH = "the branch's changes against main, uncommitted ones too"
/** To app.ts's diff: the branch's, with the commit's line 10 and the uncommitted line 3. */
const openFile = () => [`goto /t/${task.id}`, "click Changes", "click role=treeitem[name='app.ts']", "wait css=[data-testid=changes-path][title='src/app.ts']"]
/** The rows of app.ts's diff (their index and text), once it has come. */
async function diffRows(ui) {
  const rowsOf = ui.page.locator('[data-diff="src/app.ts"] [data-i]')
  await rowsOf.filter({ hasText: "export const ten" }).first().waitFor()
  const rows = await rowsOf.evaluateAll((els) => els.map((e) => [e.dataset.i, e.textContent]))
  return (re) => {
    const row = rows.find(([, t]) => re.test(t))
    assert.ok(row, `no row of the diff matches ${re}: ${JSON.stringify(rows)}`)
    return row[0]
  }
}
/** A row's line number, which picks it (shift-click: the lines from the last one picked). */
const number = (ui, i) => ui.page.locator(`[data-diff="src/app.ts"] [data-i="${i}"] > span`).first()
/** Picks the removed line 3. */
const pickThree = async (ui) => number(ui, (await diffRows(ui))(/^\s*3\s*-export const line3/)).click()

async function waitIdle() {
  await waitFor(async () => !(await server.rpc("tasks.get", { id: task.id })).running, 15000)
}

// HA-10: lines picked in a file's diff, each with a note, go to the agent as one message.
test("comments on a file's lines reach the agent in one message", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(openFile())
    const at = await diffRows(ui)
    // The removed line 3: its number, n, a note, Enter; with the focus in the thread's composer before (a line number
    // picked brings the keys to the view).
    await ui.page.locator("textarea").first().click()
    await pickThree(ui)
    await ui.run(["press n", `wait ${DRAFT}`, "type Name it after its value.", "press Enter", `gone ${DRAFT}`, "wait Comment for the agent on removed line 3"])
    // Line 10 (removed and added): a click, then a shift-click.
    await number(ui, at(/^\s*10\s*-export const line10/)).click()
    await number(ui, at(/^\s*10\s*\+export const ten/)).click({ modifiers: ["Shift"] })
    await ui.run(["press n", `wait ${DRAFT}`, "type Keep the old name too.", "press Enter", `gone ${DRAFT}`, "wait 2 comments for the agent"])
    await ui.run(["click Send to the agent", "gone 2 comments for the agent"])
    await waitFor(() => prompts().some((p) => p.includes("Keep the old name too.")))
    const prompt = prompts().find((p) => p.includes("Keep the old name too."))
    assert.match(prompt, /2 comments on the diff:/)
    const fence = "```"
    assert.ok(
      prompt.includes(`**src/app.ts**, removed line 3 (${BRANCH}):\n${fence}diff\n-export const line3 = 3;\n${fence}\nName it after its value.`),
      prompt,
    )
    assert.ok(
      prompt.includes(
        `**src/app.ts**, line 10 (${BRANCH}):\n${fence}diff\n-export const line10 = 10;\n+export const ten = 10;\n${fence}\nKeep the old name too.`,
      ),
      prompt,
    )
  })
})

test("unsent comments and drafts survive switching tabs and a reload, and show in the composer", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(openFile())
    await pickThree(ui)
    await ui.run(["press n", `wait ${DRAFT}`, "type Half a thought"])
    // Away to the thread and back: the draft's still there.
    await ui.run(["click Thread", "click Changes", "wait Half a thought"])
    // A reload: still there. Finished and added.
    await ui.run([
      `goto /t/${task.id}`,
      "click Changes",
      "wait Half a thought",
      "click Half a thought",
      "press End",
      "type , finished.",
      "press Enter",
      "wait Half a thought, finished.",
    ])
    await ui.run(["wait 1 comment for the agent"])
    // In the thread's composer, which can take it off again.
    await ui.run(["click Thread", "wait A comment on the diff, sent with this message", "wait app.ts:3", "click Remove the comment", "gone app.ts:3"])
    // Back in the Changes tab (on all the diffs, as it opens): gone there too.
    await ui.run(["click Changes", "wait app.ts", "wait export const three", "gone 1 comment for the agent", "gone Half a thought"])
  })
})

test("the composer sends the comments with what's typed", async () => {
  await waitIdle()
  await withBrowser(server, {}, async (ui) => {
    await ui.run(openFile())
    await pickThree(ui)
    await ui.run(["press n", `wait ${DRAFT}`, "type Use a better name.", "press Enter", "wait 1 comment for the agent"])
    await ui.run(["click Thread", "wait app.ts:3", "click Add a message to the comment", "type Two things:", "press Enter", "gone app.ts:3"])
    await waitFor(() => prompts().some((p) => p.includes("Use a better name.")))
    const prompt = prompts().find((p) => p.includes("Use a better name."))
    assert.match(
      prompt,
      /Two things:\n\nA comment on the diff:\n\n\*\*src\/app\.ts\*\*, removed line 3 \(the branch's changes against main, uncommitted ones too\):/,
    )
  })
})

test("a line's comment button comments on that line, or on the lines picked if it's one of them", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(openFile())
    const diff = '[data-diff="src/app.ts"]'
    const at = await diffRows(ui)
    const button = async (i) => {
      await ui.page.locator(`${diff} [data-i="${i}"]`).hover()
      await ui.page.locator(`${diff} button[title^="Comment for the agent"]`).click()
    }
    // Outside what's picked: just its line.
    await ui.page
      .locator(`${diff} [data-i="${at(/^\s*8\s*8\s/)}"] > span`)
      .first()
      .click()
    await button(at(/^\s*12\s*12\s/))
    await ui.run([`wait ${DRAFT}`, "wait Comment for the agent on line 12", "click Discard", `gone ${DRAFT}`])
    // In it: all of them (lines 8 to 12, the removed line 10 too).
    await ui.page
      .locator(`${diff} [data-i="${at(/^\s*8\s*8\s/)}"] > span`)
      .first()
      .click()
    await ui.page
      .locator(`${diff} [data-i="${at(/^\s*12\s*12\s/)}"] > span`)
      .first()
      .click({ modifiers: ["Shift"] })
    await button(at(/^\s*10\s*-/))
    await ui.run([`wait ${DRAFT}`, "wait Comment for the agent on lines 8–12", "type All of these.", "press Enter", "wait 1 comment for the agent"])
    const draft = await ui.page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("ia.review."))[1]))
    assert.deepEqual(draft.comments[0].lines, [
      " export const line8 = 8;",
      " export const line9 = 9;",
      "-export const line10 = 10;",
      "+export const ten = 10;",
      " export const line11 = 11;",
      " export const line12 = 12;",
    ])
  })
})

test("diffs are highlighted, and the split layout is remembered", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(openFile())
    // Coloured runs, once the worker has the grammar.
    await waitFor(async () => (await ui.page.locator('[data-diff="src/app.ts"] span[style*="color"]').count()) > 0, 10000)
    const keyword = await ui.page
      .locator('[data-diff="src/app.ts"] span[style*="color"]', { hasText: /^export$/ })
      .first()
      .evaluate((e) => getComputedStyle(e).color)
    const name = await ui.page
      .locator('[data-diff="src/app.ts"] span[style*="color"]', { hasText: /^line3$/ })
      .first()
      .evaluate((e) => getComputedStyle(e).color)
    assert.notEqual(keyword, name)
    // Side by side: the removed line on the left, the added one on the right, in one row.
    await ui.run(["press |"])
    const pair = ui.page.locator('[data-diff="src/app.ts"] > div.flex:has(> div.w-1\\/2)', { hasText: "export const three" })
    await pair.waitFor()
    assert.match(await pair.textContent(), /line3 = 3;.*three = 3;/)
    await ui.run(openFile())
    await ui.page.locator('[data-diff="src/app.ts"] > div.flex:has(> div.w-1\\/2)', { hasText: "export const three" }).waitFor()
  })
})
