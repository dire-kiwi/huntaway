import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

test("merge summaries inherit the profile, override on/off, and reset to inheritance", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /settings"]);
    await page.locator("section").filter({ has: page.getByRole("heading", { name: "Profiles", exact: true }) }).getByRole("button", { name: "Edit", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Summarise and approve before merging" });
    await toggle.click();
    // ProfileForm uses the same Save changes action as its other settings.
    await page.getByRole("button", { name: /^Save/ }).click();
    await ui.run(["gone Edit profile on"]);
    const [profile] = await server.api("GET", "/profiles");
    assert.equal(profile.summarize_merge, true);
    await ui.run([`goto /p/${project.id}/settings/review`, "wait Summarize merge"]);
    const setting = page.getByLabel("Summarize merge", { exact: true });
    assert.equal(await setting.inputValue(), "profile");
    assert.match(await setting.innerText(), /Profile's setting \(on\)/);
    for (const [value, expected] of [["false", false], ["true", true], ["profile", null]]) {
      await setting.selectOption(value);
      await ui.run(["click Save changes", "wait text=Saved"]);
      assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), true);
      assert.equal((await server.api("GET", `/projects/${project.id}`)).summarize_merge, expected);
      await page.reload();
      await ui.run(["wait Summarize merge"]);
      assert.equal(await setting.inputValue(), value);
    }
    await page.screenshot({ path: `${process.env.TMPDIR}/ha85-merge-settings.png` });
  });
});
