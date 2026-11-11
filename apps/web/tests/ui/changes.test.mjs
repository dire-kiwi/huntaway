import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test"
import { eventually, makeProfile, routeRpc, startServer, withBrowser } from "./harness.mjs"

// The Changes tab (the old changes.test.mjs): a task with a worktree on a repository the check makes, changed by hand,
// and its tab driven from the keyboard. The old checks slowed the page's `/git/diff` and `/git/show` requests with
// `page.route`; these hold the `git.diff` RPC (`routeRpc`). Changed: the last check's "outside the tab they work" is shown
// with the next profile's board (`p`), as the assistant (`a`) isn't on this server yet.

let server
let task
let wt
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("")
/** Whether `check` holds, waiting for it a few seconds (a `git` that fails meanwhile hasn't). */
const waitFor = (check, ms = 5000) => eventually(() => assert.ok(check(), `timed out waiting for ${check}`), ms)

beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/app.txt`, lines(30))
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  const profile = await makeProfile(server, "Default")
  const project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" } })
  task = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Edit the app" } })
  task = await server.rpc("git.setupWorktree", { id: task.id })
  wt = task.worktree_path
})
afterAll(() => server?.stop())
// Nothing staged for the next test, even when one fails (else it fails the next one too).
afterEach(() => wt && git(wt, "reset", "-q"))

// HA-4: the Changes tab stages the lines picked in a file's diff, and only those.
test("stages and unstages chosen lines from the keyboard", async () => {
  // Two changes far apart: lines 3 and 25.
  writeFileSync(
    `${wt}/app.txt`,
    lines(30, (i) => (i === 3 ? "three" : i === 25 ? "twenty-five" : `line ${i}`)),
  )
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", "wait new.txt"])
    // app.txt is first. Into its diff: the cursor is on "-line 3"; down twice is "-line 25", which space stages.
    await ui.run(["press Enter", "wait Unstaged changes", "press j", "press j", "press Space"])
    await waitFor(() => git(wt, "diff", "--cached").includes("-line 25"))
    const staged = git(wt, "diff", "--cached", "--no-color")
    assert.match(staged, /^-line 25$/m)
    assert.doesNotMatch(staged, /twenty-five|three|line 3$/m)
    // In the staged changes (tab) space unstages it again.
    await ui.run(["wait Staged changes", "press Tab", "press Space"])
    await waitFor(() => git(wt, "diff", "--cached") === "")
    // Escape goes back to the files rather than closing the task.
    await ui.run(["press Escape", "press j", "press Space"])
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n")
    assert.match(ui.page.url(), /task=/)
  })
})

// HA-326 review: the task dialog over a page (?modal=<id>) was marked as a dialog itself, so the Changes tab in it took no
// keys (the view leaves keys alone under a dialog). Its keys work there as in the side panel, and Escape closes only
// what's on top.
test("the Changes tab takes its keys in a task dialog over the page", async () => {
  writeFileSync(
    `${wt}/app.txt`,
    lines(30, (i) => (i === 3 ? "three" : `line ${i}`)),
  )
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /settings?modal=${task.id}`, "click css=[data-task-modal] >> text=Changes", "wait new.txt"])
    await ui.run(["press ?", "wait role=dialog[name='Keybindings']", "press Escape", "gone role=dialog[name='Keybindings']", "wait css=[data-task-modal]"])
    await ui.run(["press j", "press Space"])
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n")
    // Closed with its button: an Escape right after the space can wait in the tab's queue while the stage settles.
    await ui.run(["click css=[data-task-modal] [title='Close (Esc)']", "gone css=[data-task-modal]"])
    assert.equal(new URL(ui.page.url()).pathname, "/settings")
  })
})

