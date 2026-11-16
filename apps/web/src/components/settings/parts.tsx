import { clsx } from "clsx"
import type { ReactNode } from "react"
import { Help } from "../ui"

// What the settings pages share (the board's and a project's): a section's heading and a group of settings in one.
// What a setting does is behind the ? beside its label (`Help`), not in a line under it (HE-32, HE-39).

/**
 * A settings section's heading: its name, what it's for in a line under it, the rest behind the ? beside the name, and
 * its buttons (`children`) at the right. `small` is for a section among others on a longer page (a host's).
 */
export function PanelHeading({
  title,
  description,
  help,
  small,
  children,
}: {
  title: string
  description?: ReactNode | undefined
  help?: ReactNode | undefined
  small?: boolean | undefined
  children?: ReactNode | undefined
}) {
  return (
    <div className="space-y-1">
      {/* As tall as a button, so a heading with buttons sits where one without does. */}
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <h2 className={clsx("font-semibold", small ? "text-[13px]" : "text-[15px]")}>{title}</h2>
          {help && <Help label={title}>{help}</Help>}
        </div>
        {children && <div className="ml-auto flex flex-wrap justify-end gap-2">{children}</div>}
      </div>
      {description && <p className="text-[12.5px] text-faint">{description}</p>}
    </div>
  )
}

/** Settings of a tab that belong together, under a heading, with a line between it and what's above. */
export function Group({ title, help, children }: { title: string; help?: ReactNode | undefined; children: ReactNode }) {
  return (
    <section className="space-y-5 border-t border-line pt-5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {help && <Help label={title}>{help}</Help>}
      </div>
      {children}
    </section>
  )
}

/** A select as the settings' fields have them. */
export const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none focus:border-accent/60"
