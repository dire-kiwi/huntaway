import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "vite-plus/test";

// The app's modules import each other without extensions, as Vite allows (as in store.test.mjs).
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
// The router listens to the window as it loads.
globalThis.window = { addEventListener() {}, location: { pathname: "/", search: "", hash: "" }, history: { pushState() {}, replaceState() {} } };
const { docBase, href, parse } = await import("../src/router.ts");

test("routes round-trip through their paths", () => {
  for (const route of [
    { name: "profile", profile: "work" },
    { name: "assistant", profile: "my work" },
    { name: "docs", profile: "my work" },
    { name: "docs", profile: "work", slug: "plan", page: "" },
    { name: "docs", profile: "work", slug: "plan", page: "plan/phase 1" },
    { name: "docs", profile: "work", slug: "plan", version: 3, page: "" },
    { name: "docs", profile: "work", slug: "plan", version: 3, page: "notes" },
    { name: "board", projectId: "p1" },
    { name: "projectSettings", projectId: "p1", tab: "agents" },
    { name: "task", taskId: "t1" },
    { name: "subproject", taskId: "t1" },
    { name: "group", hostId: "h1", group: "Sites & apps" },
    { name: "host", hostId: "h1" },
    { name: "settings" },
    { name: "analytics" },
    { name: "guide" },
    { name: "guide", page: "workflows" },
  ]) {
    assert.deepEqual(parse(new URL(href(route), "http://x").pathname), route, href(route));
  }
});

// HA-32: a malformed escape in a hand-typed or mangled link (a group named "100%" linked as /g/h/100%) was a
// crash in render, with no error boundary to catch it; it's taken as it is instead.
test("a path with a malformed escape still parses", () => {
  assert.deepEqual(parse("/g/h1/100%"), { name: "group", hostId: "h1", group: "100%" });
  assert.deepEqual(parse("/profile/%E0%A4%A"), { name: "profile", profile: "%E0%A4%A" });
  assert.deepEqual(parse("/p/p1/settings/%"), { name: "projectSettings", projectId: "p1", tab: "%" });
  assert.deepEqual(parse("/profile/100%25"), { name: "profile", profile: "100%" });
});

// HA-281: the links the docs server gives agents (doc_base in apps/server/src/mcp/docs_mcp.ts) open the Docs page.
test("a document's links parse as the docs route", () => {
  assert.deepEqual(parse("/docs/p1/d/plan/"), { name: "docs", profile: "p1", slug: "plan", page: "" });
  assert.deepEqual(parse("/docs/p1/d/plan/plan/"), { name: "docs", profile: "p1", slug: "plan", page: "plan" });
  assert.deepEqual(parse("/docs/p1/d/plan/-/v/2/plan/phase-1"), { name: "docs", profile: "p1", slug: "plan", version: 2, page: "plan/phase-1" });
  assert.deepEqual(parse("/docs/p1/d/plan/-/v/x/"), { name: "docs", profile: "p1", slug: "plan", page: "-/v/x" });
  assert.deepEqual(parse("/docs/p1"), { name: "docs", profile: "p1" });
  assert.deepEqual(parse("/docs/p1/d"), { name: "docs", profile: "p1" });
  assert.deepEqual(parse("/docs"), { name: "home" });
  assert.equal(docBase("my work", "plan"), "/docs/my%20work/d/plan/");
  assert.equal(docBase("p1", "plan", 2), "/docs/p1/d/plan/-/v/2/");
});
