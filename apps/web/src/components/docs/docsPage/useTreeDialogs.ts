import { useState } from "react"
import type { Row } from "./model"

/** Which of a home's tree's dialogs is open: the document being moved or labelled, the folder being renamed. */
export function useTreeDialogs() {
  const [moving, setMoving] = useState<Row | null>(null)
  const [labelling, setLabelling] = useState<Row | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  return { moving, setMoving, labelling, setLabelling, renaming, setRenaming }
}
