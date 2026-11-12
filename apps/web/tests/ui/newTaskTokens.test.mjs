// Ports the old newTaskTokens check (IA-220, HA-93, HA-303, HA-392): the new task dialog's tokens (`/plan`, `!sonnet`,
// `^high`, `in:`, `#KEY-n`), its drafts, and Add another.
//
// Changed from the old check:
// - The board is made with the RPC (a profile "Default"; the old server started with one), and its agents run with the
//   fake claude (the old one's ran /bin/false): a scratch task in no project is offered only on a host that runs agents.
//   Tasks are read back with `tasks.list`.
// - HA-93: the old check held the profile board's `GET /profiles/<id>/projects` and clicked New task before they came.
//   The projects now come in the board's one snapshot (`board.watch`), which is what is held here (routeRpc); until it
//   comes there is no New task to click, so the check is that, then the draft as before.
// - "a repository that becomes git's after the board loads": the old board showed the project's setup page until the
//   folder was ready, and looked again every 3 s (on a clock 10 times as fast). Here the setup page (task/WorktreeSetup)
//   asks again with `projects.get` every 3 s and the server reads a not-ready folder again as often
//   (`Projects.gitSweeper`), on the real clock, so the check waits for the page to go.
// - The two cases with another host checked that a draft's uploaded files stay on the host its `in:` sends it to.
//   Attachments in New task are a cut on this board (docs/plan/13-milestones.md), so they check where the draft goes
//   and its text, without files. They share one linked host rather than starting one each.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { afterAll, beforeAll, describe, test } from "vite-plus/test"
import { eventually, gate, gitRepo, makeProfile, makeTask, routeRpc, startServer, withBrowser } from "./harness.mjs"

// Agents run (with the fake claude, which nothing here sends to), as the old check's did (with /bin/false): a scratch task
// in no project (`in:none`) is offered only on a host that runs agents.
let server, profile, project, dep, shopfront
beforeAll(async () => {
  server = startServer("--fake-claude")
  profile = await makeProfile(server, "Default")
  const create = (fields) => server.rpc("projects.create", { project: { profile_id: profile.id, ...fields } })
  project = await create({ name: "Shop", repo_path: gitRepo(`${server.dataDir}/shop`), key: "SHOP" })
  dep = await makeTask(server, project, { title: "Checkout rework" })
  // SHOP-1 is the start of SHOP-10 and SHOP-11, and SHOP of SHOPF.
  for (let i = 2; i <= 11; i++) await makeTask(server, project, { title: `Chore ${i}` })
  shopfront = await create({ name: "Shopfront", repo_path: `${server.dataDir}/shopfront`, key: "SHOPF", use_worktrees: false })
  // A project keyed like `in:none`.
  await create({ name: "Nonesuch", repo_path: `${server.dataDir}/nonesuch`, key: "NONE" })
})
afterAll(() => server?.stop())

const value = "document.querySelector('textarea').value"
const tasksOf = (filter) => server.rpc("tasks.list", { filter })
const created = async (description) => (await tasksOf({ _tag: "ByProject", project_id: project.id })).find((t) => t.description === description)

// IA-220: the new task dialog's options are tokens typed in its description, picked from a list as they're typed,
// and taken out of what its agent is given.
test("tokens set a new task's options, and are taken out of its description", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "wait Reads as",
      "type /pl",
      "wait role=option[name=/plan/]",
      "press Tab",
      `assert ${value} === '/plan '`,
      "wait New task in Shop",
      "type Price rules !son",
      "press Enter",
      "type ^hi",
      "press Tab",
      "type in:XYZ #SHOP-1",
      "wait role=option[name=/Checkout rework/]",
      // Escape closes the list, not the dialog.
      "press Escape",
      "gone role=listbox",
      "assert document.querySelectorAll('[data-modal]').length === 1",
      "press Space",
      "wait after SHOP-1",
    ])
    assert.equal(await page.evaluate(value), "/plan Price rules !sonnet ^high in:XYZ #SHOP-1 ")
    // Known tokens are marked; one that isn't (in:XYZ: there's nowhere else to go from a project's board) is left as text.
    const marked = await page.$$eval("[data-modal] [aria-hidden] span[class*=bg-]", (els) => els.map((e) => [e.textContent, e.className.includes("amber")]))
    assert.deepEqual(marked, [
      ["/plan", false],
      ["!sonnet", false],
      ["^high", false],
      ["in:XYZ", true],
      ["#SHOP-1", false],
    ])
    assert.match(await page.locator("[aria-label='Reads as']").innerText(), /Task\s+Plan\s+Shop\s+Sonnet\s+high effort\s+after SHOP-1/)
    // A chip's × takes its token out.
    await ui.run([
      "click [title='Remove the model']",
      "gone Sonnet",
      `assert ${value} === '/plan Price rules ^high in:XYZ #SHOP-1'`,
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const task = await created("Price rules in:XYZ")
  assert.ok(task)
  // A plan is a label (HA-27): a code task with one.
  assert.deepEqual([task.task_type, task.labels, task.model, task.effort, task.depends_on], [null, ["plan"], null, "high", [dep.id]])
})

