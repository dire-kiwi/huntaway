import { clsx } from "clsx"
import { ExternalLink } from "lucide-react"
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { GUIDE_PAGES, guideLink, headings, isGuidePage, loadGuidePage, namedPage, REPO_URL, slug } from "../../guide"
import { href } from "../../router"
import { navigate } from "../../state/route"
import { MenuButton } from "../ui"

/** A heading's text, for its anchor. */
function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : ""))
    .join("")
}

/** Scrolls to the heading with id `hash` on the page, or to the top without one. */
function scrollTo(hash: string | undefined, root: HTMLElement | null): void {
  const el = hash ? document.getElementById(decodeURIComponent(hash)) : null
  if (el) el.scrollIntoView({ block: "start" })
  else if (root) root.scrollTop = 0
}

/** Goes to `page`'s heading `hash` in the app: the URL changes as for any page, so Back comes back. */
function open(e: MouseEvent, page: string, hash: string | undefined, current: string, root: HTMLElement | null): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  const url = href({ name: "guide", page }) + (hash ? `#${hash}` : "")
  if (page === current) {
    window.history.pushState(null, "", url)
    scrollTo(hash, root)
  } else navigate(url)
}

/** The open page, and the element it scrolls in: what the page's links need. */
const PageContext = createContext<{ page: string; root: RefObject<HTMLElement | null> }>({ page: "", root: { current: null } })

/** A heading, with its anchor. */
function heading(Tag: "h1" | "h2" | "h3" | "h4"): (props: { children?: ReactNode }) => ReactNode {
  return function Heading({ children }) {
    return (
      <Tag id={slug(textOf(children))} className="scroll-mt-4">
        {children}
      </Tag>
    )
  }
}

/** A link: to another place in the guide, opened in the app, or out of it. */
function GuideAnchor({ href: to, children }: { href?: string | undefined; children?: ReactNode }) {
  const { page, root } = useContext(PageContext)
  if (!to) return <a>{children}</a>
  const link = guideLink(to, page)
  if (link.kind === "external")
    return (
      <a href={link.url} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  return (
    <a href={href({ name: "guide", page: link.page }) + (link.hash ? `#${link.hash}` : "")} onClick={(e) => open(e, link.page, link.hash, page, root.current)}>
      {children}
    </a>
  )
}

/** Code; `hosts.md` in the text names another page: a link to it. */
function GuideCode({ children, className }: { children?: ReactNode; className?: string | undefined }) {
  const { page, root } = useContext(PageContext)
  const named = !className && typeof children === "string" ? namedPage(children) : null
  if (!named) return <code className={className}>{children}</code>
  return (
    <a href={href({ name: "guide", page: named })} onClick={(e) => open(e, named, undefined, page, root.current)}>
      <code>{children}</code>
    </a>
  )
}

const components: Components = {
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  a: ({ href: to, children }) => <GuideAnchor href={to}>{children}</GuideAnchor>,
  code: ({ children, className }) => <GuideCode className={className}>{children}</GuideCode>,
  // A picture is a link to it rather than loaded, as in threads (the guide has none of its own).
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">
      {alt || String(src)}
    </a>
  ),
}

/** The guide (docs/guide), a page at a time, with its pages and the open page's sections beside it. */
export function Guide({ page: wanted }: { page?: string | undefined }) {
  const page = wanted ?? GUIDE_PAGES[0].page
  const [text, setText] = useState<{ page: string; markdown: string | null } | null>(null)
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    const req = { live: true }
    loadGuidePage(page).then(
      (markdown) => {
        if (req.live) setText({ page, markdown })
      },
      () => {
        if (req.live) setText({ page, markdown: null })
      },
    )
    return () => {
      req.live = false
    }
  }, [page])

  const loaded = text?.page === page ? text.markdown : undefined
  // Once the page is in, to the heading the link named (`/guide/workflows#column`).
  useEffect(() => {
    if (loaded != null) scrollTo(window.location.hash.slice(1) || undefined, main.current)
  }, [loaded])
  // Back and Forward between headings of the same page.
  useEffect(() => {
    const back = (): void => scrollTo(window.location.hash.slice(1) || undefined, main.current)
    window.addEventListener("popstate", back)
    return () => window.removeEventListener("popstate", back)
  }, [])

  const sections = useMemo(() => (loaded ? headings(loaded) : []), [loaded])
  const pageContext = useMemo(() => ({ page, root: main }), [page])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="text-[14px] font-semibold">Guide</h1>
        <select
          aria-label="Guide page"
          className="no-drag hidden min-w-0 rounded-md border border-line bg-panel px-2 py-1 text-[12px] narrow:block"
          value={page}
          onChange={(e) => navigate({ name: "guide", page: e.target.value })}
        >
          {GUIDE_PAGES.map((p) => (
            <option key={p.page} value={p.page}>
              {p.title}
            </option>
          ))}
        </select>
        <a
          href={`${REPO_URL}docs/guide/${page}.md`}
          target="_blank"
          rel="noreferrer"
          className="no-drag ml-auto flex shrink-0 items-center gap-1 text-[12px] whitespace-nowrap text-muted hover:text-fg"
          title="This page on GitHub"
        >
          <span className="narrow:hidden">On GitHub</span> <ExternalLink size={12} />
        </a>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Guide pages" className="w-60 shrink-0 overflow-y-auto border-r border-line p-2 narrow:hidden">
          {GUIDE_PAGES.map((p) => (
            <div key={p.page}>
              <a
                href={href({ name: "guide", page: p.page })}
                onClick={(e) => open(e, p.page, undefined, page, main.current)}
                aria-current={p.page === page ? "page" : undefined}
                className={clsx("block rounded-md px-2 py-1 text-[13px]", p.page === page ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {p.title}
              </a>
              {p.page === page && sections.length > 0 && (
                <div className="my-1 ml-2 border-l border-line pl-2">
                  {sections.map((s) => (
                    <a
                      key={s.id}
                      href={`${href({ name: "guide", page })}#${s.id}`}
                      onClick={(e) => open(e, page, s.id, page, main.current)}
                      className="block truncate rounded px-2 py-0.5 text-[12px] text-faint hover:text-fg"
                      title={s.text}
                    >
                      {s.text}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <main ref={main} className="min-w-0 flex-1 overflow-y-auto px-8 py-6 narrow:px-4">
          {!isGuidePage(page) || loaded === null ? (
            <p className="text-[13px] text-muted">The guide has no page “{page}”.</p>
          ) : loaded === undefined ? null : (
            <div className="mx-auto max-w-4xl">
              <div className="prose-chat">
                <PageContext value={pageContext}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                    {loaded}
                  </ReactMarkdown>
                </PageContext>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

/** A link to a page of the guide, or a heading on it (`slug` of its text), that opens in the app. */
export function GuideLink({ page, hash, children }: { page: string; hash?: string | undefined; children: ReactNode }) {
  return (
    <a
      href={href({ name: "guide", page }) + (hash ? `#${hash}` : "")}
      onClick={(e) => open(e, page, hash, "", null)}
      className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {children}
    </a>
  )
}