// HA-169: a key that came before what the one before it did was rendered (a slow machine) was taken against the old
// state: after an Escape back to the files, `j` moved the cursor in the diff that was left and space staged app.txt.
// Keys sent at once, with no render between them, are the same at any speed.
test("keys pressed before the last one's change is shown wait for it", async () => {
  writeFileSync(
    `${wt}/app.txt`,
    lines(30, (i) => (i === 3 ? "three" : i === 25 ? "twenty-five" : `line ${i}`)),
  )
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
  await withBrowser(server, {}, async (ui) => {
    // Into app.txt's diff, staging its lines ("Select range" is only offered there).
    await ui.run([`goto /t/${task.id}`, "click Changes", "wait new.txt", "press Enter", "wait Select range"])
    await ui.page.evaluate(() => {
      for (const key of ["Escape", "j", " "]) document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    })
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n")
    assert.match(ui.page.url(), /task=/)
  })
})

// Enter on a file before its diff had loaded didn't go into it, so the Escape after it closed the task.
test("Escape after Enter on a file still loading goes back to the files", async () => {
  await withBrowser(server, {}, async (ui) => {
    // Slow diffs, so the keys come before new.txt's.
    await routeRpc(ui.page, (request) => (request.tag === "git.diff" ? new Promise((r) => setTimeout(() => r(undefined), 500)) : undefined))
    await ui.run([
      `goto /p/${task.project_id}?task=${task.id}`,
      "click Changes",
      "wait new.txt",
      "sleep 700",
      "press j",
      "press Enter",
      "press Escape",
      "sleep 800",
    ])
    assert.match(ui.page.url(), /task=/)
    // Back in the files: space stages new.txt.
    await ui.run(["press Space"])
    await waitFor(() => git(wt, "diff", "--cached", "--name-only") === "new.txt\n")
  })
})

// A dialog opened from a menu (stash options, then its message) had nothing to give the focus back to, so keys
// went nowhere once it closed.
test("keys still work after a dialog opened from a menu", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /t/${task.id}`,
      "click Changes",
      "wait new.txt",
      "press S",
      "wait Stash staged changes",
      "press a",
      "wait Message (optional)",
      "type wip",
    ])
    await ui.run(["press Enter", "gone Message (optional)"])
    await waitFor(() => git(wt, "stash", "list").includes("wip"))
    await ui.run(["press 4", "press g", "wait Apply and then drop", "press Enter", "gone Apply and then drop"])
    await waitFor(() => git(wt, "stash", "list") === "" && git(wt, "status", "--short").includes("new.txt"))
  })
})

// The commit dialog commits what's staged, and the commit is listed, with its patch.
test("commits what's staged, and shows the commit", async () => {
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", "wait new.txt", "press 2", "press a"])
    await waitFor(() => git(wt, "diff", "--cached", "--name-only").includes("new.txt"))
    await ui.run(["press c", "wait role=dialog[name='Commit']", "type Add new.txt", "press Control+Enter", "gone role=dialog[name='Commit']"])
    await waitFor(() => git(wt, "log", "-1", "--format=%s") === "Add new.txt\n")
    await ui.run(["wait Committed", "press 3", "wait Add new.txt", "press Enter", "wait commit "])
  })
})

// Review of HA-396: the keys that work on every page (p, P and a) were taken in the Changes tab wherever the focused
// panel had nothing for them, which left the task.
test("the keys that work on every page leave the Changes tab's alone", async () => {
  writeFileSync(`${wt}/new.txt`, "a\nb\n")
  await makeProfile(server, "Work").catch(() => {})
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /t/${task.id}`, "click Changes", "wait new.txt"])
    const at = ui.page.url()
    // The Commits panel has no key of its own for any of them.
    await ui.run(["press 3", "press a", "press p", "press Shift+P", "sleep 200"])
    assert.equal(ui.page.url(), at)
    // Outside the tab they work: the next profile's board.
    await ui.run(["click Thread", "eval document.activeElement.blur()", "press p"])
    await waitFor(() => ui.page.url() !== at)
  })
})
