// HE-78: agents' HTML pages in the thread, as T3 Code shows them (its html_render and html_preview tools). An agent
// writes a self-contained page and calls the board's `html_render`, which keeps it as an attachment; the thread shows it
// in place of the call, in a sandboxed frame as tall as the page, in the board's theme. `html_preview` loads a page in
// the host's headless Chrome as the board would show it, and answers with a screenshot, the page's height and its
// console. What both sides share is here: the page's theme and base styles, and the checks of what it may use.

export const HTML_RENDER_TOOL = "html_render"
export const HTML_PREVIEW_TOOL = "html_preview"

/** The reply column's width on a desktop's thread, about: what a preview is taken at unless told. */
export const HTML_RENDER_COLUMN_WIDTH = 760
/** The frame's height while the page hasn't said its own, and the least it gets. */
export const HTML_RENDER_MIN_HEIGHT = 40
/**
 * The most a frame grows to fit its page. Only a page that grows with its frame gets there, since viewport units are
 * refused (`viewportHeightUnit`).
 */
export const HTML_RENDER_MAX_HEIGHT = 20_000
export const HTML_RENDER_MAX_TITLE = 200

/** The page's file name, from its title (as attachments keep it: letters, digits, `.`, `-` and `_`). */
export const htmlRenderFileName = (title: string): string => {
  const base = title
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 80)
  return `${base === "" ? "page" : base}.html`
}

/** Where a page is kept, as `html_render`'s answer names it: `attachments/<id>/<name>.html`. */
const KEPT = /attachments[/\\]+([0-9A-Fa-f]{32})[/\\]+([A-Za-z0-9._-]+\.html)\b/

/** The attachment an `html_render` call's answer says it kept the page as. */
export const htmlRenderAttachment = (answer: string): { readonly id: string; readonly name: string } | null => {
  const m = KEPT.exec(answer)
  return m === null || m[1] === undefined || m[2] === undefined ? null : { id: m[1], name: m[2] }
}

/**
 * The theme a page gets, as CSS custom properties on :root: the board's colours (the dark theme, and the profile's tint
 * where the board has one), with the names an <ia-html> in a plan has, so an agent learns one set.
 */
export const HTML_RENDER_THEME: Readonly<Record<string, string>> = {
  "--bg": "#0b0b0e",
  "--panel": "#111116",
  "--panel-2": "#16161d",
  "--raised": "#1c1c25",
  "--line": "#24242e",
  "--line-strong": "#33333f",
  "--fg": "#e6e6ec",
  "--heading": "#f4f4f8",
  "--muted": "#9a9aab",
  "--faint": "#6b6b7b",
  "--accent": "#7c7cf8",
  "--accent-bg": "#1d1d3c",
  "--ok": "#6fd49a",
  "--ok-bg": "#173527",
  "--warn": "#f2c46b",
  "--warn-bg": "#3a2e14",
  "--danger": "#ff8f97",
  "--danger-bg": "#3d1c20",
  "--info": "#8fb8f5",
  "--info-bg": "#1b2a45",
  "--chart-1": "#7c7cf8",
  "--chart-2": "#2dd4bf",
  "--chart-3": "#fbbf24",
  "--chart-4": "#f472b6",
  "--chart-5": "#a3e635",
  "--chart-6": "#60a5fa",
  "--radius": "8px",
  "--font-sans": '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
}

/**
 * The styles a page starts with, before its own (which win): the theme's variables, the page on the thread's own
 * background in the board's type, no margin on the body, which holds what's in it (its margins and what's positioned
 * absolutely: the frame is sized to the body), and no scrollbar of its own.
 */
