// Tests of Docs (HA-280): the profiles' document store (db/docs.ts), the `docs` MCP server (mcp/docs_mcp.ts, over the
// runs' HTTP transport too) and the board's API for them (api/docs.ts).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import * as db from "../db.ts";
import { dispatch, makeReq, router } from "../api.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import * as runs from "../agent/runs.ts";
import * as docs_mcp from "./docs_mcp.ts";
import * as mcp_http from "./http.ts";

/** A profile with a task and a run of it, as the docs server sees its caller. */
function caller(s: AppState, name = "p"): docs_mcp.DocsRun & { run: db.Run } {
  const profile = db.insert_profile(s.db(), name, [], null);
  const task = db.insert_task(s.db(), {
    profile_id: profile.id,
    project_id: null,
    kind: "task",
    title: `${name}'s task`,
    description: "",
    status: "in_progress",
    use_worktree: false,
    model: null,
    effort: null,
    claude_config_id: null,
  });
  const run = db.insert_run(s.db(), task.id, "prompt");
  return { profile_id: profile.id, task_id: task.id, run_id: run.id, run };
}

/** A tool call's result: its JSON (or text) and whether it failed. */
async function tool(s: AppState, r: docs_mcp.DocsRun, name: string, args: any = {}): Promise<{ v: any; error: boolean; text: string }> {
  const res = await docs_mcp.handle(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, r);
  assert.ok(res.result, JSON.stringify(res));
  const text = res.result.content[0].text;
  return { v: res.result.structuredContent ?? text, error: res.result.isError === true, text };
}

/** Status and body of a request to the API. */
async function call(s: AppState, method: string, path: string): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const a = await dispatch(s, makeReq(method, path, { authorization: "Bearer " }, Buffer.alloc(0)));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

const plan = [
  { path: "index", content: "# The plan\n\nSee [phase 1](plan/phase-1.md).\n" },
  { path: "plan/phase-1.md", content: "# Phase 1\n\nBack to [the start](../index.md).\n\n## Steps\n\nOne.\n" },
];

test("publish_list_and_read_a_document", async () => {
  const s = testing.state();
  s.internal_url = "http://127.0.0.1:9";
  const r = caller(s);
  const pub = await tool(s, r, "publish_document", { pages: plan, message: "first" });
  assert.equal(pub.error, false, pub.text);
  const base = `http://127.0.0.1:9/docs/${r.profile_id}/d/the-plan/`;
  assert.deepEqual(pub.v, {
    slug: "the-plan",
    version: 1,
    url: base,
    version_url: `${base}-/v/1/`,
    pages: [
      { path: "index", title: "The plan", url: base },
      { path: "plan/phase-1", title: "Phase 1", url: `${base}plan/phase-1` },
    ],
    warnings: [],
  });
  // The text is the same JSON, for clients that don't read structuredContent.
  assert.deepEqual(JSON.parse(pub.text), pub.v);

  const list = await tool(s, r, "list_documents");
  assert.equal(list.v.documents.length, 1);
  assert.deepEqual(
    { ...list.v.documents[0], updated_at: null },
    { slug: "the-plan", title: "The plan", url: base, latest_version: 1, pages: 2, updated_at: null },
  );

  const page = await tool(s, r, "read_page", { slug: "the-plan", path: "Plan/Phase 1.md" });
  assert.deepEqual(page.v, { path: "plan/phase-1", title: "Phase 1", format: "md", version: 1, url: `${base}-/v/1/plan/phase-1`, content: plan[1].content });
  // A folder's path reads its index page; there's none here.
  const missing = await tool(s, r, "read_page", { slug: "the-plan", path: "plan" });
  assert.deepEqual([missing.error, missing.text], [true, 'version 1 has no page "plan"']);

  const doc = await tool(s, r, "get_document", { slug: "the-plan" });
  assert.equal(doc.v.version.number, 1);
  assert.equal(doc.v.version.message, "first");
  assert.equal(doc.v.version.task_id, r.task_id);
  assert.deepEqual(
    doc.v.pages.map((p: any) => [p.path, p.format, p.url]),
    [
      ["index", "md", base],
      ["plan/phase-1", "md", `${base}plan/phase-1`],
    ],
  );
  // Who published it is kept.
  assert.equal(db.value(s.db(), "SELECT run_id FROM doc_versions"), r.run_id);

  // The host's public address, when it has one, is the board's.
  db.set_setting(s.db(), "public_url", "https://board.example.com");
  assert.equal((await tool(s, r, "list_documents")).v.documents[0].url, `https://board.example.com/docs/${r.profile_id}/d/the-plan/`);
});

