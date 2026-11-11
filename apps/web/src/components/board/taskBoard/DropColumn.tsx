import type { ComponentProps, DragEvent } from "react"
import type { Status } from "@huntaway/contracts"
import { STATUS_COLOR } from "../../ui"

export type Drops = { onDragOver: (e: DragEvent, status: Status) => void; onDrop: (e: DragEvent, status: Status) => void; onLeave: () => void }

/** A column or section that tasks dragged onto it move to: to `status`, where `drops` says. */
export function DropColumn({
  status,
  drops,
  ...props
}: { status: Status; drops: Drops } & Omit<ComponentProps<"section">, "onDragOver" | "onDragLeave" | "onDrop">) {
  return (
    <section
      {...props}
      data-status={status}
      onDragOver={(e) => drops.onDragOver(e, status)}
      onDragLeave={(e) => {
        // Not when it's onto a card in it.
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) drops.onLeave()
      }}
      onDrop={(e) => drops.onDrop(e, status)}
    />
  )
}

export function DropLine({ status, className = "mb-2 h-0.5 rounded-full" }: { status: Status; className?: string | undefined }) {
  return <div className={className} style={{ background: STATUS_COLOR[status] }} />
}