// IA-220: on a profile's board, `in:` and a project's key put the task in that project. The draft keeps the tokens.
test("in: puts a task in another project, and its draft keeps the tokens", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /profile/Default",
      // The board has its projects (a draft written in a dialog opened before then didn't always come back, HA-92).
      "wait Checkout rework",
      "click New task",
      "wait Reads as",
      "type in:SHOP",
      "press Enter",
      "wait New task in Shop",
      "type Fix totals `in:none` /nothing",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New task in Shop",
      `assert ${value} === 'in:SHOP Fix totals \`in:none\` /nothing'`,
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  assert.ok(await created("Fix totals `in:none` /nothing"))
})

// HA-303 review: `in:` is English too, so Enter at a bare `in:` ending a line starts a new line rather than picking
// the first place (which put the task elsewhere and took the word out). Tab, or Enter on an option arrowed to, picks.
test("Enter after a bare in: starts a new line, and leaves where the task goes", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /profile/Default",
      "wait Checkout rework",
      "click New task",
      "wait Reads as",
      "type in:SHOP",
      "press Enter",
      "wait New task in Shop",
      "type Fix totals",
      "press Shift+Enter",
      "type The errors are in:",
      "wait role=option[name=/Shopfront/]",
      "press Enter",
      "gone role=listbox",
      "type - cart.ts",
      `assert ${value} === 'in:SHOP Fix totals\\nThe errors are in:\\n- cart.ts'`,
      "wait New task in Shop",
      "press Control+Enter",
      "gone Reads as",
    ])
    assert.ok(await created("Fix totals\nThe errors are in:\n- cart.ts"), "made in Shop, with its text as typed")
    // An option arrowed to is picked with Enter, and the first with Tab.
    await ui.run([
      "click New task",
      "wait Reads as",
      "type Also in:",
      "wait role=option[name=/Shopfront/]",
      "press ArrowDown",
      "press ArrowUp",
      "press Enter",
      "gone role=listbox",
      `assert /^Also in:\\S+ $/.test(${value})`,
      "type and in:",
      "wait role=listbox",
      "press Tab",
      `assert /^Also in:\\S+ and in:\\S+ $/.test(${value})`,
    ])
  })
})

// HA-93: New task clicked on a profile's board before its projects load opens the dialog once they're there. Opened
// before them, it started in no project (the only place there was) and kept its draft there, so the next dialog,
// which starts in a project, came up empty.
test("a draft typed before the profile board's projects load comes back", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const held = gate()
    await routeRpc(page, (r) => (r.tag === "board.watch" ? held.hold() : undefined))
    // It waits for them: no New task to click, and no dialog, before the board's snapshot is there.
    await ui.run(["goto /profile/Default"])
    await eventually(() => assert.equal(held.held(), 1, "the board is held"))
    assert.equal(await page.getByRole("button", { name: "New task" }).count(), 0, "nothing to open a dialog with yet")
    assert.equal(await page.locator("[data-modal]").count(), 0, "no dialog before the projects are there")
    held.release()
    await ui.run([
      "click New task",
      "wait Reads as",
      "type in:SHOP",
      "press Enter",
      "wait New task in Shop",
      "type Fix rounding",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New task in Shop",
      `assert ${value} === 'in:SHOP Fix rounding'`,
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  assert.ok(await created("Fix rounding"))
})

// IA-220 review: Ctrl+Enter with the caret still in a token that's the start of another (#SHOP-1 of #SHOP-10, in:SHOP
// of in:SHOPF) takes it as typed, rather than sending it to the agent as text.
test("Ctrl+Enter takes the token being typed, even when it's the start of another", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "wait Reads as",
      "type Fix checkout #SHOP-1",
      "wait role=option[name=/SHOP-10/]",
      "press Control+Enter",
      "gone Reads as",
    ])
    await ui.run([
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type Fix totals in:SHOP",
      "wait role=option[name=/Shopfront/]",
      "press Control+Enter",
      "gone Reads as",
    ])
  })
  const task = await created("Fix checkout")
  assert.deepEqual(task?.depends_on, [dep.id])
  assert.ok(await created("Fix totals"))
})

