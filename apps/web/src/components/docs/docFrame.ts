// A document's page in its frame (HA-281). The pages come rendered and sanitized from their host (docs-render, see
// apps/server/src/api/docs.ts), but its sanitizer keeps remote images, which would load from wherever an agent's page
// (say, one written from a poisoned issue) points them, with what's in the page in their URLs. So pages are shown as
// plans and artifacts are: in a sandboxed frame under FRAME_CSP (frameDoc), whose links ask the board to follow them.
import readerCss from "@dire-kiwi/docs-render/styles.css?raw"
import { frameDoc } from "../task/htmlFrame"
import { toJson } from "../ui/json"

/** The reader's colours (docs-render's variables) from the board's theme, as its root has them now. */
export function boardTheme(root: Element = document.documentElement): string {
  const style = getComputedStyle(root)
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const vars: Record<string, string> = {
    "--bg": v("--color-bg", "#0b0b0e"),
    "--bg-soft": v("--color-panel-2", "#16161d"),
    "--fg": v("--color-fg", "#e6e6ec"),
    "--fg-muted": v("--color-muted", "#9a9aab"),
    "--border": v("--color-line-strong", "#33333f"),
    "--accent": v("--color-accent", "#7c7cf8"),
    "--accent-fg": "#ffffff",
    "--bg-mark": "color-mix(in srgb, var(--accent) 30%, transparent)",
    "--success": v("--color-st-done", "#34d399"),
    "--warning": v("--color-st-attention", "#f59e0b"),
    "--danger": "#fca5a5",
    "--font": v("--font-sans", "ui-sans-serif, system-ui, sans-serif"),
    "--mono": v("--font-mono", "ui-monospace, monospace"),
  }
  const scheme = style.colorScheme && style.colorScheme !== "normal" ? style.colorScheme : "dark"
  return `color-scheme:${scheme};${Object.entries(vars)
    .map(([k, val]) => `${k}:${val}`)
    .join(";")}`
}

/**
 * What runs in the page's frame, as source, before the board's own scripts (frameDoc's): local documents keep no
 * answers yet, so form fields are read-only and say so; links within the page scroll to their target (in a srcdoc
 * frame they'd load the board's address); and the page opens at `hash`'s target.
 */
function docPage(hash: string, note: string) {
  for (const field of document.querySelectorAll(".field")) {
    for (const c of field.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button"))
      c.disabled = true
    const status = field.querySelector(".field-status") ?? field.appendChild(document.createElement("div"))
    status.className = "field-status ia-read-only"
    status.textContent = note
  }
  const root = document
  const target = (id: string) => {
    let name = id
    try {
      name = decodeURIComponent(id)
    } catch {
      /* as it is */
    }
    return root.getElementById(name)
  }
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null
    const href = a?.getAttribute("href") ?? ""
    if (!href.startsWith("#")) return
    e.preventDefault()
    target(href.slice(1))?.scrollIntoView()
  })
  if (hash) addEventListener("load", () => target(hash)?.scrollIntoView())
}

/**
 * Comments (HA-302), in the page's frame, as the hosted site's reader has them (its selection.ts and quote.ts): selecting
 * text in the page offers a "Comment" button, which sends the board the quote with up to 64 characters of the page's
 * text either side (`{iaComment: {quote, prefix, suffix}}`). The board sends the page's comments (`{iaComments: [{id,
 * quote, prefix, suffix}], enabled, draft}`), which are highlighted where they can still be found, and answered with the
 * ids of those that were (`{iaFound}`); `{iaScrollTo: id}` scrolls to one, and a click on one tells the board
 * (`{iaFocus: id}`). Commenting is off until the board says it's `enabled` (a host that keeps comments).
 */
