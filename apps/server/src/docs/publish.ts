import { Effect, Option, Schema } from "effect"
import type { SecureRandom } from "effect/crypto"
import { DocFormat, DocId } from "@huntaway/contracts"
import type { ProfileId, RunId, Task } from "@huntaway/contracts"
import type { Db } from "../platform/Db.ts"
import type { Events } from "../platform/Events.ts"
import { nowTimestamp } from "../platform/columns.ts"
import type { ProjectRepo } from "../projects/ProjectRepo.ts"
import type { DocImages, ImageRefused, NewDocImage } from "./DocImages.ts"
import type { DocPage, DocRepo, NewDocPage } from "./DocRepo.ts"
import { RenderError, rendered } from "./DocsRender.ts"
import type { DocsRender, RenderLib } from "./DocsRender.ts"
import { docBase, docSlug, normalizeLabels, quoted, spelt } from "./docRules.ts"
import { withImages } from "./imageRules.ts"
import type { GivenImage } from "./imageRules.ts"

// `publish_document` (huntaway's mcp/docs_mcp.ts `publish_document` and db/docs.ts `publish_doc`): `Docs.publish`'s
// body. The pages are checked as the hosted server checks them (docs-render's `validatePages`), once their inline
// images have been taken out (image data doesn't count toward a page's size); the images are converted only after
// that, as it's the slow part; then one transaction makes the version (and the document, if it's new).

/** Who publishes: the profile its documents belong to, the task and run that publish. */
export interface DocsCaller {
  readonly profile: ProfileId
  readonly task: Task
  /** Null for the demo's document, which no run published. */
  readonly run: RunId | null
}

/** `publish_document`'s arguments, their types checked. */
export interface PublishInput {
  readonly slug: string | null
  readonly title: string | null
  readonly message: string | null
  readonly mode: string
  /** Given: used as it is (normalised); null: the task's project's name. */
  readonly folder: string | null
  readonly delete_paths: ReadonlyArray<string>
  /** The document's labels from now on, or null to keep its own. */
  readonly labels: ReadonlyArray<string> | null
  /** As given: `validatePages` checks them. */
  readonly pages: ReadonlyArray<unknown>
  readonly images: ReadonlyArray<GivenImage>
}

/** What `publish_document` answers. */
export interface Published {
  readonly slug: string
  readonly folder: string
  readonly labels: ReadonlyArray<string>
  readonly note: string | null
  readonly version: number
  readonly url: string
  readonly version_url: string
  readonly pages: ReadonlyArray<{ readonly path: string; readonly title: string; readonly url: string }>
  readonly images: ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly width: number; readonly height: number }>
  readonly warnings: ReadonlyArray<{ readonly page: string; readonly warning: string }>
}

/** What a publish needs of the docs area. */
export interface PublishDeps {
  readonly repo: DocRepo["Service"]
  readonly db: Db["Service"]
  readonly events: Events["Service"]
  readonly render: DocsRender["Service"]
  readonly images: DocImages["Service"]
  readonly projects: ProjectRepo["Service"]
  readonly boardUrl: Effect.Effect<string>
  readonly random: SecureRandom.SecureRandom["Service"]
}

const Content = Schema.Struct({ content: Schema.String })

/** What `validatePages` gives. */
const Validated = Schema.Struct({
  pages: Schema.Array(Schema.Struct({ path: Schema.String, format: DocFormat, title: Schema.String, position: Schema.Int })),
  warnings: Schema.Array(Schema.Struct({ page: Schema.String, warning: Schema.String })),
})
const contentOf = (page: unknown): string => Option.match(Schema.decodeUnknownOption(Content)(page), { onNone: () => "", onSome: (p) => p.content })

/** A page rendered (its HTML), or null if it can't be. */
const htmlOf = (lib: RenderLib, p: { readonly path: string; readonly format: DocFormat; readonly source: string }): string | null => {
  try {
    return lib.render(p.source, p.format, { pagePath: p.path, baseUrl: "/" }).html
  } catch {
    return null
  }
}

