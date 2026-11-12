import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, Schema } from "effect"
import { vi } from "vite-plus/test"
import { ProfileId } from "@huntaway/contracts"
import type { DocId } from "@huntaway/contracts"
import type { LegacyBoard } from "@huntaway/testing"
import { AT, importOld, onBoard } from "../../../../tests/importLegacy/importOld.ts"
import { DocRepo } from "../../../docs/DocRepo.ts"
import { DocsSiteRepo } from "../../../docs/DocsSiteRepo.ts"
import { OldDoc, OldDocComment, OldDocImage, OldDocsSiteConnection } from "./docs.ts"

vi.mock("./index.ts", () => import("../../../../tests/importLegacy/families.ts"))

const SITE = "https://docs.example.test"

describe("docs: old rows", () => {
  it.each<readonly [string, () => Result.Result<unknown, Schema.SchemaError>, object]>([
    [
      "a document from before folders",
      () => Schema.decodeResult(OldDoc)({ id: "d1", profile_id: "p1", slug: "s", title: "T", created_at: AT, updated_at: AT }),
      { folder: "" },
    ],
    [
      "a comment with no context",
      () => Schema.decodeResult(OldDocComment)({ id: 1, version_id: "v1", page_path: "index", quote: "q", created_at: AT, updated_at: AT }),
      { prefix: "", suffix: "", comment: "", sent_at: null },
    ],
    [
      "an image's bytes",
      () => Schema.decodeResult(OldDocImage)({ profile_id: "p1", sha256: "h", data: new Uint8Array([1, 2]), width: 1, height: 1, created_at: AT }),
      { data: new Uint8Array([1, 2]) },
    ],
    [
      "a sign-in from before logins were known",
      () => Schema.decodeResult(OldDocsSiteConnection)({ profile_id: "p1", site_url: SITE, kind: "token", access_token: "a", connected_at: AT }),
      { refresh_token: null, expires_at: null, login: null },
    ],
  ])("%s", (_, decode, expected) => {
    expect(Result.getOrThrow(decode())).toMatchObject(expected)
  })
})

const fill = (old: LegacyBoard) =>
  Effect.gen(function* () {
    yield* old.insert("docs", { id: "d1", profile_id: "p1", slug: "plan", title: "The plan", created_at: AT, updated_at: AT, folder: "Proj/plans" })
    for (const n of [1, 2])
      yield* old.insert("doc_versions", { id: `v${n}`, doc_id: "d1", number: n, message: `v${n}`, task_id: "t1", run_id: null, created_at: AT })
    yield* old.insert("doc_pages", { version_id: "v2", path: "index", title: "Plan", format: "md", source: "# Plan\n![c](images/c.avif)", position: 0 })
    yield* old.insert("doc_pages", { version_id: "v2", path: "more", title: "More", format: "mdx", source: "<Note>x</Note>", position: 1 })
    yield* old.insert("doc_labels", { doc_id: "d1", label: "research/ai" })
    yield* old.run(`INSERT INTO doc_images (profile_id, sha256, data, width, height, created_at) VALUES ('p1', 'h1', X'00010203', 4, 3, ?)`, [AT])
    yield* old.insert("doc_version_images", { version_id: "v2", name: "images/c.avif", sha256: "h1" })
    yield* old.insert("doc_comments", {
      id: 42,
      version_id: "v2",
      page_path: "index",
      quote: "Plan",
      prefix: "# ",
      comment: "Why?",
      created_at: AT,
      updated_at: AT,
      sent_at: null,
    })
    yield* old.insert("docs_site_clients", { site_url: SITE, client_id: "client-1", created_at: AT })
    yield* old.insert("docs_site_connections", {
      profile_id: "p1",
      site_url: SITE,
      kind: "oauth",
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 1_800_000_000_000,
      login: "me",
      connected_at: AT,
    })
    yield* old.insert("docs_site_published", {
      doc_id: "d1",
      site_url: SITE,
      remote_slug: "plan",
      remote_version: 3,
      local_version: 2,
      url: `${SITE}/me/plan`,
      version_url: `${SITE}/me/plan/v3`,
      published_at: AT,
      login: "me",
    })
  })

const readBack = (dataDir: string) =>
  Effect.gen(function* () {
    const docs = yield* DocRepo
    const site = yield* DocsSiteRepo
    const p1 = ProfileId.make("p1")
    const doc = yield* docs.get(p1, "plan")
    const id: DocId = doc?.id ?? (yield* Effect.die("no document"))
    return {
      doc,
      versions: yield* docs.versions(id),
      pages: yield* docs.pagesFull("v2"),
      images: yield* docs.images("v2"),
      bytes: yield* docs.imageData(p1, "h1"),
      comments: yield* docs.comments(id),
      client: yield* site.client(SITE),
      connection: yield* site.connection(p1),
      published: yield* site.published(id, SITE),
    }
  }).pipe(Effect.provide(onBoard(dataDir, Layer.mergeAll(DocRepo.layer, DocsSiteRepo.layer))))

describe("docs: import", () => {
  it.effect("documents, their versions, pages, labels, images and comments, and hosted docs read back as they were", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill)
      expect(report.failures).toEqual([])
      expect(report.json).toEqual([])
      expect(report.tables["doc_versions"]).toEqual({ old: 2, written: 2, withheld: 0 })
      expect(report.tables["docs_site_connections"]).toEqual({ old: 1, written: 1, withheld: 0 })
      const r = yield* readBack(dataDir)
      expect(r.doc).toMatchObject({ id: "d1", title: "The plan", folder: "Proj/plans", latest_version: 2, page_count: 2, labels: ["research/ai"] })
      expect(r.versions.map((v) => [v.number, v.task_id])).toEqual([
        [2, "t1"],
        [1, "t1"],
      ])
      expect(r.pages.map((p) => [p.path, p.format])).toEqual([
        ["index", "md"],
        ["more", "mdx"],
      ])
      expect(r.images).toEqual([{ name: "images/c.avif", sha256: "h1", bytes: 4, width: 4, height: 3 }])
      expect(r.bytes === null ? null : Array.from(r.bytes)).toEqual([0, 1, 2, 3])
      expect(r.comments).toMatchObject([{ id: 42, version: 2, page: "index", quote: "Plan", prefix: "# ", suffix: "", comment: "Why?", sent_at: null }])
      expect(r.client).toBe("client-1")
      expect(r.connection).toMatchObject({ kind: "oauth", expires_at: 1_800_000_000_000, login: "me" })
      expect(r.published).toMatchObject({ remote_version: 3, local_version: 2, login: "me" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect("a rehearsal writes no docs-site sign-in, and the rest", () =>
    Effect.gen(function* () {
      const { report, dataDir } = yield* importOld(fill, { rehearsal: true })
      expect(report.failures).toEqual([])
      expect(report.tables["docs_site_connections"]).toEqual({ old: 1, written: 0, withheld: 1 })
      const r = yield* readBack(dataDir)
      expect(r.connection).toBeNull()
      expect(r.client).toBe("client-1")
      expect(r.published).not.toBeNull()
      expect(r.comments).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