test("merge_keeps_the_other_pages_and_replace_does_not", async () => {
  const s = testing.state();
  const r = caller(s);
  await tool(s, r, "publish_document", { slug: "plan", pages: plan });
  const paths = async (version?: number) =>
    (await tool(s, r, "get_document", { slug: "plan", ...(version ? { version } : {}) })).v.pages.map((p: any) => p.path);

  // Merge: the new page is added, the others stay as they were. As on the hosted server, a page's place is its index in
  // the publish that gave it (unless its frontmatter has `order`), then its path.
  const merged = await tool(s, r, "publish_document", { slug: "plan", mode: "merge", pages: [{ path: "plan/phase-2", content: "# Phase 2" }] });
  assert.equal(merged.v.version, 2);
  assert.deepEqual(await paths(), ["index", "plan/phase-2", "plan/phase-1"]);
  // A page given again replaces the old one; delete_paths drops one (as written, normalised).
  await tool(s, r, "publish_document", {
    slug: "plan",
    mode: "merge",
    pages: [{ path: "index", content: "# New start" }],
    delete_paths: ["./Plan/Phase-1.md"],
  });
  assert.deepEqual(await paths(), ["index", "plan/phase-2"]);
  assert.equal((await tool(s, r, "read_page", { slug: "plan", path: "index" })).v.content, "# New start");
  // A publish doesn't rename the document unless it's given a title.
  assert.equal((await tool(s, r, "get_document", { slug: "plan" })).v.title, "The plan");

  // Replace (the default): exactly the pages given.
  await tool(s, r, "publish_document", { slug: "plan", pages: [{ path: "index", content: "# Only" }], title: "Renamed" });
  assert.deepEqual(await paths(), ["index"]);
  assert.equal((await tool(s, r, "get_document", { slug: "plan" })).v.title, "Renamed");
  // Old versions don't change.
  assert.deepEqual(await paths(1), ["index", "plan/phase-1"]);
  assert.equal((await tool(s, r, "read_page", { slug: "plan", path: "index", version: 3 })).v.content, "# New start");
  const doc = (await tool(s, r, "get_document", { slug: "plan" })).v;
  assert.deepEqual([doc.latest_version, doc.versions.map((v: any) => v.number)], [4, [4, 3, 2, 1]]);

  // Deleting every page leaves nothing to show: refused, and no version is made.
  const empty = await tool(s, r, "publish_document", { slug: "plan", mode: "merge", delete_paths: ["index"] });
  assert.deepEqual([empty.error, empty.text], [true, "a version needs at least one page"]);
  assert.equal((await tool(s, r, "get_document", { slug: "plan" })).v.latest_version, 4);
});

test("publishing_checks_the_pages_as_the_hosted_server_does", async () => {
  const s = testing.state();
  const r = caller(s);
  const err = async (args: any) => {
    const out = await tool(s, r, "publish_document", args);
    assert.equal(out.error, true, out.text);
    return out.text;
  };
  assert.equal(
    await err({ pages: [{ path: "../secrets", content: "x" }] }),
    `invalid page path "../secrets": use letters, digits, '-', '_' or '.' separated by '/'`,
  );
  assert.equal(await err({ pages: [] }), "pass at least one page");
  assert.equal(await err({ pages: [{ path: "a", content: "x" }], mode: "append" }), 'mode must be "replace" or "merge", not "append"');
  assert.equal(
    await err({
      pages: [
        { path: "a", content: "x" },
        { path: "A.md", content: "y" },
      ],
    }),
    'page "a" is listed twice',
  );
  assert.match(await err({ pages: [{ path: "index", content: "<Callout>never closed", format: "mdx" }] }), /^page "index" is not valid mdx: /);
  assert.match(await err({ pages: [{ path: "index" }] }), /missing field `content`/);
  assert.equal(await err({ pages: [{ path: "a", content: "x" }], title: 5 }), "invalid arguments: invalid type: integer `5`, expected a string");
  // Nothing was made.
  assert.deepEqual((await tool(s, r, "list_documents")).v.documents, []);

  // An unknown MDX component is a warning: the page is published.
  const ok = await tool(s, r, "publish_document", { pages: [{ path: "index", content: "# Hi\n\n<Sparkles />\n" }] });
  assert.equal(ok.error, false, ok.text);
  assert.deepEqual(ok.v.warnings, [{ page: "index", warning: "unknown component <Sparkles>; see the component list for what is available" }]);
  assert.equal((await tool(s, r, "read_page", { slug: ok.v.slug, path: "index" })).v.format, "mdx");

  const bad_path = await tool(s, r, "read_page", { slug: ok.v.slug, path: "a//../b" });
  assert.equal(bad_path.error, true);
  assert.match(bad_path.text, /^invalid page path/);
  const no_doc = await tool(s, r, "get_document", { slug: "nope" });
  assert.deepEqual([no_doc.error, no_doc.text], [true, 'no document "nope"; call list_documents to see what exists']);
  const no_version = await tool(s, r, "get_document", { slug: ok.v.slug, version: 7 });
  assert.equal(no_version.text, `document "hi" has no version 7`);
  assert.equal((await tool(s, r, "get_document", {})).text, "invalid arguments: missing field `slug`");
});

