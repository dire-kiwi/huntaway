import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId } from "@huntaway/contracts"
import type { NewDocComment } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Docs } from "./Docs.ts"
import { at, caller, listAt, ok, one, PLAN, pluck, refused, since, tool } from "./tests/docs.ts"
import type { Caller } from "./tests/docs.ts"

// The board's side of published documents (the old mcp/docs_mcp.test.ts's API cases, through `Docs` as the `docs.*`
// handlers call it): listing, rendering, moving, relabelling and deleting a profile's documents, the user's comments on
// their pages, `get_feedback`, and sending the comments to the agent that published them. Dropped, with why:
// - the HTTP statuses: the errors are tagged (`NotFound`, `Invalid`, `Conflict`), and the handlers pass them on;
// - `the_board_moves_documents…`'s 400 for a body with no `folder` is `Invalid` here too, as it was.

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** The tag a failed effect failed with. */
const tag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail")?.error._tag ?? "Die") : "Success"))

const comment = (r: Caller, slug: string, c: NewDocComment) => Effect.flatMap(Docs, (docs) => docs.addComment(r.profile.id, slug, c))

describe("the board's documents", () => {
  it.effect("lists, renders and deletes a profile's documents", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        const other = yield* caller("other")
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN, message: "first" })
        yield* ok(r, "publish_document", { slug: "plan", mode: "merge", pages: [{ path: "notes", content: "# Notes\n\n<Sparkles />" }] })
        const p = r.profile.id

        const list = yield* docs.list(p, null)
        assert.deepStrictEqual(
          list.map((d) => [d.slug, d.title, d.latest_version, d.page_count, d.task?.title, d.published]),
          [["plan", "The plan", 2, 3, "Assistant", null]],
        )
        const doc = yield* docs.get(p, "plan")
        assert.deepStrictEqual(
          doc.versions.map((v) => [v.number, v.message, v.task?.id]),
          [
            [2, null, r.task],
            [1, "first", r.task],
          ],
        )
        assert.deepStrictEqual(
          doc.pages.map((pg) => pg.path),
          ["index", "notes", "plan/phase-1"],
        )

        // Rendered, with relative links pointing at the board's pages for the version asked for.
        const v1 = yield* docs.version(p, "plan", 1, {})
        const base = `/docs/${p}/d/plan/-/v/1/`
        assert.strictEqual(v1.base_url, base)
        assert.deepStrictEqual(
          v1.pages.map((pg) => [pg.path, pg.url_suffix]),
          [
            ["index", ""],
            ["plan/phase-1", "plan/phase-1"],
          ],
        )
        assert.include(v1.pages[0]?.html, `href="${base}plan/phase-1"`)
        assert.include(v1.pages[1]?.html, `href="${base}"`)
        assert.deepStrictEqual(v1.pages[1]?.toc, [{ depth: 2, id: "steps", text: "Steps" }])
        assert.strictEqual(v1.pages[1]?.has_h1, true)
        assert.deepStrictEqual(
          v1.nav.map((n) => [n.segment, n.children.map((c) => c.page)]),
          [
            ["index", []],
            ["plan", ["plan/phase-1"]],
          ],
        )
        // The latest, one page, and links under another base.
        const latest = yield* docs.version(p, "plan", null, { path: "notes", base_url: "/x/" })
        assert.deepStrictEqual([latest.number, latest.base_url, latest.pages.length, latest.pages[0]?.path], [2, "/x/", 1, "notes"])
        assert.deepStrictEqual(latest.pages[0]?.warnings, ["unknown component <Sparkles>; see the component list for what is available"])
        assert.strictEqual((yield* docs.version(p, "plan", null, { path: "index" })).base_url, `/docs/${p}/d/plan/`)
        assert.strictEqual(yield* tag(docs.version(p, "plan", null, { base_url: "https://evil.example/" })), "Invalid")
        assert.strictEqual(yield* tag(docs.version(p, "plan", 9, {})), "NotFound")
        assert.strictEqual(yield* tag(docs.version(p, "plan", null, { path: "nope" })), "NotFound")
        // Only the first page, for a document opened at a page it may not have (an index), or at none.
        for (const o of [{ path: "nope", first: true }, { path: "", first: true }, { first: true }]) {
          const first = yield* docs.version(p, "plan", 1, o)
          assert.deepStrictEqual([first.pages.map((pg) => pg.path), first.nav.length], [["index"], 2], o.path ?? "no path")
        }
        assert.deepStrictEqual(
          (yield* docs.version(p, "plan", 1, { path: "plan/phase-1", first: true })).pages.map((pg) => pg.path),
          ["plan/phase-1"],
        )

        // Another profile's documents aren't reached through this one.
        assert.strictEqual(yield* tag(docs.get(other.profile.id, "plan")), "NotFound")
        assert.strictEqual(yield* tag(docs.delete(other.profile.id, "plan")), "NotFound")
        assert.strictEqual(yield* tag(docs.list(ProfileId.make("nope"), null)), "NotFound")

        const events = yield* since
        yield* docs.delete(p, "plan")
        assert.deepStrictEqual(yield* events.seen, [{ type: "docs", profile_id: p, slug: "plan", deleted: true }])
        assert.strictEqual(yield* tag(docs.get(p, "plan")), "NotFound")
        assert.deepStrictEqual(yield* docs.list(p, null), [])
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM doc_pages`)[0]?.n, 0)
      }),
    ),
  )

  it.effect("moves documents and renames folders", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        const other = yield* caller("other")
        for (const [title, folder] of [
          ["A", "docs"],
          ["B", "docs/plans"],
          ["C", "docs2"],
          ["D", ""],
        ] as const)
          yield* ok(r, "publish_document", { pages: one(title), folder })
        yield* ok(other, "publish_document", { pages: one("A"), folder: "docs" })
        const p = r.profile.id
        const folders = Effect.map(docs.list(p, null), (list) => Object.fromEntries(list.map((d) => [d.slug, d.folder])))
        assert.deepStrictEqual(yield* folders, { a: "docs", b: "docs/plans", c: "docs2", d: "" })

        // Moving one: normalised, with its slug as it was.
        const out = yield* docs.update(p, "d", { folder: "  new/ folder " })
        assert.deepStrictEqual([out.slug, out.folder], ["d", "new/folder"])
        assert.strictEqual(yield* tag(docs.update(p, "d", { folder: "../x" })), "Invalid")
        assert.strictEqual(yield* tag(docs.update(p, "d", {})), "Invalid")
        assert.strictEqual(yield* tag(docs.update(p, "nope", { folder: "x" })), "NotFound")
        assert.strictEqual(yield* tag(docs.update(other.profile.id, "d", { folder: "x" })), "NotFound")

        // Renaming a folder moves what's in it and in its folders, not docs2's, nor another profile's.
        const events = yield* since
        const renamed = yield* docs.renameFolder(p, "docs/", "Huntaway/docs")
        assert.deepStrictEqual(renamed.moved.toSorted(), ["a", "b"])
        assert.deepStrictEqual(
          pluck(yield* events.seen, "slug")
            .map(String)
            .toSorted(),
          ["a", "b"],
        )
        assert.deepStrictEqual(yield* folders, { a: "Huntaway/docs", b: "Huntaway/docs/plans", c: "docs2", d: "new/folder" })
        assert.strictEqual((yield* docs.get(other.profile.id, "a")).folder, "docs")
        // To the top level: its folders come up a level.
        yield* docs.renameFolder(p, "Huntaway", "")
        assert.deepStrictEqual(yield* folders, { a: "docs", b: "docs/plans", c: "docs2", d: "new/folder" })
        // Bad folders, the top level, and one that would be too long.
        assert.strictEqual(yield* tag(docs.renameFolder(p, "", "x")), "Invalid")
        assert.strictEqual(yield* tag(docs.renameFolder(p, "docs", "a/../b")), "Invalid")
        const long = yield* Effect.flip(docs.renameFolder(p, "docs", "x".repeat(195)))
        assert.match(long._tag === "Invalid" ? long.reason : "", /would be longer than 200 characters/)
        assert.deepStrictEqual(yield* folders, { a: "docs", b: "docs/plans", c: "docs2", d: "new/folder" })
        // A folder that has nothing in it moves nothing.
        assert.deepStrictEqual(yield* docs.renameFolder(p, "nope", "x"), { moved: [] })
      }),
    ),
  )

  it.effect("lists documents by label and relabels them", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        const other = yield* caller("other")
        yield* ok(r, "publish_document", { pages: one("A"), labels: ["research/ai"], folder: "docs" })
        yield* ok(r, "publish_document", { pages: one("B") })
        yield* ok(other, "publish_document", { pages: one("A"), labels: ["mine"] })
        const p = r.profile.id
        assert.deepStrictEqual(Object.fromEntries((yield* docs.list(p, null)).map((d) => [d.slug, d.labels])), { a: ["research/ai"], b: [] })
        assert.deepStrictEqual(
          (yield* docs.list(p, "Research")).map((d) => d.slug),
          ["a"],
        )
        assert.strictEqual(yield* tag(docs.list(p, "a\nb")), "Invalid")

        // Relabelling keeps its folder; labels and a folder at once do both.
        let out = yield* docs.update(p, "b", { labels: ["Research/AI", " plans"] })
        assert.deepStrictEqual([out.labels, out.folder, out.latest_version], [["plans", "research/ai"], "", 1])
        out = yield* docs.update(p, "a", { labels: [], folder: "x" })
        assert.deepStrictEqual([out.labels, out.folder], [[], "x"])
        assert.strictEqual(yield* tag(docs.update(p, "a", { labels: [" "] })), "Invalid")
        // A bad folder changes neither.
        assert.strictEqual(yield* tag(docs.update(p, "b", { labels: [], folder: "../x" })), "Invalid")
        assert.deepStrictEqual((yield* docs.get(p, "b")).labels, ["plans", "research/ai"])
        assert.strictEqual(yield* tag(docs.update(other.profile.id, "b", { labels: ["x"] })), "NotFound")

        assert.deepStrictEqual(yield* docs.labels(p), {
          labels: [
            { name: "plans", path: "plans", documents: 1, children: [] },
            { name: "research", path: "research", documents: 1, children: [{ name: "ai", path: "research/ai", documents: 1, children: [] }] },
          ],
          documents: 2,
          unlabelled: 1,
        })
        assert.strictEqual(yield* tag(docs.labels(ProfileId.make("nope"))), "NotFound")
      }),
    ),
  )
})

describe("comments on documents", () => {
  it.effect("the board comments on a document's pages, and edits and deletes them", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller("p", "Web")
        const other = yield* caller("other")
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        const p = r.profile.id
        const events = yield* since

        const made = yield* comment(r, "plan", { version: 1, page: "plan/phase-1", quote: "Phase 1", prefix: "", suffix: "\n\nBack", comment: "  Rename it  " })
        const { created_at: _made, updated_at: _changed, ...said } = made
        assert.deepStrictEqual(said, {
          id: made.id,
          version: 1,
          page: "plan/phase-1",
          quote: "Phase 1",
          prefix: "",
          suffix: "\n\nBack",
          comment: "Rename it",
          sent_at: null,
        })
        assert.deepStrictEqual(yield* events.seen, [{ type: "doc_comments", profile_id: p, slug: "plan" }])
        // A quote alone is a comment too.
        const bare = yield* comment(r, "plan", { version: 1, page: "index", quote: "The plan" })
        assert.strictEqual(bare.comment, "")

        const list = yield* docs.comments(p, "plan")
        // In the hosted app's order: by version, then page.
        assert.deepStrictEqual(
          list.comments.map((m) => [m.page, m.quote]),
          [
            ["index", "The plan"],
            ["plan/phase-1", "Phase 1"],
          ],
        )
        // They'd go to the task that published it.
        assert.deepStrictEqual([list.task?.id, list.task?.title, list.can_send], [r.task, "p's task", true])

        // Refused: no quote, a page or version the document doesn't have, too long, another profile's document.
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 1, page: "index", quote: "  " })), "Invalid")
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 1, page: "nope", quote: "x" })), "NotFound")
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 2, page: "index", quote: "x" })), "NotFound")
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 0, page: "index", quote: "x" })), "Invalid")
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 1, page: "index", quote: "x", prefix: "y".repeat(501) })), "Invalid")
        assert.strictEqual(yield* tag(comment(other, "plan", { version: 1, page: "index", quote: "x" })), "NotFound")
        assert.strictEqual(yield* tag(docs.comments(other.profile.id, "plan")), "NotFound")
        assert.strictEqual(yield* tag(docs.deleteComment(other.profile.id, "plan", made.id)), "NotFound")
        // A comment of another document's isn't reached through this one.
        yield* ok(r, "publish_document", { slug: "notes", pages: one("Notes") })
        assert.strictEqual(yield* tag(docs.updateComment(p, "notes", made.id, "x")), "NotFound")
        assert.strictEqual(yield* tag(docs.deleteComment(p, "notes", made.id)), "NotFound")

        const edited = yield* docs.updateComment(p, "plan", made.id, "Call it Start")
        assert.strictEqual(edited.comment, "Call it Start")
        yield* docs.deleteComment(p, "plan", bare.id)
        assert.strictEqual(yield* tag(docs.deleteComment(p, "plan", bare.id)), "NotFound")
        assert.deepStrictEqual(
          (yield* docs.comments(p, "plan")).comments.map((m) => m.comment),
          ["Call it Start"],
        )
        // They go with their document.
        yield* docs.delete(p, "plan")
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM doc_comments`)[0]?.n, 0)
      }),
    ),
  )

  it.effect("comments stay with their version after a republish", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        yield* comment(r, "plan", { version: 1, page: "index", quote: "The plan", comment: "Too vague" })
        yield* ok(r, "publish_document", { slug: "plan", pages: one("The detailed plan") })
        yield* comment(r, "plan", { version: 2, page: "index", quote: "detailed", comment: "Better" })
        // Version 1's page is still there to comment on, but version 2 has no such page.
        yield* comment(r, "plan", { version: 1, page: "plan/phase-1", quote: "Steps" })
        assert.strictEqual(yield* tag(comment(r, "plan", { version: 2, page: "plan/phase-1", quote: "Steps" })), "NotFound")
        assert.deepStrictEqual(
          (yield* docs.comments(r.profile.id, "plan")).comments.map((m) => [m.version, m.page, m.quote]),
          [
            [1, "index", "The plan"],
            [1, "plan/phase-1", "Steps"],
            [2, "index", "detailed"],
          ],
        )
      }),
    ),
  )

  it.effect("get_feedback gives the user's comments as the hosted server gives selections", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller()
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        yield* comment(r, "plan", { version: 1, page: "index", quote: "The plan", prefix: "", suffix: "\n\nSee", comment: "Too vague" })
        yield* ok(r, "publish_document", { slug: "plan", mode: "merge", pages: one("The detailed plan") })
        // An older comment, made a minute ago, on the new version.
        const late = yield* comment(r, "plan", { version: 2, page: "plan/phase-1", quote: "Steps", comment: "Number them" })
        const now = yield* DateTime.now
        const minuteAgo = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }))
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE doc_comments SET created_at = ${minuteAgo}, updated_at = ${minuteAgo} WHERE id <> ${late.id}`

        const all = yield* ok(r, "get_feedback", { slug: "plan" })
        const seconds = Math.floor(DateTime.toEpochMillis(now) / 1000)
        assert.strictEqual(at(all, "cursor"), seconds)
        const selections = listAt(all, "selections")
        assert.deepStrictEqual(
          { ...Object(all), cursor: null, selections: selections.map((x) => ({ ...Object(x), id: null, created_at: null })) },
          {
            document: "plan",
            latest_version: 2,
            cursor: null,
            responses: [],
            selections: [
              {
                id: null,
                version: 1,
                page: "index",
                quote: "The plan",
                comment: "Too vague",
                context_before: "",
                context_after: "\n\nSee",
                user: "user",
                created_at: null,
              },
              {
                id: null,
                version: 2,
                page: "plan/phase-1",
                quote: "Steps",
                comment: "Number them",
                context_before: "",
                context_after: "",
                user: "user",
                created_at: null,
              },
            ],
            hint: "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
          },
        )
        // Unix times, as the hosted server's.
        assert.strictEqual(at(selections, 0, "created_at"), seconds - 60)
        assert.strictEqual(at(selections, 1, "id"), late.id)

        const quotes = (args: object) => Effect.map(ok(r, "get_feedback", { slug: "plan", ...args }), (v) => pluck(listAt(v, "selections"), "quote"))
        assert.deepStrictEqual(yield* quotes({ version: 1 }), ["The plan"])
        assert.deepStrictEqual(yield* quotes({ version: 2 }), ["Steps"])
        assert.deepStrictEqual(yield* quotes({ version: 3 }), [])
        // Since a time: those made or changed at or after it.
        assert.deepStrictEqual(yield* quotes({ since: seconds - 30 }), ["Steps"])
        assert.deepStrictEqual(yield* quotes({ since: seconds + 60 }), [])
        assert.deepStrictEqual(yield* quotes({ since: seconds - 3600 }), ["The plan", "Steps"])
        // An edited one is new again.
        yield* docs.updateComment(r.profile.id, "plan", Number(at(selections, 0, "id")), "Still vague")
        assert.deepStrictEqual(yield* quotes({ since: seconds - 30 }), ["The plan", "Steps"])
        assert.deepStrictEqual(yield* quotes({ since: seconds - 30, version: 1 }), ["The plan"])
        // Its arguments are read as the hosted server's are.
        assert.strictEqual(
          yield* refused(r, "get_feedback", { slug: "plan", since: "yesterday" }),
          'invalid arguments: invalid type: string "yesterday", expected i64',
        )
        assert.strictEqual(yield* refused(r, "get_feedback", { slug: "nope" }), 'no document "nope"; call list_documents to see what exists')
        // Another profile's agents don't see them.
        const other = yield* caller("other")
        assert.isTrue((yield* tool(other, "get_feedback", { slug: "plan" })).error)
      }),
    ),
  )

  it.effect("sending comments to the agent sends the unsent ones, as one message, and marks them sent", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller("p", "Web")
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        const p = r.profile.id
        const send = docs.sendComments(p, "plan")
        // Nothing to send yet.
        assert.strictEqual(yield* tag(send), "Conflict")
        yield* comment(r, "plan", { version: 1, page: "index", quote: "The plan", comment: "Too vague" })
        yield* comment(r, "plan", { version: 1, page: "plan/phase-1", quote: "One.\nTwo.", comment: "" })
        const events = yield* since
        const out = yield* send
        assert.deepStrictEqual([out.sent, out.task.id], [2, r.task])
        assert.isTrue((yield* events.seen).some((e) => e["type"] === "doc_comments" && e["slug"] === "plan"))
        const base = `${yield* docs.boardUrl}/docs/${p}/d/plan/-/v/1/`
        const sent = [
          'The user left 2 comments on the document "The plan" (slug `plan`):',
          `1. On version 1, page \`index\` (${base}):`,
          "> The plan",
          "Too vague",
          `2. On version 1, page \`plan/phase-1\` (${base}plan/phase-1):`,
          "> One.\n> Two.",
          "(No comment: just the quote.)",
          'The docs server\'s `get_feedback` (slug "plan") has them too.',
        ].join("\n\n")
        // The agent is running: it's told at once (steered).
        const messages = Effect.map(r.agent.input, (lines) => lines.map((l) => at(l, "message", "content")).filter((m): m is string => typeof m === "string"))
        assert.include(yield* messages, sent)
        const list = yield* docs.comments(p, "plan")
        assert.isTrue(list.comments.every((m) => m.sent_at !== null))
        // Sent once: there's nothing more until there's a new or edited comment.
        assert.strictEqual(yield* tag(send), "Conflict")
        yield* docs.updateComment(p, "plan", list.comments[0]?.id ?? 0, "Much too vague")
        assert.strictEqual((yield* send).sent, 1)
        assert.isTrue(
          (yield* messages).some((m) =>
            /^The user left a comment on the document "The plan" \(slug `plan`\):\n\n1\. On version 1, page `index`.*\n\n> The plan\n\nMuch too vague/.test(m),
          ),
        )

        // With the task gone, there's nobody to send them to.
        yield* comment(r, "plan", { version: 1, page: "index", quote: "plan" })
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM tasks WHERE id = ${r.task}`
        const orphaned = yield* docs.comments(p, "plan")
        assert.deepStrictEqual([orphaned.task, orphaned.can_send], [null, false])
        assert.strictEqual(yield* tag(send), "Conflict")
        assert.strictEqual((yield* docs.comments(p, "plan")).comments.filter((m) => m.sent_at === null).length, 1)
      }),
    ),
  )

  it.effect("a task in an archived project isn't sent comments", () =>
    run(
      Effect.gen(function* () {
        const docs = yield* Docs
        const r = yield* caller("p", "Web")
        yield* ok(r, "publish_document", { slug: "plan", pages: PLAN })
        yield* comment(r, "plan", { version: 1, page: "index", quote: "The plan" })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE projects SET archived_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE id = (SELECT project_id FROM tasks WHERE id = ${r.task})`
        const list = yield* docs.comments(r.profile.id, "plan")
        assert.deepStrictEqual([list.task?.id, list.can_send], [r.task, false])
        assert.strictEqual(yield* tag(docs.sendComments(r.profile.id, "plan")), "Conflict")
      }),
    ),
  )
})
