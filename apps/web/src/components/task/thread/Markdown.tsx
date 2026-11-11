import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { remarkTaskRefs, TASK_REF_TAG } from "./taskRefs"
import { DocLink } from "./DocLink"
import { TaskRef } from "./TaskRef"

// An image is a link to it rather than loaded: an agent's `![](https://…/?k=<secret>)` would send the secret out as
// soon as the text was shown, with nothing to approve (the phone doesn't load them either).
const imageLink = ({ src, alt }: { src?: unknown; alt?: string | undefined }) => {
  const href = typeof src === "string" ? src : undefined
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {alt || href}
    </a>
  )
}

const plugins = [remarkGfm, remarkTaskRefs]
const components: Components = Object.assign(
  {
    // Links to the board's documents open in it and show their title (HA-321, see DocLink.tsx); others open a new tab.
    a: DocLink,
    img: imageLink,
  },
  // Task keys open their task in the side panel (see taskRefs.ts): an element of the plugin's own, which `Components`
  // does not name.
  { [TASK_REF_TAG]: TaskRef },
)

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
