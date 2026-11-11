import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { DEMO_TASKS, makeProfile, makeProject, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server
beforeAll(async () => {
  server = startServer()
  await seedBoard(server, DEMO_TASKS)
})
afterAll(() => server?.stop())

// The counts in a profile's sidebar bar, by status.
const bar = (page, profile) =>
  page.evaluate((name) => {
    const row = [...document.querySelectorAll("nav[aria-label=Profiles] button")].find((b) => b.textContent.includes(name))
    return Object.fromEntries([...(row?.querySelectorAll("[data-status]") ?? [])].map((s) => [s.dataset.status, Number(s.textContent)]))
  }, profile)

// IA-120: each profile has a board of all its tasks, with a bar of counts in the sidebar, in place of the inbox.
test("a profile's board has its tasks from every project, and its bar leaves out empty columns", async () => {
  const work = await makeProfile(server, "work")
  const site = await makeProject(server, work, "Site", "SITE")
  await makeTask(server, site, { title: "Ship the site", status: "ready_for_merge" })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // An old inbox link lands on the first profile's board.
    await ui.run(["goto /inbox", "wait Finished work to look over"])
    assert.equal(new URL(page.url()).pathname, "/profile/Default")
    assert.equal(await page.getByText("Ship the site").count(), 0)
    assert.deepEqual(await bar(page, "Default"), { in_progress: 1, needs_attention: 1, in_review: 2 })
    assert.deepEqual(await bar(page, "work"), { ready_for_merge: 1 })

    await ui.run(["click css=nav[aria-label=Profiles] >> text=work", "wait Ship the site", "gone Finished work to look over"])
    assert.equal(new URL(page.url()).pathname, "/profile/work")
  })
})

// IA-120 review: a profile with no projects, on a host that can't run agents (so it can't take new scratch tasks), still
// shows every column its tasks are in. (This server runs no agents: the old check made its host so by rewriting
// /api/hosts.)
test("a profile with no projects on a host that can't run agents shows all its columns", async () => {
  const lab = await makeProfile(server, "lab")
  await server.rpc("tasks.create", { task: { profile_id: lab.id, title: "Old question", status: "in_review" } })
  await server.rpc("tasks.create", { task: { profile_id: lab.id, title: "Old chat", status: "done" } })
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/lab", "wait Old question", "wait Old chat"])
    assert.deepEqual(await bar(page, "lab"), { in_review: 1 })
    // It can't make a scratch task here, and has no project to make a task in.
    assert.equal(await page.locator("role=button[name=/New task/]").count(), 0)
  })
})
