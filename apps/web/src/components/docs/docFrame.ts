// A document's page in its frame (HA-281). The pages come rendered and sanitized from their host (docs-render, see
// apps/server/src/api/docs.ts), but its sanitizer keeps remote images, which would load from wherever an agent's page
// (say, one written from a poisoned issue) points them, with what's in the page in their URLs. So pages are shown as
// plans and artifacts are: in a sandboxed frame under FRAME_CSP (frameDoc), whose links ask the board to follow them.
import readerCss from "@dire-kiwi/docs-render/styles.css?raw";
import { frameDoc } from "../task/htmlFrame";

/** The reader's colours (docs-render's variables) from the board's theme, as its root has them now. */
export function boardTheme(root: Element = document.documentElement): string {
  const style = getComputedStyle(root);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
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
  };
  const scheme = style.colorScheme && style.colorScheme !== "normal" ? style.colorScheme : "dark";
  return `color-scheme:${scheme};${Object.entries(vars)
    .map(([k, val]) => `${k}:${val}`)
    .join(";")}`;
}

/**
 * What runs in the page's frame, as source, before the board's own scripts (frameDoc's): local documents keep no
 * answers yet, so form fields are read-only and say so; links within the page scroll to their target (in a srcdoc
 * frame they'd load the board's address); and the page opens at `hash`'s target.
 */
function docPage(hash: string, note: string) {
  for (const field of document.querySelectorAll(".field")) {
    for (const c of field.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button"))
      c.disabled = true;
    const status = field.querySelector(".field-status") ?? field.appendChild(document.createElement("div"));
    status.className = "field-status ia-read-only";
    status.textContent = note;
  }
  const target = (id: string) => {
    let name = id;
    try {
      name = decodeURIComponent(id);
    } catch {
      /* as it is */
    }
    return document.getElementById(name);
  };
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = a?.getAttribute("href") ?? "";
    if (!href.startsWith("#")) return;
    e.preventDefault();
    target(href.slice(1))?.scrollIntoView();
  });
  if (hash) addEventListener("load", () => target(hash)?.scrollIntoView());
}

/** Under a read-only form field. */
export const READ_ONLY_NOTE = "Read-only: local documents don't collect answers.";

/**
 * The frame's page for a document's rendered page `html`, in the reader's styles with the board's colours (`theme`, from
 * boardTheme), opened at `hash`'s target (without its #), or else scrolled to `y` (the same page again, as a new version
 * came).
 */
export function docFrame(html: string, theme: string, hash = "", y = 0): string {
  // Inside a <script>, so nothing in them closes it.
  const arg = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  const page =
    `<!doctype html><meta charset="utf-8"><style>${readerCss}\n` +
    `html,body{margin:0}\n` +
    // Above the reader's own :scope rules (its dark set included), which the scope's proximity would otherwise put first.
    `.docs-render.docs-render{${theme};min-height:100vh;padding:28px max(24px,calc((100% - 860px)/2)) 80px}\n` +
    `.docs-render.docs-render .ia-read-only{color:var(--fg-muted);font-style:italic}\n` +
    `</style>\n<div class="docs-render"><article class="doc-content">${html}</article></div>\n` +
    `<script>(${String(docPage)})(${arg(hash)}, ${arg(READ_ONLY_NOTE)})</script>`;
  return frameDoc(page, hash ? 0 : y, 0);
}
