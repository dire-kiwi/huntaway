// The guide (docs/guide/*.md) shown in the app: its pages, their headings, and where their links go. A link out of the
// guide goes to the file in this repository on GitHub; one to the old repository's files is written out in full.

/** The guide's pages in order, with the names the app lists them under. */
export const GUIDE_PAGES = [
  { page: "board", title: "Using the board" },
  { page: "concepts", title: "Concepts" },
  { page: "agents", title: "Agents" },
  { page: "github", title: "Pull requests and checks" },
  { page: "integrations", title: "Asana and automations" },
  { page: "workflows", title: "Workflows" },
  { page: "assistant", title: "The personal assistant" },
  { page: "server", title: "Running a server" },
  { page: "hosts", title: "Hosts" },
  { page: "desktop", title: "The desktop app and releases" },
  { page: "switching", title: "Switching from the old server" },
  { page: "mobile", title: "Phones" },
] as const

/** Where the guide's links to the rest of the repository (READMEs, design notes) go. */
export const REPO_URL = "https://github.com/dire-kiwi/huntaway-effect/blob/main/"

export const isGuidePage = (page: string): boolean => GUIDE_PAGES.some((p) => p.page === page)

/** A heading's anchor, as GitHub makes it: lower case, punctuation dropped, spaces as dashes. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

/** The page's `##` headings (not those in code blocks), for its table of contents. */
export function headings(markdown: string): { text: string; id: string }[] {
  const out: { text: string; id: string }[] = []
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    // As it reads: without the marks of code, emphasis and links.
    const text = (m[1] ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .trim()
    out.push({ text, id: slug(text) })
  }
  return out
}

export type GuideLink = { kind: "page"; page: string; hash?: string } | { kind: "external"; url: string }

/**
 * Where a link on guide page `page` goes: another place in the guide (`workflows.md#column`, `#telegram`), or a page
 * outside the app (a web address, or a file of the repository on GitHub, `../threads.md`).
 */
export function guideLink(href: string, page: string): GuideLink {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "external", url: href }
  const [path, hash] = splitHash(href)
  if (!path) return { kind: "page", page, ...(hash && { hash }) }
  const file = resolve(`docs/guide/${page}.md`, path)
  const m = /^docs\/guide\/([^/]+)\.md$/.exec(file)
  if (m?.[1] !== undefined && isGuidePage(m[1])) return { kind: "page", page: m[1], ...(hash && { hash }) }
  return { kind: "external", url: REPO_URL + file + (hash ? `#${hash}` : "") }
}

function splitHash(href: string): [string, string | undefined] {
  const i = href.indexOf("#")
  return i < 0 ? [href, undefined] : [href.slice(0, i), href.slice(i + 1) || undefined]
}

/** `path` relative to file `from`, both from the top of the repository. */
function resolve(from: string, path: string): string {
  const parts = path.startsWith("/") ? [] : from.split("/").slice(0, -1)
  for (const part of path.split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return parts.join("/")
}

/** The guide page that inline code names as a file (`hosts.md`, `docs/guide/hosts.md`), so it can link there. */
export function namedPage(code: string): string | null {
  const m = /^(?:docs\/guide\/)?([a-z]+)\.md$/.exec(code.trim())
  return m?.[1] !== undefined && isGuidePage(m[1]) ? m[1] : null
}

const loaders = import.meta.glob<string>("../../../docs/guide/*.md", { query: "?raw", import: "default" })

/** Page `page`'s markdown, or null for a page the guide doesn't have. Each page is a chunk of its own, loaded when it's opened. */
export function loadGuidePage(page: string): Promise<string | null> {
  const load = isGuidePage(page) ? loaders[`../../../docs/guide/${page}.md`] : undefined
  return load ? load() : Promise.resolve(null)
}
