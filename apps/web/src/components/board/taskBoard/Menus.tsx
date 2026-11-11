import { isArchived, keyPrefix, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { Resolution } from "@huntaway/contracts"
import { Schema } from "effect"
import { useSelection } from "../../../selection"
import { titleItem } from "../../layout/TitleModal"
import { reminderItems, starItem } from "../../task/Reminders"
import { ContextMenu, RESOLUTION_LABELS, StatusIcon, useClock } from "../../ui"
import { penItems } from "../Pens"
import type { BoardMenus } from "./useBoardMenus"

/** A card's menu, for `task`: the columns and resolutions to move it to, its star, reminder and pen, and renaming it. */
export function CardMenu({
  menus,
  task: menuTask,
  picked,
  projectOf,
  setDropErr,
}: {
  menus: BoardMenus
  task: Task
  picked: Task[]
  projectOf: (t: Task) => Project | undefined
  setDropErr: (msg: string | null) => void
}) {
  const { menu, setMenu, moveItems, complete, setPicking, setRenaming, newPen } = menus
  const now = useClock(1000)
  if (!menu) return null
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      title={`Move ${keyPrefix(menuTask, projectOf(menuTask))}-${menuTask.number} to`}
      items={[
        ...moveItems(menuTask),
        ...Object.keys(RESOLUTION_LABELS)
          .filter(Schema.is(Resolution))
          .map((r, i) => ({
            label: (
              <span className="flex items-center gap-2">
                <StatusIcon status="done" size={13} /> {RESOLUTION_LABELS[r]}
              </span>
            ),
            // An archived task isn't in Done: picking its resolution brings it back.
            checked: menuTask.status === "done" && menuTask.resolution === r && !isArchived(menuTask, now),
            divider: i === 0,
            onSelect: () => complete(menuTask, r),
          })),
        starItem(menuTask, setDropErr, true),
        ...reminderItems(menuTask, () => setPicking(menuTask), setDropErr),
        ...penItems(menuTask, picked, setDropErr, newPen),
        titleItem(() => setRenaming(menuTask), true),
        // "Compare all from its prompt" (changes/Compare.tsx) is not yet on this server.
      ]}
      // A right-click on another task may already have opened its menu in place of this one.
      onClose={() => setMenu((m) => (m === menu ? null : m))}
    />
  )
}

/** The picked tasks' pen menu, at `at`. */
export function PenMenu({
  at,
  menus,
  picked,
  setDropErr,
}: {
  at: { x: number; y: number }
  menus: BoardMenus
  picked: Task[]
  setDropErr: (msg: string | null) => void
}) {
  return (
    <ContextMenu
      x={at.x}
      y={at.y}
      title={`Put ${picked.length} task${picked.length === 1 ? "" : "s"} in a pen`}
      items={(picked[0] ? penItems(picked[0], picked, setDropErr, menus.newPen) : []).map((i) => {
        const select = i.onSelect
        return Object.assign(i, {
          divider: false,
          onSelect: () => {
            select()
            useSelection.getState().clear()
          },
        })
      })}
      onClose={() => menus.setPenMenu(null)}
    />
  )
}
