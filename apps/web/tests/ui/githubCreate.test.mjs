import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { failure, makeProfile, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The old tests/ui/githubCreate.test.mjs. The old check answered `POST /profiles/<id>/projects/github` with `page.route`;
// this one answers `projects.createOnGithub` on the RPC websocket (`routeRpc`), adding the folder as a plain project.

let server, profile, folders
beforeAll(async () => {
  // The fake gh, so nothing here reaches GitHub even if the server runs gh.
  server = startServer("--fake-gh")
  profile = await makeProfile(server, "Default")
  folders = realpathSync(mkdtempSync(join(tmpdir(), "ia-create-")))
})
afterAll(() => {
  server?.stop()
  if (folders) rmSync(folders, { recursive: true, force: true })
})

const projects = () => server.rpc("projects.list", { profile_id: profile.id })

// HA-133: Add project's Folder tab can also create a GitHub repository for the folder, private or public. gh isn't run here: the
// request is checked and answered by adding the folder as a plain project.
test("creates a GitHub repository, private or public, when adding a folder", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const requests = []
    let fail = true
    let pushError = null
    await routeRpc(page, async (request) => {
      if (request.tag !== "projects.createOnGithub") return undefined
      const body = request.payload.project
      // What was given (a field left out goes as null).
      requests.push(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)))
      if (fail) return failure({ _tag: "External", service: "GitHub", reason: "Name already exists on this account" })
      const project = await server.rpc("projects.create", { project: { profile_id: profile.id, name: body.name, repo_path: body.repo_path } })
      return success({ project, github: { full_name: pushError ? "acme/pushy" : "me/x", pushed: !pushError, push_error: pushError } })
    })
    await ui.run(["goto /", "click [title='Add project']", "wait Repository folder", "click role=radio[name=/Folder/]"])
    // Nothing is created unless it's asked for.
    assert.equal(await page.getByText("Repository name").count(), 0)
    assert.equal(await page.locator("[data-modal]").getByRole("button", { name: "Add project", exact: true }).count(), 1)

    await ui.run(["click role=checkbox[name=/Create a GitHub repository/]", "wait Repository name"])
    // Private is the default, and the button says what it does. The repository is named after the folder.
    assert.equal(await page.getByRole("radio", { name: "Private" }).getAttribute("aria-checked"), "true")
    await page.locator("[data-modal] input[type=text], [data-modal] input:not([type])").first().fill(`${folders}/mine`)
    assert.equal(await page.getByPlaceholder("mine").count(), 2, "the repository's and the project's names")
    await ui.run(["click role=button[name='Create private repository and add project']", "wait Name already exists"])
    assert.deepEqual(requests, [{ profile_id: profile.id, repo_path: `${folders}/mine`, visibility: "private", name: "" }])

    // Public, under an organization, with a name of its own.
    await ui.run(["click role=radio[name=Public]", "click [placeholder='your account']", "type acme", "click [placeholder=mine] >> nth=0", "type theirs"])
    fail = false
    await ui.run(["click role=button[name='Create public repository and add project']", "gone [data-modal]"])
    assert.deepEqual(requests[1], { profile_id: profile.id, repo_path: `${folders}/mine`, visibility: "public", owner: "acme", repo_name: "theirs", name: "" })
    const added = (await projects()).find((p) => p.repo_path === `${folders}/mine`)
    await ui.run([`assert location.pathname === '/p/${added.id}'`])

    // A repository that's made but can't be pushed to still adds the project, and the dialog says why instead of closing.
    pushError = "couldn't push to acme/pushy: remote: Permission denied"
    await ui.run([
      "click [title='Add project']",
      "wait Repository folder",
      "click role=radio[name=/Folder/]",
      "click role=checkbox[name=/Create a GitHub repository/]",
    ])
    await page.locator("[data-modal] input[type=text], [data-modal] input:not([type])").first().fill(`${folders}/pushy`)
    await ui.run(["click role=button[name='Create private repository and add project']", "wait Project added, but not pushed", "wait Permission denied"])
    assert.match(await page.locator("[data-modal]").innerText(), /acme\/pushy.*git push -u origin HEAD/s)
    const pushy = (await projects()).find((p) => p.repo_path === `${folders}/pushy`)
    assert.ok(pushy, "the project is added")
    assert.equal(new URL(page.url()).pathname, `/p/${added.id}`, "the board stays where it was until it's asked for")
    await ui.run(["click role=button[name='Open project']", "gone [data-modal]", `assert location.pathname === '/p/${pushy.id}'`])
  })
})
