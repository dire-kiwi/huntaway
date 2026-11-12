// What the Docs page reads (6.3, step 2): one query per host, and what the page makes of several hosts' answers, as
// derived atoms. They're read again by the queries' own rules: a mutation of `docs.*` on the host, and its `docs`,
// `doc_comments` and `docs_site` events (packages/client's invalidate.ts).
import { AsyncResult, Atom } from "effect/reactivity"
import { ProfileId, type DocDetail, type RenderedDocVersion } from "@huntaway/contracts"
import { query } from "@huntaway/client"
import { failureOf, isTagged } from "../../../state/mutation"
import { resultError, resultValue } from "../../ui"
import { docImageShas, withDocImages, type DocsHome } from "../docs"
import type { Row } from "./model"

/** Nothing to read (yet): what a reader with no host to ask reads in place of a query. */
export const idle: Atom.Atom<AsyncResult.AsyncResult<never>> = Atom.make(AsyncResult.initial())

/** A result's value if it has answered and not failed since: undefined while it's first read, or once it failed. */
const answer = <A>(r: AsyncResult.AsyncResult<A, unknown>): A | undefined => (resultError(r) === null ? resultValue(r) : undefined)

/** Whether a result is still to answer for the first time. */
const pending = (r: AsyncResult.AsyncResult<unknown, unknown>): boolean => resultError(r) === null && resultValue(r) === undefined

/** Every document of the homes' (null until each host has answered), and why a host's couldn't be read. */
export interface DocsRows {
  readonly rows: Row[] | null
  readonly error: string | null
}

/** The documents of `homes`, each with the host's profile it's kept by. */
export const docsListAtom = Atom.family((homes: ReadonlyArray<DocsHome>) =>
  Atom.make((get): DocsRows => {
    const got = homes.map((h) => ({ h, r: get(query("docs.list", h.hostId, { profile_id: ProfileId.make(h.profileId) })) }))
    if (got.some(({ r }) => pending(r))) return { rows: null, error: null }
    const failed = got.map(({ r }) => resultError(r)).find((e) => e !== null)
    return {
      error: failed ?? null,
      rows: got.flatMap(({ h, r }) => (answer(r) ?? []).map((d): Row => Object.assign({}, d, h))),
    }
  }),
)

/** A document's host, of those the route's profile stands for: the first that has it, or why none could say. */
export interface Found {
  readonly home?: DocsHome | undefined
  readonly detail?: DocDetail | undefined
  readonly missing: boolean
  readonly error?: string | undefined
}

export const docHomeAtom = Atom.family(({ homes, slug }: { readonly homes: ReadonlyArray<DocsHome>; readonly slug: string }) =>
  Atom.make((get): Found => {
    const got = homes.map((h) => get(query("docs.get", h.hostId, { profile_id: ProfileId.make(h.profileId), slug })))
    if (got.some(pending)) return { missing: false }
    const i = got.findIndex((r) => answer(r) !== undefined)
    const detail = got[i] === undefined ? undefined : answer(got[i])
    if (detail !== undefined) return { home: homes[i], detail, missing: false }
    // Not found on any of them, or a host that couldn't say.
    const other = got.find((r) => resultError(r) !== null && !isTagged(failureOf(r), "NotFound"))
    return { missing: other === undefined, error: other === undefined ? undefined : (resultError(other) ?? undefined) }
  }),
)

/** Which version's page is read: the latest's (`version` undefined), or a numbered one's. */
export interface PageKey {
  readonly hostId: string | undefined
  readonly profileId: string | undefined
  readonly slug: string
  readonly version: number | undefined
  readonly page: string
  readonly base: string
}

/** The page as it's shown (its images as data: URLs), or why it couldn't be read; neither while it's read. */
export interface PageRead {
  readonly shown?: RenderedDocVersion | undefined
  /** What reading it failed with. */
  readonly failure?: unknown
}

/** An image as the frame shows it (its host gives AVIF). */
const imageUrl = (im: { readonly mime: string; readonly data: string }) => `data:${im.mime === "image/avif" ? im.mime : "image/avif"};base64,${im.data}`

/** A version's page with its images, which the page's frame can't fetch itself: shown once they've all answered. */
export const docPageAtom = Atom.family(({ hostId, profileId, slug, version, page, base }: PageKey) =>
  Atom.make((get): PageRead => {
    if (hostId === undefined || profileId === undefined) return {}
    const profile_id = ProfileId.make(profileId)
    // A document without an index page opens at its first page.
    const r = get(query("docs.version", hostId, { profile_id, slug, version: version ?? null, path: page, first: page === "", base_url: base }))
    if (resultError(r) !== null) return { failure: failureOf(r) }
    const read = resultValue(r)
    if (read === undefined) return {}
    const [first] = read.pages
    if (first === undefined || first.html === null) return { shown: { ...read, pages: first === undefined ? [] : [first] } }
    const shas = docImageShas(first.html)
    const images = shas.map((sha256) => get(query("docs.image", hostId, { profile_id, sha256 })))
    if (images.some(pending)) return {}
    // One that couldn't be read loses its `src`.
    const urls = new Map(
      shas.map((sha, i): [string, string | null] => {
        const im = images[i] === undefined ? undefined : answer(images[i])
        return [sha, im === undefined ? null : imageUrl(im)]
      }),
    )
    return { shown: { ...read, pages: [{ ...first, html: withDocImages(first.html, urls) }] } }
  }),
)
