import { assert, describe, it } from "@effect/vitest"
import type { HostProfile } from "@huntaway/client"
import { HostId, ProfileId } from "@huntaway/contracts"
import type { Host } from "@huntaway/contracts"
import type { DocFolder, DocLabel } from "../../src/components/docs/docs"
import { toJson } from "../../src/components/ui/json"
import { profile as wireProfile } from "../../../../packages/client/test/fixtures"

// The old tests/docs.test.ts (HA-281): where a profile's documents are, the board's links for what agents publish, and
// the page's frame. Changed: every host has Docs (6.3), so a host is left out only when it isn't connected.

// What the tree tests compare: a folder or label as its path, count, documents' slugs and what's inside it.
interface FolderShape {
  readonly path: string
  readonly count: number
  readonly docs: ReadonlyArray<string>
  readonly folders: ReadonlyArray<FolderShape>
}
interface LabelShape {
  readonly path: string
  readonly count: number
  readonly docs: ReadonlyArray<string>
  readonly labels: ReadonlyArray<LabelShape>
}

// Only what the router uses of a window, and an origin the last test sets.
const location = { pathname: "/", search: "", hash: "", origin: "http://localhost" }
Object.assign(globalThis, { window: { addEventListener() {}, location, history: { pushState() {}, replaceState() {} } } })
const { boardDocLink, docsHomes, docsProfileName, docTree, folderPaths, labelPaths, labelTree, pageSuffix, publishedDocPath, renamedFolder } =
  await import("../../src/components/docs/docs")
const { docFrame, READ_ONLY_NOTE } = await import("../../src/components/docs/docFrame")
const { FRAME_CSP } = await import("../../src/components/task/htmlFrame")

const host = (id: string, o: Partial<Host> = {}): Host => ({
  id: HostId.make(id),
  name: id,
  local: id === "local",
  connected: true,
  mode: id === "local" ? "local" : "outbound",
  agents: true,
  url: null,
  version: null,
  protocol: null,
  capabilities: [],
  commit: null,
  updates_from: null,
  last_seen: null,
  last_message_at: null,
  uplink: false,
  ...o,
})
const profile = (hostId: string, id: string, name: string): HostProfile =>
  Object.assign(wireProfile({ id: ProfileId.make(id), name }), { host_id: HostId.make(hostId) })

/** A tool's result as JSON text. */
const result = (v: object) => toJson(v)
const folderDoc = (slug: string, folder?: string, title = slug) => (folder === undefined ? { slug, title } : { slug, title, folder })
const labelDoc = (slug: string, labels?: ReadonlyArray<string>, title = slug) => (labels === undefined ? { slug, title } : { slug, title, labels })

