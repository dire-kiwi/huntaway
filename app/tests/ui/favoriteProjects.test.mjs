import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startServer, withBrowser } from "./harness.mjs";

let server, solo;
before(async () => {
  server = startServer();
  const [profile] = await server.api("GET", "/profiles");
  const add = (name, key) => server.api("POST", `/profiles/${profile.id}/projects`, { name, key, repo_path: `${server.dataDir}/${key}`, use_worktrees: false });
  await add("zeta", "ZET");
  await add("Beta", "BET");
  await add("alpha", "ALP");
  const gamma = await add("Gamma", "GAM");
  await server.api("PATCH", `/projects/${gamma.id}`, { group_name: "Middle" });
  // A group with one project, and a group task waiting on an answer.
  const omega = await add("Omega", "OME");
  await server.api("PATCH", `/projects/${omega.id}`, { group_name: "Solo" });
  solo = await server.api("POST", `/profiles/${profile.id}/group-tasks`, { group: "Solo", title: "Plan across Solo", status: "needs_attention" });
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

// HA-84 review: favoriting a group's only project leaves the group's row, the way to its group tasks, with their counts.
test("keeps a group with group tasks once its only project is a favorite", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const group = "css=aside >> role=button[name=/^Solo/]";
    await ui.run(["goto /", `wait ${row("Omega")}`, `rclick ${row("Omega")}`, "click [role=menu] >> text=Add to favorites", "wait [aria-label=Favorites]"]);
    assert.equal((await page.locator(group).innerText()).replace(/\s+/g, " ").trim(), "Solo 1", "the row stays, with its group task needing attention");
    assert.equal(await page.locator("css=aside >> role=button[name=/Expand Solo|Collapse Solo/]").count(), 0, "with nothing to open");
    await ui.run([`click ${group}`, `wait ${solo.title}`]);
    assert.match(new URL(page.url()).pathname, /\/Solo$/, "opens the group's board");
  });
});
