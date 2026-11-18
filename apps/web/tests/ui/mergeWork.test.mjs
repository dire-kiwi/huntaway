import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { gitRepo, makeProfile, startServer, withBrowser } from "./harness.mjs"

// HE-51: a task in review is marked with what it has to merge (`git.mergeWork`), read from the worktrees git really
// has: the commits not on its base branch and the uncommitted files; "nothing to merge"; and what's gone (a worktree
// deleted behind the board's back with its branch kept, as FLO-12's was, or the branch too) rather than an error.

let server
let project
/** The repository's branch, which the tasks' work goes to (git's default: `master` or `main`). */
let base
const tasks = {}
const commit = (wt, file) => {
  writeFileSync(`${wt}/${file}`, `${file}\n`)
  execFileSync("git", ["-C", wt, "add", "-A"])
  execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file])
}

beforeAll(async () => {
  server = startServer()
  const repo = `${server.dataDir}/shop`
  gitRepo(repo)
  base = execFileSync("git", ["-C", repo, "branch", "--show-current"]).toString().trim()
  const profile = await makeProfile(server, "Default")
  project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Shop", repo_path: repo, key: "SHOP" } })
  for (const title of ["Has work", "Nothing left", "Worktree deleted", "Branch deleted", "Still in progress"]) {
    const t = await server.rpc("tasks.create", { task: { project_id: project.id, title, use_worktree: true, status: "backlog" } })
    const { worktree_path: wt, branch } = await server.rpc("git.setupWorktree", { id: t.id })
    tasks[title] = { ...t, wt, branch }
  }
  commit(tasks["Has work"].wt, "a.txt")
  commit(tasks["Has work"].wt, "b.txt")
  writeFileSync(`${tasks["Has work"].wt}/draft.txt`, "not committed\n")
  commit(tasks["Worktree deleted"].wt, "c.txt")
  rmSync(tasks["Worktree deleted"].wt, { recursive: true })
  rmSync(tasks["Branch deleted"].wt, { recursive: true })
  execFileSync("git", ["-C", repo, "worktree", "prune"])
  execFileSync("git", ["-C", repo, "branch", "-qD", tasks["Branch deleted"].branch])
  commit(tasks["Still in progress"].wt, "d.txt")
  for (const title of ["Has work", "Nothing left", "Worktree deleted", "Branch deleted"])
    await server.rpc("tasks.update", { id: tasks[title].id, patch: { status: "in_review" } })
  await server.rpc("tasks.update", { id: tasks["Still in progress"].id, patch: { status: "needs_attention" } })
})
afterAll(() => server?.stop())

const mark = (t) => `[data-task="${t.id}"] [data-merge-work]`

test("marks what each task in review has to merge, and nothing on a task in another column", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      `wait ${mark(tasks["Has work"])}`,
      `wait ${mark(tasks["Nothing left"])} >> text=nothing to merge`,
      `wait ${mark(tasks["Branch deleted"])} >> text=branch gone`,
      `wait ${mark(tasks["Worktree deleted"])}`,
    ])
    const marked = async (t) => {
      const el = ui.page.locator(mark(t))
      return [await el.getAttribute("data-merge-work"), await el.getAttribute("title")]
    }
    assert.deepEqual(await marked(tasks["Has work"]), ["changes", `To merge: 2 commits not on ${base}, 1 file with uncommitted changes`])
    assert.deepEqual(await marked(tasks["Nothing left"]), ["nothing", `Nothing to merge: ${base} has all of its commits, and nothing is uncommitted`])
    assert.deepEqual(await marked(tasks["Worktree deleted"]), ["changes", `To merge: 1 commit not on ${base}; its worktree's folder is gone`])
    assert.deepEqual(await marked(tasks["Branch deleted"]), ["gone", "Its branch is gone, and so is its worktree"])
    assert.equal(await ui.page.locator(mark(tasks["Still in progress"])).count(), 0, "no mark outside In review")
    // The task's own view says it in words.
    await ui.run([`goto /p/${project.id}?task=${tasks["Has work"].id}`, `wait To merge: 2 commits not on ${base}, 1 file with uncommitted changes`])
  })
})
