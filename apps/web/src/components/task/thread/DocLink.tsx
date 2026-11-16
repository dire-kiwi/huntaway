import { BookOpen } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { navigate } from "../../../state/route"
import { boardDocLink } from "./docLinks"
import type { DocPath } from "./docLinks"

// A link in a message (HA-321; 6.3 brings back what M2 cut): one to a document of this board opens in the board (the
// docs plugin's page, HE-42), not a new window (in the desktop app, that's the browser), and a link shown as its URL
// shows the document's slug instead.

/** The text a link shows, if it's plain text. */
function plainText(children: ReactNode): string | null {
  const parts = Array.isArray(children) ? children : [children]
  return parts.every((c) => typeof c === "string") ? parts.join("") : null
}

export function DocLink({ href, children, ...rest }: ComponentProps<"a">) {
  const doc = boardDocLink(href)
  if (!doc)
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  return (
    <BoardDocLink {...rest} doc={doc}>
      {children}
    </BoardDocLink>
  )
}

function BoardDocLink({ doc, children, ...rest }: Omit<ComponentProps<"a">, "href"> & { doc: DocPath }) {
  // Words the agent wrote for the link stay; its URL (what an autolink shows) is replaced.
  const text = plainText(children)
  const showsUrl = text === null ? false : /^(https?:\/\/|www\.|\/docs\/)\S+$/.test(text.trim())
  return (
    <a
      {...rest}
      href={doc.path}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(doc.path)
      }}
    >
      {showsUrl ? (
        <>
          <BookOpen size={12} className="mr-1 inline align-[-1px]" />
          {doc.slug}
          {doc.version !== null ? ` (v${doc.version})` : ""}
        </>
      ) : (
        children
      )}
    </a>
  )
}