// IA-220 review: `in:none` is always no project, also beside a project keyed NONE (which has a word of its own).
test("in:none is no project even with a project keyed NONE", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /profile/Default", "click New task", "wait Reads as", "type in:non", "wait role=option[name=/Nonesuch/]"])
    assert.match(await page.locator("role=option[name=/Nonesuch/]").innerText(), /^in:NONE\.\S+/)
    await ui.run(["click role=option[name=/No project/]", "wait New scratch task in Default", "type Just a question", "press Control+Enter", "gone Reads as"])
  })
  const task = (await tasksOf({ _tag: "Projectless", profile_id: profile.id })).find((t) => t.description === "Just a question")
  assert.deepEqual([task?.project_id, task?.task_type], [null, "scratch"])
})

// IA-220 review: a draft of nothing but tokens is kept, with the options they pick.
test("a draft of only tokens is kept", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}`,
      "click New task",
      "wait Reads as",
      "type /plan !sonnet",
      "press Space",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New task in Shop",
      `assert ${value} === '/plan !sonnet '`,
    ])
  })
})

// IA-220 review: after Add another creates a task somewhere else, that's where the dialog opens next, so the next
// task's draft is kept there too and comes back with its tokens.
test("with Add another, the next task's draft follows the task created somewhere else", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type in:SHOPF",
      "press Space",
      "type /plan First task",
      "click Add another",
      "press Control+Enter",
      "wait Created",
      `assert ${value} === 'in:SHOPF /plan '`,
      "type Second task not yet submitted",
      "press Escape",
      "gone Reads as",
      "click New task",
      "wait New task in Shopfront",
      `assert ${value} === 'in:SHOPF /plan Second task not yet submitted'`,
    ])
  })
})

// IA-220 review: a draft already saved where Add another created a task comes back into the dialog (nothing new is
// written in it yet), rather than being written over by the next one's.
test("a draft saved where Add another creates a task comes back rather than being written over", async () => {
  const notes = "Long Shopfront notes I was writing"
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${shopfront.id}`,
      "click New task",
      "wait Reads as",
      `type ${notes}`,
      "press Escape",
      "gone Reads as",
      "goto /profile/Default",
      "click New task",
      "wait Reads as",
      "type in:SHOPF",
      "press Space",
      "type First task",
      "click Add another",
      "press Control+Enter",
      "wait Created",
      `assert ${value} === '${notes}'`,
      "press Escape",
      "gone Reads as",
      `goto /p/${shopfront.id}`,
      "click New task",
      "wait Reads as",
      `assert ${value} === '${notes}'`,
    ])
  })
})

// IA-220 review: the project the dialog starts in is the board's as it is now, so a repository that became git's after
// the board loaded gets worktrees. Until it has a commit, the board says it isn't ready for them (HA-20).
test("a repository that becomes git's after the board loads gets worktrees", async () => {
  const dir = `${server.dataDir}/later`
  mkdirSync(dir)
  const later = await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Later", repo_path: dir, key: "LATER", use_worktrees: true } })
  assert.equal(later.is_git, false)
  // Steps of 15 s: the server's look is every 3 s, which a busy runner can make longer.
  await withBrowser(server, { timeout: 15000 }, async (ui) => {
    await ui.run([`goto /p/${later.id}`, "wait Start setup thread"])
    gitRepo(dir)
    // Once the server has seen the repository (it looks again every 3 s), the board is back, and a new task gets a
    // worktree.
    await ui.run(["gone Start setup thread", "click New task", "wait Own git worktree", "type Plain task", "press Control+Enter", "gone Reads as"])
  })
  const plain = (await tasksOf({ _tag: "ByProject", project_id: later.id })).find((t) => t.description === "Plain task")
  assert.equal(plain?.use_worktree, true)
})

/** The draft kept for Shopfront's dialog. */
const drafted = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), `ia.newTask.draft.${shopfront.id}`)
/** The profile's board, its dialog starting in `start`, once both hosts' projects are there (a dialog opened before then starts in no project). */
const profileBoard = (start) => [
  "goto /profile/Default",
  `eval localStorage.setItem('ia.newTask.project', '${start.id}')`,
  "goto /profile/Default",
  "wait css=[title='Configure remote']:not(:has-text('offline'))",
  "wait Faraway",
  "wait Shopfront",
]

