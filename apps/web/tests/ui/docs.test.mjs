// HA-281: the profile's Docs page, under its assistant in the sidebar: the documents its agents publish (HA-280), each
// with its menu of pages and its versions. `--demo` seeds one ("Rollout plan", two versions).
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { demoProject, routeThread, startServer, withBrowser } from "./harness.mjs";

let server, profile;
beforeAll(async () => {
  server = startServer();
  [profile] = await server.api("GET", "/profiles");
});
afterAll(() => server?.stop());

const DOC = "/docs/Default/d/rollout-plan";
/** A page a version doesn't have, and a document that's been deleted. */
const MISSING = [/status of 404 .*\/docs\/rollout-plan(\/versions\/.*)?\)$/];
/** The page's frame. */
const reader = (page) => page.frameLocator("main iframe, iframe[title]").first();
const path = (page) => decodeURIComponent(new URL(page.url()).pathname);

/** Waits for the page's path to be `want` (with or without a slash at the end). */
async function waitPath(page, want) {
  await page.waitForFunction((want) => decodeURIComponent(location.pathname).replace(/\/$/, "") === want.replace(/\/$/, ""), want);
}

test("the sidebar's Docs lists the profile's documents, and a document's links, menu and versions move between its pages", async () => {
  await withBrowser(server, { allowErrors: MISSING }, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /profile/Default", "wait Try a scratch task"]);
    // Right under the assistant.
    const entries = await page.locator("nav[aria-label=Assistant], nav[aria-label=Docs]").evaluateAll((navs) => navs.map((n) => n.getAttribute("aria-label")));
    assert.deepEqual(entries, ["Assistant", "Docs"]);
    await ui.run(["click css=nav[aria-label=Docs] >> text=Docs", "wait Rollout plan"]);
    assert.equal(path(page), "/docs/Default");
    const row = page.locator("table[aria-label=Documents] tbody tr");
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /Rollout plan\s+rollout-plan · 5 pages\s+v2\s+just now\s+DEMO-5\s*Finished work to look over/);
    assert.match(await row.getByRole("link", { name: /Finished work to look over/ }).getAttribute("href"), /^\/t\//);
    assert.equal(
      await page
        .locator("nav[aria-label=Docs] button")
        .getAttribute("class")
        .then((c) => c.includes("bg-raised")),
      true,
      "the entry is marked",
    );

    // The latest version's index, in the reader's styles with the board's colours, in one request for one page (HA-286).
    const asked = [];
    page.on("request", (r) => r.url().includes("/versions/") && asked.push(new URL(r.url()).search));
    await ui.run(["click Rollout plan"]);
    await waitPath(page, DOC);
    const frame = reader(page);
    await frame.locator("h1", { hasText: "Rollout plan" }).waitFor();
    const look = await frame.locator(".docs-render").evaluate((el) => {
      const h2 = el.querySelector("h2");
      return { bg: getComputedStyle(el).backgroundColor, rule: getComputedStyle(h2).borderBottomStyle };
    });
    assert.deepEqual(look, { bg: "rgb(11, 11, 14)", rule: "solid" });
    await ui.run(["wait Add phase 2 and the open questions"]);
    assert.equal(await page.getByRole("combobox", { name: "Version" }).inputValue(), "2");
    // The merged version's menu reads in order (HA-286: its pages' `order:`, as a merge keeps the others' positions).
    assert.deepEqual(await page.locator("nav[aria-label=Pages] button").allInnerTexts(), ["Rollout plan", "Phases", "Phase 1", "Phase 2", "Notes"]);
    assert.deepEqual(
      asked.map((q) => new URLSearchParams(q).get("first")),
      ["1"],
    );

    // A link to a heading in the page stays in the page (in a srcdoc frame it would load the board's address there).
    await frame.locator("h2 .anchor").click();
    await page.waitForTimeout(300);
    assert.equal(path(page), `${DOC}/`);
    assert.equal(await frame.locator(".docs-render h1").count(), 1);
    // A link out opens in a tab of its own.
    await page.context().route("https://github.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>docs</title>" }));
    const [tab] = await Promise.all([page.context().waitForEvent("page"), frame.getByRole("link", { name: "the docs app" }).click()]);
    assert.equal(tab.url(), "https://github.com/dire-kiwi/docs");
    await tab.close();
    assert.equal(path(page), `${DOC}/`);

    // A link between pages opens the page here.
    await frame.getByRole("link", { name: "Phase 1" }).click();
    await waitPath(page, `${DOC}/plan/phase-1`);
    await frame.locator("h1", { hasText: "Phase 1" }).waitFor();
    assert.equal(await page.locator("nav[aria-label=Pages] [aria-current=page]").innerText(), "Phase 1");

    // The menu, nested: a folder's own page, then another page.
    await page.locator("nav[aria-label=Pages]").getByRole("button", { name: "Phases" }).click();
    await waitPath(page, `${DOC}/plan`);
    await frame.locator("h1", { hasText: "Phases" }).waitFor();
    await page.locator("nav[aria-label=Pages]").getByRole("button", { name: "Notes" }).click();
    await waitPath(page, `${DOC}/notes`);
    // Its form fields are read-only, and say why.
    await frame.getByText("Read-only: local documents don't collect answers.").first().waitFor();
    assert.equal(await frame.locator(".field input:not([disabled]), .field textarea:not([disabled])").count(), 0);
    assert.ok((await frame.locator(".field input").count()) > 0);
    assert.equal(await frame.locator(".callout-warning").count(), 1);

    // The first version has no notes page: it says so, and opens its own first page.
    await page.getByRole("combobox", { name: "Version" }).selectOption("1");
    await waitPath(page, `${DOC}/-/v/1/notes`);
    await ui.run(["wait Version 1 of this document has no page “notes”.", "click Open its first page"]);
    await waitPath(page, `${DOC}/-/v/1`);
    await frame.locator("h1", { hasText: "Rollout plan" }).waitFor();
    await ui.run(["wait First draft of the rollout plan", "wait An older version: the latest is v2."]);
    const pages = await page.locator("nav[aria-label=Pages] button").allInnerTexts();
    assert.deepEqual(pages, ["Rollout plan", "Phases", "Phase 1"]);
    // Its links stay in that version.
    await frame.getByRole("link", { name: "Phase 1" }).click();
    await waitPath(page, `${DOC}/-/v/1/plan/phase-1`);
    await frame.locator("h1", { hasText: "Phase 1" }).waitFor();
    await ui.run(["click Read the latest"]);
    await waitPath(page, `${DOC}/plan/phase-1`);
    await ui.run(["gone An older version"]);

    // Back and forward go through the pages read.
    await page.goBack();
    await waitPath(page, `${DOC}/-/v/1/plan/phase-1`);
    await ui.run(["wait First draft of the rollout plan"]);

    // A version that isn't there says so (HA-286), and offers the latest.
    await ui.run([`goto ${DOC}/-/v/9/plan`, "wait Version 9 not found.", "click Read the latest"]);
    await waitPath(page, `${DOC}/plan`);
    await reader(page).locator("h1", { hasText: "Phases" }).waitFor();
  });
});

