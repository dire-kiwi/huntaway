import { Clock, Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { Conflict, Invalid, NotFound, Timestamp } from "@huntaway/contracts"
import type {
  DocComment,
  DocComments,
  DocDetail,
  DocImageData,
  DocLabels,
  DocPatch,
  DocPublisher,
  DocSummary,
  NewDocComment,
  ProfileId,
  RenderedDocPage,
  RenderedDocVersion,
  Task,
} from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { ProjectRepo } from "../projects/ProjectRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { DocImages } from "./DocImages.ts"
import { DocRepo } from "./DocRepo.ts"
import type { Doc, VersionRow } from "./DocRepo.ts"
import { DocsRender, renderMessage, rendered } from "./DocsRender.ts"
import type { RenderLib } from "./DocsRender.ts"
import { chars, commentsMessage, docBase, inLabel, labelTree, normalizeLabels, quoted, renamedFolders, spelt } from "./docRules.ts"
import { HostedDocs } from "./HostedDocs.ts"
import { withImages } from "./imageRules.ts"
import { publishFor } from "./publish.ts"
import type { DocsCaller, PublishInput, Published } from "./publish.ts"

// Published documents (docs/plan/06-server.md, Documents and docs; docs/plan/inventory/02-agent-support.md 2.8;
// huntaway's db/docs.ts, api/docs.ts, mcp/docs_mcp.ts): each profile's documents, which its agents publish through the
// `docs` MCP server as they would to the hosted docs app (dire-kiwi/docs), and which the board shows. A document has
// immutable versions, each with its pages (Markdown or MDX), and every publish makes a new one. Slugs are unique per
// profile. A document is filed in a folder when it's created (a '/'-path, "" the top level; no table of folders), has
// labels ('/'-nested, matched whatever their case, spelt as first used in the profile), images (AVIFs kept once per
// profile, `DocImages`), and comments the user leaves on a version's pages for the agent. Publishing to a hosted docs
// site is `HostedDocs`. A publish's body is `publish.ts`.

/** A refusal an agent is told in the docs server's words (the hosted server's, where it has one). */
export class DocsRefused extends Schema.TaggedError<DocsRefused, { readonly brand: unique symbol }>()("DocsRefused", { message: Schema.String }) {}

/** The longest quote, comment, and quote's context either side a comment may have, in characters. */
export const MAX_QUOTE_CHARS = 10_000
export const MAX_COMMENT_CHARS = 20_000
export const MAX_CONTEXT_CHARS = 500

/** Where a rendered page's `<img>` points for one of the profile's images: what the board fetches with `docs.image`. */
export const imageSrc = (profile: string, sha256: string): string => `/api/profiles/${encodeURIComponent(profile)}/doc_images/${sha256}`

/** A version as the docs server's tools show it. */
export const versionJson = (v: VersionRow) => ({ number: v.number, message: v.message, task_id: v.task_id, created_at: v.created_at })

/** Labels from a request, normalised. */
const labelsOf = (raw: ReadonlyArray<string>) => {
  const out = normalizeLabels(raw)
  return "error" in out ? Effect.fail(new Invalid({ field: "labels", reason: out.error })) : Effect.succeed(out.labels)
}

/** A comment's text from a request, checked. */
const text = (v: string | undefined, name: string, max: number, required = false) => {
  const s = v ?? ""
  if (required && s.trim() === "") return Effect.fail(new Invalid({ field: name, reason: `${name} is required` }))
  if (chars(s) > max) return Effect.fail(new Invalid({ field: name, reason: `${name} is longer than ${max} characters` }))
  return Effect.succeed(s)
}

const labelsForAgent = (raw: ReadonlyArray<string>) => Effect.mapError(labelsOf(raw), (e) => new DocsRefused({ message: e.reason }))

const refusedBy = (e: { readonly message: string }) => new DocsRefused({ message: e.message })

/** The board's URLs of a profile's documents' pages. */
const urlOf = (lib: RenderLib, board: string, profile: ProfileId) => (slug: string, number: number | null, path: string) =>
  `${board}${docBase(profile, slug, number)}${lib.urlSuffix(path)}`

export interface DocsShape {
  /** The board's address documents' URLs start with: the host's public URL if it has one, else its own. */
  readonly boardUrl: Effect.Effect<string>
  readonly list: (profile: ProfileId, label: string | null) => Effect.Effect<ReadonlyArray<DocSummary>, NotFound | Invalid>
  readonly get: (profile: ProfileId, slug: string) => Effect.Effect<DocDetail, NotFound>
  /** Moves it, relabels it, or both. Emits `docs`. */
  readonly update: (profile: ProfileId, slug: string, patch: DocPatch) => Effect.Effect<DocDetail, NotFound | Invalid>
  /** Deletes it with its versions, and the images nothing uses any more. Emits `docs` (deleted). */
  readonly delete: (profile: ProfileId, slug: string) => Effect.Effect<void, NotFound>
  /** Renames (or moves) a folder: every document in it or in one inside it. A `docs` event for each. */
  readonly renameFolder: (profile: ProfileId, from: string, to: string) => Effect.Effect<{ readonly moved: ReadonlyArray<string> }, NotFound | Invalid>
  readonly labels: (profile: ProfileId) => Effect.Effect<DocLabels, NotFound>
  readonly image: (profile: ProfileId, sha256: string) => Effect.Effect<DocImageData, NotFound>
  readonly version: (
    profile: ProfileId,
    slug: string,
    number: number | null,
    o: { readonly base_url?: string | undefined; readonly path?: string | undefined; readonly first?: boolean | undefined },
  ) => Effect.Effect<RenderedDocVersion, NotFound | Invalid>
  readonly comments: (profile: ProfileId, slug: string) => Effect.Effect<DocComments, NotFound>
  /** Emits `doc_comments`, as the next two do. */
  readonly addComment: (profile: ProfileId, slug: string, c: NewDocComment) => Effect.Effect<DocComment, NotFound | Invalid>
  readonly updateComment: (profile: ProfileId, slug: string, id: number, comment: string) => Effect.Effect<DocComment, NotFound | Invalid>
  readonly deleteComment: (profile: ProfileId, slug: string, id: number) => Effect.Effect<void, NotFound>
  /** Sends the unsent comments to the task that published the document, as one message, and marks them sent. */
  readonly sendComments: (profile: ProfileId, slug: string) => Effect.Effect<{ readonly sent: number; readonly task: DocPublisher }, NotFound | Conflict>

  // The docs server's (mcp/tools/docs.ts): each as its tool answers, failing with what the agent is told.

  /** `publish_document`. Emits `docs`. */
  readonly publish: (caller: DocsCaller, input: PublishInput) => Effect.Effect<Published, DocsRefused>
  readonly agentList: (caller: DocsCaller, label: string | null) => Effect.Effect<unknown, DocsRefused>
  readonly agentGet: (caller: DocsCaller, slug: string, version: number | null) => Effect.Effect<unknown, DocsRefused>
  readonly readPage: (caller: DocsCaller, slug: string, path: string, version: number | null) => Effect.Effect<unknown, DocsRefused>
  readonly agentMove: (caller: DocsCaller, slug: string, folder: string) => Effect.Effect<unknown, DocsRefused>
  readonly setLabels: (caller: DocsCaller, slug: string, labels: ReadonlyArray<string>) => Effect.Effect<unknown, DocsRefused>
  /** `list_labels`. */
  readonly agentLabels: (caller: DocsCaller) => Effect.Effect<DocLabels>
  readonly feedback: (caller: DocsCaller, slug: string, version: number | null, since: number | null) => Effect.Effect<unknown, DocsRefused>
  readonly components: Effect.Effect<string>
}

export class Docs extends Context.Service<Docs, DocsShape>()("huntaway-server/docs/Docs") {
  static readonly layer = Layer.effect(
    Docs,
    Effect.gen(function* () {
      const repo = yield* DocRepo
      const db = yield* Db
      const events = yield* Events
      const render = yield* DocsRender
      const images = yield* DocImages
      const hosted = yield* HostedDocs
      const profiles = yield* ProfileRepo
      const projects = yield* ProjectRepo
      const tasks = yield* TaskRepo
      const runs = yield* Runs
      const settings = yield* HostSettings
      const config = yield* ServerConfig
      const random = yield* SecureRandom.SecureRandom

      const boardUrl = Effect.map(settings.get, (s) => {
        const set = s.public_url?.trim() ?? ""
        return (set === "" ? `http://127.0.0.1:${config.port}` : set).replace(/\/+$/, "")
      })

      const profileOf = (profile: ProfileId) =>
        Effect.flatMap(profiles.get(profile), (p) => (Option.isNone(p) ? Effect.fail(new NotFound({ what: "profile", id: profile })) : Effect.void))
      const docOf = Effect.fnUntraced(function* (profile: ProfileId, slug: string) {
        yield* profileOf(profile)
        const d = yield* repo.get(profile, slug)
        if (d === null) return yield* new NotFound({ what: "document", id: slug })
        return d
      })

      /** A task as documents name it: its id, title and key. */
      const publisherOf = Effect.fnUntraced(function* (taskId: string | null) {
        const t = taskId === null ? null : yield* tasks.get(taskId)
        const out: DocPublisher | null = t === null ? null : { id: t.id, title: t.title, key: t.key }
        return out
      })

      const folderOf = (raw: string, field: string) =>
        Effect.flatMap(render.lib, (lib) => rendered(() => lib.normalizeFolder(raw))).pipe(Effect.mapError((e) => new Invalid({ field, reason: e.message })))

      /** Gives a document these labels (normalised), spelt as the profile spells them already. */
      const setLabelsOf = Effect.fnUntraced(function* (profile: ProfileId, doc: Doc, labels: ReadonlyArray<string>) {
        const known = yield* repo.knownLabels(profile)
        yield* repo.replaceLabels(doc.id, spelt(known, labels))
      })

      const summaryOf = Effect.fnUntraced(function* (d: Doc) {
        const latest = yield* repo.version(d.id, null)
        const { id: _id, ...rest } = d
        const out: DocSummary = { ...rest, task: yield* publisherOf(latest?.task_id ?? null), published: yield* hosted.published(d.profile_id, d) }
        return out
      })

      const detailOf = Effect.fnUntraced(function* (d: Doc) {
        const versions = yield* repo.versions(d.id)
        const latest = versions[0]
        const { id: _id, ...rest } = d
        const out: DocDetail = {
          ...rest,
          published: yield* hosted.published(d.profile_id, d),
          versions: yield* Effect.forEach(
            versions,
            (v) =>
              Effect.map(publisherOf(v.task_id), (task) => ({
                number: v.number,
                message: v.message,
                task_id: v.task_id,
                run_id: v.run_id,
                created_at: v.created_at,
                task,
              })),
            { concurrency: 1 },
          ),
          pages: latest === undefined ? [] : yield* repo.pages(latest.id),
        }
        return out
      })

      const docsChanged = (profile: ProfileId, slug: string, deleted?: boolean) =>
        events.emit(deleted === true ? { type: "docs", profile_id: profile, slug, deleted } : { type: "docs", profile_id: profile, slug })
      const commentsChanged = (d: Doc) => events.emit({ type: "doc_comments", profile_id: d.profile_id, slug: d.slug })

      const list = Effect.fn("Docs.list")(function* (profile: ProfileId, label: string | null) {
        yield* profileOf(profile)
        const wanted = label === null || label.trim() === "" ? null : ((yield* labelsOf([label]))[0] ?? null)
        const all = yield* repo.list(profile)
        const docs = wanted === null ? all : all.filter((d) => d.labels.some((l) => inLabel(l, wanted)))
        return yield* Effect.forEach(docs, summaryOf, { concurrency: 1 })
      })

      const update = Effect.fn("Docs.update")(function* (profile: ProfileId, slug: string, patch: DocPatch) {
        const d = yield* docOf(profile, slug)
        if (patch.folder === undefined && patch.labels === undefined) {
          return yield* new Invalid({ field: "folder", reason: 'folder is a folder: a path like "docs/plans", or "" for the top level' })
        }
        const to = patch.folder === undefined ? null : yield* folderOf(patch.folder, "folder")
        const labels = patch.labels === undefined ? null : yield* labelsOf(patch.labels)
        yield* db.tx(
          Effect.gen(function* () {
            if (to !== null) yield* repo.move(d.id, to)
            if (labels !== null) yield* setLabelsOf(profile, d, labels)
            yield* docsChanged(profile, d.slug)
          }),
        )
        return yield* detailOf(yield* docOf(profile, slug))
      })

      const renameFolder = Effect.fn("Docs.renameFolder")(function* (profile: ProfileId, rawFrom: string, rawTo: string) {
        yield* profileOf(profile)
        const from = yield* folderOf(rawFrom, "from")
        const to = yield* folderOf(rawTo, "to")
        return yield* db.tx(
          Effect.gen(function* () {
            const out = renamedFolders(yield* repo.list(profile), from, to)
            if ("error" in out) return yield* new Invalid({ field: "to", reason: out.error })
            for (const m of out.moved) {
              yield* repo.move(m.doc.id, m.folder)
              yield* docsChanged(profile, m.doc.slug)
            }
            return { moved: out.moved.map((m) => m.doc.slug) }
          }),
        )
      })

      const version = Effect.fn("Docs.version")(function* (
        profile: ProfileId,
        slug: string,
        number: number | null,
        o: { readonly base_url?: string | undefined; readonly path?: string | undefined; readonly first?: boolean | undefined },
      ) {
        const d = yield* docOf(profile, slug)
        const v = yield* repo.version(d.id, number)
        if (v === null) return yield* new NotFound({ what: "version", id: String(number) })
        const base = o.base_url ?? docBase(d.profile_id, d.slug, number)
        if (!base.startsWith("/") || !base.endsWith("/") || base.startsWith("//")) {
          return yield* new Invalid({ field: "base_url", reason: "base_url is a path from / that ends in /" })
        }
        const lib = yield* render.lib
        let pages = yield* repo.pagesFull(v.id)
        const imageNames = new Map((yield* repo.imageRefs(v.id)).map((im) => [im.name, im.sha256]))
        const nav = lib.navTree(pages.map((p) => [p.path, p.title]))
        if (o.path !== undefined) {
          const raw = o.path
          const path = yield* rendered(() => lib.normalizePath(raw)).pipe(Effect.mapError((e) => new Invalid({ field: "path", reason: e.message })))
          const page = pages.find((p) => p.path === path) ?? pages.find((p) => p.path === `${path}/index`) ?? (o.first === true ? pages[0] : undefined)
          if (page === undefined) return yield* new NotFound({ what: "page", id: path })
          pages = [page]
        } else if (o.first === true) pages = pages.slice(0, 1)
        const out: RenderedDocVersion = {
          slug: d.slug,
          title: d.title,
          number: v.number,
          latest_version: d.latest_version,
          message: v.message,
          created_at: v.created_at,
          task: yield* publisherOf(v.task_id),
          base_url: base,
          nav,
          pages: pages.map((p): RenderedDocPage => {
            const shown = Result.try({
              try: () => lib.render(p.source, p.format, { pagePath: p.path, baseUrl: base }),
              // Checked when it was published, so only a renderer that changed since would get here.
              catch: renderMessage,
            })
            const page = Result.getOrNull(shown)
            return {
              path: p.path,
              title: p.title,
              format: p.format,
              url_suffix: lib.urlSuffix(p.path),
              html:
                page === null ? null : imageNames.size > 0 ? withImages(page.html, p.path, imageNames, (sha) => imageSrc(d.profile_id, sha)).html : page.html,
              toc: page?.toc ?? [],
              has_h1: page?.hasH1 ?? false,
              warnings: page?.warnings ?? [],
              error: Result.isFailure(shown) ? shown.failure : null,
            }
          }),
        }
        return out
      })

      /**
       * The task a document's comments go to: the newest version's publisher that's still there, and whether it can be
       * sent them (its project isn't archived).
       */
      const commentsTask = Effect.fnUntraced(function* (d: Doc) {
        for (const v of yield* repo.versions(d.id)) {
          const t: Task | null = v.task_id === null ? null : yield* tasks.get(v.task_id)
          if (t === null) continue
          const project = t.project_id === null ? Option.none() : yield* projects.get(t.project_id)
          return { task: t, can_send: Option.isNone(project) || project.value.archived_at === null }
        }
        return { task: null, can_send: false }
      })

      const docForAgent = Effect.fnUntraced(function* (caller: DocsCaller, slug: string) {
        const d = yield* repo.get(caller.profile, slug)
        if (d === null) return yield* new DocsRefused({ message: `no document ${quoted(slug)}; call list_documents to see what exists` })
        return d
      })
      const versionForAgent = Effect.fnUntraced(function* (d: Doc, number: number | null) {
        const v = yield* repo.version(d.id, number)
        if (v === null) return yield* new DocsRefused({ message: `document ${quoted(d.slug)} has no version ${number ?? 0}` })
        return v
      })

      return Docs.of({
        boardUrl,
        list,
        get: Effect.fn("Docs.get")(function* (profile: ProfileId, slug: string) {
          return yield* detailOf(yield* docOf(profile, slug))
        }),
        update,
        delete: Effect.fn("Docs.delete")(function* (profile: ProfileId, slug: string) {
          yield* profileOf(profile)
          const deleted = yield* db.tx(Effect.tap(repo.delete(profile, slug), (gone) => (gone ? docsChanged(profile, slug, true) : Effect.void)))
          return deleted ? undefined : yield* new NotFound({ what: "document", id: slug })
        }),
        renameFolder,
        labels: Effect.fn("Docs.labels")(function* (profile: ProfileId) {
          yield* profileOf(profile)
          return labelTree(yield* repo.list(profile))
        }),
        image: Effect.fn("Docs.image")(function* (profile: ProfileId, sha256: string) {
          yield* profileOf(profile)
          const data = /^[0-9a-f]{64}$/.test(sha256) ? yield* repo.imageData(profile, sha256) : null
          if (data === null) return yield* new NotFound({ what: "image", id: sha256 })
          return { sha256, mime: "image/avif", data: Base64.encode(data) }
        }),
        version,
        comments: Effect.fn("Docs.comments")(function* (profile: ProfileId, slug: string) {
          const d = yield* docOf(profile, slug)
          const { task, can_send } = yield* commentsTask(d)
          const out: DocComments = { comments: yield* repo.comments(d.id), task: yield* publisherOf(task?.id ?? null), can_send }
          return out
        }),
        addComment: Effect.fn("Docs.addComment")(function* (profile: ProfileId, slug: string, c: NewDocComment) {
          const d = yield* docOf(profile, slug)
          if (!(Number.isInteger(c.version) && c.version > 0)) return yield* new Invalid({ field: "version", reason: "version is a version's number" })
          const v = yield* repo.version(d.id, c.version)
          if (v === null) return yield* new NotFound({ what: "version", id: String(c.version) })
          const page = yield* repo.page(v.id, c.page)
          if (page === null) return yield* new NotFound({ what: "page", id: c.page })
          const said = {
            quote: yield* text(c.quote, "quote", MAX_QUOTE_CHARS, true),
            prefix: yield* text(c.prefix, "prefix", MAX_CONTEXT_CHARS),
            suffix: yield* text(c.suffix, "suffix", MAX_CONTEXT_CHARS),
            comment: (yield* text(c.comment, "comment", MAX_COMMENT_CHARS)).trim(),
          }
          const now = yield* nowTimestamp
          return yield* db.tx(Effect.tap(repo.addComment(d.id, v.id, page.path, said, now), () => commentsChanged(d)))
        }),
        updateComment: Effect.fn("Docs.updateComment")(function* (profile: ProfileId, slug: string, id: number, comment: string) {
          const d = yield* docOf(profile, slug)
          const said = (yield* text(comment, "comment", MAX_COMMENT_CHARS)).trim()
          const now = yield* nowTimestamp
          const out = yield* db.tx(Effect.tap(repo.editComment(d.id, id, said, now), (c) => (c === null ? Effect.void : commentsChanged(d))))
          if (out === null) return yield* new NotFound({ what: "comment", id: String(id) })
          return out
        }),
        deleteComment: Effect.fn("Docs.deleteComment")(function* (profile: ProfileId, slug: string, id: number) {
          const d = yield* docOf(profile, slug)
          const deleted = yield* db.tx(Effect.tap(repo.deleteComment(d.id, id), (gone) => (gone ? commentsChanged(d) : Effect.void)))
          return deleted ? undefined : yield* new NotFound({ what: "comment", id: String(id) })
        }),
        sendComments: Effect.fn("Docs.sendComments")(function* (profile: ProfileId, slug: string) {
          const lib = yield* render.lib
          const d = yield* docOf(profile, slug)
          const { task, can_send } = yield* commentsTask(d)
          if (task === null) {
            return yield* new Conflict({ reason: "no_task", detail: "no task that published this document is still on the board to send its comments to" })
          }
          if (!can_send) return yield* new Conflict({ reason: "archived", detail: "the task that published this document is in an archived project" })
          const unsent = (yield* repo.comments(d.id)).filter((m) => m.sent_at === null)
          if (unsent.length === 0) return yield* new Conflict({ reason: "nothing_to_send", detail: "every comment has been sent already" })
          const board = yield* boardUrl
          const message = commentsMessage(
            d,
            unsent.map((m) => ({
              version: m.version,
              page: m.page,
              quote: m.quote,
              comment: m.comment,
              url: `${board}${docBase(d.profile_id, d.slug, m.version)}${lib.urlSuffix(m.page)}`,
            })),
          )
          yield* runs.send(task.id, { text: message, source: "board" }).pipe(
            Effect.catchTags({
              TaskNotFound: () => Effect.fail(new Conflict({ reason: "no_task", detail: "the task that published this document is gone" })),
              SendRefused: (e) => Effect.fail(new Conflict({ reason: "archived", detail: e.detail })),
            }),
          )
          const now = yield* nowTimestamp
          yield* db.tx(
            Effect.andThen(
              repo.markSent(
                unsent.map((m) => m.id),
                now,
              ),
              commentsChanged(d),
            ),
          )
          const sentTo: DocPublisher = { id: task.id, title: task.title, key: task.key }
          return { sent: unsent.length, task: sentTo }
        }),

        publish: (caller, input) =>
          publishFor({ repo, db, events, render, images, projects, boardUrl, random }, caller, input).pipe(
            Effect.catchTags({ RenderError: (e) => Effect.fail(refusedBy(e)), ImageRefused: (e) => Effect.fail(refusedBy(e)) }),
          ),
        agentList: Effect.fn("Docs.agentList")(function* (caller: DocsCaller, label: string | null) {
          const lib = yield* render.lib
          const url = urlOf(lib, yield* boardUrl, caller.profile)
          const wanted = label === null || label.trim() === "" ? null : ((yield* labelsForAgent([label]))[0] ?? null)
          const all = yield* repo.list(caller.profile)
          return {
            documents: all
              .filter((d) => wanted === null || d.labels.some((l) => inLabel(l, wanted)))
              .map((d) => ({
                slug: d.slug,
                title: d.title,
                folder: d.folder,
                labels: d.labels,
                url: url(d.slug, null, "index"),
                latest_version: d.latest_version,
                pages: d.page_count,
                updated_at: d.updated_at,
              })),
          }
        }),
        agentGet: Effect.fn("Docs.agentGet")(function* (caller: DocsCaller, slug: string, number: number | null) {
          const lib = yield* render.lib
          const url = urlOf(lib, yield* boardUrl, caller.profile)
          const d = yield* docForAgent(caller, slug)
          const v = yield* versionForAgent(d, number)
          return {
            slug: d.slug,
            title: d.title,
            folder: d.folder,
            labels: d.labels,
            url: url(d.slug, null, "index"),
            version: versionJson(v),
            latest_version: d.latest_version,
            pages: (yield* repo.pages(v.id)).map((p) => ({ path: p.path, title: p.title, format: p.format, url: url(d.slug, number, p.path) })),
            images: (yield* repo.images(v.id)).map((im) => ({ name: im.name, bytes: im.bytes, width: im.width, height: im.height })),
            versions: (yield* repo.versions(d.id)).slice(0, 50).map(versionJson),
          }
        }),
        readPage: Effect.fn("Docs.readPage")(function* (caller: DocsCaller, slug: string, raw: string, number: number | null) {
          const lib = yield* render.lib
          const url = urlOf(lib, yield* boardUrl, caller.profile)
          const d = yield* docForAgent(caller, slug)
          const v = yield* versionForAgent(d, number)
          const path = yield* rendered(() => lib.normalizePath(raw)).pipe(Effect.mapError(refusedBy))
          const page = (yield* repo.page(v.id, path)) ?? (yield* repo.page(v.id, `${path}/index`))
          if (page === null) return yield* new DocsRefused({ message: `version ${v.number} has no page ${quoted(path)}` })
          return { path: page.path, title: page.title, format: page.format, version: v.number, url: url(d.slug, v.number, page.path), content: page.source }
        }),
        agentMove: Effect.fn("Docs.agentMove")(function* (caller: DocsCaller, slug: string, raw: string) {
          const lib = yield* render.lib
          const url = urlOf(lib, yield* boardUrl, caller.profile)
          const d = yield* docForAgent(caller, slug)
          const folder = yield* rendered(() => lib.normalizeFolder(raw)).pipe(Effect.mapError(refusedBy))
          yield* db.tx(Effect.andThen(repo.move(d.id, folder), docsChanged(caller.profile, d.slug)))
          return { slug: d.slug, folder, url: url(d.slug, null, "index") }
        }),
        setLabels: Effect.fn("Docs.setLabels")(function* (caller: DocsCaller, slug: string, raw: ReadonlyArray<string>) {
          const lib = yield* render.lib
          const url = urlOf(lib, yield* boardUrl, caller.profile)
          const d = yield* docForAgent(caller, slug)
          const labels = yield* labelsForAgent(raw)
          yield* db.tx(Effect.andThen(setLabelsOf(caller.profile, d, labels), docsChanged(caller.profile, d.slug)))
          return { slug: d.slug, labels: (yield* docForAgent(caller, d.slug)).labels, url: url(d.slug, null, "index") }
        }),
        feedback: Effect.fn("Docs.feedback")(function* (caller: DocsCaller, slug: string, number: number | null, since: number | null) {
          const d = yield* docForAgent(caller, slug)
          const cursor = Math.floor((yield* Clock.currentTimeMillis) / 1000)
          // Times are kept as ISO strings, which compare as the times do.
          const from = since === null ? Option.none() : DateTime.make(since * 1000)
          const after = Option.isNone(from) ? null : Timestamp.make(DateTime.formatIso(from.value))
          const comments = yield* repo.comments(d.id, { version: number, since: after })
          return {
            document: d.slug,
            latest_version: d.latest_version,
            cursor,
            responses: [],
            selections: comments.map((m) => ({
              id: m.id,
              version: m.version,
              page: m.page,
              quote: m.quote,
              comment: m.comment,
              context_before: m.prefix,
              context_after: m.suffix,
              user: "user",
              created_at: Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(m.created_at)) / 1000),
            })),
            hint: "Pass `since: cursor` next time to get only feedback that is new or changed (items may repeat within the same second).",
          }
        }),
        agentLabels: (caller) => Effect.map(repo.list(caller.profile), labelTree),
        components: Effect.map(render.lib, (lib) => lib.componentsReference()),
      })
    }),
  )
}
