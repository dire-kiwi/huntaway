import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

let server, profile, folders;
beforeAll(async () => {
  server = startServer();
  [profile] = await server.api("GET", "/profiles");
  folders = realpathSync(mkdtempSync(join(tmpdir(), "ia-create-")));
});
afterAll(() => {
  server?.stop();
  if (folders) rmSync(folders, { recursive: true, force: true });
});

// HA-133: Add project's Folder tab can also create a GitHub repository for the folder, private or public. gh isn't run here: the
// request is checked and answered by adding the folder as a plain project.
test("creates a GitHub repository, private or public, when adding a folder", async () => {
  await withBrowser(server, { allowErrors: [/status of 400 .*\/projects\/github\)$/] }, async (ui) => {
    const { page } = ui;
    const requests = [];
    let fail = true;
    let pushError = null;
    await page.route("**/projects/github", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (fail) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Name already exists on this account" }) });
      const project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: body.name, repo_path: body.repo_path });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...project, github: { full_name: pushError ? "acme/pushy" : "me/x", pushed: !pushError, push_error: pushError } }),
      });
    });
    await ui.run(["goto /", "click [title='Add project']", "wait Repository folder", "click role=radio[name=/Folder/]"]);
    // Nothing is created unless it's asked for.
    assert.equal(await page.getByText("Repository name").count(), 0);
    assert.equal(await page.locator("[data-modal]").getByRole("button", { name: "Add project", exact: true }).count(), 1);

    await ui.run(["click role=checkbox[name=/Create a GitHub repository/]", "wait Repository name"]);
    // Private is the default, and the button says what it does. The repository is named after the folder.
    assert.equal(await page.getByRole("radio", { name: "Private" }).getAttribute("aria-checked"), "true");
    await page.locator("[data-modal] input[type=text], [data-modal] input:not([type])").first().fill(`${folders}/mine`);
    assert.equal(await page.getByPlaceholder("mine").count(), 2, "the repository's and the project's names");
    await ui.run(["click role=button[name='Create private repository and add project']", "wait Name already exists"]);
    assert.deepEqual(requests, [{ repo_path: `${folders}/mine`, visibility: "private", name: "" }]);

    // Public, under an organization, with a name of its own.
    await ui.run(["click role=radio[name=Public]", "click [placeholder='your account']", "type acme", "click [placeholder=mine] >> nth=0", "type theirs"]);
    fail = false;
    await ui.run(["click role=button[name='Create public repository and add project']", "gone [data-modal]"]);
    assert.deepEqual(requests[1], { repo_path: `${folders}/mine`, visibility: "public", owner: "acme", repo_name: "theirs", name: "" });
    const added = (await server.api("GET", `/profiles/${profile.id}/projects`)).find((p) => p.repo_path === `${folders}/mine`);
    await ui.run([`assert location.pathname === '/p/${added.id}'`]);

    // A repository that's made but can't be pushed to still adds the project, and the dialog says why instead of closing.
    pushError = "couldn't push to acme/pushy: remote: Permission denied";
    await ui.run([
      "click [title='Add project']",
      "wait Repository folder",
      "click role=radio[name=/Folder/]",
      "click role=checkbox[name=/Create a GitHub repository/]",
    ]);
    await page.locator("[data-modal] input[type=text], [data-modal] input:not([type])").first().fill(`${folders}/pushy`);
    await ui.run(["click role=button[name='Create private repository and add project']", "wait Project added, but not pushed", "wait Permission denied"]);
    assert.match(await page.locator("[data-modal]").innerText(), /acme\/pushy.*git push -u origin HEAD/s);
    const pushy = (await server.api("GET", `/profiles/${profile.id}/projects`)).find((p) => p.repo_path === `${folders}/pushy`);
    assert.ok(pushy, "the project is added");
    assert.equal(new URL(page.url()).pathname, `/p/${added.id}`, "the board stays where it was until it's asked for");
    await ui.run(["click role=button[name='Open project']", "gone [data-modal]", `assert location.pathname === '/p/${pushy.id}'`]);
  });
});
