import { clsx } from "clsx"
import { Folder } from "lucide-react"
import type { DocNavNode } from "@huntaway/contracts"

/** The document's menu (docs-render's navTree): pages, and folders of them, the open one marked. */
export function NavTree({
  nodes,
  current,
  onOpen,
  depth = 0,
}: {
  nodes: ReadonlyArray<DocNavNode>
  current?: string | undefined
  onOpen: (path: string) => void
  depth?: number | undefined
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.segment}>
          <button
            type="button"
            disabled={n.page === null}
            aria-current={n.page !== null && n.page === current ? "page" : undefined}
            onClick={() => n.page !== null && onOpen(n.page)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={clsx(
              "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px]",
              n.page !== null && n.page === current ? "bg-raised text-fg" : "text-muted enabled:hover:bg-white/[0.04] enabled:hover:text-fg",
              n.page === null && "cursor-default",
            )}
          >
            {n.children.length > 0 && <Folder size={13} className="shrink-0 text-faint" />}
            <span className="truncate">{n.title}</span>
          </button>
          {n.children.length > 0 && <NavTree nodes={n.children} current={current} onOpen={onOpen} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  )
}
