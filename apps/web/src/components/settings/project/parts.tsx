import type { ReactNode } from "react"
import { Help } from "../../ui"

/** Settings of a tab that belong together, under a heading, with a line between it and what's above. */
export function Group({ title, help, children }: { title: string; help?: ReactNode | undefined; children: ReactNode }) {
  return (
    <section className="space-y-5 border-t border-line pt-5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {help && <Help label={title}>{help}</Help>}
      </div>
      {children}
    </section>
  )
}

/** A select as the settings' fields have them. */
export const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none focus:border-accent/60"