test("slugs_are_per_profile_and_new_documents_get_free_ones", async () => {
  const s = testing.state();
  const [a, b] = [caller(s, "a"), caller(s, "b")];
  const one = { pages: [{ path: "index", content: "# Weekly report" }] };
  assert.equal((await tool(s, a, "publish_document", one)).v.slug, "weekly-report");
  // Without a slug, a document of the same title is a new one.
  assert.equal((await tool(s, a, "publish_document", one)).v.slug, "weekly-report-2");
  // Another profile has slugs of its own, and can't see the first's documents.
  assert.equal((await tool(s, b, "publish_document", one)).v.slug, "weekly-report");
  assert.equal((await tool(s, b, "list_documents")).v.documents.length, 1);
  assert.equal((await tool(s, b, "get_document", { slug: "weekly-report-2" })).error, true);
  // A slug that's given is tidied as the hosted app's are, and names that document from then on.
  assert.equal((await tool(s, a, "publish_document", { ...one, slug: "My Notes!" })).v.slug, "my-notes");
  assert.equal((await tool(s, a, "publish_document", { ...one, slug: "my-notes" })).v.version, 2);
  assert.equal(db.doc_slug("  ¿Qué tal?  "), "qu-tal");
  assert.equal(db.doc_slug("!!!"), "doc");
  assert.equal(db.doc_slug("x".repeat(80)).length, 60);

  // A profile's documents go with it.
  db.run(s.db(), "DELETE FROM profiles WHERE id=?1", a.profile_id);
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM docs"), 1);
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM doc_versions"), 1);
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM doc_pages"), 1);
});

test("its_tools_are_the_hosted_ones_but_feedback_and_sharing", async () => {
  const s = testing.state();
  const r = caller(s);
  const lib = await docs_mcp.renderer();
  const init = await docs_mcp.handle(s, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, r);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /publish_document/);
  // Local documents keep no answers (HA-281).
  assert.match(init.result.instructions, /read-only here and collect no answers/);
  const list = await docs_mcp.handle(s, { jsonrpc: "2.0", id: 1, method: "tools/list" }, r);
  const names = list.result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), ["get_document", "list_components", "list_documents", "publish_document", "read_page"]);
  // Exactly as the hosted server describes them.
  for (const t of list.result.tools)
    assert.deepEqual(
      t,
      lib.toolDefinitions().find((d) => d.name === t.name),
    );
  const components = await tool(s, r, "list_components");
  assert.equal(components.text, lib.componentsReference());
  const unknown = await docs_mcp.handle(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "share_document", arguments: {} } }, r);
  assert.equal(unknown.error.code, -32602);
  assert.equal(await docs_mcp.handle(s, { jsonrpc: "2.0", method: "notifications/initialized" }, r), null);
});

test("runs_reach_it_over_http_whatever_has_their_board_tools", async () => {
  const s = testing.state();
  const r = caller(s);
  // A run whose board tools are in process still has this server (as it has gh's).
  mkdirSync(runs.run_dir(s, r.run.id), { recursive: true });
  writeFileSync(
    join(runs.run_dir(s, r.run.id), mcp_http.SETTINGS_FILE),
    mcp_http.settings_json({ cwd: "/tmp", github_account: null, review: false, in_process: true }),
  );
  const server = createServer((req, res) => {
    mcp_http.serve(s, req, res).catch((e) => res.destroy(e));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  s.internal_url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const e = mcp_http.servers(s, r.run.id)[docs_mcp.SERVER_NAME];
    assert.ok(e.url.endsWith(`/api/mcp/${r.run.id}/docs`));
    const post = (msg: any, headers = e.headers) =>
      fetch(e.url, { method: "POST", headers: { ...headers, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(msg) });
    const msg = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "publish_document", arguments: { pages: [{ path: "index", content: "# Over HTTP" }] } },
    };
    const res = await post(msg);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.result.structuredContent.slug, "over-http", JSON.stringify(body));
    assert.equal(db.get_doc(s.db(), r.profile_id, "over-http")?.title, "Over HTTP");
    // Only with the run's own secret.
    assert.equal((await post(msg, { Authorization: "Bearer nope" })).status, 401);
  } finally {
    server.close();
  }
});

