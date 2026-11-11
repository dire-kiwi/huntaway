import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Exit, Redacted, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { HostedDocsStatus } from "@huntaway/contracts"
import type { DocPublishOutcome, ProfileId } from "@huntaway/contracts"
import { fakeDocsSite, TestBoard } from "@huntaway/testing"
import type { FakeDocsSite } from "@huntaway/testing"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { DocRepo } from "./DocRepo.ts"
import { Docs } from "./Docs.ts"
import { DocsSiteRepo } from "./DocsSiteRepo.ts"
import { DEFAULT_SITE, DocsSiteTiming, HostedDocs, siteUrl } from "./HostedDocs.ts"
import { caller, ok, since } from "./tests/docs.ts"
import type { Caller } from "./tests/docs.ts"

// Hosted docs (the old integrations/docs_site.test.ts): connecting a profile to a docs site with the device flow or a
// pasted token, renewing its sign-in, and publishing its documents there, against the fake site of packages/testing (an
// HTTP server in this process, so these run on the live clock, with the polls' intervals shortened). Dropped: the HTTP
// statuses (the errors are tagged: `Invalid` was 400, `External` 502, `Conflict` 409, `NotFound` 404).

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const FAST = { request: 5, slowDown: 0.05, interval: 0.02 }

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(DocsSiteTiming, FAST), Effect.scoped, Effect.provide(TestBoard()))

/** How an effect ended: "Success", or the tag of its failure and its detail, reason or what. */
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return { tag: "Success", said: "" }
    const e = exit.cause.reasons.find((r) => r._tag === "Fail")?.error
    if (e === undefined) return { tag: "Die", said: String(exit.cause) }
    const said = "detail" in e ? String(e.detail) : "reason" in e ? String(e.reason) : "what" in e ? String(e.what) : ""
    return { tag: e._tag, said }
  })

/** Done once `check` holds: checked now, and again at each `docs_site` event. */
const until = <R>(check: Effect.Effect<boolean, never, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const w = yield* (yield* Events).watch(undefined)
      if (yield* check) return
      yield* w.live.pipe(
        Stream.filter((e) => e.type === "docs_site" || e.type === "docs"),
        Stream.mapEffect(() => check, { concurrency: 1 }),
        Stream.takeUntil((done) => done),
        Stream.runDrain,
      )
    }),
  )

/** What the board is sent of a status, as JSON. */
const json = (status: HostedDocsStatus) => Effect.orDie(Schema.encodeEffect(Schema.fromJsonString(HostedDocsStatus))(status))

const connection = (p: ProfileId) => Effect.flatMap(DocsSiteRepo, (repo) => repo.connection(p))

/** A profile with a document of two versions ("the-plan", in Huntaway/plans). */
const setup = (name = "p") =>
  Effect.gen(function* () {
    const r = yield* caller(name)
    for (const [i, text] of ["First draft", "Second draft"].entries()) {
      yield* ok(r, "publish_document", {
        slug: "the-plan",
        title: "The plan",
        message: `v${i + 1}`,
        folder: "Huntaway/plans",
        pages: [
          { path: "index", content: `# The plan\n\n${text}\n` },
          { path: "plan/phase-1", content: "# Phase 1\n" },
        ],
      })
    }
    return r
  })

/** Connect `r`'s profile to `site` with the device flow. */
const connect = (r: Caller, site: FakeDocsSite) =>
  Effect.gen(function* () {
    yield* (yield* HostedDocs).startDevice(r.profile.id, site.url)
    site.decide("approved")
    yield* until(Effect.map(connection(r.profile.id), (c) => c !== null))
  })

const publish = (r: Caller, o: { readonly version?: number; readonly slug?: string; readonly ask?: boolean } = {}) =>
  Effect.flatMap(HostedDocs, (hosted) => hosted.publish(r.profile.id, "the-plan", o.version ?? null, { slug: o.slug, ask: o.ask }))

const published = (o: DocPublishOutcome) => ("published" in o ? o.published : assert.fail("not published"))

const tokenOf = (t: Redacted.Redacted | null | undefined) => (t == null ? null : Redacted.value(t))

const docId = (r: Caller) =>
  Effect.map(
    Effect.flatMap(DocRepo, (repo) => repo.get(r.profile.id, "the-plan")),
    (d) => d?.id ?? assert.fail("no document"),
  )

