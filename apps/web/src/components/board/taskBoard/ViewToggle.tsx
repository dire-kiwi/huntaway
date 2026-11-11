import { clsx } from "clsx"
import { VIEWS, type BoardView } from "./model"

/** The switch between the board's views. */
export function ViewToggle({ view, onChange, wide, roomy }: { view: BoardView; onChange: (v: BoardView) => void; wide: boolean; roomy: boolean }) {
  // Every view's name on a roomy board, the current one's on a wide one, and only icons on a narrow one.
  const labelled = (id: BoardView) => roomy || (wide && view === id)
  return (
    <div className="mr-1 flex items-center rounded-md border border-line p-0.5">
      {VIEWS.map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          title={title}
          aria-label={`${label} view`}
          aria-pressed={view === id}
          onClick={() => onChange(id)}
          className={clsx(
            "inline-flex h-6 items-center gap-1 rounded text-xs font-medium transition-colors narrow:h-8",
            labelled(id) ? "px-2" : "px-1.5",
            view === id ? "bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon size={13} /> {labelled(id) && <span className="narrow:hidden">{label}</span>}
        </button>
      ))}
    </div>
  )
}
