import { isArchived, isAssistant, keyPrefix, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { Resolution } from "@huntaway/contracts"
import { Schema } from "effect"
import { useSelection } from "../../../selection"
import { openCompare } from "../../../state/route"
import { titleItem } from "../../layout/TitleModal"
import { reminderMenu, starItem } from "../../task/Reminders"
import { ContextMenu, RESOLUTION_LABELS, StatusIcon, useClock } from "../../ui"
import { penItems, penMenu } from "../Pens"
import type { BoardMenus } from "./useBoardMenus"

/**
 * A card's menu, for `task`: the columns and resolutions to move it to, its star, reminder and pen, renaming and
 * deleting it. Right-clicked, the moves are in a submenu of their own; from the card's Move button (on a phone or a
 * touch screen), they come first, in the menu itself.
 */
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
  const { menu, setMenu, moveItems, complete, setPicking, setRenaming, setDeleting, newPen, menuSiblings } = menus
  const now = useClock(1000)
  if (!menu) return null
  const key = `${keyPrefix(menuTask, projectOf(menuTask))}-${menuTask.number}`
  const moves = [
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
  ]
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      title={menu.move ? `Move ${key} to` : key}
      items={[
        ...(menu.move ? moves : [{ label: "Move to", items: moves }]),
        starItem(menuTask, setDropErr, true),
        reminderMenu(menuTask, () => setPicking(menuTask), setDropErr),
        ...penMenu(menuTask, picked, setDropErr, newPen),
        titleItem(() => setRenaming(menuTask), true),
        ...(menuSiblings > 1 ? [{ label: `Compare all ${menuSiblings} from its prompt`, onSelect: () => openCompare(menuTask.id) }] : []),
        // The assistant lasts: it can't be deleted.
        ...(isAssistant(menuTask) ? [] : [{ label: "Delete…", divider: true, danger: true, onSelect: () => setDeleting(menuTask) }]),
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
            select?.()
            useSelection.getState().clear()
          },
        })
      })}
      onClose={() => menus.setPenMenu(null)}
    />
  )
}
