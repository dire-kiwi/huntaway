import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestBoard } from "@huntaway/testing"
import { DOCS_INSTRUCTIONS, McpServers } from "../mcp/McpServers.ts"
import { docsDefinitions } from "../mcp/tools/docs.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { DocRepo } from "./DocRepo.ts"
import { Docs } from "./Docs.ts"
import { DocsRender } from "./DocsRender.ts"
import { docSlug } from "./docRules.ts"
import { at, caller, listAt, ok, one, PLAN, pluck, refused, since, tool } from "./tests/docs.ts"

// The `docs` MCP server (the old mcp/docs_mcp.test.ts's tool cases): agents publish, read, file and label their
// profile's documents through `ToolCalls`, as they would on the hosted docs app. The board's side of the same cases is
// Docs.test.ts. Dropped, with why:
// - `a_database_from_before_*` and `the_migration_files_documents_under_their_first_publishers_project`: the initial
//   schema has the tables and the columns; a legacy database's are the importer's (docs/plan/11-migration.md);
// - `project_names_become_folders_as_the_renderer_normalises_them`: `folder_of_name` was the migration's copy of the
//   renderer's rule; the renderer itself names folders here;
// - a call with no task (`task_id: null`): every call here comes from a run of a task.
// Changed: an argument a tool doesn't have is refused (the dispatcher's check, as for every server), where the hosted
// server's serde structs ignored it.

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))
const count = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`).pipe(
    Effect.map((r) => r[0]?.n),
    Effect.orDie,
  )

describe("the docs server", () => {
  it.effect("publishes, lists and reads a document", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const pub = yield* ok(r, "publish_document", { pages: PLAN, message: "first" })
        // The board's own address, as the host has no public one.
        const board = yield* (yield* Docs).boardUrl
        assert.match(board, /^http:\/\/127\.0\.0\.1:\d+$/)
        const base = `${board}/docs/${r.profile.id}/d/the-plan/`
        assert.deepStrictEqual(pub, {
          slug: "the-plan",
          folder: "",
          labels: [],
          note: null,
          version: 1,
          url: base,
          version_url: `${base}-/v/1/`,
          pages: [
            { path: "index", title: "The plan", url: base },
            { path: "plan/phase-1", title: "Phase 1", url: `${base}plan/phase-1` },
          ],
          images: [],
          warnings: [],
        })
        // The text is the same JSON, for clients that don't read structuredContent.
        const twice = yield* tool(r, "publish_document", { slug: "x", pages: PLAN })
        assert.deepStrictEqual(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(twice.text), twice.v)

        const list = listAt(yield* ok(r, "list_documents"), "documents")
        const first = list.find((d) => at(d, "slug") === "the-plan")
        assert.deepStrictEqual(
          { ...Object(first), updated_at: null },
          {
            slug: "the-plan",
            title: "The plan",
            folder: "",
            labels: [],
            url: base,
            latest_version: 1,
            pages: 2,
            updated_at: null,
          },
        )

        assert.deepStrictEqual(yield* ok(r, "read_page", { slug: "the-plan", path: "Plan/Phase 1.md" }), {
          path: "plan/phase-1",
          title: "Phase 1",
          format: "md",
          version: 1,
          url: `${base}-/v/1/plan/phase-1`,
          content: PLAN[1]?.content,
        })
        // A folder's path reads its index page; there's none here.
        assert.strictEqual(yield* refused(r, "read_page", { slug: "the-plan", path: "plan" }), 'version 1 has no page "plan"')

        const doc = yield* ok(r, "get_document", { slug: "the-plan" })
        assert.deepStrictEqual([at(doc, "version", "number"), at(doc, "version", "message"), at(doc, "version", "task_id")], [1, "first", r.task])
        assert.deepStrictEqual(
          listAt(doc, "pages").map((p) => [at(p, "path"), at(p, "format"), at(p, "url")]),
          [
            ["index", "md", base],
            ["plan/phase-1", "md", `${base}plan/phase-1`],
          ],
        )
        // Who published it is kept.
        const sql = yield* SqlClient.SqlClient
        const runs = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM doc_versions WHERE number = 1 LIMIT 1`
        assert.strictEqual(runs[0]?.run_id, r.agent.run.id)

        // The host's public address, when it has one, is the board's.
        yield* (yield* HostSettings).update({ public_url: "https://board.example.com" })
        const again = listAt(yield* ok(r, "list_documents"), "documents").find((d) => at(d, "slug") === "the-plan")
        assert.strictEqual(at(again, "url"), `https://board.example.com/docs/${r.profile.id}/d/the-plan/`)
      }),
    ),
  )

  it.effect("merge keeps the other pages, and replace doesn't", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        const paths = (version?: number) =>
          Effect.map(ok(r, "get_document", { slug: "plan", ...(version === undefined ? {} : { version }) }), (d) => pluck(listAt(d, "pages"), "path"))
        // Merge: the new page is added, the others stay. As on the hosted server, a page's place is its index in the
        // publish that gave it (unless its frontmatter has `order`), then its path.
        const merged = yield* ok(r, "publish_document", { slug: "plan", mode: "merge", pages: [{ path: "plan/phase-2", content: "# Phase 2" }] })
        assert.strictEqual(at(merged, "version"), 2)
        assert.deepStrictEqual(yield* paths(), ["index", "plan/phase-2", "plan/phase-1"])
        // A page given again replaces the old one; delete_paths drops one (as written, normalised).
        yield* ok(r, "publish_document", {
          slug: "plan",
          mode: "merge",
          pages: [{ path: "index", content: "# New start" }],
          delete_paths: ["./Plan/Phase-1.md"],
        })
        assert.deepStrictEqual(yield* paths(), ["index", "plan/phase-2"])
        assert.strictEqual(at(yield* ok(r, "read_page", { slug: "plan", path: "index" }), "content"), "# New start")
        // A publish doesn't rename the document unless it's given a title.
        assert.strictEqual(at(yield* ok(r, "get_document", { slug: "plan" }), "title"), "The plan")

        // Replace (the default): exactly the pages given.
        yield* ok(r, "publish_document", { slug: "plan", pages: [{ path: "index", content: "# Only" }], title: "Renamed" })
        assert.deepStrictEqual(yield* paths(), ["index"])
        assert.strictEqual(at(yield* ok(r, "get_document", { slug: "plan" }), "title"), "Renamed")
        // Old versions don't change.
        assert.deepStrictEqual(yield* paths(1), ["index", "plan/phase-1"])
        assert.strictEqual(at(yield* ok(r, "read_page", { slug: "plan", path: "index", version: 3 }), "content"), "# New start")
        const doc = yield* ok(r, "get_document", { slug: "plan" })
        assert.deepStrictEqual([at(doc, "latest_version"), pluck(listAt(doc, "versions"), "number")], [4, [4, 3, 2, 1]])

        // Deleting every page leaves nothing to show: refused, and no version is made.
        assert.strictEqual(
          yield* refused(r, "publish_document", { slug: "plan", mode: "merge", pages: [], delete_paths: ["index"] }),
          "a version needs at least one page",
        )
        assert.strictEqual(at(yield* ok(r, "get_document", { slug: "plan" }), "latest_version"), 4)
      }),
    ),
  )

  it.effect("checks the pages as the hosted server does", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const no = (args: unknown) => refused(r, "publish_document", args)
        assert.strictEqual(
          yield* no({ pages: [{ path: "../secrets", content: "x" }] }),
          `invalid page path "../secrets": use letters, digits, '-', '_' or '.' separated by '/'`,
        )
        assert.strictEqual(yield* no({ pages: [] }), "pass at least one page")
        assert.strictEqual(yield* no({ pages: [{ path: "a", content: "x" }], mode: "append" }), 'mode must be "replace" or "merge", not "append"')
        assert.strictEqual(
          yield* no({
            pages: [
              { path: "a", content: "x" },
              { path: "A.md", content: "y" },
            ],
          }),
          'page "a" is listed twice',
        )
        assert.match(yield* no({ pages: [{ path: "index", content: "<Callout>never closed", format: "mdx" }] }), /^page "index" is not valid mdx: /)
        // Badly shaped pages fail as the hosted server's arguments do, without serde_json's position.
        assert.strictEqual(yield* no({ pages: [{ path: "index" }] }), "invalid arguments: missing field `content`")
        assert.strictEqual(yield* no({ pages: ["index"] }), 'invalid arguments: invalid type: string "index", expected struct PageInput')
        assert.strictEqual(yield* no({ pages: "index" }), 'invalid arguments: invalid type: string "index", expected a sequence')
        assert.strictEqual(yield* no({ pages: { path: "index", content: "x" } }), "invalid arguments: invalid type: a map, expected a sequence")
        assert.strictEqual(yield* no({ pages: [{ path: "a", content: "x" }], title: 5 }), "invalid arguments: invalid type: integer `5`, expected a string")
        assert.strictEqual(yield* no({ pages: null }), "invalid arguments: invalid type: null, expected a sequence")
        // Nothing was made.
        assert.deepStrictEqual(at(yield* ok(r, "list_documents"), "documents"), [])

        // An unknown MDX component is a warning: the page is published.
        const pub = yield* ok(r, "publish_document", { pages: [{ path: "index", content: "# Hi\n\n<Sparkles />\n" }] })
        assert.deepStrictEqual(at(pub, "warnings"), [{ page: "index", warning: "unknown component <Sparkles>; see the component list for what is available" }])
        assert.strictEqual(at(yield* ok(r, "read_page", { slug: "hi", path: "index" }), "format"), "mdx")

        assert.match(yield* refused(r, "read_page", { slug: "hi", path: "a//../b" }), /^invalid page path/)
        assert.strictEqual(yield* refused(r, "get_document", { slug: "nope" }), 'no document "nope"; call list_documents to see what exists')
        assert.strictEqual(yield* refused(r, "get_document", { slug: "hi", version: 7 }), `document "hi" has no version 7`)
        assert.strictEqual(yield* refused(r, "get_document", { slug: "hi", version: "7" }), 'invalid arguments: invalid type: string "7", expected i64')
        assert.strictEqual(yield* refused(r, "get_document", {}), "invalid arguments: missing field `slug`")
        // An argument a tool doesn't have is the dispatcher's to name, as for every server.
        assert.match((yield* tool(r, "get_document", { slug: "hi", page: "x" })).text, /^Error: get_document has no argument "page"/)
      }),
    ),
  )

  it.effect("slugs are per profile, and new documents get free ones", () =>
    run(
      Effect.gen(function* () {
        const [a, b] = [yield* caller("a"), yield* caller("b")]
        const page = { pages: one("Weekly report") }
        assert.strictEqual(at(yield* ok(a, "publish_document", page), "slug"), "weekly-report")
        // Without a slug, a document of the same title is a new one.
        assert.strictEqual(at(yield* ok(a, "publish_document", page), "slug"), "weekly-report-2")
        // Another profile has slugs of its own, and can't see the first's documents.
        assert.strictEqual(at(yield* ok(b, "publish_document", page), "slug"), "weekly-report")
        assert.strictEqual(listAt(yield* ok(b, "list_documents"), "documents").length, 1)
        assert.isTrue((yield* tool(b, "get_document", { slug: "weekly-report-2" })).error)
        // A slug that's given is tidied as the hosted app's are, and names that document from then on.
        assert.strictEqual(at(yield* ok(a, "publish_document", { ...page, slug: "My Notes!" }), "slug"), "my-notes")
        assert.strictEqual(at(yield* ok(a, "publish_document", { ...page, slug: "my-notes" }), "version"), 2)
        assert.strictEqual(docSlug("  ¿Qué tal?  "), "qu-tal")
        assert.strictEqual(docSlug("!!!"), "doc")
        assert.strictEqual(docSlug("x".repeat(80)).length, 60)

        // A profile's documents go with it.
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM tasks WHERE profile_id = ${a.profile.id}`
        yield* sql`DELETE FROM profiles WHERE id = ${a.profile.id}`
        assert.deepStrictEqual([yield* count("docs"), yield* count("doc_versions"), yield* count("doc_pages")], [1, 1, 1])
      }),
    ),
  )

  it.effect("its tools are the hosted server's but sharing, with labels and images added", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const lib = yield* (yield* DocsRender).lib
        const servers = yield* McpServers
        const init = servers.initializeResult("docs", "2025-06-18")
        assert.strictEqual(init["protocolVersion"], "2025-06-18")
        assert.deepStrictEqual(init["serverInfo"], { name: "huntaway-docs", version: at(init, "serverInfo", "version") })
        const instructions = DOCS_INSTRUCTIONS
        assert.strictEqual(init["instructions"], instructions)
        // Local documents keep no answers; a sub-agent writes the pages, and publish_document checks them, not npm.
        for (const said of [
          /read-only here and collect no answers/,
          /sub-agent/,
          /`publish_document` is the check/,
          /Don't install or run npm packages/,
          /folder named after your task's project unless you give `folder`/,
          /`"plans"` is a top-level folder/,
          /Use `move_document` only when the user asks/,
          /comment on it for you: read the comments with `get_feedback`/,
          /pass `labels` to `publish_document` or call `set_document_labels`/,
          /SVG and remote images aren't shown/,
        ])
          assert.match(instructions, said)
        const listed = yield* servers.tools("docs", false)
        assert.deepStrictEqual(listed.map((t) => t.name).toSorted(), [
          "get_document",
          "get_feedback",
          "list_components",
          "list_documents",
          "list_labels",
          "move_document",
          "publish_document",
          "read_page",
          "set_document_labels",
        ])
        // Exactly as the hosted server describes them, with labels and images where the renderer doesn't have them yet.
        const patched = docsDefinitions(lib)
        for (const t of listed) {
          const def = patched.find((d) => d.name === t.name)
          assert.deepStrictEqual([t.description, t.inputSchema], [def?.description, def?.inputSchema], t.name)
          const hosted = lib.toolDefinitions().find((d) => d.name === t.name)
          if (hosted === undefined) assert.include(["set_document_labels", "list_labels"], t.name)
          else assert.strictEqual(at(t, "annotations", "readOnlyHint"), hosted.annotations?.["readOnlyHint"] === true, t.name)
        }
        const publish = listed.find((t) => t.name === "publish_document")
        assert.strictEqual(at(publish, "inputSchema", "properties", "labels", "type"), "array")
        assert.strictEqual(at(publish, "inputSchema", "properties", "images", "type"), "array")
        assert.include(publish?.description, "Images: pass them in `images`")
        assert.strictEqual(
          at(
            listed.find((t) => t.name === "list_documents"),
            "inputSchema",
            "properties",
            "label",
            "type",
          ),
          "string",
        )
        assert.strictEqual((yield* tool(r, "list_components")).text, lib.componentsReference())
        // Sharing isn't here.
        assert.match((yield* tool(r, "share_document", {})).text, /share_document/)
        assert.deepStrictEqual(yield* servers.answer("docs", false, { id: 3, method: "resources/list", params: {} }), {
          jsonrpc: "2.0",
          id: 3,
          result: { resources: [] },
        })
        assert.deepStrictEqual(yield* servers.answer("docs", false, { id: 4, method: "prompts/list", params: {} }), {
          jsonrpc: "2.0",
          id: 4,
          result: { prompts: [] },
        })
      }),
    ),
  )

  it.effect("files a new document under its task's project unless a folder is given", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller("p", "Huntaway")
        // No folder: the task's project's name.
        let pub = yield* ok(r, "publish_document", { pages: one("Plan") })
        assert.deepStrictEqual([at(pub, "slug"), at(pub, "folder"), at(pub, "note")], ["plan", "Huntaway", null])
        // A folder that's given is used as it is, normalised as the hosted server does: a sub-path isn't put in the project's.
        pub = yield* ok(r, "publish_document", { pages: one("Notes"), folder: " plans// " })
        assert.strictEqual(at(pub, "folder"), "plans")
        pub = yield* ok(r, "publish_document", { pages: one("Deep"), folder: "Huntaway/plans/v2" })
        assert.strictEqual(at(pub, "folder"), "Huntaway/plans/v2")
        pub = yield* ok(r, "publish_document", { pages: one("Top"), folder: "" })
        assert.strictEqual(at(pub, "folder"), "")
        assert.match(yield* refused(r, "publish_document", { pages: one("Bad"), folder: "a/../b" }), /invalid folder/)
        assert.isNull(yield* (yield* DocRepo).get(r.profile.id, "bad"))
        // A task with no project files it at the top level.
        const scratch = yield* caller("q")
        pub = yield* ok(scratch, "publish_document", { pages: one("Scratch") })
        assert.strictEqual(at(pub, "folder"), "")

        const list = listAt(yield* ok(r, "list_documents"), "documents")
        assert.deepStrictEqual(Object.fromEntries(list.map((d) => [at(d, "slug"), at(d, "folder")])), {
          plan: "Huntaway",
          notes: "plans",
          deep: "Huntaway/plans/v2",
          top: "",
        })
        assert.strictEqual(at(yield* ok(r, "get_document", { slug: "deep" }), "folder"), "Huntaway/plans/v2")
      }),
    ),
  )

  it.effect("a republish leaves a document where it was moved, and move_document moves it", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller("p", "Huntaway")
        const other = yield* caller("other")
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        const events = yield* since
        const moved = yield* ok(r, "move_document", { slug: "plan", folder: "archive/ 2026 " })
        assert.deepStrictEqual([at(moved, "slug"), at(moved, "folder")], ["plan", "archive/2026"])
        assert.match(String(at(moved, "url")), new RegExp(`/docs/${r.profile.id}/d/plan/$`))
        assert.deepStrictEqual(yield* events.seen, [{ type: "docs", profile_id: r.profile.id, slug: "plan" }])

        // Without a folder, and with another: it stays where the user (or move_document) put it, and the agent is told.
        let pub = yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        assert.deepStrictEqual([at(pub, "version"), at(pub, "folder"), at(pub, "note")], [2, "archive/2026", null])
        pub = yield* ok(r, "publish_document", { slug: "plan", pages: PLAN, folder: "Huntaway" })
        assert.deepStrictEqual([at(pub, "version"), at(pub, "folder")], [3, "archive/2026"])
        assert.match(String(at(pub, "note")), /stays in its folder "archive\/2026"; call move_document only if the user asks/)
        pub = yield* ok(r, "publish_document", { slug: "plan", pages: PLAN, folder: "archive/2026" })
        assert.isNull(at(pub, "note"))

        // To the top level; a bad folder, a document that isn't there, or another profile's, aren't moved.
        assert.strictEqual(at(yield* ok(r, "move_document", { slug: "plan", folder: "" }), "folder"), "")
        assert.match(yield* refused(r, "move_document", { slug: "plan", folder: "x/./y" }), /invalid folder/)
        assert.match(yield* refused(r, "move_document", { slug: "nope", folder: "x" }), /^no document "nope"/)
        assert.match(yield* refused(other, "move_document", { slug: "plan", folder: "x" }), /^no document "plan"/)
        assert.match(yield* refused(r, "move_document", { slug: "plan" }), /missing field `folder`/)
        assert.strictEqual((yield* (yield* DocRepo).get(r.profile.id, "plan"))?.folder, "")
      }),
    ),
  )

  it.effect("labels: publish_document gives them, list_documents filters by them, list_labels counts them", () =>
    run(
      Effect.gen(function* () {
        const r = yield* caller()
        const other = yield* caller("other")
        let pub = yield* ok(r, "publish_document", { pages: one("A"), labels: ["Research/AI", " plans "] })
        assert.deepStrictEqual(at(pub, "labels"), ["plans", "Research/AI"])
        // A label is spelt as the profile spelt it first, whatever case it's given in; another profile's are its own.
        pub = yield* ok(r, "publish_document", { pages: one("B"), labels: ["research/ai/LLMs", "RESEARCH"] })
        assert.deepStrictEqual(at(pub, "labels"), ["Research", "Research/AI/LLMs"])
        yield* ok(r, "publish_document", { pages: one("C") })
        pub = yield* ok(other, "publish_document", { pages: one("A"), labels: ["research"] })
        assert.deepStrictEqual(at(pub, "labels"), ["research"])
        // A republish without labels keeps them; with them, replaces them.
        pub = yield* ok(r, "publish_document", { slug: "a", pages: one("A") })
        assert.deepStrictEqual([at(pub, "version"), at(pub, "labels")], [2, ["plans", "Research/AI"]])
        assert.match(yield* refused(r, "publish_document", { slug: "a", pages: one("A"), labels: [" / "] }), /invalid label/)
        assert.strictEqual((yield* (yield* DocRepo).get(r.profile.id, "a"))?.latest_version, 2)

        const slugs = (label?: string) =>
          Effect.map(ok(r, "list_documents", label === undefined ? {} : { label }), (v) => pluck(listAt(v, "documents"), "slug").map(String).toSorted())
        assert.deepStrictEqual(yield* slugs(), ["a", "b", "c"])
        assert.deepStrictEqual(yield* slugs("research"), ["a", "b"])
        assert.deepStrictEqual(yield* slugs("RESEARCH/ai/llms"), ["b"])
        assert.deepStrictEqual(yield* slugs("research/a"), [])
        assert.deepStrictEqual(yield* slugs("plans"), ["a"])
        assert.deepStrictEqual(at(yield* ok(r, "get_document", { slug: "b" }), "labels"), ["Research", "Research/AI/LLMs"])

        // The tree: a document counts once in each label, however many of its labels are in it.
        assert.deepStrictEqual(yield* ok(r, "list_labels"), {
          labels: [
            { name: "plans", path: "plans", documents: 1, children: [] },
            {
              name: "Research",
              path: "Research",
              documents: 2,
              children: [{ name: "AI", path: "Research/AI", documents: 2, children: [{ name: "LLMs", path: "Research/AI/LLMs", documents: 1, children: [] }] }],
            },
          ],
          documents: 3,
          unlabelled: 1,
        })

        // set_document_labels replaces them (not a new version), and takes `slug` for the document too.
        const events = yield* since
        let set = yield* ok(r, "set_document_labels", { slug: "c", labels: ["research/ml"] })
        assert.deepStrictEqual(at(set, "labels"), ["Research/ml"])
        assert.deepStrictEqual(yield* events.seen, [{ type: "docs", profile_id: r.profile.id, slug: "c" }])
        // The document's own labels' spelling counts too.
        set = yield* ok(r, "set_document_labels", { document: "a", labels: ["PLANS", "Zed", "research/ai/x"] })
        assert.deepStrictEqual(at(set, "labels"), ["plans", "Research/AI/x", "Zed"])
        set = yield* ok(r, "set_document_labels", { document: "a", labels: [] })
        assert.deepStrictEqual(at(set, "labels"), [])
        assert.strictEqual((yield* (yield* DocRepo).get(r.profile.id, "a"))?.latest_version, 2)
        assert.match(yield* refused(r, "set_document_labels", { slug: "a" }), /missing field `labels`/)
        assert.match(yield* refused(other, "set_document_labels", { slug: "b", labels: ["x"] }), /^no document "b"/)
        assert.deepStrictEqual((yield* (yield* DocRepo).get(r.profile.id, "b"))?.labels, ["Research", "Research/AI/LLMs"])
        assert.deepStrictEqual(yield* ok(other, "list_labels"), {
          labels: [{ name: "research", path: "research", documents: 1, children: [] }],
          documents: 1,
          unlabelled: 0,
        })
        // Deleting a document takes its labels with it.
        yield* (yield* DocRepo).delete(r.profile.id, "b")
        const sql = yield* SqlClient.SqlClient
        const left = yield* sql<{
          readonly n: number
        }>`SELECT COUNT(*) AS n FROM doc_labels l JOIN docs d ON d.id = l.doc_id WHERE d.profile_id = ${r.profile.id}`
        assert.strictEqual(left[0]?.n, 1)
      }),
    ),
  )
})
