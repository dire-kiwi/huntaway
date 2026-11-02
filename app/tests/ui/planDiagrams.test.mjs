import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project, plan;
before(async () => {
  server = startServer();
  project = await demoProject(server);
  plan = (await server.api("GET", `/projects/${project.id}/tasks`)).find((t) => t.labels.includes("plan"));
});
after(() => server?.stop());

async function openPlan(ui, content) {
  if (content) {
    const at = new Date().toISOString();
    await ui.page.route(new RegExp(`/tasks/${plan.id}/document(\\?.*)?$`), (route) => route.fulfill({ json: {
      task_type: "plan", file: "plan.html", versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }], version: 1, content,
    } }));
  }
  await ui.run([`goto /p/${project.id}?task=${plan.id}`, "wait css=iframe"]);
  return ui.page.frames().find((f) => f.parentFrame() === ui.page.mainFrame());
}

const ready = (frame, count) => frame.waitForFunction((count) => {
  const images = [...document.querySelectorAll("ia-diagram > img")];
  return images.length === count && images.every((i) => i.complete && i.naturalWidth > 0);
}, count, { timeout: 10000 });

async function withDownload(page, check) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download plan.html", exact: true }).click();
  const downloaded = await downloading;
  const path = `${await downloaded.path()}.html`;
  await downloaded.saveAs(path);
  const offline = await page.context().browser().newContext({ offline: true });
  try {
    const exported = await offline.newPage();
    await exported.goto(pathToFileURL(path).href);
    await check(exported, await readFile(path, "utf8"));
  } finally {
    await offline.close();
  }
}

test("plan diagrams render Mermaid locally, including multiple types and escaped labels, without disturbing answers", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    const external = [];
    await page.route(/^https?:\/\//, (route) => {
      if (!route.request().url().startsWith(server.url)) external.push(route.request().url());
      return route.continue();
    });
    const content = `<h1>Diagrams</h1>
<ia-diagram title="Update flow"><pre>flowchart LR
  A["Version &lt; 2 &amp; stable"] --&gt; B["Restart (server)"] --&gt; C["Two&lt;br/&gt;lines"]
</pre></ia-diagram>
<ia-diagram><pre>sequenceDiagram
  Board-&gt;&gt;Server: Check releases
  Server--&gt;&gt;Board: Ready
</pre></ia-diagram>
<ia-question name="notes" type="text" title="Notes?"></ia-question>`;
    let frame = await openPlan(ui, content);
    await frame.locator("input[name=notes]").fill("Keep this answer");
    await ready(frame, 2);
    assert.deepEqual(external, [], "Mermaid comes from the app, not a CDN");
    assert.equal(await frame.locator("ia-diagram > svg").count(), 0, "SVGs are displayed as inert images");
    const svg = await frame.locator("ia-diagram > img").first().getAttribute("src");
    assert.match(decodeURIComponent(svg), /Version &lt; 2 &amp; stable/);
    assert.match(decodeURIComponent(svg), /Restart \(server\)/);
    // Mermaid writes a label's line break as HTML (<br>), which an SVG image can't load (HA-80).
    assert.match(decodeURIComponent(svg), /Two<br \/>lines/);
    assert.equal(await frame.locator("input[name=notes]").inputValue(), "Keep this answer");
    assert.ok(await frame.locator("ia-diagram > pre").first().isHidden());

    // Source stays editable Mermaid, and rebuilding the sandbox restores both diagrams and unsent answers.
    await ui.run(["click Source", "gone css=iframe"]);
    assert.match(await page.locator("pre").innerText(), /sequenceDiagram/);
    await ui.run(["click Preview", "wait css=iframe"]);
    frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
    await ready(frame, 2);
    assert.equal(await frame.locator("input[name=notes]").inputValue(), "Keep this answer");

    // Exported plans contain the pictures and work without a running board or external libraries.
    await withDownload(page, async (exported, html) => {
      assert.match(html, /data:image\/svg\+xml/);
      assert.doesNotMatch(html, /<ia-diagram[^>]*>\s*<pre>/);
      await ready(exported, 2);
    });
  });
});

test("a broken Mermaid diagram shows its error and source while other diagrams and older SVG plans still display", async () => {
  await withBrowser(server, {}, async (ui) => {
    const frame = await openPlan(ui, `<h1>Mixed diagrams</h1>
<ia-diagram><pre>flowchart LR
  A[broken
</pre></ia-diagram>
<ia-diagram><pre>flowchart LR
  A["Works"] --&gt; B["Still works"]
</pre></ia-diagram>
<ia-diagram><svg viewBox="0 0 100 30"><text x="0" y="20">Earlier plan</text></svg></ia-diagram>`);
    await frame.getByRole("alert").waitFor();
    assert.match(await frame.getByRole("alert").innerText(), /Mermaid:.*Parse error/s);
    assert.ok(await frame.locator("ia-diagram > pre").first().isVisible());
    await ready(frame, 1);
    assert.equal(await frame.locator("ia-diagram > svg text").textContent(), "Earlier plan");
    assert.equal(await frame.locator("ia-diagram[aria-busy]").count(), 0);
    await withDownload(ui.page, async (exported) => {
      await ready(exported, 1);
      assert.ok(await exported.locator(".ia-diagram-error pre").isVisible());
      assert.match(await exported.locator(".ia-diagram-error").innerText(), /Mermaid:.*Parse error/s);
      assert.equal(await exported.locator("ia-diagram[aria-busy]").count(), 0);
    });
  });
});

test("the demo plan uses Mermaid, and the standalone diagram viewer still renders and zooms", async () => {
  await withBrowser(server, {}, async (ui) => {
    const frame = await openPlan(ui);
    await ready(frame, 1);
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    const diagram = tasks.find((t) => t.labels.includes("diagram"));
    await ui.run([`goto /p/${project.id}?task=${diagram.id}`, "wait css=img[alt=Diagram]", "click Zoom in"]);
    assert.ok(await ui.page.getByTitle("Download the rendered diagram", { exact: true }).isVisible());
    assert.match(await ui.page.getByTitle("Fit to the width", { exact: true }).innerText(), /^\d+%$/);
  });
});

test("a standalone diagram with line breaks in its labels loads as an image", async () => {
  await withBrowser(server, {}, async (ui) => {
    const tasks = await server.api("GET", `/projects/${project.id}/tasks`);
    const diagram = tasks.find((t) => t.labels.includes("diagram"));
    const content = 'flowchart LR\n  A["One<br/>two"] --> B["Three<br>four"]\n';
    const at = new Date().toISOString();
    await ui.page.route(new RegExp(`/tasks/${diagram.id}/document(\\?.*)?$`), (route) => route.fulfill({ json: {
      task_type: "diagram", file: "diagram.mmd", versions: [{ version: 1, open: false, created_at: at, updated_at: at, size: content.length }], version: 1, content,
    } }));
    await ui.run([`goto /p/${project.id}?task=${diagram.id}`, "wait css=img[alt=Diagram]"]);
    await ui.page.waitForFunction(() => {
      const img = document.querySelector("img[alt=Diagram]");
      return img.complete && img.naturalWidth > 0;
    }, null, { timeout: 10000 });
  });
});
