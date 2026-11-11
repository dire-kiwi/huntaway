import { Archive } from "lucide-react"
import type { Status } from "@huntaway/contracts"
import { inTab, type PenTab } from "../pens"
import { CardPenLabel } from "../Pens"
import { TaskCard } from "../TaskCard"
import { StackCard, StackTab } from "../StackCard"
import type { ColumnEntry } from "../stacks"
import { DropLine } from "./DropColumn"
import type { BoardDrops } from "./useBoardDrops"
import type { BoardMenus } from "./useBoardMenus"
import type { BoardQueryState } from "./useBoardQuery"
import type { BoardStacks } from "./useBoardStacks"
import type { BoardTasks } from "./useBoardTasks"

/** What every column's cards are drawn from. */
export type CardsProps = {
  board: BoardTasks
  q: BoardQueryState
  drops: BoardDrops
  menus: BoardMenus
  stacks: BoardStacks
  penLabels: boolean
  onOpenPen?: ((key: string) => void) | undefined
  /** What a column or section with nothing to show says. */
  emptyText: (status: Status) => string
}

/** A column's cards (with `lane`, those in its pen), with where a dragged one would go, and what it says when it has none. */
export function Cards({
  status,
  lane,
  board,
  q,
  drops,
  menus,
  stacks,
  penLabels,
  onOpenPen,
  emptyText,
}: CardsProps & { status: Status; lane?: PenTab | undefined }) {
  const { shown, shownArchived, projectOf, progressOf } = board
  const { dropTarget } = drops
  const { dragStack, spreadOf } = stacks
  const list: ColumnEntry[] = lane
    ? shown[status].filter((t) => inTab(lane, t)).map((task) => ({ task }))
    : stacks.kanban
      ? stacks.entries[status]
      : shown[status].map((task) => ({ task }))
  const here = dropTarget?.status === status && dropTarget.lane === lane?.key
  // A gathered stack dragged over a column: Ready for merge takes it when it can merge; the others say why they don't.
  const stackDrop = dragStack && dropTarget?.status === status && !lane
  const check = stackDrop ? stacks.checkOf(dragStack) : null
  return (
    <>
      {stackDrop && (status !== "ready_for_merge" || !check?.ok) && (
        <div role="status" className="rounded-md border border-dashed border-st-attention/40 px-2 py-1.5 text-[12px] leading-snug text-amber-200/90">
          {status !== "ready_for_merge"
            ? "A gathered stack only moves to Ready for merge, which merges it. Spread it to move one of its levels."
            : `The stack can't merge yet. ${check?.reason ?? ""}`}
        </div>
      )}
      {list.map(({ task: t, stack, ...more }) => {
        const spread = spreadOf.get(t.id)
        return (
          <div key={stack ? stack.key : t.id}>
            {here && dropTarget.before === t.id && <DropLine status={status} />}
            {stack ? (
              <StackCard
                stack={stack}
                hidden={"hidden" in more ? more.hidden : 0}
                project={projectOf(stack.bottom)}
                check={stacks.checkOf(stack)}
                meta={stacks.hasMeta(stack)}
                anchor={t.id}
                onSpread={() => stacks.spread(stack, false)}
                onMenu={stacks.onMenu}
                onDragStart={stacks.setDragStack}
                onDragEnd={() => {
                  stacks.setDragStack(null)
                  drops.setDropTarget(null)
                }}
              />
            ) : (
              <>
                {penLabels && <CardPenLabel task={t} onOpen={onOpenPen} />}
                {spread ? (
                  <div className="relative pt-[10px]">
                    <StackTab stack={spread} task={t} onGather={() => stacks.spread(spread, true)} />
                    <TaskCard task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={menus.onMenu} />
                  </div>
                ) : (
                  <TaskCard task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={menus.onMenu} />
                )}
              </>
            )}
          </div>
        )
      })}
      {q.sort === "manual" && here && dropTarget.before === null && !dragStack && <DropLine status={status} />}
      {list.length === 0 && !lane && <div className="px-2 py-6 text-center text-[12px] text-faint">{emptyText(status)}</div>}
      {status === "done" && !lane && shownArchived.length > 0 && (
        <button
          onClick={q.showArchived}
          title="Tasks done for two days or more are in the list view"
          className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] text-faint transition-colors hover:bg-raised/40 hover:text-fg"
        >
          <Archive size={12} /> {shownArchived.length} archived
        </button>
      )}
    </>
  )
}
