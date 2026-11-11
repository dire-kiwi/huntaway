import { clsx } from "clsx"
import { Archive, ChevronRight, Plus } from "lucide-react"
import { IconButton, StatusIcon } from "../../ui"
import { showsStatus } from "../boardQuery"
import { TaskRow } from "../TaskCard"
import type { CardsProps } from "./Cards"
import { DropColumn, DropLine } from "./DropColumn"
import { CAN_ADD } from "./model"

/** The list view: a section for each status, then the archived tasks. */
export function ListView({ board, q, drops: d, menus, canAdd, emptyText }: CardsProps & { canAdd: boolean }) {
  const { shownStatuses, shown, shownArchived, archived, projectOf, progressOf } = board
  const { query, sort, collapsed, toggleCollapsed, backlogOpen, toggleBacklog, archivedOpen, toggleArchived } = q
  const { dropTarget, drops } = d
  const { onMenu, setNewIn } = menus
  return (
    <div className="space-y-5 p-6 narrow:p-3">
      {shownStatuses.map((s) => {
        const items = shown[s.id]
        // The backlog is open or collapsed in both views at once, and starts collapsed.
        const open = s.id === "backlog" ? backlogOpen : !collapsed.has(s.id)
        return (
          <DropColumn key={s.id} status={s.id} drops={drops}>
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={() => (s.id === "backlog" ? toggleBacklog() : toggleCollapsed(s.id))}
                className={clsx(
                  "flex items-center gap-2 rounded-md text-left",
                  !open && dropTarget?.status === s.id && "ring-1 ring-accent/40 ring-offset-4 ring-offset-bg",
                )}
              >
                <ChevronRight size={14} className={clsx("text-faint transition-transform", open && "rotate-90")} />
                <StatusIcon status={s.id} />
                <h2 className="text-[13px] font-medium">{s.label}</h2>
                <span className="text-[12px] text-faint">{items.length}</span>
              </button>
              {canAdd && CAN_ADD.has(s.id) && (
                <IconButton className="ml-auto h-6 w-6" title={`New task in ${s.label}`} onClick={() => setNewIn(s.id)}>
                  <Plus size={14} />
                </IconButton>
              )}
            </div>
            {open &&
              (items.length === 0 ? (
                <div
                  className={clsx(
                    "rounded-lg border border-dashed px-4 py-4 text-center text-[12.5px] text-faint transition-colors",
                    dropTarget?.status === s.id ? "border-accent/40 bg-accent/[0.03]" : "border-line",
                  )}
                >
                  {emptyText(s.id)}
                </div>
              ) : (
                <div className={clsx("overflow-hidden rounded-lg border transition-colors", dropTarget?.status === s.id ? "border-accent/40" : "border-line")}>
                  {items.map((t, i) => (
                    <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                      {dropTarget?.status === s.id && dropTarget.before === t.id && <DropLine status={s.id} className="h-0.5" />}
                      <TaskRow task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
                    </div>
                  ))}
                  {sort === "manual" && dropTarget?.status === s.id && dropTarget.before === null && <DropLine status={s.id} className="h-0.5" />}
                </div>
              ))}
          </DropColumn>
        )
      })}
      {/* Done for two days: off the kanban board, and here last, collapsed. Dragging one back into Done brings it back. */}
      {showsStatus(query, "done") && (
        <section id="archived-tasks" className="scroll-mt-6">
          <div className="mb-2 flex items-center gap-2">
            <button onClick={() => toggleArchived()} className="flex items-center gap-2 rounded-md text-left" title="Tasks done for two days or more">
              <ChevronRight size={14} className={clsx("text-faint transition-transform", archivedOpen && "rotate-90")} />
              <Archive size={14} className="text-faint" />
              <h2 className="text-[13px] font-medium">Archived</h2>
              <span className="text-[12px] text-faint">{shownArchived.length}</span>
            </button>
          </div>
          {archivedOpen &&
            (shownArchived.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-[12.5px] text-faint">
                {archived.length ? "No matching tasks" : "Tasks done for two days move here"}
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                {shownArchived.map((t, i) => (
                  <div key={t.id} className={clsx(i > 0 && "border-t border-line")}>
                    <TaskRow task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} />
                  </div>
                ))}
              </div>
            ))}
        </section>
      )}
    </div>
  )
}