describe("the Docs page's helpers", () => {
  it("a profile's documents are on each connected host of its name, this board's first", () => {
    const hosts = [host("far"), host("off", { connected: false }), host("local")]
    const profiles = [profile("far", "p-far", "work"), profile("off", "p-off", "work"), profile("local", "p-local", "work"), profile("local", "p-me", "me")]
    assert.deepStrictEqual(docsHomes(profiles, hosts, "work"), {
      name: "work",
      homes: [
        { hostId: "local", profileId: "p-local" },
        { hostId: "far", profileId: "p-far" },
      ],
    })
    // By id, as agents' links name it: only that one.
    assert.deepStrictEqual(docsHomes(profiles, hosts, "p-far"), { name: "work", homes: [{ hostId: "far", profileId: "p-far" }] })
    assert.deepStrictEqual(docsHomes(profiles, hosts, "p-off"), { name: "work", homes: [] })
    assert.deepStrictEqual(docsHomes(profiles, hosts, "nobody"), { name: "nobody", homes: [] })
    assert.strictEqual(docsProfileName(profiles, "p-far"), "work")
    assert.strictEqual(docsProfileName(profiles, "work"), "work")
  })

  it("a published document links to the board's own Docs page, not the host's address", () => {
    // The version it published, which the link says.
    assert.deepStrictEqual(
      publishedDocPath(
        result({
          slug: "the-plan",
          version: 3,
          url: "http://127.0.0.1:7878/docs/p1/d/the-plan/",
          version_url: "http://127.0.0.1:7878/docs/p1/d/the-plan/-/v/3/",
        }),
      ),
      { path: "/docs/p1/d/the-plan/-/v/3/", slug: "the-plan", version: 3 },
    )
    // Without version_url, the document.
    assert.deepStrictEqual(publishedDocPath(result({ slug: "the-plan", version: 3, url: "http://127.0.0.1:7878/docs/p1/d/the-plan/" })), {
      path: "/docs/p1/d/the-plan/",
      slug: "the-plan",
      version: 3,
    })
    // A public URL with a path of its own, even one with docs in it.
    for (const prefix of ["/board", "/docs", "/a/docs/b"]) {
      const url = `https://example.com${prefix}/docs/p1/d/the-plan/`
      assert.deepStrictEqual(
        publishedDocPath(result({ slug: "the-plan", version: 2, url, version_url: `${url}-/v/2/` })),
        { path: "/docs/p1/d/the-plan/-/v/2/", slug: "the-plan", version: 2 },
        prefix,
      )
    }
    // Another server's documents (a project's own `docs`), and results that aren't JSON, have none.
    assert.isNull(publishedDocPath(result({ url: "https://docs.example.com/d/plan/" })))
    assert.isNull(publishedDocPath("no document"))
    assert.isNull(publishedDocPath("null"))
  })

  it("page paths map to their URLs as docs-render's urlSuffix does", () => {
    assert.strictEqual(pageSuffix("index"), "")
    assert.strictEqual(pageSuffix("plan/index"), "plan")
    assert.strictEqual(pageSuffix("plan/phase-1"), "plan/phase-1")
    assert.strictEqual(pageSuffix("indexes"), "indexes")
  })

  it("a page's frame has the board's policy first, the board's colours over the reader's, and its scripts can't be closed", () => {
    const doc = docFrame('<h1 id="t">Hi</h1><div class="field" data-field="a"><input type="text"></div>', "--bg:#000", "t</script><b>")
    assert.isTrue(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`))
    assert.include(doc, ".docs-render.docs-render{--bg:#000;", "the theme, above the reader's own colours")
    assert.include(doc, '<div class="docs-render"><article class="doc-content"><h1 id="t">Hi</h1>')
    assert.include(doc, toJson(READ_ONLY_NOTE))
    assert.notInclude(doc, "t</script><b>", "the hash is escaped")
  })

  it("the Docs page's tree: folders first, then documents, each by name, a folder for each path a document is in", () => {
    const tree = docTree([
      folderDoc("b", "Huntaway"),
      folderDoc("top", undefined, "Top"),
      folderDoc("a", "Huntaway", "a"),
      folderDoc("plan", "Huntaway/plans"),
      folderDoc("x", "docs/deep/er"),
      folderDoc("other", ""),
    ])
    const shape = (f: DocFolder<{ slug: string }>): FolderShape => ({
      path: f.path,
      count: f.count,
      docs: f.docs.map((d) => d.slug),
      folders: f.folders.map(shape),
    })
    assert.deepStrictEqual(shape(tree), {
      path: "",
      count: 6,
      docs: ["other", "top"],
      folders: [
        {
          path: "docs",
          count: 1,
          docs: [],
          folders: [{ path: "docs/deep", count: 1, docs: [], folders: [{ path: "docs/deep/er", count: 1, docs: ["x"], folders: [] }] }],
        },
        { path: "Huntaway", count: 3, docs: ["a", "b"], folders: [{ path: "Huntaway/plans", count: 1, docs: ["plan"], folders: [] }] },
      ],
    })
    assert.deepStrictEqual(folderPaths(tree), ["docs", "docs/deep", "docs/deep/er", "Huntaway", "Huntaway/plans"])
    assert.strictEqual(renamedFolder("docs/plans", "docs", "Huntaway/docs"), "Huntaway/docs/plans")
    assert.strictEqual(renamedFolder("docs", "docs", ""), "")
    assert.strictEqual(renamedFolder("docs/plans", "docs", ""), "plans")
    assert.isNull(renamedFolder("docs2", "docs", "x"))
  })

  it("the Labels view: labels nest, a document is under each of its labels, and those with none are unlabelled", () => {
    const { root, unlabelled } = labelTree([
      labelDoc("both", ["research/ai", "plans"]),
      labelDoc("deep", ["Research/AI/llms"]),
      labelDoc("top", ["research", "research/ai"]),
      labelDoc("old", undefined),
      labelDoc("none", [], "None"),
      labelDoc("blank", ["/ /"]),
    ])
    const shape = (l: DocLabel<{ slug: string }>): LabelShape => ({
      path: l.path,
      count: l.count,
      docs: l.docs.map((d) => d.slug),
      labels: l.labels.map(shape),
    })
    assert.deepStrictEqual(shape(root), {
      path: "",
      count: 3,
      docs: [],
      labels: [
        { path: "plans", count: 1, docs: ["both"], labels: [] },
        {
          // Spelt as the first document spells it, matched whatever the case; a document counts once in each.
          path: "research",
          count: 3,
          docs: ["top"],
          labels: [{ path: "research/ai", count: 3, docs: ["both", "top"], labels: [{ path: "research/ai/llms", count: 1, docs: ["deep"], labels: [] }] }],
        },
      ],
    })
    // Documents without labels are unlabelled.
    assert.deepStrictEqual(
      unlabelled.map((d) => d.slug),
      ["blank", "none", "old"],
    )
    assert.deepStrictEqual(labelPaths(root), ["plans", "research", "research/ai", "research/ai/llms"])
    assert.deepStrictEqual(labelTree([]), { root: { name: "", path: "", labels: [], docs: [], count: 0 }, unlabelled: [] })
  })

  it("a message's link to a document is the board's when it's at the board's address or the host's own", () => {
    location.origin = "https://board.example.com"
    const path = "/docs/p1/d/word-round-trip/"
    for (const link of [`http://127.0.0.1:7878${path}`, `https://board.example.com${path}`, `http://localhost:7878${path}`, path]) {
      const found = boardDocLink(link)
      assert.strictEqual(found?.route.slug, "word-round-trip", link)
      assert.strictEqual(found?.path, path)
    }
    assert.strictEqual(boardDocLink(`http://127.0.0.1:7878${path}-/v/3/p2#h`)?.path, `${path}-/v/3/p2#h`)
    // Not documents, or not the board's.
    for (const link of [undefined, "", "https://docs.example.com/docs/p1/d/x/", "http://127.0.0.1:7878/docs/p1", "http://127.0.0.1:7878/t/abc", "mailto:a@b.c"])
      assert.isNull(boardDocLink(link), String(link))
  })
})
