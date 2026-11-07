// HA-282: connecting a profile to a hosted docs site from the Docs page (the device sign-in), and publishing a
// document's versions there, against a stub of the site's OAuth and MCP endpoints (dire-kiwi/docs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

/** The stub site: a device sign-in the test approves, and `publish_document`. */
function stubSite() {
  // Access tokens → their user (the device sign-in's are ivan's); documents by slug, with their owner and versions.
  const site = { url: "", devices: [], docs: new Map(), access: new Map(), published: [] };
  site.server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const path = new URL(req.url, "http://x").pathname;
    const form = Object.fromEntries(new URLSearchParams(raw));
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/.well-known/oauth-authorization-server") {
      return send(200, {
        token_endpoint: `${site.url}/oauth/token`,
        registration_endpoint: `${site.url}/oauth/register`,
        device_authorization_endpoint: `${site.url}/oauth/device_authorization`,
      });
    }
    if (path === "/oauth/register") return send(201, { client_id: "client-1" });
    if (path === "/oauth/device_authorization") {
      const d = { code: `dc-${site.devices.length}`, approved: false };
      site.devices.push(d);
      return send(200, {
        device_code: d.code,
        user_code: "BCDF-GHJK",
        verification_uri: `${site.url}/device`,
        verification_uri_complete: `${site.url}/device?user_code=BCDF-GHJK`,
        expires_in: 600,
        interval: 0.05,
      });
    }
    if (path === "/oauth/token") {
      const d = site.devices.find((x) => x.code === form.device_code);
      if (!d) return send(400, { error: "invalid_grant" });
      if (!d.approved) return send(400, { error: "authorization_pending" });
      const token = `at-${site.access.size}`;
      site.access.set(token, "ivan");
      return send(200, { access_token: token, refresh_token: `rt-${token}`, expires_in: 3600 });
    }
    if (path === "/mcp") {
      const user = site.access.get((req.headers.authorization ?? "").replace("Bearer ", ""));
      if (!user) return send(401, { error: "invalid_token" });
      const m = JSON.parse(raw);
      const a = m.params.arguments;
      const ok = (v) => send(200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v } });
      const fail = (text) => send(200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } });
      const mine = [...site.docs].filter(([, d]) => d.owner === user);
      if (m.params.name === "list_documents")
        return ok({ documents: mine.map(([slug, d]) => ({ slug, title: d.title, owner: d.owner, shared_with_you: false })) });
      if (m.params.name === "get_document") {
        const d = site.docs.get(a.slug);
        if (!d || d.owner !== user) return fail(`no document "${a.slug}"; call list_documents to see what exists`);
        return ok({ sharing: {}, slug: a.slug, title: d.title, owner: d.owner, url: `${site.url}/d/${a.slug}/`, latest_version: d.versions.length });
      }
      if (m.params.name === "publish_document") {
        if (a.slug === "taken") return fail(`the slug "taken" is taken by another user's document; choose a different slug, or omit it`);
        const d = site.docs.get(a.slug) ?? { owner: user, title: a.title, versions: [] };
        if (d.owner !== user) return fail(`the slug "${a.slug}" is taken by another user's document; choose a different slug, or omit it`);
        d.versions.push(a);
        site.docs.set(a.slug, d);
        site.published.push(a);
        const url = `${site.url}/d/${a.slug}/`;
        return ok({
          slug: a.slug,
          version: d.versions.length,
          url,
          version_url: `${url}-/v/${d.versions.length}/`,
          warnings: [{ page: "notes", warning: "a field" }],
        });
      }
    }
    send(404, {});
  });
  return new Promise((resolve) =>
    site.server.listen(0, "127.0.0.1", () => {
      site.url = `http://127.0.0.1:${site.server.address().port}`;
      resolve(site);
    }),
  );
}

let server, site;
beforeAll(async () => {
  server = startServer();
  site = await stubSite();
});
afterAll(() => {
  server?.stop();
  site?.server.close();
});

/** The site's pages open in a tab of their own: answered here rather than fetched. */
const SITE_TAB = /\/device\?user_code=|\/d\/rollout\//;

/** The publish with a slug that's taken (the site's error, a 400). */
const TAKEN = [/status of 400 .*\/docs\/rollout-plan\/publish\)$/];

