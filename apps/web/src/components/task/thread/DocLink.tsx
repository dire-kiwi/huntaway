import { BookOpen } from "lucide-react"
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react"
import { ProfileId } from "@huntaway/contracts"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { rpc } from "../../../state/rpc"
import { boardDocLink, docsHomes, type DocsHome } from "../../docs/docs"
import { useDocsChanged } from "../../docs/docsPage/hooks"

// A link in a message (HA-321; 6.3 brings back what M2 cut): one to a document of this board opens in the board, not a
// new window (in the desktop app, that's the browser), and a link shown as its URL shows the document's title instead.

/** A document's title by where it's kept, so that a message with the same link twice (or shown again) asks once. */
const titles = new Map<string, Promise<string | null>>()

const titleKey = (home: DocsHome, slug: string) => `${home.hostId}\n${home.profileId}\n${slug}`

function titleOf(home: DocsHome, slug: string): Promise<string | null> {
  const key = titleKey(home, slug)
  let got = titles.get(key)
  if (!got) {
    got = rpc(home.hostId, "docs.get", { profile_id: ProfileId.make(home.profileId), slug }).then(
      (d) => d.title,
      () => {
        titles.delete(key)
        return null
      },
    )
    titles.set(key, got)
  }
  return got
}

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
  const key = useBoard((s) =>
    docsHomes(s.profiles, s.hosts, route.profile)
      .homes.map((h) => `${h.hostId}\u0000${h.profileId}`)
      .join("\n"),
  )
  const homes = useMemo(
    () =>
      key === ""
        ? []
        : key.split("\n").map((h) => {
            const [hostId = "", profileId = ""] = h.split("\u0000")
            return { hostId, profileId }
          }),
    [key],
  )
  const [title, setTitle] = useState<string | null>(null)
  // A publish changes the title: it's asked again (`asked` is part of what is asked).
  const [asked, setAsked] = useState(0)
  useDocsChanged(homes, () => {
    for (const h of homes) titles.delete(titleKey(h, route.slug))
    setAsked((n) => n + 1)
  })
  const ask = useMemo(() => ({ homes, slug: route.slug, n: asked }), [homes, route.slug, asked])
  useEffect(() => {
    let live = true
    // Each home in turn: the first that has the document names it.
    void ask.homes
      .reduce<Promise<string | null>>((found, h) => found.then((t) => t ?? titleOf(h, ask.slug)), Promise.resolve(null))
      .then((t) => {
        if (live && t !== null) setTitle(t)
      })
    return () => {
      live = false
    }
  }, [ask])
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