function docComments(label: string) {
  const article = document.querySelector("article.doc-content")
  if (!article) return
  const CONTEXT = 64
  type Index = { text: string; nodes: { node: Text; start: number }[] }
  const indexText = (): Index => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("textarea, select, .field-status") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    const nodes: Index["nodes"] = []
    let text = ""
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n instanceof Text)) continue
      nodes.push({ node: n, start: text.length })
      text += n.data
    }
    return { text, nodes }
  }
  const offsetOf = (index: Index, container: Node, offset: number) => {
    const before = document.createRange()
    before.setStart(article, 0)
    before.setEnd(container, offset)
    for (const { node, start } of index.nodes) {
      if (node === container) return start + offset
      if (!before.intersectsNode(node)) return start
    }
    return index.text.length
  }
  const rangeFor = (index: Index, start: number, end: number) => {
    const locate = (pos: number, preferNext: boolean): [Text, number] | null => {
      for (let i = 0; i < index.nodes.length; i++) {
        const entry = index.nodes[i]
        if (entry === undefined) continue
        const { node, start: s } = entry
        const e = s + node.data.length
        if ((pos < e || (pos === e && !preferNext) || i === index.nodes.length - 1) && pos >= s) return [node, Math.min(pos - s, node.data.length)]
      }
      return null
    }
    const a = locate(start, true)
    const b = locate(end, false)
    if (!a || !b) return null
    const range = document.createRange()
    range.setStart(a[0], a[1])
    range.setEnd(b[0], b[1])
    return range
  }
  // The occurrence of the quote whose surroundings best match its context.
  const find = (index: Index, q: { quote: string; prefix: string; suffix: string }) => {
    const { text } = index
    let [best, score] = [-1, -1]
    for (let i = q.quote ? text.indexOf(q.quote) : -1; i !== -1; i = text.indexOf(q.quote, i + 1)) {
      // How much of the context matches: before the quote from its end, after it from its start.
      const pre = text.slice(Math.max(0, i - q.prefix.length), i)
      const post = text.slice(i + q.quote.length, i + q.quote.length + q.suffix.length)
      let sc = 0
      while (sc < pre.length && sc < q.prefix.length && pre[pre.length - 1 - sc] === q.prefix[q.prefix.length - 1 - sc]) sc++
      let after = 0
      while (after < post.length && after < q.suffix.length && post[after] === q.suffix[after]) after++
      sc += after
      if (sc > score) [best, score] = [i, sc]
    }
    return best < 0 ? null : rangeFor(index, best, best + q.quote.length)
  }

  const button = document.createElement("button")
  button.type = "button"
  button.className = "ia-comment-button"
  button.textContent = label
  button.hidden = true
  document.body.append(button)
  let enabled = false
  let pending: { quote: string; prefix: string; suffix: string; range: Range } | null = null
  let ranges = new Map<number, Range>()
  // The CSS Custom Highlight API, where the browser has it.
  const highlights = typeof CSS === "undefined" ? undefined : CSS.highlights
  const mark = (name: string, rs: Range[]) => {
    if (highlights && typeof Highlight !== "undefined") highlights.set(name, new Highlight(...rs))
  }

  const current = () => {
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!article.contains(range.commonAncestorContainer)) return null
    const index = indexText()
    let start = offsetOf(index, range.startContainer, range.startOffset)
    let end = offsetOf(index, range.endContainer, range.endOffset)
    while (start < end && /\s/.test(index.text[start] ?? "")) start++
    while (end > start && /\s/.test(index.text[end - 1] ?? "")) end--
    if (end <= start) return null
    return {
      quote: index.text.slice(start, end),
      prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
      suffix: index.text.slice(end, end + CONTEXT),
      range: range.cloneRange(),
    }
  }
  // Offers the button under what's selected, if anything is.
  const offer = () => {
    pending = enabled ? current() : null
    button.hidden = !pending
    if (!pending) return
    const rect = pending.range.getBoundingClientRect()
    const width = button.offsetWidth || 100
    button.style.left = `${Math.max(8, Math.min(rect.left + scrollX, scrollX + document.documentElement.clientWidth - width - 8))}px`
    button.style.top = `${rect.bottom + scrollY + 6}px`
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer)
    timer = setTimeout(offer, 120)
  })
  // Pressing it keeps the selection.
  button.addEventListener("mousedown", (e) => e.preventDefault())
  button.addEventListener("click", () => {
    if (!pending) return
    const { quote, prefix, suffix, range } = pending
    parent.postMessage({ iaComment: { quote, prefix, suffix } }, "*")
    // The board highlights it as the comment's draft from here.
    mark("ia-comment-draft", [range])
    getSelection()?.removeAllRanges()
    pending = null
    button.hidden = true
  })

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return
    const d = e.data
    if (Array.isArray(d.iaComments)) {
      const was = enabled
      enabled = d.enabled === true
      // Text selected before the board said it could be commented on.
      if (enabled !== was) offer()
      const index = indexText()
      ranges = new Map()
      for (const c of d.iaComments) {
        const r = find(index, c)
        if (r) ranges.set(c.id, r)
      }
      mark("ia-comment", [...ranges.values()])
      const draft = d.draft ? find(index, d.draft) : null
      mark("ia-comment-draft", draft ? [draft] : [])
      const chosen = d.active == null ? undefined : ranges.get(d.active)
      mark("ia-comment-active", chosen ? [chosen] : [])
      parent.postMessage({ iaFound: [...ranges.keys()] }, "*")
    }
    if (typeof d.iaScrollTo === "number") {
      const r = ranges.get(d.iaScrollTo)
      if (!r) return
      mark("ia-comment-active", [r])
      ;(r.startContainer.parentElement ?? article).scrollIntoView({ behavior: "smooth", block: "center" })
    }
  })
  // A click on a highlighted quote (not the end of a selection) opens its comment.
  article.addEventListener("click", (e) => {
    const sel = getSelection()
    if (!ranges.size || (sel && !sel.isCollapsed) || !(e instanceof MouseEvent)) return
    const at = document.caretPositionFromPoint?.(e.clientX, e.clientY)
    if (!at) return
    const [node, offset] = [at.offsetNode, at.offset]
    for (const [id, r] of ranges) {
      if (r.isPointInRange(node, offset)) {
        mark("ia-comment-active", [r])
        parent.postMessage({ iaFocus: id }, "*")
        return
      }
    }
  })
}

