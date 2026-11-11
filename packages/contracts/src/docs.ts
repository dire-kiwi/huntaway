import { Schema } from "effect"
import { ProfileId, RunId, TaskId } from "./ids.ts"
import { Timestamp } from "./time.ts"

// Published documents (huntaway's apps/server/src/wire/docs.ts; docs/plan/inventory/02-agent-support.md 2.8): each
// profile's documents, which its agents publish through the `docs` MCP server and the board shows, with their versions,
// pages, labels, images and comments, and where each went on the profile's hosted docs site. The board names documents
// by their slugs and versions by their numbers: no row id crosses the wire.

/** A page's format. */
export const DocFormat = Schema.Literals(["md", "mdx"])
export type DocFormat = typeof DocFormat.Type

/** A comment on a page of a version, with the version's number: the text quoted, with its context either side to find it again, and what was said. */
export const DocComment = Schema.Struct({
  id: Schema.Int,
  version: Schema.Int,
  page: Schema.String,
  quote: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String,
  comment: Schema.String,
  created_at: Timestamp,
  updated_at: Timestamp,
  /** When it was last sent to the agent; null while it hasn't been since it was made or edited. */
  sent_at: Schema.NullOr(Timestamp),
})
export interface DocComment extends Schema.Schema.Type<typeof DocComment> {}

/** A page of a version, without its source. */
export const DocPageSummary = Schema.Struct({ path: Schema.String, title: Schema.String, format: DocFormat, position: Schema.Int })
export interface DocPageSummary extends Schema.Schema.Type<typeof DocPageSummary> {}

/** The task that published a version: its id, title and key. */
export const DocPublisher = Schema.Struct({ id: TaskId, title: Schema.String, key: Schema.NullOr(Schema.String) })
export interface DocPublisher extends Schema.Schema.Type<typeof DocPublisher> {}

/** A version of a document, as its detail lists it. */
export const DocVersion = Schema.Struct({
  number: Schema.Int,
  message: Schema.NullOr(Schema.String),
  /** The task and run that published it, if an agent's run did. */
  task_id: Schema.NullOr(TaskId),
  run_id: Schema.NullOr(RunId),
  created_at: Timestamp,
  /** That task, if it's still there. */
  task: Schema.NullOr(DocPublisher),
})
export interface DocVersion extends Schema.Schema.Type<typeof DocVersion> {}

/** A profile's label: its last segment, its whole path, and how many documents have it or one inside it. */
export interface DocLabelNode {
  readonly name: string
  readonly path: string
  readonly documents: number
  readonly children: ReadonlyArray<DocLabelNode>
}
export const DocLabelNode: Schema.Codec<DocLabelNode> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  documents: Schema.Int,
  children: Schema.Array(Schema.suspend((): Schema.Codec<DocLabelNode> => DocLabelNode)),
})

/** A profile's labels as a tree, how many documents it has, and how many have no label (the docs server's `list_labels`). */
export const DocLabels = Schema.Struct({ labels: Schema.Array(DocLabelNode), documents: Schema.Int, unlabelled: Schema.Int })
export interface DocLabels extends Schema.Schema.Type<typeof DocLabels> {}

/** A document's comments, every version's, and the task they'd be sent to (if one that published it is still there). */
export const DocComments = Schema.Struct({ comments: Schema.Array(DocComment), task: Schema.NullOr(DocPublisher), can_send: Schema.Boolean })
export interface DocComments extends Schema.Schema.Type<typeof DocComments> {}

/** Where a document went on the profile's docs site: its slug there, and the last version published (the site's and the local one). */
export const DocPublished = Schema.Struct({
  site_url: Schema.String,
  remote_slug: Schema.String,
  remote_version: Schema.Int,
  local_version: Schema.Int,
  url: Schema.String,
  version_url: Schema.String,
  /** The site's username it was published as, if it was known. */
  login: Schema.NullOr(Schema.String),
  published_at: Timestamp,
})
export interface DocPublished extends Schema.Schema.Type<typeof DocPublished> {}

/** A device sign-in under way: what the user is shown. */
export const HostedDocsPending = Schema.Struct({
  site_url: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.NullOr(Schema.String),
  expires_at: Timestamp,
  /** Why it stopped: denied, expired or failed. */
  error: Schema.NullOr(Schema.String),
})
export interface HostedDocsPending extends Schema.Schema.Type<typeof HostedDocsPending> {}

/** A profile's connection to its docs site (never its tokens), and the device sign-in under way, if any. */
export const HostedDocsStatus = Schema.Struct({
  default_site_url: Schema.String,
  site_url: Schema.String,
  connected: Schema.Boolean,
  kind: Schema.NullOr(Schema.Literals(["oauth", "token"])),
  /** The site's username, once it's known (from the profile's documents there). */
  login: Schema.NullOr(Schema.String),
  connected_at: Schema.NullOr(Timestamp),
  pending: Schema.NullOr(HostedDocsPending),
})
export interface HostedDocsStatus extends Schema.Schema.Type<typeof HostedDocsStatus> {}

