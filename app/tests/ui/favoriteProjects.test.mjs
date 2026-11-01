import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server;
before(async () => {
  server = startServer();
  const [profile] = await server.api("GET", "/profiles");
  const add = (name, key) => server.api("POST", `/profiles/${profile.id}/projects`, { name, key, repo_path: `${server.dataDir}/${key}`, use_worktrees: false });
  await add("zeta", "ZET");
  await add("Beta", "BET");
  await add("alpha", "ALP");
  const gamma = await add("Gamma", "GAM");
  await server.api("PATCH", `/projects/${gamma.id}`, { group_name: "Middle" });
});
after(() => server?.stop());

/** The sidebar's project and group names (and section headings), top to bottom. */
const rows = (page) =>
  page.locator("aside").evaluate((aside) => {
    const names = [];
    const walker = aside.ownerDocument.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (["alpha", "Beta", "Demo", "Gamma", "Middle", "zeta", "Favorites", "Projects"].includes(text)) names.push(text);
    }
    return names;
  });
const row = (name) => `css=aside >> role=button[name=/^[A-Z]{3} ${name}$/]`;

// HA-84: projects and groups are in alphabetical order, whatever the case, and favorites have a section above them.
test("lists projects alphabetically, with favorites in a section of their own", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /", `wait ${row("zeta")}`]);
    assert.deepEqual(await rows(page), ["Projects", "alpha", "Beta", "Demo", "Middle", "Gamma", "zeta"]);

    await ui.run([`rclick ${row("zeta")}`, "click [role=menu] >> text=Add to favorites", "wait [aria-label=Favorites]"]);
    await ui.run([`rclick ${row("Gamma")}`, "click [role=menu] >> text=Add to favorites"]);
    // Gamma leaves its group, which goes as it has no other project.
    assert.deepEqual(await rows(page), ["Favorites", "Gamma", "zeta", "Projects", "alpha", "Beta", "Demo"]);

    await ui.run(["goto /", `wait ${row("zeta")}`]);
    assert.deepEqual(await rows(page), ["Favorites", "Gamma", "zeta", "Projects", "alpha", "Beta", "Demo"], "still favorites after a reload");

    // A hidden favorite goes under the hidden row, and is back under Favorites once it's shown again.
    await ui.run([`rclick ${row("zeta")}`, "click [role=menu] >> text=Hide from sidebar", "wait 1 hidden"]);
    assert.deepEqual(await rows(page), ["Favorites", "Gamma", "Projects", "alpha", "Beta", "Demo"]);
    await ui.run(["click 1 hidden", `rclick ${row("zeta")}`, "click [role=menu] >> text=Show in sidebar", "gone 1 hidden"]);
    assert.deepEqual(await rows(page), ["Favorites", "Gamma", "zeta", "Projects", "alpha", "Beta", "Demo"]);

    await ui.run([`rclick ${row("Gamma")}`, "click [role=menu] >> text=Remove from favorites"]);
    await ui.run([`rclick ${row("zeta")}`, "click [role=menu] >> text=Remove from favorites", "gone [aria-label=Favorites]"]);
    assert.deepEqual(await rows(page), ["Projects", "alpha", "Beta", "Demo", "Middle", "Gamma", "zeta"]);
  });
});
