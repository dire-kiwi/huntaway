// Fix broken checks in a task's details (the old fixChecks check, HA-53): the button is there for any open task with a
// pull request, whether or not a read found failures, and the failures the last read found are listed and marked on
// the card. A test server can't read GitHub, so the board is given what a read found: the old check rewrote the REST
// task list, this rewrites the task in `board.watch`'s snapshot and events; and `tasks.fixChecks` (the old
// `POST /tasks/<id>/fix_checks`) is answered with the `Conflict` (`nothing_failed`) the server gives when GitHub says
// nothing failed.
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, makeProject, makeProfile, makeTask, startServer, updateTask, withBrowser } from "./harness.mjs"
import { routeSockets } from "./servers.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  const profile = await makeProfile(server)
  project = await makeProject(server, profile, "Shop", "SHOP")
  // Nothing reads its pull requests in the background: neither watching them in review nor Done when merged.
  project = await server.rpc("projects.update", { id: project.id, patch: { watch_pull_requests: "off", done_when_merged: false } })
})
afterAll(() => server?.stop())

const PR = "https://github.com/o/r/pull/7"

/** A task with pull request #7, whose checks the board shows as `checks` (null: never read). */
async function taskWith(page, title, checks) {
  const task = await makeTask(server, project, { title })
  await updateTask(server, task, { pr_url: PR })
  // The host only keeps what a read of GitHub found, which a test server can't make: the board is given it.
  const given = (t) => (t.id === task.id ? { ...t, pr_checks: checks } : t)
  const calls = []
  await routeSockets(page, {
    rewrite: (tag, value) => {
      if (tag !== "board.watch") return value
      if (value.type === "snapshot") return { ...value, tasks: value.tasks.map(given) }
      return value.task ? { ...value, task: given(value.task) } : value
    },
    // Fix broken checks reads GitHub afresh, which says nothing failed.
    handle: (r) => {
      if (r.tag !== "tasks.fixChecks") return undefined
      calls.push(r.payload.id)
      return failure({ _tag: "Conflict", reason: "nothing_failed", detail: "no checks have failed on o/r#7's head commit" })
    },
  })
  return { task, calls }
}

const snapshot = (outcome, failed = []) => ({
  url: PR,
  head: "c0ffee1234",
  outcome,
  failed,
  more_failed: 0,
  pending: 0,
  passed: 2,
  since: new Date().toISOString(),
})

// HA-53 review: the button was only there once a background read had found failures, so a pull request no read
// watches (or one whose last read was before its checks failed) had no way to send them to the agent.
for (const { name, checks, shown } of [
  { name: "never read", checks: null, shown: "Reads the pull request's checks now" },
  { name: "last read when they passed", checks: snapshot("passed"), shown: "Checks passed on c0ffee1 as last read" },
]) {
  test(`Fix broken checks is there for a pull request ${name}, and says when nothing failed`, async () => {
    await withBrowser(server, {}, async (ui) => {
      const { task, calls } = await taskWith(ui.page, `Unwatched, ${name}`, checks)
      await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", `wait ${shown}`])
      assert.equal(await ui.page.locator("[title*='checks failed'], [title*='check failed']").count(), 0, "no failed checks mark")
      await ui.run(["click Fix broken checks", "wait no checks have failed on o/r#7's head commit"])
      assert.deepEqual(calls, [task.id])
    })
  })
}

test("failed checks from the last read are listed with links to their runs, and marked on the card", async () => {
  await withBrowser(server, {}, async (ui) => {
    const failed = [{ name: "Tests / server", conclusion: "failure", url: "https://github.com/o/r/actions/runs/9/job/42" }]
    const { task } = await taskWith(ui.page, "Failing", snapshot("failed", failed))
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", "wait 1 check failed on", "wait Fix broken checks"])
    assert.equal(await ui.page.getByRole("link", { name: "Tests / server" }).getAttribute("href"), failed[0].url)
    assert.equal(await ui.page.locator(`[data-task='${task.id}'] [title^='1 check failed on #7']`).count(), 1, "the card's mark")
  })
})
