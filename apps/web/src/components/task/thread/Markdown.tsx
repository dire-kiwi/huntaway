import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { memo } from "react"

/**
 * The Markdown renderer (react-markdown, micromark, GFM), a chunk of its own so the board's first load doesn't wait for
 * it (HE-71, docs/plan/09-frontend.md, The bundle). The app reads this at boot, so the chunk is normally in before the
 * first text is shown. An atom rather than `React.lazy`: once it has loaded, a text is drawn in the same render,
 * where a lazy component would suspend on its first render and show its fallback for a moment anyway.
 */
export const markdownViewAtom = Atom.make(Effect.promise(() => import("./MarkdownView"))).pipe(Atom.keepAlive)

/**
 * `text` as Markdown. While the renderer is still loading, the text takes its room unseen, so the page doesn't jump
 * and the source doesn't flash. A renderer that failed to load (the network, or a build that changed under this tab)
 * leaves the text as it is, shown.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const view = useAtomValue(markdownViewAtom)
  if (AsyncResult.isSuccess(view)) return <view.value.MarkdownView text={text} />
  if (AsyncResult.isFailure(view)) return <div className="prose-chat whitespace-pre-wrap">{text}</div>
  return (
    <div className="prose-chat invisible whitespace-pre-wrap" aria-hidden>
      {text}
    </div>
  )
})
