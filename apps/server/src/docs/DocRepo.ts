import { Context, Effect, Layer, Schema } from "effect"
import { DocFormat, DocId, ProfileId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { DocComment, DocPageSummary } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { rowsOf } from "../platform/columns.ts"
import { byLowercase } from "./docRules.ts"

// The tables of published documents (docs/plan/04-database.md; huntaway's db/docs.ts): `docs` (a profile's, slug
// unique in it, with its folder), its immutable `doc_versions` and their `doc_pages`, `doc_labels`, the profile's AVIFs
// by sha256 (`doc_images`) and the names versions give them (`doc_version_images`), and `doc_comments` on a version's
// pages. Single statements; `Docs` puts them in transactions. `SqlError` and `SchemaError` are defects. Nothing here
// waits: no process, network, file system or sleep.

/** A document as it's kept, with its latest version's number, how many pages that has, and its labels (sorted). */
export interface Doc {
  readonly id: DocId
  readonly profile_id: ProfileId
  readonly slug: string
  readonly title: string
  readonly folder: string
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
  readonly latest_version: number
  readonly page_count: number
  readonly labels: ReadonlyArray<string>
}

const DocRow = Schema.Struct({
  id: DocId,
  profile_id: ProfileId,
  slug: Schema.String,
  title: Schema.String,
  folder: Schema.String,
  created_at: Timestamp,
  updated_at: Timestamp,
  latest_version: Schema.NullOr(Schema.Finite),
  page_count: Schema.Finite,
  labels: Schema.NullOr(Schema.String),
})

/** A version as it's kept: its id, and what the wire's `DocVersion` says but the task. */
export const VersionRow = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  message: Schema.NullOr(Schema.String),
  task_id: Schema.NullOr(TaskId),
  run_id: Schema.NullOr(RunId),
  created_at: Timestamp,
})
export interface VersionRow extends Schema.Schema.Type<typeof VersionRow> {}

const PageSummaryRow = Schema.Struct({ path: Schema.String, title: Schema.String, format: DocFormat, position: Schema.Int })
const PageRow = Schema.Struct({ ...PageSummaryRow.fields, source: Schema.String })
/** A page with its source. */
export interface DocPage extends Schema.Schema.Type<typeof PageRow> {}

/** A page ready to store. */
export interface NewDocPage {
  readonly path: string
  readonly title: string
  readonly format: DocFormat
  readonly source: string
  readonly position: number
}

const ImageRow = Schema.Struct({ name: Schema.String, sha256: Schema.String, bytes: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
/** A version's image, without its bytes. */
export interface DocImage extends Schema.Schema.Type<typeof ImageRow> {}

const ImageRef = Schema.Struct({ name: Schema.String, sha256: Schema.String })
const ImageData = Schema.Struct({ data: Schema.Uint8Array })

const CommentRow = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  page: Schema.String,
  quote: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String,
  comment: Schema.String,
  created_at: Timestamp,
  updated_at: Timestamp,
  sent_at: Schema.NullOr(Timestamp),
})

const Id = Schema.Struct({ id: Schema.String })
const Label = Schema.Struct({ label: Schema.String })
const Count = Schema.Struct({ n: Schema.Finite })

const first = <A>(found: Effect.Effect<ReadonlyArray<A>>) => Effect.map(found, (list) => list[0] ?? null)
const done = <A, E>(statement: Effect.Effect<A, E>) => statement.pipe(Effect.asVoid, Effect.orDie)

const docRows = rowsOf(DocRow)
const versionRows = rowsOf(VersionRow)
const pageSummaryRows = rowsOf(PageSummaryRow)
const pageRows = rowsOf(PageRow)
const imageRows = rowsOf(ImageRow)
const imageRefs = rowsOf(ImageRef)
const imageData = rowsOf(ImageData)
const commentRows = rowsOf(CommentRow)
const idRows = rowsOf(Id)
const labelRows = rowsOf(Label)
const countRows = rowsOf(Count)

// Labels have no control characters, so a newline keeps them apart.
const docOf = (r: typeof DocRow.Type): Doc => ({
  ...r,
  latest_version: r.latest_version ?? 0,
  labels: r.labels === null || r.labels === "" ? [] : r.labels.split("\n").toSorted(byLowercase),
})

