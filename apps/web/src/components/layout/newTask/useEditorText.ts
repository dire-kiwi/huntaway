import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { completionAt, findTokens } from "../taskTokens"
import type { Draft } from "./draft"

export type EditorText = ReturnType<typeof useEditorText>

/** The description as it's typed, tokens and all: where its caret is, the token being typed and those found in it. */
export function useEditorText(saved: Draft | null) {
  const [description, setDescription] = useState(saved?.description ?? "")

  // The token being typed, to suggest values for: unless Escape closed the list for it, or the editor isn't focused.
  const input = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(description.length)
  const [focused, setFocused] = useState(true)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const typing = focused ? completionAt(description, caret) : null
  const completing = typing && typing.start !== closedAt ? typing : null
  const found = useMemo(() => findTokens(description), [description])

  // Where the caret goes once a change to the text is drawn: at first, after a draft that comes back.
  const caretTo = useRef<number | null>(description.length)
  const edit = (next: string, at: number) => {
    setDescription(next)
    setCaret(at)
    setClosedAt(null)
    caretTo.current = at
  }
  useLayoutEffect(() => {
    if (caretTo.current === null || !input.current) return
    input.current.focus()
    input.current.setSelectionRange(caretTo.current, caretTo.current)
    caretTo.current = null
  })

  return { description, setDescription, input, caret, setCaret, focused, setFocused, setClosedAt, completing, found, edit }
}
