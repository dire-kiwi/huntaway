// A project whose folder isn't ready for worktrees (the old worktreeSetup check, HA-20): its board shows the setup thread
// that helps get the folder ready, until it is a git repository with a commit; or the project can do without worktrees.
//
// Changed: the old check ran the page's clock ten times as fast (`fastClock`) for the page's look at the folder every
// 3 s; this installs Playwright's clock and moves it on 3 s once the folder has changed. The agents are the fake claude
// (`--fake-claude`), as the setup thread starts its agent with the user's message: on a host that runs no agents the
// new server refuses the message where the old one kept it (docs/plan/06-server.md).
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { seedAgentBoard, startServer, withBrowser } from "./harness.mjs"

let server, profile
beforeAll(async () => {
  server = startServer("--fake-claude")
  ;({ profile } = await seedAgentBoard(server))
})
afterAll(() => server?.stop())

/** A project on a new, empty folder (not a git repository). */
const project = async (name, key) => {
  const dir = join(server.dataDir, name.toLowerCase())
  mkdirSync(dir)
  return [await server.rpc("projects.create", { project: { profile_id: profile.id, name, repo_path: dir, key } }), dir]
}
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args])

// HA-20: a project whose tasks would wait for worktrees shows a thread that helps get its folder ready instead of its
// board, until the folder is a git repository with a commit.
test("a folder that isn't ready for worktrees shows its setup thread until it is", async () => {
  const [notes, dir] = await project("Notes", "NOTE")
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // The page looks at the folder every 3 s: moved on by the check below.
    await page.clock.install()
    await ui.run([`goto /p/${notes.id}`, "wait isn't a git repository yet", "wait Start setup thread", "gone Search tasks"])
    await ui.run(["type Call the branch trunk", "press Control+Enter", "gone Start setup thread", "wait Call the branch trunk"])
    const p = await server.rpc("projects.get", { id: notes.id })
    assert.ok(p.setup_task_id)
    const t = await server.rpc("tasks.get", { id: p.setup_task_id })
    assert.deepEqual([t.project_id, t.use_worktree], [notes.id, false])
    // A repository with no commits has nothing for a worktree to branch from yet.
    git(dir, "init", "-q", "-b", "main")
    await page.clock.runFor(3000)
    await ui.run(["wait is a git repository with no commits yet", "wait Call the branch trunk"])
    // The board comes back by itself, with the setup thread's task on it.
    git(dir, "commit", "-q", "--allow-empty", "-m", "first")
    await page.clock.runFor(3000)
    await ui.run(["gone Use without worktrees", "wait Search tasks", `wait NOTE-${t.number}`])
  })
  // Asked again, it's the same thread.
  assert.equal((await server.rpc("projects.setupThread", { id: notes.id })).id, (await server.rpc("projects.get", { id: notes.id })).setup_task_id)
})

test("a project can be used without worktrees instead", async () => {
  const [plain] = await project("Plain", "PLN")
  await withBrowser(server, {}, async (ui) => {
    await ui.run([`goto /p/${plain.id}`, "click Use without worktrees", "gone Start setup thread", "wait Search tasks"])
  })
  const p = await server.rpc("projects.get", { id: plain.id })
  assert.deepEqual([p.use_worktrees, p.setup_task_id ?? null], [false, null])
  assert.deepEqual(await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: plain.id } }), [])
})