const SELECT_DOC = `SELECT d.id, d.profile_id, d.slug, d.title, d.folder, d.created_at, d.updated_at,
  (SELECT MAX(number) FROM doc_versions v WHERE v.doc_id = d.id) AS latest_version,
  (SELECT COUNT(*) FROM doc_pages p JOIN doc_versions v ON v.id = p.version_id
     WHERE v.doc_id = d.id AND v.number = (SELECT MAX(number) FROM doc_versions WHERE doc_id = d.id)) AS page_count,
  (SELECT group_concat(label, char(10)) FROM doc_labels l WHERE l.doc_id = d.id) AS labels
  FROM docs d`

const SELECT_COMMENT = `SELECT m.id, v.number AS version, m.page_path AS page, m.quote, m.prefix, m.suffix, m.comment, m.created_at, m.updated_at, m.sent_at
  FROM doc_comments m JOIN doc_versions v ON v.id = m.version_id`

/** What a new comment says: the quote, its context, and the comment. */
export interface CommentText {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly comment: string
}

export interface DocRepoShape {
  /** A profile's documents, most recently updated first. */
  readonly list: (profile: ProfileId) => Effect.Effect<ReadonlyArray<Doc>>
  readonly get: (profile: ProfileId, slug: string) => Effect.Effect<Doc | null>
  /** A document's versions, newest first. */
  readonly versions: (doc: DocId) => Effect.Effect<ReadonlyArray<VersionRow>>
  /** Version `number` of a document, or its latest when `number` is null. */
  readonly version: (doc: DocId, number: number | null) => Effect.Effect<VersionRow | null>
  /** A version's pages, in menu order, without and with their sources. */
  readonly pages: (version: string) => Effect.Effect<ReadonlyArray<DocPageSummary>>
  readonly pagesFull: (version: string) => Effect.Effect<ReadonlyArray<DocPage>>
  readonly page: (version: string, path: string) => Effect.Effect<DocPage | null>
  readonly insertDoc: (doc: {
    readonly id: DocId
    readonly profile_id: ProfileId
    readonly slug: string
    readonly title: string
    readonly folder: string
    readonly now: Timestamp
  }) => Effect.Effect<void>
  readonly setTitle: (doc: DocId, title: string) => Effect.Effect<void>
  readonly touch: (doc: DocId, now: Timestamp) => Effect.Effect<void>
  readonly insertVersion: (v: {
    readonly id: string
    readonly doc: DocId
    readonly number: number
    readonly message: string | null
    readonly task_id: TaskId | null
    readonly run_id: RunId | null
    readonly now: Timestamp
  }) => Effect.Effect<void>
  readonly insertPage: (version: string, page: NewDocPage) => Effect.Effect<void>
  readonly pageCount: (version: string) => Effect.Effect<number>
  /** The labels of a profile's documents, in the order they were first given. */
  readonly knownLabels: (profile: ProfileId) => Effect.Effect<ReadonlyArray<string>>
  /** A document's labels from now on (spelt and deduplicated already). */
  readonly replaceLabels: (doc: DocId, labels: ReadonlyArray<string>) => Effect.Effect<void>
  /** Keeps an AVIF for the profile (once, by its sha256) and gives it a name in a version. */
  readonly addImage: (
    profile: ProfileId,
    version: string,
    image: { readonly name: string; readonly sha256: string; readonly data: Uint8Array; readonly width: number; readonly height: number },
    now: Timestamp,
  ) => Effect.Effect<void>
  /** Gives a version a name for an AVIF the profile has. */
  readonly nameImage: (version: string, name: string, sha256: string) => Effect.Effect<void>
  /** A version's images' names and hashes. */
  readonly imageRefs: (version: string) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly sha256: string }>>
  /** A version's images, by name, without their bytes. */
  readonly images: (version: string) => Effect.Effect<ReadonlyArray<DocImage>>
  /** A profile's image's AVIF, by its sha256. */
  readonly imageData: (profile: ProfileId, sha256: string) => Effect.Effect<Uint8Array | null>
  /** Deletes a document with its versions, and the profile's images no version uses any more. Whether there was one. */
  readonly delete: (profile: ProfileId, slug: string) => Effect.Effect<boolean>
  readonly move: (doc: DocId, folder: string) => Effect.Effect<void>
  /** A document's comments by version, page, then age: on one version, and made or changed at or after `since`, if given. */
  readonly comments: (doc: DocId, filter?: { readonly version?: number | null; readonly since?: Timestamp | null }) => Effect.Effect<ReadonlyArray<DocComment>>
  readonly comment: (doc: DocId, id: number) => Effect.Effect<DocComment | null>
  readonly addComment: (doc: DocId, version: string, page: string, text: CommentText, now: Timestamp) => Effect.Effect<DocComment>
  /** Changes what a comment says, which makes it unsent. Null if the document has no such comment. */
  readonly editComment: (doc: DocId, id: number, comment: string, now: Timestamp) => Effect.Effect<DocComment | null>
  readonly deleteComment: (doc: DocId, id: number) => Effect.Effect<boolean>
  readonly markSent: (ids: ReadonlyArray<number>, at: Timestamp) => Effect.Effect<void>
}

