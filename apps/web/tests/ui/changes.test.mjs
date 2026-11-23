import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, startServer, withBrowser } from "./harness.mjs"

// HE-96: the Changes tab, laid out as the Code tab is: the Code tab's tree of the files the task changed (committed on
// its branch, uncommitted, untracked), the diff of the file picked (all of them until one is), and each file opened in the
// Code tab. A task with a worktree on a repository the check makes, changed by hand.

let server
let task
let wt
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("")

beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  mkdirSync(`${repo}/src/lib`, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/app.txt`, lines(30))
  writeFileSync(`${repo}/src/lib/util.txt`, lines(5))
  writeFileSync(`${repo}/untouched.txt`, "as it was\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  const profile = await makeProfile(server, "Default")
  const project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" } })
  task = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Edit the app" } })
  task = await server.rpc("git.setupWorktree", { id: task.id })
  wt = task.worktree_path
  // Committed on the task's branch (app.txt's line 20), uncommitted (util.txt's line 2), and a new file.
  writeFileSync(
    `${wt}/app.txt`,
    lines(30, (i) => (i === 20 ? "twenty" : `line ${i}`)),
  )
  git(wt, "commit", "-qam", "Name twenty")
  writeFileSync(
    `${wt}/src/lib/util.txt`,
    lines(5, (i) => (i === 2 ? "two" : `line ${i}`)),
  )
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
})
afterAll(() => server?.stop())

const tree = (name) => `role=treeitem[name='${name}']`

test("the tree lists only the changed files, and shows the diff of the one picked", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", `wait ${tree("app.txt")}`, `wait ${tree("util.txt")}`, `wait ${tree("new.txt")}`])
    // The folders with one folder in them are one row, open; the files the task didn't change aren't there.
    await ui.run([`wait ${tree("src/lib")}`, "wait 3 files changed against main"])
    assert.equal(await ui.page.locator(tree("untouched.txt")).count(), 0)
    // All the diffs until a file is picked.
    await ui.run(["wait css=[data-diff='app.txt']", "wait css=[data-diff='src/lib/util.txt']"])
    // A file: its diff alone, its path above it.
    await ui.run([`click ${tree("util.txt")}`, "wait css=[data-testid=changes-path][title='src/lib/util.txt']", `wait ${tree("util.txt")}[selected]`])
    await ui.run(["gone css=[data-diff='app.txt']", "wait css=[data-diff='src/lib/util.txt'] >> text=two"])
    // `j` and `k` go through the files in the tree's order, Escape back to all of them (the task stays open).
    await ui.run([
      "press j",
      "wait css=[data-testid=changes-path][title='app.txt']",
      "press k",
      "wait css=[data-testid=changes-path][title='src/lib/util.txt']",
    ])
    await ui.run(["press Escape", "gone css=[data-testid=changes-path]", "wait css=[data-diff='app.txt']"])
    assert.match(ui.page.url(), /task=/)
    // A folder folds.
    await ui.run([`click ${tree("src/lib")}`, `gone ${tree("util.txt")}`, `click ${tree("src/lib")}`, `wait ${tree("util.txt")}`])
    // The finder (`t`) goes to a changed file.
    await ui.run(["press t", "type new", "press Enter", "wait css=[data-testid=changes-path][title='new.txt']"])
  })
})

test("a file opens in the Code tab, at its first change", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", `click ${tree("app.txt")}`, "wait css=[data-testid=changes-path][title='app.txt']"])
    await ui.run(["click css=[data-testid=changes-view] button[title='Open in the Code tab']"])
    // At its changed line, 20 (from 0 in the Code tab).
    await ui.run(["wait css=[data-testid=code-path][title='app.txt']", "wait css=[data-n='19'].bg-accent\\/15"])
    // Back in the Changes tab, the file's still picked. From a file's header in all the diffs too.
    await ui.run(["click Changes", "wait css=[data-testid=changes-path][title='app.txt']", "press Escape"])
    await ui.run(["click role=button[name='Open src/lib/util.txt in the Code tab']"])
    await ui.run(["wait css=[data-testid=code-path][title='src/lib/util.txt']"])
  })
})

test("new changes show as the agent makes them", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", `wait ${tree("new.txt")}`])
    writeFileSync(`${wt}/later.txt`, "made later\n")
    await eventually(() => ui.run([`wait ${tree("later.txt")}`]), 15000)
  })
})

// Review of HA-396: the keys that work on every page (p, P and a) aren't taken from the Changes tab.
test("the keys that work on every page leave the Changes tab's alone", async () => {
  await makeProfile(server, "Work").catch(() => {})
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", `wait ${tree("new.txt")}`])
    const at = ui.page.url()
    await ui.run(["press a", "press p", "press Shift+P", "sleep 200"])
    assert.equal(ui.page.url(), at)
  })
})
