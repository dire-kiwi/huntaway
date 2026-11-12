import type { Mermaid } from "mermaid"
import { errorText } from "../ui"

let loaded: Promise<Mermaid> | null = null
let renders = 0

// Shared by standalone diagrams and plans; load the bundled library only when a diagram needs it.
const load = () =>
  (loaded ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" })
    return m.default
  }))

export function renderMermaid(source: string): Promise<string> {
  return load().then((mermaid) => {
    const id = `ia-mermaid-${++renders}`
    return mermaid
      .render(id, source)
      .then((drawn) => asXml(drawn.svg))
      .finally(() => {
        // Mermaid can leave these behind after a failed render.
        document.getElementById(id)?.remove()
        document.getElementById(`d${id}`)?.remove()
      })
  })
}

/** Mermaid writes labels' HTML as HTML (`<br>` for a line break, `&nbsp;`), which isn't XML, so an image of
 *  the SVG wouldn't load. Read it as HTML and write it out again as XML. */
export function asXml(svg: string): string {
  const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg")
  return root ? new XMLSerializer().serializeToString(root) : svg
}

// Display SVGs as images, so they can't execute scripts even if something gets past Mermaid's sanitizer.
export const diagramImage = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** The width a Mermaid SVG is drawn at, from its viewBox. */
export const svgWidth = (svg: string) => Number(/viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)/.exec(svg)?.[1]) || null

/** Bake a plan's diagrams into its download, so it can be read without the board or a network connection. */
export function withPlanDiagrams(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html")
  // Each rendered as it comes (Mermaid renders one at a time of its own accord).
  const each = [...doc.querySelectorAll("ia-diagram > pre")].map((pre) => {
    const host = pre.parentElement
    if (!host) return Promise.resolve()
    return renderMermaid(pre.textContent ?? "").then(
      (svg) => {
        const img = doc.createElement("img")
        img.alt = host.getAttribute("title") || "Diagram"
        img.src = diagramImage(svg)
        img.style.width = "100%"
        const width = svgWidth(svg)
        if (width) img.style.maxWidth = `${width}px`
        host.replaceChildren(img)
      },
      (e: unknown) => {
        const error = doc.createElement("div")
        error.className = "ia-diagram-error"
        error.textContent = `Mermaid: ${errorText(e)}`
        // Nest the source so the exported page's component script doesn't ask the board to retry it.
        pre.replaceWith(error)
        error.append(pre)
      },
    )
  })
  return Promise.all(each).then(() => `<!doctype html>\n${doc.documentElement.outerHTML}`)
}
