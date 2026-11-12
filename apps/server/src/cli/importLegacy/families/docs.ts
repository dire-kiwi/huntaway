import { Effect, Schema } from "effect"
import { DocId, ProfileId, Timestamp } from "@huntaway/contracts"
import { CommentRow, DocRow, ImageData, ImageRef, PageRow, VersionRow } from "../../../docs/DocRepo.ts"
import { ConnectionRow, PublishedRow } from "../../../docs/DocsSiteRepo.ts"
import { keyOf } from "../family.ts"
import type { Family, TableCheck } from "../family.ts"
import { orDefault, orNull, readOld, writeUnlessRehearsal } from "./common.ts"

// Docs and hosted docs (docs/plan/11-migration.md, Table by table: as is): a profile's documents, their versions,
// pages, labels, images and comments, and what this host knows of docs sites. A rehearsal does not write the profiles'
// sign-ins to a docs site (`docs_site_connections`): they are credentials for something outside the folder.

export const OldDoc = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  folder: orDefault(Schema.String, ""),
  created_at: Schema.String,
  updated_at: Schema.String,
})

export const OldDocVersion = Schema.Struct({
  id: Schema.String,
  doc_id: Schema.String,
  number: Schema.Int,
  message: orNull(Schema.String),
  task_id: orNull(Schema.String),
  run_id: orNull(Schema.String),
  created_at: Schema.String,
})

export const OldDocPage = Schema.Struct({
  version_id: Schema.String,
  path: Schema.String,
  title: Schema.String,
  format: Schema.String,
  source: Schema.String,
  position: Schema.Int,
})

export const OldDocLabel = Schema.Struct({ doc_id: Schema.String, label: Schema.String })

export const OldDocImage = Schema.Struct({
  profile_id: Schema.String,
  sha256: Schema.String,
  data: Schema.Uint8Array,
  width: Schema.Int,
  height: Schema.Int,
  created_at: Schema.String,
})

export const OldDocVersionImage = Schema.Struct({ version_id: Schema.String, name: Schema.String, sha256: Schema.String })

export const OldDocComment = Schema.Struct({
  id: Schema.Int,
  version_id: Schema.String,
  page_path: Schema.String,
  quote: Schema.String,
  prefix: orDefault(Schema.String, ""),
  suffix: orDefault(Schema.String, ""),
  comment: orDefault(Schema.String, ""),
  created_at: Schema.String,
  updated_at: Schema.String,
  sent_at: orNull(Schema.String),
})

export const OldDocsSiteClient = Schema.Struct({ site_url: Schema.String, client_id: Schema.String, created_at: Schema.String })

export const OldDocsSiteConnection = Schema.Struct({
  profile_id: Schema.String,
  site_url: Schema.String,
  kind: Schema.String,
  access_token: Schema.String,
  refresh_token: orNull(Schema.String),
  expires_at: orNull(Schema.Finite),
  login: orNull(Schema.String),
  connected_at: Schema.String,
})

export const OldDocsSitePublished = Schema.Struct({
  doc_id: Schema.String,
  site_url: Schema.String,
  remote_slug: Schema.String,
  remote_version: Schema.Int,
  local_version: Schema.Int,
  url: Schema.String,
  version_url: Schema.String,
  login: orNull(Schema.String),
  published_at: Schema.String,
})

const byId = keyOf("id")
const { latest_version: _latest, page_count: _pages, labels: _labels, ...docFields } = DocRow.fields
const { version: _version, page: _page, ...commentFields } = CommentRow.fields

const docRows: TableCheck = { row: Schema.Struct(docFields), key: byId }
const versions: TableCheck = { row: Schema.Struct({ doc_id: DocId, ...VersionRow.fields }), key: byId }
const pages: TableCheck = { row: Schema.Struct({ version_id: Schema.String, ...PageRow.fields }), key: keyOf("version_id", "path") }
const labels: TableCheck = { row: Schema.Struct({ doc_id: DocId, label: Schema.String }), key: keyOf("doc_id", "label") }
const images: TableCheck = {
  row: Schema.Struct({ profile_id: ProfileId, sha256: Schema.String, ...ImageData.fields, width: Schema.Int, height: Schema.Int, created_at: Timestamp }),
  key: keyOf("profile_id", "sha256"),
}
const versionImages: TableCheck = { row: Schema.Struct({ version_id: Schema.String, ...ImageRef.fields }), key: keyOf("version_id", "name") }
const comments: TableCheck = {
  row: Schema.Struct({ ...commentFields, version_id: Schema.String, page_path: Schema.String }),
  key: byId,
}
const siteClients: TableCheck = {
  row: Schema.Struct({ site_url: Schema.String, client_id: Schema.String, created_at: Timestamp }),
  key: keyOf("site_url"),
}
const siteConnections: TableCheck = { row: ConnectionRow, key: keyOf("profile_id") }
const sitePublished: TableCheck = { row: Schema.Struct({ doc_id: DocId, ...PublishedRow.fields }), key: keyOf("doc_id", "site_url") }

export const docs: Family = {
  name: "docs",
  reads: [
    "docs",
    "doc_versions",
    "doc_pages",
    "doc_labels",
    "doc_images",
    "doc_version_images",
    "doc_comments",
    "docs_site_clients",
    "docs_site_connections",
    "docs_site_published",
  ],
  writes: [
    "docs",
    "doc_versions",
    "doc_pages",
    "doc_labels",
    "doc_images",
    "doc_version_images",
    "doc_comments",
    "docs_site_clients",
    "docs_site_connections",
    "docs_site_published",
  ],
  run: (io) =>
    Effect.gen(function* () {
      yield* io.write("docs", docRows, yield* readOld(io, "docs", OldDoc, byId))
      yield* io.write("doc_versions", versions, yield* readOld(io, "doc_versions", OldDocVersion, byId))
      yield* io.write("doc_pages", pages, yield* readOld(io, "doc_pages", OldDocPage, keyOf("version_id", "path")))
      yield* io.write("doc_labels", labels, yield* readOld(io, "doc_labels", OldDocLabel, keyOf("doc_id", "label")))
      yield* io.write("doc_images", images, yield* readOld(io, "doc_images", OldDocImage, keyOf("profile_id", "sha256")))
      yield* io.write("doc_version_images", versionImages, yield* readOld(io, "doc_version_images", OldDocVersionImage, keyOf("version_id", "name")))
      yield* io.write("doc_comments", comments, yield* readOld(io, "doc_comments", OldDocComment, byId))
      yield* io.write("docs_site_clients", siteClients, yield* readOld(io, "docs_site_clients", OldDocsSiteClient, keyOf("site_url")))
      yield* writeUnlessRehearsal(
        io,
        "docs_site_connections",
        siteConnections,
        yield* readOld(io, "docs_site_connections", OldDocsSiteConnection, keyOf("profile_id")),
      )
      yield* io.write("docs_site_published", sitePublished, yield* readOld(io, "docs_site_published", OldDocsSitePublished, keyOf("doc_id", "site_url")))
    }),
}