/** A warning the renderer or the site gave about a page. */
export const DocPageWarning = Schema.Struct({ page: Schema.String, warning: Schema.String })
export interface DocPageWarning extends Schema.Schema.Type<typeof DocPageWarning> {}

/** A version published to the site. */
export const DocPublishResult = Schema.Struct({ published: DocPublished, warnings: Schema.Array(DocPageWarning) })
export interface DocPublishResult extends Schema.Schema.Type<typeof DocPublishResult> {}

/** The site's document at the slug a publish with `ask` would have added a version to, for the user to confirm. */
export const DocPublishExists = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  latest_version: Schema.NullOr(Schema.Int),
  url: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Schema.String),
})
export interface DocPublishExists extends Schema.Schema.Type<typeof DocPublishExists> {}

/** What `docs.publish` gives: the version published, or (with `ask`) the site's document it would have added to. */
export const DocPublishOutcome = Schema.Union([DocPublishResult, Schema.Struct({ exists: DocPublishExists })])
export type DocPublishOutcome = typeof DocPublishOutcome.Type

/** What a document's list entry and its detail both say of it. */
const docFields = {
  profile_id: ProfileId,
  slug: Schema.String,
  title: Schema.String,
  /** The folder it's filed in: a '/'-separated path, "" for the top level. */
  folder: Schema.String,
  /** Its labels, '/'-separated paths. */
  labels: Schema.Array(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  latest_version: Schema.Int,
  /** How many pages its latest version has. */
  page_count: Schema.Int,
  /** Where it was published on the profile's docs site. */
  published: Schema.NullOr(DocPublished),
}

/** A document in a profile's list. */
export const DocSummary = Schema.Struct({
  ...docFields,
  /** The task that published its latest version, if it's still there. */
  task: Schema.NullOr(DocPublisher),
})
export interface DocSummary extends Schema.Schema.Type<typeof DocSummary> {}

/** One document: what its summary says but `task` (each of its versions has its own), its versions (newest first) and its latest one's pages. */
export const DocDetail = Schema.Struct({ ...docFields, versions: Schema.Array(DocVersion), pages: Schema.Array(DocPageSummary) })
export interface DocDetail extends Schema.Schema.Type<typeof DocDetail> {}

/** A node of a version's menu (docs-render's `navTree`). */
export interface DocNavNode {
  readonly segment: string
  readonly title: string
  readonly page: string | null
  readonly children: ReadonlyArray<DocNavNode>
}
export const DocNavNode: Schema.Codec<DocNavNode> = Schema.Struct({
  segment: Schema.String,
  title: Schema.String,
  page: Schema.NullOr(Schema.String),
  children: Schema.Array(Schema.suspend((): Schema.Codec<DocNavNode> => DocNavNode)),
})

/** A heading of a page, for its "On this page" menu. */
export const DocTocEntry = Schema.Struct({ depth: Schema.Int, id: Schema.String, text: Schema.String })
export interface DocTocEntry extends Schema.Schema.Type<typeof DocTocEntry> {}

/** A page rendered: its sanitized HTML, its headings, the renderer's warnings, or why it couldn't be. */
export const RenderedDocPage = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  format: DocFormat,
  /** Its URL under the version's `base_url` (`plan/` for `plan/index`, `` for `index`). */
  url_suffix: Schema.String,
  html: Schema.NullOr(Schema.String),
  toc: Schema.Array(DocTocEntry),
  has_h1: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  /** Why it couldn't be rendered, if it couldn't. */
  error: Schema.NullOr(Schema.String),
})
export interface RenderedDocPage extends Schema.Schema.Type<typeof RenderedDocPage> {}

/** A version rendered: its pages and its menu. */
export const RenderedDocVersion = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  number: Schema.Int,
  latest_version: Schema.Int,
  message: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  task: Schema.NullOr(DocPublisher),
  /** What relative links between its pages were rendered against. */
  base_url: Schema.String,
  nav: Schema.Array(DocNavNode),
  pages: Schema.Array(RenderedDocPage),
})
export interface RenderedDocVersion extends Schema.Schema.Type<typeof RenderedDocVersion> {}

/** An image of a profile's, by its sha256: its AVIF in base64. */
export const DocImageData = Schema.Struct({ sha256: Schema.String, mime: Schema.String, data: Schema.String })
export interface DocImageData extends Schema.Schema.Type<typeof DocImageData> {}

/** What `docs.update` changes: the folder (moved, its slug and URLs stay), the labels (in place of its own), or both. */
export const DocPatch = Schema.Struct({ folder: Schema.optional(Schema.String), labels: Schema.optional(Schema.Array(Schema.String)) })
export interface DocPatch extends Schema.Schema.Type<typeof DocPatch> {}

/** A comment to add: on a page of a version, the text selected with its context, and what's said about it. */
export const NewDocComment = Schema.Struct({
  version: Schema.Int,
  page: Schema.String,
  quote: Schema.String,
  prefix: Schema.optional(Schema.String),
  suffix: Schema.optional(Schema.String),
  comment: Schema.optional(Schema.String),
})
export interface NewDocComment extends Schema.Schema.Type<typeof NewDocComment> {}
