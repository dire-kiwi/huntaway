import { useAtomValue } from "@effect/atom-react"
import { BookOpen } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { Atom } from "effect/reactivity"
import { query } from "@huntaway/client"
import { ProfileId } from "@huntaway/contracts"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { boardDocLink, docsHomes } from "../../docs/docs"
import { resultError, resultValue } from "../../ui"

// A link in a message (HA-321; 6.3 brings back what M2 cut): one to a document of this board opens in the board, not a
// new window (in the desktop app, that's the browser), and a link shown as its URL shows the document's title instead.

/**
 * A document's title, by its slug and the homes it may be kept in (`<slug>\n<host>\0<profile>\n…`): the first home that
 * has it names it, each asked once the one before hasn't it. One `docs.get` query per home, so a message with the same
 * link twice (or shown again) asks once, and a publish (the profile's `docs` event, invalidate.ts) asks again.
 */
const titleOf = Atom.family((ask: string) =>
  Atom.make((get): string | null => {
    const [slug = "", ...homes] = ask.split("\n")
    for (const home of homes) {
      const [hostId = "", profileId = ""] = home.split("\u0000")
      if (hostId === "") continue
      const result = get(query("docs.get", hostId, { profile_id: ProfileId.make(profileId), slug }))
      const doc = resultValue(result)
      if (doc !== undefined) return doc.title
      // Still being read: the next home waits for it.
      if (resultError(result) === null) return null
    }
    return null
  }),
)

/** The text a link shows, if it's plain text. */
function plainText(children: ReactNode): string | null {
  const parts = Array.isArray(children) ? children : [children]
  return parts.every((c) => typeof c === "string") ? parts.join("") : null
}

export function DocLink({ href, children, ...rest }: ComponentProps<"a">) {
  const link = boardDocLink(href)
  if (!link)
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  return (
    <BoardDocLink {...rest} link={link}>
      {children}
    </BoardDocLink>
  )
}

function BoardDocLink({ link, children, ...rest }: Omit<ComponentProps<"a">, "href"> & { link: NonNullable<ReturnType<typeof boardDocLink>> }) {
  const { route, path } = link
  // Where the document is kept: the first of its profile's hosts that has it.
  const homes = useBoard((s) =>
    docsHomes(s.profiles, s.hosts, route.profile)
      .homes.map((h) => `${h.hostId}\u0000${h.profileId}`)
      .join("\n"),
  )
  const title = useAtomValue(titleOf(homes === "" ? route.slug : `${route.slug}\n${homes}`))
  // Words the agent wrote for the link stay; its URL (what an autolink shows) is replaced.
  const text = plainText(children)
  const showsUrl = text === null ? false : /^(https?:\/\/|www\.|\/docs\/)\S+$/.test(text.trim())
  return (
    <a
      {...rest}
      href={path}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(path)
      }}
    >
      {showsUrl ? (
        <>
          <BookOpen size={12} className="mr-1 inline align-[-1px]" />
          {title ?? route.slug}
        </>
      ) : (
        children
      )}
    </a>
  )
}
