// The Docs page's helpers (HA-281): where a profile's documents are, the board's links for what agents publish, and the
// page's frame.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

// The router listens to the window as it loads.
globalThis.window ??= { addEventListener() {}, location: { pathname: "/", search: "", hash: "" }, history: { pushState() {}, replaceState() {} } };
const { docsHomes, docsProfileName, pageSuffix, publishedDocPath } = await import("../src/docs.ts");
const { docFrame, READ_ONLY_NOTE } = await import("../src/components/docs/docFrame.ts");
const { FRAME_CSP } = await import("../src/components/task/htmlFrame.ts");

const host = (id, o = {}) => ({ id, name: id, local: id === "local", connected: true, api_version: 124, ...o });
const profile = (host_id, id, name) => ({ host_id, id, name });

test("a profile's documents are on each connected host of its name that has Docs, this board's first", () => {
  const hosts = [host("old", { api_version: 123 }), host("far"), host("off", { connected: false }), host("local")];
  const profiles = [
    profile("old", "p-old", "work"),
    profile("far", "p-far", "work"),
    profile("off", "p-off", "work"),
    profile("local", "p-local", "work"),
    profile("local", "p-me", "me"),
  ];
  assert.deepEqual(docsHomes(profiles, hosts, "work"), {
    name: "work",
    homes: [
      { hostId: "local", profileId: "p-local" },
      { hostId: "far", profileId: "p-far" },
    ],
  });
  // By id, as agents' links name it: only that one.
  assert.deepEqual(docsHomes(profiles, hosts, "p-far"), { name: "work", homes: [{ hostId: "far", profileId: "p-far" }] });
  assert.deepEqual(docsHomes(profiles, hosts, "p-old"), { name: "work", homes: [] });
  assert.deepEqual(docsHomes(profiles, hosts, "nobody"), { name: "nobody", homes: [] });
  assert.equal(docsProfileName(profiles, "p-far"), "work");
  assert.equal(docsProfileName(profiles, "work"), "work");
});

test("a published document links to the board's own Docs page, not the host's address", () => {
  const result = JSON.stringify({
    slug: "the-plan",
    version: 3,
    url: "http://127.0.0.1:7878/docs/p1/d/the-plan/",
    version_url: "http://127.0.0.1:7878/docs/p1/d/the-plan/-/v/3/",
  });
  assert.deepEqual(publishedDocPath(result), { path: "/docs/p1/d/the-plan/", slug: "the-plan", version: 3 });
  // Another server's documents (a project's own `docs`), and results that aren't JSON, have none.
  assert.equal(publishedDocPath(JSON.stringify({ url: "https://docs.example.com/d/plan/" })), null);
  assert.equal(publishedDocPath("no document"), null);
  assert.equal(publishedDocPath("null"), null);
});

test("page paths map to their URLs as docs-render's urlSuffix does", () => {
  assert.equal(pageSuffix("index"), "");
  assert.equal(pageSuffix("plan/index"), "plan");
  assert.equal(pageSuffix("plan/phase-1"), "plan/phase-1");
  assert.equal(pageSuffix("indexes"), "indexes");
});

test("a page's frame has the board's policy first, the board's colours over the reader's, and its scripts can't be closed", () => {
  const doc = docFrame('<h1 id="t">Hi</h1><div class="field" data-field="a"><input type="text"></div>', "--bg:#000", "t</script><b>");
  assert.ok(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`));
  // (The reader's styles are left out here, as Vitest gives CSS imports as "": tests/ui/docs.test.mjs looks at them.)
  assert.ok(doc.includes(".docs-render.docs-render{--bg:#000;"), "the theme, above the reader's own colours");
  assert.ok(doc.includes('<div class="docs-render"><article class="doc-content"><h1 id="t">Hi</h1>'));
  assert.ok(doc.includes(JSON.stringify(READ_ONLY_NOTE)));
  assert.ok(!doc.includes("t</script><b>"), "the hash is escaped");
});
