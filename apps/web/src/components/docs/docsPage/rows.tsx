// The rows of a home's tree: a document's, and a folder's or label's.
import { clsx } from "clsx"
import { ChevronRight, FileText, Folder, FolderInput, Tag, Trash2 } from "lucide-react"
import type { HTMLAttributes, ReactNode } from "react"
import { Ago, IconButton } from "../../ui"
import { BoardLink, LabelChips, Publisher } from "./chrome"
import type { Row } from "./model"

/** How far each level of folders is indented, in pixels. */
const INDENT = 18

/** A document's row: its link, what's published of it, and its buttons. */
export function DocRow({
  d,
  depth,
  over,
  drag,
  to,
  editable,
  labelsEditable,
  onLabel,
  onMove,
  onRemove,
}: {
  d: Row
  depth: number
  /** The folder a dragged document is over. */
  over: string | null
  /** What makes it a row to drag, and one to drop on. */
  drag: HTMLAttributes<HTMLTableRowElement>
  to: string
  editable: boolean
  labelsEditable: boolean
  onLabel: () => void
  onMove: () => void
  onRemove: () => void
}) {
  return (
    <tr className={clsx("group border-b border-line/60 hover:bg-white/[0.02]", over === (d.folder ?? "") && "bg-accent/[0.06]")} {...drag}>
      <td className="py-2 pr-3">
        <div style={{ paddingLeft: depth * INDENT }}>
          <BoardLink to={to} className="flex min-w-0 items-center gap-2 text-fg hover:underline">
            <FileText size={14} className="shrink-0 text-muted" />
            <span className="truncate">{d.title}</span>
          </BoardLink>
          <div className="truncate pl-[22px] font-mono text-[11.5px] text-faint">
            {d.slug} · {d.page_count} page{d.page_count === 1 ? "" : "s"}
            {d.published && (
              <span className={d.published.local_version === d.latest_version ? "" : "text-amber-200/80"} aria-label="Published state">
                {" "}
                · {d.published.local_version === d.latest_version ? `published v${d.published.remote_version}` : "changed since published"}
              </span>
            )}
          </div>
          {!!d.labels?.length && <LabelChips labels={d.labels} className="mt-1 pl-[22px]" />}
        </div>
      </td>
      <td className="py-2 pr-3 text-muted narrow:hidden">v{d.latest_version}</td>
      <td className="py-2 pr-3 text-muted">
        <Ago at={d.updated_at} />
      </td>
      <td className="py-2 pr-3 narrow:hidden">
        <div className="flex min-w-0">
          <Publisher task={d.task} />
        </div>
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {labelsEditable && (
          <IconButton title={`Labels of ${d.title}`} onClick={onLabel} className="opacity-60 group-hover:opacity-100">
            <Tag size={14} />
          </IconButton>
        )}
        {editable && (
          <IconButton title={`Move ${d.title}`} onClick={onMove} className="opacity-60 group-hover:opacity-100">
            <FolderInput size={14} />
          </IconButton>
        )}
        <IconButton title={`Delete ${d.title}`} onClick={onRemove} className="opacity-60 group-hover:opacity-100">
          <Trash2 size={14} />
        </IconButton>
      </td>
    </tr>
  )
}

/** A folder's or label's row, which opens and closes what's in it. */
export function GroupRow(o: {
  kind: "Folder" | "Label"
  name: string
  title: string
  count: number
  depth: number
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  drop?: object
  /** The folder a dragged document is over. */
  over: string | null
}) {
  const { over } = o
  return (
    <tr
      aria-label={`${o.kind} ${o.title}`}
      className={clsx("group border-b border-line/60 hover:bg-white/[0.02]", o.drop && over === o.title && "bg-accent/[0.06]")}
      {...o.drop}
    >
      <td className="py-1.5 pr-3">
        <button
          type="button"
          aria-expanded={o.open}
          onClick={o.onToggle}
          style={{ paddingLeft: o.depth * INDENT }}
          className="flex max-w-full min-w-0 items-center gap-1.5 text-left text-fg"
          title={o.open ? `Close ${o.title}` : `Open ${o.title}`}
        >
          <ChevronRight size={13} className={clsx("shrink-0 text-faint transition-transform", o.open && "rotate-90")} />
          {o.kind === "Folder" ? <Folder size={14} className="shrink-0 text-muted" /> : <Tag size={13} className="shrink-0 text-muted" />}
          <span className="truncate font-medium">{o.name}</span>
          <span className="shrink-0 text-[11.5px] text-faint">{o.count}</span>
        </button>
      </td>
      {/* Cells of their own, not one across them, as the narrow layout hides some. */}
      <td className="narrow:hidden" />
      <td />
      <td className="narrow:hidden" />
      <td className="py-1.5 text-right">{o.actions}</td>
    </tr>
  )
}
