import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { makeProfile, startServer, withBrowser } from "./harness.mjs"

// HE-79: the Code tab: a task's files in a tree, one shown highlighted, a name clicked in it looked up (where it's
// defined and used), a use followed to its file, back, and Escape closing the panel rather than the task.

let server
let task
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })

beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  mkdirSync(`${repo}/src`, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "t")
  git(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/README.md`, "# The shop\n\nIt sells things.\n")
  writeFileSync(`${repo}/src/util.ts`, "export function helper(s: string) {\n  return s.trim()\n}\n")
  writeFileSync(`${repo}/src/parse.ts`, 'import { helper } from "./util"\n\nexport const parse = (text: string) => helper(text)\n')
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "init")
  const profile = await makeProfile(server, "Default")
  const project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP", base_branch: "main" } })
  task = await server.rpc("tasks.create", { task: { project_id: project.id, title: "Read the code" } })
  task = await server.rpc("git.setupWorktree", { id: task.id })
})
afterAll(() => server?.stop())

test("finds a file, looks a name up, follows a use and goes back", async () => {
  await withBrowser(server, {}, async (ui) => {
    // The README first, as its preview; the tree beside it.
    await ui.run([`goto /t/${task.id}`, "click Code", "wait role=heading[name='The shop']", "wait role=treeitem[name='src']"])
    // `t` finds a file.
    await ui.run(["press t", "type util", "press Enter", "wait css=[data-n='0'] >> text=helper"])
    await ui.run(["wait role=treeitem[name='util.ts'][selected]"])
    // A click on the name looks it up: its definition here, its uses in parse.ts.
    await ui.run(["click css=[data-n='0'] [data-code] span:text-is('helper')", "wait role=heading[name=/Definitions/]"])
    const panel = ui.page.getByLabel("Symbol")
    await panel.getByText("util.ts").first().waitFor()
    await panel.getByText("parse.ts").first().waitFor()
    // Its use in parse.ts's last line opens that file there.
    await panel.getByRole("button", { name: /export const parse/ }).click()
    await ui.run(["wait css=[data-testid=code-path][title='src/parse.ts']", "wait css=[data-n='2'].bg-accent\\/15"])
    // Back to util.ts; Escape closes the panel and leaves the task open.
    await ui.run(["click Back (Alt+←)", "wait css=[data-testid=code-path][title='src/util.ts']", "press Escape", "gone role=heading[name=/Definitions/]"])
    assert.match(ui.page.url(), /task=/)
  })
})
