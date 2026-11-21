import type { MouseEvent, ReactNode } from "react"
import { href } from "../../router"
import { navigate } from "../../state/route"

// What other pages need of the guide, apart from the guide itself (Guide.tsx, a chunk of its own with its Markdown).

/** Scrolls to the heading with id `hash` on the page, or to the top without one. */
export function scrollToHeading(hash: string | undefined, root: HTMLElement | null): void {
  const el = hash ? document.getElementById(decodeURIComponent(hash)) : null
  if (el) el.scrollIntoView({ block: "start" })
  else if (root) root.scrollTop = 0
}

/** Goes to `page`'s heading `hash` in the app: the URL changes as for any page, so Back comes back. */
export function openGuide(e: MouseEvent, page: string, hash: string | undefined, current: string, root: HTMLElement | null): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  const url = href({ name: "guide", page }) + (hash ? `#${hash}` : "")
  if (page === current) {
    window.history.pushState(null, "", url)
    scrollToHeading(hash, root)
  } else navigate(url)
}

/** A link to a page of the guide, or a heading on it (`slug` of its text), that opens in the app. */
export function GuideLink({ page, hash, children }: { page: string; hash?: string | undefined; children: ReactNode }) {
  return (
    <a
      href={href({ name: "guide", page }) + (hash ? `#${hash}` : "")}
      onClick={(e) => openGuide(e, page, hash, "", null)}
      className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {children}
    </a>
  )
}
