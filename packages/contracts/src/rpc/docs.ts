import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  DocComment,
  DocComments,
  DocDetail,
  DocImageData,
  DocLabels,
  DocPatch,
  DocPublishOutcome,
  DocPublisher,
  DocSummary,
  HostedDocsStatus,
  NewDocComment,
  RenderedDocVersion,
} from "../docs.ts"
import { Conflict, External, Invalid, NotFound, Unavailable } from "../errors.ts"
import { ProfileId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

// A profile's published documents (the old `/profiles/{id}/docs…`, `/doc_labels`, `/doc_folders/rename`,
// `/doc_images/{sha}`, `/hosted_docs…`; docs/plan/inventory/02-agent-support.md 2.8). A change to a document emits
// `docs`, one to its comments `doc_comments`, one to the profile's connection to its docs site `docs_site`.

const doc = { profile_id: ProfileId, slug: Schema.String }

export class DocRpcs extends RpcGroup.make(
  /** Its documents, most recently updated first: with `label`, those with that label or one inside it. */
  Rpc.make("docs.list", {
    payload: { profile_id: ProfileId, label: Schema.optional(Schema.String) },
    success: Schema.Array(DocSummary),
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "read"),
  Rpc.make("docs.get", { payload: doc, success: DocDetail, error: NotFound }).annotate(RequiredScope, "read"),
  /** Moves it (`folder`) or relabels it (`labels`), or both; gives it as `docs.get` does. */
  Rpc.make("docs.update", { payload: { ...doc, patch: DocPatch }, success: DocDetail, error: Schema.Union([NotFound, Invalid]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("docs.delete", { payload: doc, error: NotFound }).annotate(RequiredScope, "settings"),
  /** Renames or moves a folder (`to` "" is the top level): every document in it or in one inside it. The slugs of those that moved. */
  Rpc.make("docs.renameFolder", {
    payload: { profile_id: ProfileId, from: Schema.String, to: Schema.String },
    success: Schema.Struct({ moved: Schema.Array(Schema.String) }),
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "settings"),
  /** The profile's labels as a tree. */
  Rpc.make("docs.labels", { payload: { profile_id: ProfileId }, success: DocLabels, error: NotFound }).annotate(RequiredScope, "read"),
  /** One of the profile's images (a rendered page's `<img>` names it by its sha256), as base64. */
  Rpc.make("docs.image", { payload: { profile_id: ProfileId, sha256: Schema.String }, success: DocImageData, error: NotFound }).annotate(RequiredScope, "read"),
  /**
   * A version (null: the latest) rendered, with its menu. Relative links point under `base_url` (the board's page for
   * the document, or for that version), unless one is given (a path from / ending in /). `path` gives only that page (or
   * that folder's index), `first` only its first page in menu order (with `path`, when there's no such page).
   */
  Rpc.make("docs.version", {
    payload: {
      ...doc,
      version: Schema.NullOr(Schema.Int),
      base_url: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      first: Schema.optional(Schema.Boolean),
    },
    success: RenderedDocVersion,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "read"),
  /**
   * Publishes a version (by default the latest) to the profile's docs site. `slug` is the remote one (by default the
   * one it went to, else its own); with `ask`, a first publish to a slug the site has a document of the user's at gives
   * `{exists}` instead.
   */
  Rpc.make("docs.publish", {
    payload: {
      ...doc,
      version: Schema.optional(Schema.NullOr(Schema.Int)),
      remote_slug: Schema.optional(Schema.NullOr(Schema.String)),
      ask: Schema.optional(Schema.Boolean),
    },
    success: DocPublishOutcome,
    error: Schema.Union([NotFound, Invalid, Conflict, External]),
  }).annotate(RequiredScope, "settings"),
  /** Every version's comments, the task they'd be sent to, and whether they can be. */
  Rpc.make("docs.comments", { payload: doc, success: DocComments, error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("docs.addComment", { payload: { ...doc, comment: NewDocComment }, success: DocComment, error: Schema.Union([NotFound, Invalid]) }).annotate(
    RequiredScope,
    "operate",
  ),
  /** Changes what it says: it's unsent again. */
  Rpc.make("docs.updateComment", {
    payload: { ...doc, id: Schema.Int, comment: Schema.String },
    success: DocComment,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "operate"),
  Rpc.make("docs.deleteComment", { payload: { ...doc, id: Schema.Int }, error: NotFound }).annotate(RequiredScope, "operate"),
  /** Sends the unsent comments to the task, as one message, and marks them sent. */
  Rpc.make("docs.sendComments", {
    payload: doc,
    success: Schema.Struct({ sent: Schema.Int, task: DocPublisher }),
    error: Schema.Union([NotFound, Conflict, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /** The profile's connection to its docs site, without its tokens. */
  Rpc.make("docs.hostedStatus", { payload: { profile_id: ProfileId }, success: HostedDocsStatus, error: NotFound }).annotate(RequiredScope, "read"),
  Rpc.make("docs.hostedDisconnect", { payload: { profile_id: ProfileId }, success: HostedDocsStatus, error: NotFound }).annotate(RequiredScope, "settings"),
  /** Starts a device sign-in to the site (the default one without `site_url`). */
  Rpc.make("docs.hostedDeviceStart", {
    payload: { profile_id: ProfileId, site_url: Schema.optional(Schema.NullOr(Schema.String)) },
    success: HostedDocsStatus,
    error: Schema.Union([NotFound, Invalid, External]),
  }).annotate(RequiredScope, "settings"),
  /** Stops a sign-in under way (or clears the error of one that stopped). */
  Rpc.make("docs.hostedDeviceCancel", { payload: { profile_id: ProfileId }, success: HostedDocsStatus, error: NotFound }).annotate(RequiredScope, "settings"),
  /** Connects with a personal access token, once the site takes it. */
  Rpc.make("docs.hostedToken", {
    payload: { profile_id: ProfileId, site_url: Schema.optional(Schema.NullOr(Schema.String)), token: Schema.String },
    success: HostedDocsStatus,
    error: Schema.Union([NotFound, Invalid, Conflict, External]),
  }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}
