import { Schema } from "effect"
import { Tool } from "effect/ai"
import { HTML_PREVIEW_TOOL, HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_MAX_TITLE, HTML_RENDER_PAGE_RULES, HTML_RENDER_TOOL } from "@huntaway/shared"
import { BoardContent, ForPlanning, Rerunnable } from "../mcp/tool.ts"

// HE-78: the board's tools for agents' HTML pages in the thread (docs/plan/07-agents.md, HTML pages in the thread), on
// its own server (`huntaway`), after T3 Code's html_render and html_preview. Both only show: they change nothing of the
// task's, so a thread in plan mode has them. Neither is a reviewer's.

/** The largest page taken, in characters; a page with its images put in must also fit an attachment (10 MiB). */
export const MAX_PAGE_CHARS = 2_000_000

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PAGE_CHARS)).annotate({
  description: "A complete, self-contained HTML page.",
})

export const HtmlPreview = Tool.make(HTML_PREVIEW_TOOL, {
  description:
    "Load an HTML page in the board's headless browser as the thread would show it, and get back a screenshot (PNG), the " +
    "page's height at that width (the frame's), and its console: logs, warnings, errors, uncaught exceptions and what the " +
    "page's policy refused to load. console.log is a fine way to report your own checks. Use it to check a page and iterate " +
    "on it before html_render. The first preview on a host may download the browser, which takes a minute. " +
    HTML_RENDER_PAGE_RULES,
  parameters: Schema.Struct({
    html: Html,
    width: Schema.optionalKey(
      Schema.Int.annotate({
        description: `The width in CSS pixels, 240 to 1600; ${HTML_RENDER_COLUMN_WIDTH} (the reply column) unless given. About 360 shows a phone.`,
      }),
    ),
  }),
  success: BoardContent,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

export const HtmlRender = Tool.make(HTML_RENDER_TOOL, {
  description:
    "Show a finished HTML page (a chart, table, diagram, collage of screenshots, mockup) in your thread, where the user reads " +
    "your reply: the board keeps the page and shows it in place of this call, as wide as the reply column and as tall as the " +
    "page. Use it when a page says something better than text; check it with html_preview first. The user already sees the " +
    "page, so your reply shouldn't announce it, say where it is or repeat it: add only what the page doesn't say. Its scripts " +
    "run in a sandbox, away from the board; links open in a new tab. " +
    HTML_RENDER_PAGE_RULES,
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(HTML_RENDER_MAX_TITLE)).annotate({
      description: "A short name for the page (its file name, and what the full-screen view says).",
    }),
    html: Html,
    height: Schema.optionalKey(
      Schema.Int.annotate({
        description: "The page's height in CSS pixels, from html_preview: the frame's until the page has loaded and said its own.",
      }),
    ),
  }),
  success: BoardContent,
}).annotate(ForPlanning, true)