export const htmlRenderStyle = (theme: Readonly<Record<string, string>> = HTML_RENDER_THEME): string => {
  const vars = Object.entries(theme)
    .filter(([k]) => /^--[a-z0-9-]+$/.test(k))
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, "")};`)
    .join("")
  return (
    `:root{color-scheme:dark;${vars}}` +
    "html{background:transparent;color:var(--fg);font:14px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
    "html::-webkit-scrollbar{display:none}" +
    "body{margin:0;position:relative;display:flow-root}" +
    "code,kbd,pre,samp{font-family:var(--font-mono)}"
  )
}

/** The page as its frame loads it, after the policy and the board's own scripts: the theme first, then the page. */
export const htmlRenderPage = (html: string, theme?: Readonly<Record<string, string>>): string =>
  `<meta name="viewport" content="width=device-width, initial-scale=1"><style id="ia-theme">${htmlRenderStyle(theme)}</style>\n${html}`

// Only stylesheets and style attributes are looked at, so text that mentions a unit passes; comments match first so
// what's in them is skipped. An unclosed comment, tag or quote runs to the end, which keeps both patterns linear.
const CSS_SOURCE = /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi
// The lookbehind skips base64, such as an inlined image that happens to hold "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i

/**
 * A viewport height unit the page's CSS uses (`100vh`), if any. The frame grows to fit the page, so a size that
 * follows the viewport makes it grow again and again: the tools refuse such a page.
 */
export const viewportHeightUnit = (html: string): string | null => {
  for (const [, sheet, double, single, bare] of html.matchAll(CSS_SOURCE)) {
    const found = VIEWPORT_HEIGHT_UNIT.exec(sheet ?? double ?? single ?? bare ?? "")?.[0]
    if (found !== undefined) return found
  }
  return null
}

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

const EXTENSIONS = Object.keys(IMAGE_TYPES).join("|")
const LOCAL_IMAGE = new RegExp(
  String.raw`(["'\x60])(/(?!/)(?:(?!\1)[^\r\n]){0,2048}?\.(?:${EXTENSIONS}))\1` + String.raw`|url\(\s*(/(?!/)[^\s"'\x60()]{0,2048}?\.(?:${EXTENSIONS}))\s*\)`,
  "gid",
)

/** A local image a page names by its absolute path, in a quoted string or a CSS `url()`: where the path is in the page. */
export interface LocalImage {
  readonly start: number
  readonly end: number
  readonly path: string
}

/** The local images a page names by absolute path (`src="/tmp/shot.png"`, `url(/x/bg.webp)`, a script's string). */
export const localImages = (html: string): ReadonlyArray<LocalImage> =>
  Array.from(html.matchAll(LOCAL_IMAGE)).flatMap((m) => {
    const span = m.indices?.[2] ?? m.indices?.[3]
    return span === undefined ? [] : [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }]
  })

/** The type an image's data URI says, by its path's extension. */
export const imageType = (path: string): string => IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"

/** `html` with each of `images` (from `localImages`) whose path `uris` has swapped for its data URI. */
export const inlineImages = (html: string, images: ReadonlyArray<LocalImage>, uris: ReadonlyMap<string, string>): string => {
  const parts: Array<string> = []
  let at = 0
  for (const image of images) {
    const uri = uris.get(image.path)
    if (uri === undefined) continue
    parts.push(html.slice(at, image.start), uri)
    at = image.end
  }
  parts.push(html.slice(at))
  return parts.join("")
}

const latin1 = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/**
 * Whether a file's bytes are an image, whatever it's called, so a renamed file or a link can't carry anything else (a
 * key, say) into a page.
 */
export const isImageBytes = (bytes: Uint8Array): boolean => {
  const head = latin1(bytes, 0, 12)
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  )
    return true
  // An SVG: its root element, after any XML declaration, comments and doctype.
  const text = latin1(bytes, 0, 4096)
  const rest = text.replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>[]*(?:\[[\s\S]*?\])?\s*>)*/i, "")
  return /^<svg[\s/>]/.test(rest)
}

/** What the tools tell agents a page may use, and how it's shown (in both tools' descriptions). */
export const HTML_RENDER_PAGE_RULES =
  "Write one self-contained page, with its CSS in <style> and its scripts in <script>. Local images named by absolute path " +
  '(src="/abs/shot.png", CSS url(/abs/bg.webp), or a string in a script) are put into the page when it is kept, so it keeps ' +
  "working after the files go. Nothing else from outside loads (no remote images, requests or frames) except scripts, styles " +
  "and fonts from cdnjs, jsDelivr, unpkg and Google Fonts. The board sets its theme as CSS custom properties on :root: " +
  "--bg (the thread's background), --panel, --panel-2, --raised, --line, --line-strong, --fg, --heading, --muted, --faint, " +
  "--accent (with --accent-bg), --ok, --warn, --danger and --info (each with its -bg, a tinted background), --chart-1 to " +
  "--chart-6 (series colours for charts), --radius, --font-sans and --font-mono; the base style sets the page's colour and font " +
  "from them and the body's margin to 0. The page sits on the thread's own background, as part of your reply: leave html and " +
  "body without a background, use a fluid width with no outer padding, card, border or title banner; give a box with a " +
  "background of its own at least 16px of padding and var(--radius) corners. The frame is as wide as the reply column (about " +
  `${HTML_RENDER_COLUMN_WIDTH}px on a desktop, 360px on a phone) and grows to fit the page, so let the content set the height: ` +
  "give charts fixed pixel heights, don't use vh, svh, lvh or dvh units (the tools refuse them) or height:100% on html or body."