/** Which of the image `names` the `pages` show (for a merge, which keeps those of the previous version's). */
const referenced = (lib: RenderLib, pages: ReadonlyArray<DocPage>, names: ReadonlyArray<string>): ReadonlySet<string> => {
  const map = new Map(names.map((n) => [n, n]))
  const out = new Set<string>()
  for (const p of pages) {
    const html = htmlOf(lib, p)
    if (html !== null)
      withImages(html, p.path, map, (name) => {
        out.add(name)
        return ""
      })
  }
  return out
}

/** Warnings for the images `pages` show that the version doesn't have (relative srcs: remote ones aren't shown anyway). */
const missingImages = (lib: RenderLib, pages: ReadonlyArray<NewDocPage>, have: ReadonlyArray<{ readonly name: string; readonly sha256: string }>) => {
  const names = new Map(have.map((im) => [im.name, im.sha256]))
  return pages.flatMap((p) => {
    const html = htmlOf(lib, p)
    if (html === null) return []
    return withImages(html, p.path, names, () => "").missing.map((src) => ({
      page: p.path,
      warning: `image ${quoted(src)} isn't one of this version's images; pass it in \`images\``,
    }))
  })
}

const refused = (message: string) => new RenderError({ message })

/** The folder a new document goes in without a `folder`: its task's project's name (the top level for none). */
const defaultFolder = Effect.fnUntraced(function* (deps: PublishDeps, lib: RenderLib, task: Task) {
  if (task.project_id === null) return ""
  const project = yield* deps.projects.get(task.project_id)
  if (Option.isNone(project)) return ""
  const name = project.value.name
  return Option.getOrElse(Option.liftThrowable(() => lib.normalizeFolder(name))(), () => "")
})

