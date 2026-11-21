import { lazy, memo, Suspense } from "react"

// The Markdown renderer (react-markdown, micromark, GFM) is a chunk of its own, loaded the first time a text is shown,
// so the board's first load doesn't wait for it (HE-71, docs/plan/09-frontend.md, The bundle).
const MarkdownView = lazy(() => import("./MarkdownView").then((m) => ({ default: m.MarkdownView })))

/** `text` as Markdown; as plain text in the same box for the moment its renderer is loading. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="prose-chat whitespace-pre-wrap">{text}</div>}>
      <MarkdownView text={text} />
    </Suspense>
  )
})