describe("hosted docs", () => {
  it.live("the device flow registers a client once, polls with slow_down, and connects without showing the tokens", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        const events = yield* since
        const started = yield* hosted.startDevice(r.profile.id, yield* siteUrl(`${site.url}/`))
        assert.strictEqual(started.connected, false)
        assert.strictEqual(started.site_url, site.url, "the URL loses its slash")
        assert.match(started.pending?.user_code ?? "", /^BCDF-/)
        assert.strictEqual(started.pending?.verification_uri_complete, `${site.url}/device?user_code=${started.pending?.user_code}`)
        assert.notInclude(yield* json(started), "dc-", "the device code stays on the host")
        // Registered as a device client with no redirect URIs.
        const host = (yield* Identity).hostName
        assert.include(site.state.log, `registered Huntaway (${host}) ["${DEVICE_GRANT}","refresh_token"] redirect_uris=null`)

        // The site asks it to slow down twice before the user approves.
        const device = [...site.state.devices.values()][0]
        if (device !== undefined) device.slow_down = 2
        yield* site.logged((l) => l === "poll 3")
        const mid = yield* hosted.status(r.profile.id)
        assert.deepStrictEqual([mid.connected, mid.pending?.error], [false, null])
        site.decide("approved")
        yield* until(Effect.map(connection(r.profile.id), (c) => c !== null))
        const done = yield* hosted.status(r.profile.id)
        assert.deepStrictEqual(
          [done.default_site_url, done.site_url, done.connected, done.kind, done.login, done.pending],
          [DEFAULT_SITE, site.url, true, "oauth", null, null],
        )
        assert.isTrue((yield* events.seen).some((e) => e["type"] === "docs_site" && e["profile_id"] === r.profile.id))
        // It asked who the user is (from their documents: they have none yet).
        yield* site.logged((l) => l === "tool list_documents as ivan")

        // A second sign-in (to connect again) uses the same client.
        yield* hosted.startDevice(r.profile.id, site.url)
        assert.strictEqual(site.state.log.filter((l) => l.startsWith("registered")).length, 1)
        // Stopping it leaves the connection as it was.
        const stopped = yield* hosted.cancelDevice(r.profile.id)
        assert.deepStrictEqual([stopped.pending, stopped.connected], [null, true])
      }),
    ),
  )

  it.live("a denied or expired sign-in says so, and a forgotten client registers again", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        const stopped = Effect.map(hosted.status(r.profile.id), (s) => s.pending?.error != null)
        yield* hosted.startDevice(r.profile.id, site.url)
        site.decide("denied")
        yield* until(stopped)
        const denied = yield* hosted.status(r.profile.id)
        assert.match(denied.pending?.error ?? "", /denied/)
        assert.isFalse(denied.connected)

        // The site lost its clients (its database was reset): the next sign-in registers again.
        site.state.clients.clear()
        const again = yield* hosted.startDevice(r.profile.id, site.url)
        assert.isNull(again.pending?.error)
        assert.strictEqual(site.state.log.filter((l) => l.startsWith("registered")).length, 2)
        site.decide("expired")
        yield* until(stopped)
        assert.match((yield* hosted.status(r.profile.id)).pending?.error ?? "", /expired/)
      }),
    ),
  )

  it.live("publish, then publish again: a new remote version of the same document, and the state the board shows", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const docs = yield* Docs
        const r = yield* setup()
        yield* connect(r, site)
        yield* docs.update(r.profile.id, "the-plan", { labels: ["research/ai"] })

        // Not published yet.
        assert.isNull((yield* docs.list(r.profile.id, null))[0]?.published)

        // The first publish of version 1, under a slug of its own.
        const events = yield* since
        const first = yield* publish(r, { version: 1, slug: "Our Plan" })
        assert.deepStrictEqual("warnings" in first ? first.warnings : [], [{ page: "index", warning: "a warning" }])
        const p1 = published(first)
        assert.deepStrictEqual([p1.remote_slug, p1.remote_version, p1.local_version, p1.url], ["our-plan", 1, 1, `${site.url}/d/our-plan/`])
        const sent = site.state.docs.get("our-plan")
        assert.strictEqual(sent?.title, "The plan")
        // The first publish files it in its folder there, and gives it its labels.
        assert.deepStrictEqual([sent?.folder, site.state.folders], ["Huntaway/plans", ["Huntaway/plans"]])
        assert.deepStrictEqual(site.state.labels, [["research/ai"]])
        assert.deepStrictEqual(sent?.versions[0], {
          message: "v1",
          pages: [
            { path: "index", title: "The plan", format: "md", content: "# The plan\n\nFirst draft\n" },
            { path: "plan/phase-1", title: "Phase 1", format: "md", content: "# Phase 1\n" },
          ],
        })
        assert.isTrue((yield* events.seen).some((e) => e["type"] === "docs" && e["slug"] === "the-plan"))
        // Who's connected, from the document published.
        assert.strictEqual((yield* connection(r.profile.id))?.login, "ivan")

        // The document shows it's changed since: v2 is local only.
        const listed = (yield* docs.list(r.profile.id, null))[0]
        assert.deepStrictEqual([listed?.latest_version, listed?.published?.local_version], [2, 1])
        assert.strictEqual((yield* docs.get(r.profile.id, "the-plan")).published?.remote_slug, "our-plan")

        // Publishing again (the latest) adds a version to the same remote document, without asking.
        const p2 = published(yield* publish(r, { ask: true }))
        assert.deepStrictEqual([p2.remote_slug, p2.remote_version, p2.local_version, p2.login], ["our-plan", 2, 2, "ivan"])
        assert.deepStrictEqual([sent?.versions.length, sent?.versions[1]?.message, site.state.docs.size], [2, "v2", 1])
        // Later ones don't send the folder or labels, so a move on either side stays.
        yield* docs.update(r.profile.id, "the-plan", { folder: "elsewhere" })
        yield* publish(r)
        assert.deepStrictEqual([sent?.folder, site.state.folders], ["Huntaway/plans", ["Huntaway/plans", undefined, undefined]])
        assert.deepStrictEqual(site.state.labels, [["research/ai"], undefined, undefined])

        // Publishes of one document at once go one after the other, to the same remote document.
        const both = yield* Effect.all([publish(r), publish(r)], { concurrency: 2 })
        assert.deepStrictEqual(
          both.map((o) => published(o).remote_version).toSorted((a, b) => a - b),
          [4, 5],
        )
        const site_ = yield* DocsSiteRepo
        assert.strictEqual((yield* site_.published(yield* docId(r), site.url))?.remote_version, 5)

        // A document deleted locally takes its record with it.
        yield* docs.delete(r.profile.id, "the-plan")
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM docs_site_published`)[0]?.n, 0)
      }),
    ),
  )

  it.live("the site's errors come back as they are: a slug taken, a version or document that isn't there, not connected", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        assert.deepStrictEqual(yield* outcome(publish(r)), { tag: "Conflict", said: "Connect this profile to docs.nest.dire.nz first." })
        yield* connect(r, site)
        site.state.docs.set("the-plan", { owner: "someone-else", title: "Theirs", versions: [] })
        assert.deepStrictEqual(yield* outcome(publish(r)), {
          tag: "Invalid",
          said: `${new URL(site.url).host}: the slug "the-plan" is taken by another user's document; choose a different slug, or omit it`,
        })
        assert.isNull(yield* (yield* DocsSiteRepo).published(yield* docId(r), site.url), "nothing is remembered")
        assert.strictEqual((yield* outcome(publish(r, { version: 9 }))).tag, "NotFound")
        assert.strictEqual((yield* outcome(hosted.publish(r.profile.id, "nothing", null, {}))).tag, "NotFound")
        // Another slug works.
        assert.strictEqual(published(yield* publish(r, { slug: "my-plan" })).remote_slug, "my-plan")
      }),
    ),
  )

  it.live("a first publish asks before adding to the user's document at the slug, and says whose another user's is", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const r = yield* setup()
        yield* connect(r, site)
        site.state.docs.set("the-plan", { owner: "ivan", title: "Published elsewhere", versions: [{ message: null, pages: [] }] })
        const asked = yield* publish(r, { ask: true })
        assert.deepStrictEqual(asked, {
          exists: { slug: "the-plan", title: "Published elsewhere", latest_version: 1, url: `${site.url}/d/the-plan/`, owner: "ivan" },
        })
        assert.strictEqual(site.state.docs.get("the-plan")?.versions.length, 1, "nothing was published")
        assert.isNull(yield* (yield* DocsSiteRepo).published(yield* docId(r), site.url))
        // Confirmed: it's added to.
        const added = published(yield* publish(r))
        assert.deepStrictEqual([added.remote_slug, added.remote_version], ["the-plan", 2])

        // Another user's document that the user can see: theirs, so another slug it is.
        site.state.docs.set("shared", { owner: "alice", shared: ["ivan"], title: "Alice's", versions: [{ message: null, pages: [] }] })
        assert.deepStrictEqual(yield* outcome(publish(r, { slug: "shared", ask: true })), {
          tag: "Invalid",
          said: `${new URL(site.url).host} has “shared” already, as alice's document: choose another slug`,
        })
        // A slug with nothing there publishes straight away, and re-targets the document.
        const fresh = published(yield* publish(r, { slug: "Fresh Plan", ask: true }))
        assert.deepStrictEqual([fresh.remote_slug, fresh.remote_version], ["fresh-plan", 1])
        assert.strictEqual((yield* (yield* DocsSiteRepo).published(yield* docId(r), site.url))?.remote_slug, "fresh-plan")
      }),
    ),
  )

  it.live("a document published as another account, or to a remote one taken since, publishes again under a new slug", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const docs = yield* Docs
        const r = yield* setup()
        yield* connect(r, site)
        yield* publish(r)
        assert.strictEqual((yield* (yield* DocsSiteRepo).published(yield* docId(r), site.url))?.login, "ivan")

        // Connected again, as bob (who has a document there, so the site says who he is): it isn't published as bob.
        site.state.access.set("bob-token", "bob")
        site.state.docs.set("bobs-notes", { owner: "bob", title: "Notes", versions: [{ message: null, pages: [] }] })
        const bob = yield* hosted.connectToken(r.profile.id, site.url, "bob-token")
        assert.strictEqual(bob.login, "bob")
        assert.isNull((yield* docs.list(r.profile.id, null))[0]?.published)
        assert.isNull((yield* docs.get(r.profile.id, "the-plan")).published)
        // Its slug is ivan's there (and bob can't see it): the site says so, and another slug works.
        assert.match((yield* outcome(publish(r, { ask: true }))).said, /the slug "the-plan" is taken by another user's document/)
        const bobs = published(yield* publish(r, { slug: "bobs-plan", ask: true }))
        assert.deepStrictEqual([bobs.remote_slug, bobs.remote_version, bobs.login], ["bobs-plan", 1, "bob"])
        assert.strictEqual((yield* docs.list(r.profile.id, null))[0]?.published?.remote_slug, "bobs-plan")

        // The remote document was deleted, and someone else took its slug: publishing to it fails, and a new slug works.
        site.state.docs.set("bobs-plan", { owner: "mallory", title: "Mine now", versions: [] })
        assert.match((yield* outcome(publish(r))).said, /taken by another user's document/)
        yield* publish(r, { slug: "bobs-plan-2", ask: true })
        const detail = yield* docs.get(r.profile.id, "the-plan")
        assert.deepStrictEqual([detail.published?.remote_slug, detail.published?.remote_version], ["bobs-plan-2", 1])
      }),
    ),
  )

  it.live("an expired access token is renewed once for calls at once, the rotated refresh token is kept, and a revoked one disconnects", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const docs = yield* Docs
        const r = yield* setup()
        yield* connect(r, site)
        const before = yield* connection(r.profile.id)
        // The access token has expired (by the host's clock).
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE docs_site_connections SET expires_at = ${(yield* Clock.currentTimeMillis) - 1000}`
        yield* Effect.all([publish(r), hosted.callTool(r.profile.id, "list_documents", {})], { concurrency: 2 })
        const after = yield* connection(r.profile.id)
        assert.notStrictEqual(tokenOf(after?.access_token), tokenOf(before?.access_token))
        assert.notStrictEqual(tokenOf(after?.refresh_token), tokenOf(before?.refresh_token))
        assert.isAbove(after?.expires_at ?? 0, (yield* Clock.currentTimeMillis) + 3000_000)
        assert.strictEqual(site.state.log.filter((l) => l === "token refresh_token").length, 1, "one refresh for both")

        // The site forgets the access token (it expired early, say): renewed on the 401, and the call goes through.
        site.state.access.clear()
        assert.isTrue(Array.isArray(Object(yield* hosted.callTool(r.profile.id, "list_documents", {}))["documents"]))

        // Revoked on the site: the next call says to connect again, and the profile is disconnected.
        site.state.access.clear()
        site.state.refresh.clear()
        const events = yield* since
        const revoked = yield* outcome(publish(r))
        assert.strictEqual(revoked.tag, "Conflict")
        assert.match(revoked.said, /expired or was revoked .*connect again/)
        assert.isNull(yield* connection(r.profile.id))
        assert.isTrue((yield* events.seen).some((e) => e["type"] === "docs_site"))
        // Where it was published is still known, and still shown: the profile is still on that site.
        assert.strictEqual((yield* docs.list(r.profile.id, null))[0]?.published?.remote_slug, "the-plan")
        assert.strictEqual((yield* hosted.status(r.profile.id)).site_url, site.url)
      }),
    ),
  )

  it.live("a pasted access token connects once the site takes it, and one it no longer takes disconnects", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        assert.match((yield* outcome(hosted.connectToken(r.profile.id, site.url, "nope"))).said, /doesn't take that token/)
        assert.strictEqual((yield* outcome(hosted.connectToken(r.profile.id, site.url, "  "))).tag, "Invalid")
        assert.strictEqual((yield* outcome(siteUrl("ftp://x"))).tag, "Invalid")

        site.state.access.set("pat-1", "ivan")
        site.state.docs.set("shared", { owner: "someone-else", title: "Shared", versions: [] })
        site.state.docs.set("mine", { owner: "ivan", title: "Mine", versions: [] })
        const out = yield* hosted.connectToken(r.profile.id, site.url, " pat-1 ")
        assert.deepStrictEqual([out.kind, out.login], ["token", "ivan"], "its own document's owner, not the shared one's")
        assert.notInclude(yield* json(out), "pat-1")
        yield* publish(r)

        site.state.access.delete("pat-1")
        const refused = yield* outcome(publish(r))
        assert.strictEqual(refused.tag, "Conflict")
        assert.match(refused.said, /no longer accepts .*connect again/)
        assert.isNull(yield* connection(r.profile.id))
      }),
    ),
  )

  it.live("disconnecting forgets the tokens, and a site that isn't a docs site or can't be reached says so", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        yield* connect(r, site)
        const out = yield* hosted.disconnect(r.profile.id)
        // Still on the site it was connected to, not the default.
        assert.deepStrictEqual([out.connected, out.site_url, out.default_site_url], [false, site.url, DEFAULT_SITE])
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM docs_site_connections`)[0]?.n, 0)

        const notDocs = yield* outcome(hosted.startDevice(r.profile.id, `${site.url}/elsewhere`))
        assert.deepStrictEqual([notDocs.tag, /doesn't look like a docs site/.test(notDocs.said)], ["External", true])
        const unreachable = yield* outcome(hosted.startDevice(r.profile.id, "http://127.0.0.1:9"))
        assert.deepStrictEqual([unreachable.tag, /couldn't reach 127\.0\.0\.1:9/.test(unreachable.said)], ["External", true])
        // Another profile's connection is its own.
        const other = yield* caller("q")
        yield* connect(r, site)
        assert.isFalse((yield* hosted.status(other.profile.id)).connected)
      }),
    ),
  )

  it.effect("site URLs", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* siteUrl(undefined), DEFAULT_SITE)
      assert.strictEqual(yield* siteUrl("docs.example.com/"), "https://docs.example.com")
      assert.strictEqual(yield* siteUrl("http://localhost:3000//"), "http://localhost:3000")
      for (const bad of ["javascript:alert(1)", "https://u:p@x", "https://x/?a=1"]) assert.strictEqual((yield* outcome(siteUrl(bad))).tag, "Invalid", bad)
    }),
  )

  it.live("URLs from the site that the board opens or links are web pages' only", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const hosted = yield* HostedDocs
        const r = yield* setup()
        yield* connect(r, site)
        site.state.evil = true
        const started = yield* hosted.startDevice(r.profile.id, site.url)
        assert.deepStrictEqual([started.pending?.verification_uri_complete, started.pending?.verification_uri], [null, `${site.url}/device`])
        const answer = yield* outcome(publish(r))
        assert.deepStrictEqual([answer.tag, /isn't what was expected/.test(answer.said)], ["External", true])
        assert.isNull(yield* (yield* DocsSiteRepo).published(yield* docId(r), site.url))
      }),
    ),
  )

  it.live("a version's images go to the site as the AVIFs kept here, under the names its pages use", () =>
    run(
      Effect.gen(function* () {
        const site = yield* fakeDocsSite
        const r = yield* setup()
        yield* connect(r, site)
        // As kept: what's sent is the stored AVIF's bytes, whatever they are.
        const avif = new TextEncoder().encode("not really an AVIF, but what's kept")
        const sql = yield* SqlClient.SqlClient
        const version =
          (yield* sql<{ readonly id: string }>`SELECT v.id FROM doc_versions v JOIN docs d ON d.id = v.doc_id WHERE d.slug = 'the-plan' AND v.number = 2`)[0]
            ?.id ?? ""
        const sha = "a".repeat(64)
        yield* (yield* DocRepo).addImage(
          r.profile.id,
          version,
          { name: "images/chart.png", sha256: sha, data: avif, width: 1, height: 1 },
          (yield* (yield* DocRepo).versions(yield* docId(r)))[0]?.created_at ?? assert.fail(),
        )
        yield* publish(r)
        assert.deepStrictEqual(site.state.images.at(-1), [{ name: "images/chart.png", data: Base64.encode(avif) }])
        // A version without images sends no `images`, which a site before DOC-12 doesn't know.
        yield* publish(r, { version: 1 })
        assert.isUndefined(site.state.images.at(-1))
      }),
    ),
  )
})
