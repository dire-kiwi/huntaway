import type { ComponentProps } from "react"

/**
 * A link in a message. The old board opened a link to one of its own documents in the board, showing the document's
 * title (HA-321); the board's documents come with the docs area (M6), so until then every link opens in a new tab.
 */
export function DocLink({ href, children, ...rest }: ComponentProps<"a">) {
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}