// With another host linked, named "remote": a profile "Default" there too, with projects Demo (DEMO, as this host's Demo,
// so in:DEMO.remote from here), Remnant (REM) and Faraway (REMOTE). The old checks each started a demo board of their own
// for it, beside this one's demo board.
describe("with another host", () => {
  let remote
  beforeAll(async () => {
    await server.rpc("projects.create", { project: { profile_id: profile.id, name: "Demo", repo_path: `${server.dataDir}/demo`, key: "DEMO" } })
    remote = startServer("--fake-claude")
    const theirs = await makeProfile(remote, "Default")
    for (const [name, key] of [
      ["Demo", "DEMO"],
      ["Remnant", "REM"],
      ["Faraway", "REMOTE"],
    ])
      await remote.rpc("projects.create", { project: { profile_id: theirs.id, name, repo_path: `${remote.dataDir}/${name.toLowerCase()}`, key } })
    const link = await server.rpc("hub.hosts.add", { url: remote.url, token: remote.token })
    await server.rpc("hub.hosts.update", { id: link.id, name: "remote" })
    await eventually(async () => assert.ok((await server.rpc("hub.hosts.list")).find((h) => h.id === link.id)?.connected), 20000)
  })
  afterAll(() => remote?.stop())

  // IA-220 review: a draft brought back by Add another keeps where its `in:` sends it, on another host than the task just
  // created. (The old check's point was that its files, uploaded on that host, are kept: attachments in New task are a
  // cut on this server, docs/plan/13-milestones.md, so it checks the draft's text and where it goes.)
  test("a draft brought back by Add another keeps the host its in: sends it to", async () => {
    await withBrowser(server, { timeout: 20000 }, async (ui) => {
      const { page } = ui
      // A draft in Shopfront's dialog that goes to the other host's project.
      await ui.run([
        ...profileBoard(shopfront),
        "click New task",
        "wait New task in Shopfront",
        "type in:DEMO.re",
        "press Enter",
        "wait New task in Demo (remote)",
        "type Saved remote notes",
      ])
      await eventually(async () => assert.equal((await drafted(page))?.description, "in:DEMO.remote Saved remote notes"))
      // Then Add another from Shop's dialog creates a task in Shopfront, which brings that draft back.
      await ui.run([
        "press Escape",
        "gone Reads as",
        ...profileBoard(project),
        "click New task",
        "wait New task in Shop",
        "type in:SHOPF",
        "press Space",
        "type First local task",
        "click Add another",
        "press Control+Enter",
        "wait Created",
        `assert ${value} === 'in:DEMO.remote Saved remote notes'`,
        "wait New task in Demo (remote)",
        // The note of the task just made stays, with its own key.
        "wait Created SHOPF-",
      ])
    })
  })

  // IA-220 review: moving the caret into an `in:` already taken (REM, the start of REMOTE) doesn't move the task back to
  // where the dialog started while it's there. (The old check's point was the files uploaded where the `in:` sends it,
  // which that would drop: attachments in New task are a cut on this server, so it checks where the task goes.)
  test("moving the caret into and out of an in: keeps where the task goes", async () => {
    await withBrowser(server, { timeout: 20000 }, async (ui) => {
      const { page } = ui
      await ui.run([
        ...profileBoard(shopfront),
        "click New task",
        "wait New task in Shopfront",
        "type in:REM",
        "wait role=option[name=/Faraway/]",
        "press Space",
        "wait New task in Remnant",
        "type Saved remote notes",
      ])
      // Into the token (its list opens, offering REMOTE too), and out again.
      for (const [keys, list] of [
        [["Control+Home", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"], "wait role=option[name=/Faraway/]"],
        [["Control+End"], "gone role=listbox"],
      ]) {
        await ui.run(["eval document.querySelector('textarea').focus()", ...keys.map((k) => `press ${k}`), list, "wait New task in Remnant"])
        assert.equal(await page.locator("text=New task in Shopfront").count(), 0)
      }
      await ui.run([`assert ${value} === 'in:REM Saved remote notes'`])
    })
  })
})

// HA-392: a call to the server after the event loop was blocked for longer than the server keeps an idle connection (as
// startServer blocks it, for a second server) goes on a connection of its own, rather than one the server has closed.
// It failed with "fetch failed" (other side closed) where fetch had two idle connections to it.
test("the harness's calls to a server work after the event loop was blocked for longer than it keeps a connection", async () => {
  await Promise.all([server.rpc("profiles.list"), server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })])
  execFileSync("sleep", ["6.5"])
  assert.equal((await server.rpc("profiles.list")).length, 1)
})