test("connect with the device sign-in, publish a version (a slug taken first), publish an older one, and disconnect", async () => {
  await withBrowser(server, { allowErrors: TAKEN }, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /docs/Default", "wait Rollout plan", "click Connect to hosted docs", "wait Publish this profile's documents"]);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Docs site").fill(site.url);
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await dialog.getByLabel("Sign-in code").getByText("BCDF-GHJK").waitFor();
    await dialog.getByText("Waiting for you to allow it there").waitFor();
    // The link opens the site's page for the code.
    await page.context().route(`${site.url}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>docs</title>" }));
    const [tab] = await Promise.all([page.context().waitForEvent("page"), dialog.getByRole("button", { name: /^Open 127\.0\.0\.1/ }).click()]);
    assert.match(tab.url(), SITE_TAB);
    await tab.close();
    // Allowed on the site: the host's poll connects it, and the board is told.
    site.devices.at(-1).approved = true;
    await dialog
      .getByLabel("Hosted docs connection")
      .getByText(`Connected to ${new URL(site.url).host}`)
      .waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: `${new URL(site.url).host}` }).waitFor();

    // Publish the latest version: the slug offered is the local one; one that's taken says so.
    await ui.run(["click Rollout plan", "wait Add phase 2 and the open questions", "click css=header >> role=button[name=Publish]"]);
    const pub = page.getByRole("dialog");
    await pub.getByText("Publishes v2").waitFor();
    assert.equal(await pub.getByLabel("Remote slug").inputValue(), "rollout-plan");
    await pub.getByLabel("Remote slug").fill("taken");
    await pub.getByRole("button", { name: "Publish" }).click();
    await pub.getByText(/the slug "taken" is taken by another user's document/).waitFor();
    await pub.getByLabel("Remote slug").fill("rollout");
    await pub.getByRole("button", { name: "Publish" }).click();
    await pub.getByLabel("Published").getByText("Published as v1 of rollout").waitFor();
    assert.match(await pub.getByLabel("Warnings").innerText(), /notes: a field/);
    const sent = site.published.at(-1);
    assert.equal(sent.title, "Rollout plan");
    assert.equal(sent.message, "Add phase 2 and the open questions");
    assert.equal(sent.pages.length, 5);
    await pub.getByRole("button", { name: "Close" }).first().click();
    await page.getByLabel("Published state").getByText("Published v1 · open").waitFor();
    assert.equal(await page.getByLabel("Published state").getByRole("link").getAttribute("href"), `${site.url}/d/rollout/`);
    assert.equal(await page.getByText("local changes since last publish").count(), 0);

    // Publish the older version: a new version of the same remote document, with no slug to choose.
    await page.getByRole("combobox", { name: "Version" }).selectOption("1");
    await ui.run(["wait An older version: the latest is v2.", "click css=header >> role=button[name=Publish]"]);
    await pub.getByText("Publishes v1").waitFor();
    await pub.getByText("as a new version of").waitFor();
    assert.equal(await pub.getByLabel("Remote slug").count(), 0);
    await pub.getByRole("button", { name: "Publish" }).click();
    await pub.getByLabel("Published").getByText("Published as v2 of rollout").waitFor();
    assert.equal(site.published.at(-1).message, "First draft of the rollout plan");
    await page.keyboard.press("Escape");
    await page.getByLabel("Published state").getByText("local changes since last publish (v1 was published)").waitFor();
    // The list says so too.
    await ui.run(["goto /docs/Default", "wait changed since published"]);

    // Disconnect: publishing asks to connect again.
    await ui.run([`click ${new URL(site.url).host}`, "click Disconnect", "wait Sign in"]);
    await page.keyboard.press("Escape");
    await ui.run(["click Rollout plan", "wait Add phase 2 and the open questions", "click css=header >> role=button[name=Publish]"]);
    await pub.getByText("Connect this profile to a docs site to publish it.").waitFor();
  });
});

// HA-286: a mapping is the account's it was published as; a slug the user has a document at already asks first; and
// another slug re-targets a published document.
test("another account's publish isn't this one's, a slug of the user's asks first, and another slug re-targets it", async () => {
  const [profile] = await server.api("GET", "/profiles");
  const connect = (token) => server.api("POST", `/profiles/${profile.id}/hosted_docs/token`, { site_url: site.url, token });
  // Bob has a document there already, so the site says who he is; and one at the local slug, from another board, say.
  site.access.set("bob-token", "bob");
  site.docs.set("bobs-notes", { owner: "bob", title: "Notes", versions: [{}] });
  site.docs.set("rollout-plan", { owner: "bob", title: "Bob's rollout plan", versions: [{}, {}] });
  const ivan = await connect("bob-token");
  assert.equal(ivan.login, "bob");
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /docs/Default/d/rollout-plan", "wait Add phase 2 and the open questions"]);
    // The first test published it as ivan: not bob's.
    assert.equal(await page.getByLabel("Published state").count(), 0);
    await ui.run(["click css=header >> role=button[name=Publish]"]);
    const pub = page.getByRole("dialog");
    assert.equal(await pub.getByLabel("Remote slug").inputValue(), "rollout-plan");
    await pub.getByRole("button", { name: "Publish" }).click();
    // Bob's own document at that slug: asked first, nothing published.
    const asked = pub.getByLabel("Already on the site");
    await asked.getByText("has a document at rollout-plan already").waitFor();
    assert.match(await asked.innerText(), /“Bob's rollout plan” \(v2\), bob's\. Publishing v2 there adds it as a new version of that document\./);
    assert.equal(site.docs.get("rollout-plan").versions.length, 2);
    // Another slug instead.
    await asked.getByRole("button", { name: "Choose another slug" }).click();
    await pub.getByLabel("Remote slug").fill("bobs-plan");
    await pub.getByRole("button", { name: "Publish" }).click();
    await pub.getByLabel("Published").getByText("Published as v1 of bobs-plan").waitFor();
    await pub.getByRole("button", { name: "Close" }).first().click();
    await page.getByLabel("Published state").getByText("Published v1 · open").waitFor();

    // Re-targeted: to bob's document at the local slug after all, confirmed this time.
    await ui.run(["click css=header >> role=button[name=Publish]", "click Change the slug"]);
    assert.equal(await pub.getByLabel("Remote slug").inputValue(), "bobs-plan");
    await pub.getByLabel("Remote slug").fill("rollout-plan");
    await pub.getByRole("button", { name: "Publish" }).click();
    await pub.getByLabel("Already on the site").getByRole("button", { name: "Publish over it" }).click();
    await pub.getByLabel("Published").getByText("Published as v3 of rollout-plan").waitFor();
    await pub.getByRole("button", { name: "Close" }).first().click();
    await page.getByLabel("Published state").getByText("Published v3 · open").waitFor();

    // Connected as ivan again elsewhere: the page is told, and bob's publish isn't ivan's.
    await connect([...site.access].find(([, u]) => u === "ivan")[0]);
    await page.getByLabel("Published state").waitFor({ state: "detached" });
    await ui.run(["goto /docs/Default", "wait Rollout plan", "gone published v"]);
    await connect("bob-token");
    await ui.run(["wait published v3"]);
  });
});
