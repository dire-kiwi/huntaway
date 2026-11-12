import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { errorText } from "../../state/mutation"

// An error's message, for showing: state/mutation.ts's.
export { errorText }

/**
 * A field's draft of `value`: it follows `value` until it's edited (and again once the edit is put back), so a refresh
 * from the server doesn't overwrite what's being typed. With `hold` (while the field is focused, say) it doesn't follow
 * even unedited. `dirty` is whether the draft differs from the value it was edited from.
 */
export function useDraft<T>(value: T, hold = false) {
  const [draft, setDraft] = useState(value)
  const [base, setBase] = useState(value)
  if (!Object.is(value, base) && !hold) {
    setBase(value)
    if (Object.is(draft, base)) setDraft(value)
  }
  return { draft, setDraft, dirty: !Object.is(draft, base) }
}

/**
 * Closes a popover on a press outside it or Escape, while it's `open`: put the returned ref on the element that holds
 * both the popover and the button that opens it, so a press on the button isn't one outside.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const root = useRef<T>(null)
  const latest = useRef(close)
  useLayoutEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) latest.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault() // so it doesn't close the task panel, or leave a subagent's thread, as well
      latest.current()
    }
    document.addEventListener("mousedown", onDown)
    // In the capture phase, ahead of the thread's own Escape on the document (registered before the popover opened).
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])
  return root
}