export const publishFor = Effect.fnUntraced(function* (
  deps: PublishDeps,
  caller: DocsCaller,
  input: PublishInput,
): Effect.fn.Return<Published, RenderError | ImageRefused> {
  const { repo, db, events } = deps
  const lib = yield* deps.render.lib
  const normalised = input.labels === null ? null : normalizeLabels(input.labels)
  if (normalised !== null && "error" in normalised) return yield* refused(normalised.error)
  const labels = normalised === null ? null : normalised.labels
  if (input.mode !== "replace" && input.mode !== "merge") return yield* refused(`mode must be "replace" or "merge", not ${quoted(input.mode)}`)
  if (input.pages.length === 0 && input.delete_paths.length === 0) return yield* refused("pass at least one page")
  const given = input.folder
  const folder = given === null ? yield* defaultFolder(deps, lib, caller.task) : yield* rendered(() => lib.normalizeFolder(given))
  // The images given, and those inline in the pages, which are checked without them.
  const taken = yield* deps.images.take(input.pages, input.images)
  const pagesIn = taken.pages
  // The pages go to the renderer as the agent gave them: it checks them, with the hosted server's messages.
  const checked = yield* rendered((): unknown => Reflect.apply(lib.validatePages, undefined, [pagesIn])).pipe(
    Effect.flatMap((out) => Effect.mapError(Schema.decodeUnknownEffect(Validated)(out), (e) => new RenderError({ message: e.message }))),
    // The renderer reads the pages with serde_json::from_str ("invalid pages: … at line 1 column 9"); the hosted server
    // reads them with the rest of the arguments ("invalid arguments: …", with no position).
    Effect.mapError((e) =>
      e.message.startsWith("invalid pages: ") ? refused(`invalid arguments: ${e.message.slice(15).replace(/ at line \d+ column \d+$/, "")}`) : e,
    ),
  )
  // validatePages gives the pages in the order they came, without their sources.
  const pages: ReadonlyArray<NewDocPage> = checked.pages.map((p, i) => ({
    path: p.path,
    title: p.title,
    format: p.format,
    position: p.position,
    source: contentOf(pagesIn[i]),
  }))
  const converted: ReadonlyArray<NewDocImage> = yield* deps.images.convert(taken.images)
  const wanted = input.slug === null ? null : docSlug(input.slug)
  const existing = wanted === null ? null : yield* repo.get(caller.profile, wanted)
  // A new document's title is its index page's (or its first page's), unless it's given.
  const newTitle = existing !== null ? null : ((pages.find((p) => p.path === "index") ?? pages[0])?.title ?? null)
  const deleted = new Set(input.delete_paths.flatMap((p) => Option.toArray(Option.liftThrowable(() => lib.normalizePath(p))())))
  const now = yield* nowTimestamp
  const docId = DocId.make(yield* deps.random.uuidV4())
  const versionId = yield* deps.random.uuidV4()

  const made = yield* db.tx(
    Effect.gen(function* () {
      const found = wanted === null ? null : yield* repo.get(caller.profile, wanted)
      let doc = found
      if (found !== null) {
        const title = input.title ?? newTitle
        if (title !== null) yield* repo.setTitle(found.id, title)
      } else {
        const title = input.title ?? newTitle ?? "Untitled"
        const base = wanted ?? docSlug(title)
        let slug = base
        for (let n = 2; (yield* repo.get(caller.profile, slug)) !== null; n++) slug = `${base}-${n}`
        yield* repo.insertDoc({ id: docId, profile_id: caller.profile, slug, title, folder, now })
        doc = yield* repo.get(caller.profile, slug)
      }
      if (doc === null) return yield* Effect.die(new Error("a document just made isn't there"))
      const prev = yield* repo.version(doc.id, null)
      const number = prev === null ? 1 : prev.number + 1
      yield* repo.insertVersion({ id: versionId, doc: doc.id, number, message: input.message, task_id: caller.task.id, run_id: caller.run, now })
      for (const page of pages) yield* repo.insertPage(versionId, page)
      const merge = input.mode === "merge" && prev !== null
      if (merge) {
        // The previous version's other pages carry over.
        const paths = new Set(pages.map((p) => p.path))
        for (const old of yield* repo.pagesFull(prev.id)) {
          if (paths.has(old.path) || deleted.has(old.path)) continue
          yield* repo.insertPage(versionId, old)
        }
      }
      if ((yield* repo.pageCount(versionId)) === 0) return yield* refused("a version needs at least one page")
      for (const im of converted) yield* repo.addImage(caller.profile, versionId, im, now)
      if (merge) {
        const names = new Set(converted.map((im) => im.name))
        const old = (yield* repo.imageRefs(prev.id)).filter((im) => !names.has(im.name))
        const keep =
          old.length > 0
            ? referenced(
                lib,
                yield* repo.pagesFull(versionId),
                old.map((im) => im.name),
              )
            : new Set<string>()
        for (const im of old) if (keep.has(im.name)) yield* repo.nameImage(versionId, im.name, im.sha256)
      }
      if (labels !== null) {
        const known = yield* repo.knownLabels(caller.profile)
        yield* repo.replaceLabels(doc.id, spelt(known, labels))
      }
      yield* repo.touch(doc.id, now)
      yield* events.emit({ type: "docs", profile_id: caller.profile, slug: doc.slug })
      return { slug: doc.slug, number }
    }),
  )

  const board = yield* deps.boardUrl
  const url = (slug: string, number: number | null, path: string) => `${board}${docBase(caller.profile, slug, number)}${lib.urlSuffix(path)}`
  const d = yield* repo.get(caller.profile, made.slug)
  const v = d === null ? null : yield* repo.version(d.id, made.number)
  if (d === null || v === null) return yield* Effect.die(new Error("a version just published isn't there"))
  const versionImages = yield* repo.images(v.id)
  // An existing document stays where it is, so a publish doesn't undo the user's move.
  const note =
    given !== null && d.folder !== folder ? `The document stays in its folder ${quoted(d.folder)}; call move_document only if the user asks to move it.` : null
  return {
    slug: made.slug,
    folder: d.folder,
    labels: d.labels,
    note,
    version: made.number,
    url: url(made.slug, null, "index"),
    version_url: url(made.slug, made.number, "index"),
    pages: (yield* repo.pages(v.id)).map((p) => ({ path: p.path, title: p.title, url: url(made.slug, null, p.path) })),
    images: versionImages.map((im) => ({ name: im.name, bytes: im.bytes, width: im.width, height: im.height })),
    warnings: [...checked.warnings, ...missingImages(lib, pages, versionImages)],
  }
})
