import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "vite-plus/test";
import { GUIDE_PAGES, guideLink, headings, loadGuidePage, namedPage, slug } from "../src/guide.ts";

const GUIDE = new URL("../../../docs/guide/", import.meta.url);

test("the app lists every page of docs/guide, and loads each", async () => {
  const files = readdirSync(GUIDE)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
  assert.deepEqual(GUIDE_PAGES.map((p) => p.page).sort(), files);
  for (const { page } of GUIDE_PAGES) assert.match(await loadGuidePage(page), /^# /, page);
  assert.equal(await loadGuidePage("nope"), null);
  assert.equal(await loadGuidePage("../README"), null);
});

test("headings get GitHub's anchors", () => {
  assert.equal(slug("Workflows from before column nodes"), "workflows-from-before-column-nodes");
  assert.equal(slug("Codex agents (API 25)"), "codex-agents-api-25");
  assert.equal(slug("Send to task: `send_to_task`"), "send-to-task-send_to_task");
  assert.deepEqual(headings("# Title\n\n## One `a`\n\n```md\n## Not one\n```\n\n### Three\n## [Two](x.md) ##\n"), [
    { text: "One a", id: "one-a" },
    { text: "Two", id: "two" },
  ]);
});

test("the guide's links open its pages in the app, and the rest of the repository on GitHub", () => {
  assert.deepEqual(guideLink("workflows.md", "integrations"), { kind: "page", page: "workflows" });
  assert.deepEqual(guideLink("workflows.md#column", "integrations"), { kind: "page", page: "workflows", hash: "column" });
  assert.deepEqual(guideLink("#telegram", "assistant"), { kind: "page", page: "assistant", hash: "telegram" });
  assert.deepEqual(guideLink("./hosts.md", "server"), { kind: "page", page: "hosts" });
  assert.deepEqual(guideLink("../../rust/broker/README.md", "hosts"), {
    kind: "external",
    url: "https://github.com/dire-kiwi/huntaway/blob/master/rust/broker/README.md",
  });
  assert.deepEqual(guideLink("../threads.md#items", "agents"), {
    kind: "external",
    url: "https://github.com/dire-kiwi/huntaway/blob/master/docs/threads.md#items",
  });
  assert.deepEqual(guideLink("https://example.com/a.md", "hosts"), { kind: "external", url: "https://example.com/a.md" });
  assert.deepEqual(guideLink("mailto:a@b", "hosts"), { kind: "external", url: "mailto:a@b" });
});

test("every link between the guide's pages goes to a page and heading it has", async () => {
  for (const { page } of GUIDE_PAGES) {
    const text = await loadGuidePage(page);
    for (const [, to] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = guideLink(to, page);
      if (link.kind !== "page" || !link.hash) continue;
      const ids = [...(await loadGuidePage(link.page)).matchAll(/^#+\s+(.+)$/gm)].map((m) => slug(m[1].replace(/[`*_]/g, "")));
      assert.ok(ids.includes(link.hash), `${page}: ${to}`);
    }
  }
});

test("inline code that names a page links to it", () => {
  assert.equal(namedPage("hosts.md"), "hosts");
  assert.equal(namedPage("docs/guide/server.md"), "server");
  assert.equal(namedPage("docs/threads.md"), null);
  assert.equal(namedPage("README.md"), null);
});
