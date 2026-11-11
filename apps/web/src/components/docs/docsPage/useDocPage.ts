import { useCallback, useEffect, useRef, useState } from "react"
import { ProfileId, type RenderedDocVersion } from "@huntaway/contracts"
import { withDocImages } from "../docs"
import { isTagged, rpc } from "../../../state/rpc"
import { errorText } from "../../ui"

/** The version of the document that's shown, with the page of it the route names: loaded when either changes. */
export function useDocPage({
  hostId,
  profileId,
  slug,
  version,
  page,
  base,
}: {
  hostId: string | undefined
  profileId: string | undefined
  slug: string
  version: number | undefined
  page: string
  base: string
}) {
  const [shown, setShown] = useState<RenderedDocVersion | null>(null)
  const [error, setError] = useState<{ text: string; missingPage?: boolean; missingVersion?: boolean } | null>(null)
  const seq = useRef(0)

  const loadPage = useCallback(() => {
    if (!hostId || !profileId) return
    const n = ++seq.current
    // A document without an index page opens at its first page.
    rpc(hostId, "docs.version", {
      profile_id: ProfileId.make(profileId),
      slug,
      version: version ?? null,
      path: page,
      first: page === "",
      base_url: base,
    })
      // Its images, which the page's frame can't fetch itself.
      .then(async (r) => {
        const [first] = r.pages
        const withImages =
          first === undefined || first.html === null ? first : Object.assign({}, first, { html: await withDocImages(first.html, hostId, profileId) })
        return { ...r, pages: withImages === undefined ? [] : [withImages] }
      })
      .then(
        (r) => {
          if (n !== seq.current) return
          setShown(r)
          setError(null)
        },
        (e: unknown) => {
          if (n !== seq.current) return
          const missing = isTagged(e, "NotFound") && "what" in e && typeof e.what === "string" ? e.what : undefined
          // A version that isn't there isn't a page that isn't.
          if (missing === "version") return setError({ text: `Version ${version} not found.`, missingVersion: true })
          const which = version === undefined ? "This document" : `Version ${version} of this document`
          setError({
            text: missing !== undefined ? `${which} has no page “${page || "index"}”.` : errorText(e),
            missingPage: missing !== undefined && page !== "",
          })
        },
      )
  }, [hostId, profileId, slug, version, page, base])
  useEffect(loadPage, [loadPage])

  return { shown, error, loadPage }
}