export class DocRepo extends Context.Service<DocRepo, DocRepoShape>()("huntaway-server/docs/DocRepo") {
  static readonly layer = Layer.effect(
    DocRepo,
    Effect.gen(function* () {
      const { sql } = yield* Db
      const selectDoc = sql.literal(SELECT_DOC)
      const selectComment = sql.literal(SELECT_COMMENT)
      const versionCols = sql.literal("SELECT id, number, message, task_id, run_id, created_at FROM doc_versions")
      const comment = (doc: DocId, id: number) => first(commentRows(sql`${selectComment} WHERE v.doc_id = ${doc} AND m.id = ${id}`))

      return DocRepo.of({
        list: (profile) => Effect.map(docRows(sql`${selectDoc} WHERE d.profile_id = ${profile} ORDER BY d.updated_at DESC, d.slug`), (r) => r.map(docOf)),
        get: (profile, slug) =>
          Effect.map(first(docRows(sql`${selectDoc} WHERE d.profile_id = ${profile} AND d.slug = ${slug}`)), (r) => (r === null ? null : docOf(r))),
        versions: (doc) => versionRows(sql`${versionCols} WHERE doc_id = ${doc} ORDER BY number DESC`),
        version: (doc, number) =>
          first(
            number === null
              ? versionRows(sql`${versionCols} WHERE doc_id = ${doc} ORDER BY number DESC LIMIT 1`)
              : versionRows(sql`${versionCols} WHERE doc_id = ${doc} AND number = ${number}`),
          ),
        pages: (version) => pageSummaryRows(sql`SELECT path, title, format, position FROM doc_pages WHERE version_id = ${version} ORDER BY position, path`),
        pagesFull: (version) =>
          pageRows(sql`SELECT path, title, format, position, source FROM doc_pages WHERE version_id = ${version} ORDER BY position, path`),
        page: (version, path) =>
          first(pageRows(sql`SELECT path, title, format, position, source FROM doc_pages WHERE version_id = ${version} AND path = ${path}`)),
        insertDoc: (d) =>
          done(sql`INSERT INTO docs (id, profile_id, slug, title, folder, created_at, updated_at)
            VALUES (${d.id}, ${d.profile_id}, ${d.slug}, ${d.title}, ${d.folder}, ${d.now}, ${d.now})`),
        setTitle: (doc, title) => done(sql`UPDATE docs SET title = ${title} WHERE id = ${doc}`),
        touch: (doc, now) => done(sql`UPDATE docs SET updated_at = ${now} WHERE id = ${doc}`),
        insertVersion: (v) =>
          done(sql`INSERT INTO doc_versions (id, doc_id, number, message, task_id, run_id, created_at)
            VALUES (${v.id}, ${v.doc}, ${v.number}, ${v.message}, ${v.task_id}, ${v.run_id}, ${v.now})`),
        insertPage: (version, p) =>
          done(sql`INSERT INTO doc_pages (version_id, path, title, format, source, position)
            VALUES (${version}, ${p.path}, ${p.title}, ${p.format}, ${p.source}, ${p.position})`),
        pageCount: (version) => Effect.map(countRows(sql`SELECT COUNT(*) AS n FROM doc_pages WHERE version_id = ${version}`), (r) => r[0]?.n ?? 0),
        knownLabels: (profile) =>
          Effect.map(labelRows(sql`SELECT l.label FROM doc_labels l JOIN docs d ON d.id = l.doc_id WHERE d.profile_id = ${profile} ORDER BY l.rowid`), (r) =>
            r.map((x) => x.label),
          ),
        replaceLabels: (doc, labels) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM doc_labels WHERE doc_id = ${doc}`
            for (const l of labels) yield* sql`INSERT INTO doc_labels (doc_id, label) VALUES (${doc}, ${l})`
          }).pipe(Effect.orDie),
        addImage: (profile, version, im, now) =>
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO doc_images (profile_id, sha256, data, width, height, created_at)
              VALUES (${profile}, ${im.sha256}, ${im.data}, ${im.width}, ${im.height}, ${now})`
            yield* sql`INSERT INTO doc_version_images (version_id, name, sha256) VALUES (${version}, ${im.name}, ${im.sha256})`
          }).pipe(Effect.orDie),
        nameImage: (version, name, sha256) => done(sql`INSERT INTO doc_version_images (version_id, name, sha256) VALUES (${version}, ${name}, ${sha256})`),
        imageRefs: (version) => imageRefs(sql`SELECT name, sha256 FROM doc_version_images WHERE version_id = ${version} ORDER BY name`),
        images: (version) =>
          imageRows(sql`SELECT vi.name, vi.sha256, length(i.data) AS bytes, i.width, i.height FROM doc_version_images vi
            JOIN doc_versions v ON v.id = vi.version_id JOIN docs d ON d.id = v.doc_id
            JOIN doc_images i ON i.profile_id = d.profile_id AND i.sha256 = vi.sha256
            WHERE vi.version_id = ${version} ORDER BY vi.name`),
        imageData: (profile, sha256) =>
          Effect.map(first(imageData(sql`SELECT data FROM doc_images WHERE profile_id = ${profile} AND sha256 = ${sha256}`)), (r) => r?.data ?? null),
        delete: (profile, slug) =>
          Effect.gen(function* () {
            const gone = yield* idRows(sql`DELETE FROM docs WHERE profile_id = ${profile} AND slug = ${slug} RETURNING id`)
            if (gone.length === 0) return false
            yield* sql`DELETE FROM doc_images WHERE profile_id = ${profile} AND NOT EXISTS (SELECT 1 FROM doc_version_images vi
              JOIN doc_versions v ON v.id = vi.version_id JOIN docs d ON d.id = v.doc_id
              WHERE vi.sha256 = doc_images.sha256 AND d.profile_id = ${profile})`.pipe(Effect.orDie)
            return true
          }),
        move: (doc, folder) => done(sql`UPDATE docs SET folder = ${folder} WHERE id = ${doc}`),
        comments: (doc, filter = {}) => {
          const version = filter.version ?? null
          const since = filter.since ?? null
          return commentRows(
            sql`${selectComment} WHERE v.doc_id = ${doc} AND (${version} IS NULL OR v.number = ${version}) AND (${since} IS NULL OR m.updated_at >= ${since})
              ORDER BY v.number, m.page_path, m.created_at, m.id`,
          )
        },
        comment,
        addComment: (doc, version, page, text, now) =>
          Effect.gen(function* () {
            const added = yield* idRows(sql`INSERT INTO doc_comments (version_id, page_path, quote, prefix, suffix, comment, created_at, updated_at)
              VALUES (${version}, ${page}, ${text.quote}, ${text.prefix}, ${text.suffix}, ${text.comment}, ${now}, ${now}) RETURNING CAST(id AS TEXT) AS id`)
            const made = yield* comment(doc, Number(added[0]?.id))
            // Just inserted, in this transaction.
            return made ?? (yield* Effect.die(new Error("a comment just added isn't there")))
          }),
        editComment: (doc, id, text, now) =>
          Effect.gen(function* () {
            const changed = yield* idRows(sql`UPDATE doc_comments SET comment = ${text}, updated_at = ${now}, sent_at = NULL
              WHERE id = ${id} AND version_id IN (SELECT id FROM doc_versions WHERE doc_id = ${doc}) RETURNING CAST(id AS TEXT) AS id`)
            return changed.length === 0 ? null : yield* comment(doc, id)
          }),
        deleteComment: (doc, id) =>
          Effect.map(
            idRows(
              sql`DELETE FROM doc_comments WHERE id = ${id} AND version_id IN (SELECT id FROM doc_versions WHERE doc_id = ${doc}) RETURNING CAST(id AS TEXT) AS id`,
            ),
            (r) => r.length > 0,
          ),
        markSent: (ids, at) =>
          Effect.forEach(ids, (id) => sql`UPDATE doc_comments SET sent_at = ${at} WHERE id = ${id}`, { concurrency: 1, discard: true }).pipe(Effect.orDie),
      })
    }),
  )
}