// Agents' links name the profile by its id (doc_base in apps/server/src/mcp/docs_mcp.ts).
test("an agent's link to a version's page opens it, with the profile's Docs marked", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /docs/${profile.id}/d/rollout-plan/-/v/2/plan/phase-2`, "wait Add phase 2 and the open questions"]);
    await reader(page).locator("h1", { hasText: "Phase 2" }).waitFor();
    assert.ok(await page.locator("nav[aria-label=Docs] button").evaluate((b) => b.className.includes("bg-raised")));
    // The latest is v2 itself: no older version's note.
    assert.equal(await page.getByText("An older version").count(), 0);
    // Its link up a folder, to the document's first page.
    await reader(page).getByRole("link", { name: "Back to the plan" }).click();
    await waitPath(page, `/docs/${profile.id}/d/rollout-plan/-/v/2/`);
    await reader(page).locator("h1", { hasText: "Rollout plan" }).waitFor();
  });
});

// The `publish_document` result names the host's own address (127.0.0.1 unless it has a public URL): the thread links
// to the board's page instead.
test("a task's thread links to the document it published, on the board's Docs page", async () => {
  const project = await demoProject(server);
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Publishes a plan" });
  const url = `http://127.0.0.1:9/docs/${profile.id}/d/rollout-plan/`;
  const result = JSON.stringify({ slug: "rollout-plan", version: 1, url, version_url: `${url}-/v/1/`, pages: [] });
  const messages = [
    { kind: "user", data: { text: "Write the plan up." } },
    {
      kind: "claude",
      data: {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "d1", name: "mcp__docs__publish_document", input: { title: "Rollout plan", pages: [] } }] },
      },
    },
    { kind: "claude", data: { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "d1", content: result }] } } },
    { kind: "claude", data: { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Published it." }] } } },
    { kind: "claude", data: { type: "result", subtype: "success", duration_ms: 1000, num_turns: 1 } },
  ].map((m, i) => ({ id: i + 1, task_id: task.id, created_at: `2026-10-26T07:00:0${i}.000Z`, ...m }));
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, task.id, messages);
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Thread", "wait Published it."]);
    // The version it published (HA-286), not the latest.
    const link = page.getByRole("link", { name: "Open “Rollout plan” (v1) in Docs" });
    assert.equal(await link.getAttribute("href"), `/docs/${profile.id}/d/rollout-plan/-/v/1/`);
    await link.click();
    await waitPath(page, `/docs/${profile.id}/d/rollout-plan/-/v/1`);
    await reader(page).locator("h1", { hasText: "Rollout plan" }).waitFor();
    await ui.run(["wait First draft of the rollout plan"]);
  });
});

test("a document deleted from the list leaves it, and the document's page open elsewhere says so", async () => {
  await withBrowser(server, { allowErrors: MISSING }, async (ui) => {
    const { page } = ui;
    await ui.run([`goto ${DOC}/`, "wait Add phase 2 and the open questions"]);
    const list = await page.context().newPage();
    await list.goto(`${server.url}/docs/Default`);
    await list.getByRole("button", { name: "Delete Rollout plan" }).click();
    await list.getByText("Delete “Rollout plan”?").waitFor();
    await list.getByRole("button", { name: "Delete", exact: true }).click();
    await list.getByText("No documents yet.").waitFor();
    assert.deepEqual(await server.api("GET", `/profiles/${profile.id}/docs`), []);
    // Told by the host's event.
    await ui.run(["wait has no document “rollout-plan”"]);
  });
});