/** A string as a script's argument: inside a <script>, so nothing in it closes it. */
const arg = (s: string) => toJson(s).replace(/</g, "\\u003c")

/** The page's button that comments on what's selected. */
export const COMMENT_LABEL = "Comment"

/** Under a read-only form field. */
export const READ_ONLY_NOTE = "Read-only: local documents don't collect answers."

/**
 * The frame's page for a document's rendered page `html`, in the reader's styles with the board's colours (`theme`, from
 * boardTheme), opened at `hash`'s target (without its #), or else scrolled to `y` (the same page again, as a new version
 * came).
 */
export function docFrame(html: string, theme: string, hash = "", y = 0): string {
  const page =
    `<!doctype html><meta charset="utf-8"><style>${readerCss}\n` +
    `html,body{margin:0}\n` +
    // Above the reader's own :scope rules (its dark set included), which the scope's proximity would otherwise put first.
    `.docs-render.docs-render{${theme};min-height:100vh;padding:28px max(24px,calc((100% - 860px)/2)) 80px}\n` +
    `.docs-render.docs-render .ia-read-only{color:var(--fg-muted);font-style:italic}\n` +
    `::highlight(ia-comment){background-color:color-mix(in srgb, #f59e0b 28%, transparent)}\n` +
    `::highlight(ia-comment-active){background-color:color-mix(in srgb, #f59e0b 55%, transparent)}\n` +
    `::highlight(ia-comment-draft){background-color:color-mix(in srgb, #7c7cf8 40%, transparent)}\n` +
    `.ia-comment-button{position:absolute;z-index:10;display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;` +
    `border:1px solid #33333f;background:#1c1c25;color:#e6e6ec;font:500 12.5px ui-sans-serif,system-ui,sans-serif;cursor:pointer;` +
    `box-shadow:0 4px 14px rgba(0,0,0,.35)}\n.ia-comment-button:hover{background:#26263a}\n.ia-comment-button[hidden]{display:none}\n` +
    `</style>\n<div class="docs-render"><article class="doc-content">${html}</article></div>\n` +
    `<script>(${String(docPage)})(${arg(hash)}, ${arg(READ_ONLY_NOTE)});(${String(docComments)})(${arg(COMMENT_LABEL)})</script>`
  return frameDoc(page, hash ? 0 : y, 0)
}