test("the_board_lists_renders_and_deletes_a_profiles_documents", async () => {
  const s = testing.state();
  const r = caller(s);
  const other = caller(s, "other");
  await tool(s, r, "publish_document", { slug: "plan", pages: plan, message: "first" });
  await tool(s, r, "publish_document", { slug: "plan", mode: "merge", pages: [{ path: "notes", content: "# Notes\n\n<Sparkles />" }] });
  const p = `/api/profiles/${r.profile_id}/docs`;

  const [, list] = await call(s, "GET", p);
  assert.deepEqual(
    list.map((d: any) => [d.slug, d.title, d.latest_version, d.page_count, d.task?.title]),
    [["plan", "The plan", 2, 3, "p's task"]],
  );
  const [, doc] = await call(s, "GET", `${p}/plan`);
  assert.deepEqual(
    doc.versions.map((v: any) => [v.number, v.message, v.task?.title]),
    [
      [2, null, "p's task"],
      [1, "first", "p's task"],
    ],
  );
  assert.deepEqual(
    doc.pages.map((pg: any) => pg.path),
    ["index", "notes", "plan/phase-1"],
  );

  // Rendered, with relative links pointing at the board's pages for the version asked for.
  const [status, v1] = await call(s, "GET", `${p}/plan/versions/1`);
  assert.equal(status, 200, JSON.stringify(v1));
  const base = `/docs/${r.profile_id}/d/plan/-/v/1/`;
  assert.equal(v1.base_url, base);
  assert.deepEqual(
    v1.pages.map((pg: any) => [pg.path, pg.url_suffix]),
    [
      ["index", ""],
      ["plan/phase-1", "plan/phase-1"],
    ],
  );
  assert.ok(v1.pages[0].html.includes(`href="${base}plan/phase-1"`), v1.pages[0].html);
  assert.ok(v1.pages[1].html.includes(`href="${base}"`), v1.pages[1].html);
  assert.deepEqual(v1.pages[1].toc, [{ depth: 2, id: "steps", text: "Steps" }]);
  assert.equal(v1.pages[1].has_h1, true);
  assert.deepEqual(
    v1.nav.map((n: any) => [n.segment, n.children.map((c: any) => c.page)]),
    [
      ["index", []],
      ["plan", ["plan/phase-1"]],
    ],
  );
  // The latest, one page, and links under another base.
  const [, latest] = await call(s, "GET", `${p}/plan/versions/latest?path=notes&base_url=/x/`);
  assert.deepEqual([latest.number, latest.base_url, latest.pages.length, latest.pages[0].path], [2, "/x/", 1, "notes"]);
  assert.deepEqual(latest.pages[0].warnings, ["unknown component <Sparkles>; see the component list for what is available"]);
  const [, def] = await call(s, "GET", `${p}/plan/versions/latest?path=index`);
  assert.equal(def.base_url, `/docs/${r.profile_id}/d/plan/`);
  assert.equal((await call(s, "GET", `${p}/plan/versions/latest?base_url=https://evil.example/`))[0], 400);
  assert.equal((await call(s, "GET", `${p}/plan/versions/9`))[0], 404);
  assert.equal((await call(s, "GET", `${p}/plan/versions/latest?path=nope`))[0], 404);

  // Another profile's documents aren't reached through this one.
  assert.equal((await call(s, "GET", `/api/profiles/${other.profile_id}/docs/plan`))[0], 404);
  assert.equal((await call(s, "DELETE", `/api/profiles/${other.profile_id}/docs/plan`))[0], 404);
  assert.equal((await call(s, "GET", `/api/profiles/nope/docs`))[0], 404);

  const seen: any[] = [];
  s.events.subscribe((e: any) => seen.push(e));
  assert.equal((await call(s, "DELETE", `${p}/plan`))[0], 200);
  assert.deepEqual(seen, [{ type: "docs", profile_id: r.profile_id, slug: "plan", deleted: true }]);
  assert.equal((await call(s, "GET", `${p}/plan`))[0], 404);
  assert.deepEqual((await call(s, "GET", p))[1], []);
  assert.equal(db.value(s.db(), "SELECT COUNT(*) FROM doc_pages"), 0);
});

test("a_database_from_before_docs_gets_its_tables", () => {
  const dir = testing.temp_dir();
  const path = join(dir, "db.sqlite");
  let c = db.open(path);
  c.exec("DROP TABLE doc_pages; DROP TABLE doc_versions; DROP TABLE docs; PRAGMA user_version=102;");
  c.close();
  c = db.open(path);
  assert.equal(Number(db.value(c, "PRAGMA user_version")), db.VERSION);
  const p = db.insert_profile(c, "p", [], null);
  const out = db.publish_doc(c, {
    profile_id: p.id,
    slug: null,
    title: "T",
    message: null,
    pages: [{ path: "index", title: "T", format: "md", source: "# T", position: 0 }],
    merge: false,
    delete: [],
    task_id: null,
    run_id: null,
  });
  assert.deepEqual(out, { slug: "t", number: 1 });
  c.close();
});
