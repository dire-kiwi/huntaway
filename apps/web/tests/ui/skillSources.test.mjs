import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, seedBoard, startServer, withBrowser } from "./harness.mjs"

// Skill sources in Settings → Skills and MCP (HA-140; the old skillSources check, 6.4): a git repository's skills added,
// switched on for a profile, updated and removed. The repository is a local one the check makes.

let server, board, repo
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" })
const skill = (name, description) => {
  mkdirSync(join(repo, "skills", name), { recursive: true })
  writeFileSync(join(repo, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`)
}

beforeAll(async () => {
  server = startServer()
  board = await seedBoard(server)
  repo = mkdtempSync(join(server.dataDir, "skill-source-"))
  git("init", "-q", "-b", "main")
  skill("alpha", "The first skill")
  skill("beta", "The second skill")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
})
afterAll(() => server?.stop())

const tools = () => server.rpc("agentTools.get")

test("adds a git repository's skills, switches them on and updates and removes the source", async () => {
  const { profile, project } = board
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    // A clone that fails says why, in the dialog.
    await ui.run(["goto /settings/tools", "click Add from git", "type /nonexistent/skills-repo", "press Control+Enter", "wait couldn't clone"])
    await page.getByRole("dialog").getByRole("textbox").first().fill(repo)
    await ui.run(["press Control+Enter", "gone Add skills from a git repository", "wait The first skill", "wait The second skill"])
    const added = await tools()
    assert.deepEqual(
      added.skills.map((s) => s.name),
      ["alpha", "beta"],
    )
    assert.equal(added.skill_sources.length, 1)
    assert.deepEqual(added.profile_switches[profile.id] ?? {}, {}, "added skills are off until switched on")

    // The source's chip switches all its skills on for a profile; a source's skills have no Edit or Delete of their own.
    const card = page.locator("div.rounded-xl", { hasText: "All skills on by default in" })
    await card.getByRole("button", { name: profile.name, exact: true }).first().click()
    const on = await eventually(async () => {
      const t = await tools()
      assert.equal(Object.values(t.profile_switches[profile.id]).filter(Boolean).length, 2)
      return t
    })
    assert.ok(on)
    assert.equal(await card.getByRole("button", { name: "Edit" }).count(), 0)

    // The project's settings list them, following the profile.
    const view = await server.rpc("agentTools.project", { project_id: project.id })
    assert.deepEqual(
      view.global_skills.map((s) => [s.name, view.profile_switches[s.id]]),
      [
        ["alpha", true],
        ["beta", true],
      ],
    )

    // A skill added to the repository comes with an update, off; one taken out goes.
    skill("gamma", "The third skill")
    git("rm", "-rq", "skills/beta")
    git("add", "-A")
    git("commit", "-q", "-m", "change")
    await ui.run(["goto /settings/tools", "wait The first skill", "click Update", "wait The third skill", "gone The second skill"])
    const updated = await tools()
    assert.deepEqual(
      updated.skills.map((s) => s.name),
      ["alpha", "gamma"],
    )
    const alpha = updated.skills.find((s) => s.name === "alpha")
    const gamma = updated.skills.find((s) => s.name === "gamma")
    assert.equal(updated.profile_switches[profile.id][alpha.id], true)
    assert.equal(updated.profile_switches[profile.id][gamma.id], undefined)

    await ui.run(["click Remove the source and its skills", "click Remove source", "gone The first skill"])
    const gone = await tools()
    assert.deepEqual([gone.skills, gone.skill_sources], [[], []])
  })
})

test("adds, edits and deletes a global skill and MCP server, and switches one on for a profile", async () => {
  const { profile } = board
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    await ui.run(["goto /settings/tools", "click New skill"])
    await page.getByRole("dialog").getByRole("textbox").fill("---\nname: house-style\ndescription: How we write\n---\n\nShort sentences.\n")
    await ui.run(["click Add skill", "gone SKILL.md", "wait How we write"])
    await ui.run(["click Add MCP server"])
    const dialog = page.getByRole("dialog")
    await dialog.getByPlaceholder("github", { exact: true }).fill("search")
    await dialog.getByRole("combobox").selectOption("http")
    await dialog.getByPlaceholder("https://mcp.example.com/mcp").fill("https://search.example/mcp")
    await ui.run(["click Add server", "wait http · https://search.example/mcp"])
    const t = await tools()
    const server_ = t.mcp_servers.find((s) => s.name === "search")
    assert.deepEqual(server_.config, { type: "http", url: "https://search.example/mcp" })
    // Switched on by default for the profile.
    const row = page.locator("div.space-y-1\\.5", { hasText: "How we write" })
    await row.getByRole("button", { name: profile.name, exact: true }).click()
    const skillId = t.skills.find((s) => s.name === "house-style").id
    await eventually(async () => assert.equal((await tools()).profile_switches[profile.id][skillId], true))
    // A name that's taken is refused, in the dialog.
    await ui.run(["click New skill"])
    await page.getByRole("dialog").getByRole("textbox").fill("---\nname: house-style\ndescription: Again\n---\n")
    await ui.run(["click Add skill", "wait already one named house-style", "press Escape"])
    // Deleted.
    await row.getByTitle("Delete").click()
    await ui.run(["click Delete skill", "gone How we write"])
    assert.deepEqual(
      (await tools()).skills.map((s) => s.name),
      [],
    )
  })
})
