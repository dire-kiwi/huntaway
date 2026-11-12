// A host's profile's documents in the Docs page's table, as a tree.
import { Pencil, X } from "lucide-react"
import { useMemo, type ReactNode } from "react"
import { docTree, folderPaths, labelTree, type DocFolder, type DocLabel, type DocsHome, type DocsView } from "../docs"
import { IconButton } from "../../ui"
import type { Row } from "./model"
import { DocRow, GroupRow } from "./rows"
import { TreeDialogs } from "./TreeDialogs"
import { useClosed } from "./useClosed"
import { useDocDrag } from "./useDocDrag"
import { useTreeDialogs } from "./useTreeDialogs"

/**
 * A host's profile's documents in the Docs page's table, as a tree of their folders, or of their labels (HA-324: a
 * document under each of its labels, those with none under Unlabelled), which close and open as the user left them.
 */
export function HomeTree({
  home,
  rows,
  view,
  label,
  editable,
  labelsEditable,
  docLink,
  onRemove,
  onChanged,
}: {
  home: DocsHome
  rows: Row[]
  view: DocsView
  /** Its host's name, where the page shows several. */
  label?: string | undefined
  /** Whether its host can move documents and rename folders (API 130). */
  editable: boolean
  /** Whether its host can label documents (API 145). */
  labelsEditable: boolean
  docLink: (d: Row) => string
  onRemove: (d: Row) => void
  onChanged: () => void
}) {
  const tree = useMemo(() => docTree(rows), [rows])
  const folders = useMemo(() => folderPaths(tree), [tree])
  const labels = useMemo(() => labelTree(rows), [rows])
  const { closed, remember, toggle } = useClosed(home, "folders")
  const closedLabels = useClosed(home, "labels")
  const dialogs = useTreeDialogs()
  const { setMoving, setLabelling, setRenaming } = dialogs
  const { over, dropError, setDropError, target, source } = useDocDrag(home, editable, view, onChanged)

  // `within`: the label it's shown under, in the Labels view, where a document can be in several places.
  const docRow = (d: Row, depth: number, within = "") => (
    <DocRow
      key={`d\n${within}\n${d.slug}`}
      d={d}
      depth={depth}
      over={over}
      drag={{ ...source(d), ...target(d.folder ?? "") }}
      to={docLink(d)}
      editable={editable}
      labelsEditable={labelsEditable}
      onLabel={() => setLabelling(d)}
      onMove={() => setMoving(d)}
      onRemove={() => onRemove(d)}
    />
  )

  /** A folder's or label's row, which opens and closes what's in it. */
  const groupRow = ({ key, ...o }: { key: string } & Omit<Parameters<typeof GroupRow>[0], "over">) => <GroupRow key={key} {...o} over={over} />

  const folderRows = (f: DocFolder<Row>, depth: number): ReactNode[] => [
    ...f.folders.flatMap((sub) => {
      const open = !closed.has(sub.path)
      return [
        groupRow({
          kind: "Folder",
          key: `f\n${sub.path}`,
          name: sub.name,
          title: sub.path,
          count: sub.count,
          depth,
          open,
          onToggle: () => toggle(sub.path),
          drop: target(sub.path),
          actions: editable && (
            <IconButton title={`Rename ${sub.path}`} onClick={() => setRenaming(sub.path)} className="opacity-60 group-hover:opacity-100">
              <Pencil size={13} />
            </IconButton>
          ),
        }),
        ...(open ? folderRows(sub, depth + 1) : []),
      ]
    }),
    ...f.docs.map((d) => docRow(d, depth)),
  ]

  // Labels match whatever their case, so a closed one is kept by its lowercase path; "" is Unlabelled.
  const labelOpen = (path: string) => !closedLabels.closed.has(path.toLowerCase())
  const labelRows = (l: DocLabel<Row>, depth: number): ReactNode[] => [
    ...l.labels.flatMap((sub) => {
      const open = labelOpen(sub.path)
      return [
        groupRow({
          kind: "Label",
          key: `l\n${sub.path}`,
          name: sub.name,
          title: sub.path,
          count: sub.count,
          depth,
          open,
          onToggle: () => closedLabels.toggle(sub.path.toLowerCase()),
        }),
        ...(open ? labelRows(sub, depth + 1) : []),
      ]
    }),
    ...l.docs.map((d) => docRow(d, depth, l.path)),
  ]
  const unlabelledRows = (): ReactNode[] => {
    if (!labels.unlabelled.length) return []
    const open = labelOpen("")
    const group = groupRow({
      kind: "Label",
      key: "u",
      name: "Unlabelled",
      title: "Unlabelled",
      count: labels.unlabelled.length,
      depth: 0,
      open,
      onToggle: () => closedLabels.toggle(""),
    })
    return [group, ...(open ? labels.unlabelled.map((d) => docRow(d, 1, "\n")) : [])]
  }

  return (
    <tbody aria-label={label ? `Documents on ${label}` : undefined}>
      {label && (
        <tr className="border-b border-line" {...target("")}>
          <td colSpan={5} className="pt-4 pb-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
            {label}
          </td>
        </tr>
      )}
      {dropError && (
        <tr>
          <td colSpan={5} className="py-1.5">
            <div role="alert" className="flex items-center gap-2 rounded bg-red-500/10 px-2 py-1 text-[12px] text-red-300">
              <span className="min-w-0 flex-1">{dropError}</span>
              <IconButton title="Dismiss" onClick={() => setDropError(null)}>
                <X size={13} />
              </IconButton>
            </div>
          </td>
        </tr>
      )}
      {view === "labels" ? [...labelRows(labels.root, 0), ...unlabelledRows()] : folderRows(tree, 0)}
      <TreeDialogs dialogs={dialogs} home={home} folders={folders} labels={labels.root} closed={closed} remember={remember} onChanged={onChanged} />
    </tbody>
  )
}
