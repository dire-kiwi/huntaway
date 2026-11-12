import { useRef, useState, type DragEvent } from "react"
import { ProfileId } from "@huntaway/contracts"
import { exitError, useMutation } from "../../../state/mutation"
import type { DocsHome, DocsView } from "../docs"
import type { Row } from "./model"

/** The type of a drag that carries one of the page's documents (its slug). */
const DOC_DRAG = "application/x-huntaway-doc"

/** Dragging a document of a home's tree onto a folder, which moves it there: the rows' handlers, and a move that failed. */
export function useDocDrag(home: DocsHome, editable: boolean, view: DocsView) {
  const [, update] = useMutation("docs.update")
  // The document being dragged, and the folder it's over.
  const dragged = useRef<Row | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)

  const drop = (folder: string) => {
    const d = dragged.current
    dragged.current = null
    setOver(null)
    if (!d || (d.folder ?? "") === folder) return
    setDropError(null)
    void update(home.hostId, { profile_id: ProfileId.make(home.profileId), slug: d.slug, patch: { folder } }).then((exit) => {
      const error = exitError(exit)
      if (error !== null) setDropError(`Couldn't move “${d.title}”: ${error}`)
    })
  }
  /** A row a dragged document can be dropped on, to move it to `folder` (in the Folders view). */
  const target = (folder: string) =>
    editable && view === "folders"
      ? {
          onDragOver: (e: DragEvent) => {
            if (!dragged.current || !e.dataTransfer.types.includes(DOC_DRAG)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            if (over !== folder) setOver(folder)
          },
          onDragLeave: (e: DragEvent) => {
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver((o) => (o === folder ? null : o))
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault()
            drop(folder)
          },
        }
      : {}
  /** A document's row, which can be dragged (in the Folders view). */
  const source = (d: Row) => ({
    draggable: editable && view === "folders",
    onDragStart: (e: DragEvent) => {
      dragged.current = d
      e.dataTransfer.setData(DOC_DRAG, d.slug)
      e.dataTransfer.effectAllowed = "move"
    },
    onDragEnd: () => {
      dragged.current = null
      setOver(null)
    },
  })

  return { over, dropError, setDropError, target, source }
}
