import { clsx } from "clsx"
import { ChevronRight, EyeOff } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"
import { type HostProject as Project } from "@huntaway/client"
import type { Host } from "@huntaway/contracts"
import { hiddenKey } from "../../../projectGroups"
import { RunningDot } from "../../ui"
import { Counts, NavItem } from "./NavItem"
import { ProjectRow, type RowProps } from "./ProjectRow"

/** A host's hidden projects: a row that counts them, and the projects under it once it's opened. Nothing when it has none. */
export function HiddenProjects({
  host,
  list,
  hidden,
  showHidden,
  setShowHidden,
  row,
}: {
  host: Host
  /** The host's projects that the sidebar lists. */
  list: ReadonlyArray<Project>
  hidden: Set<string>
  showHidden: Set<string>
  setShowHidden: Dispatch<SetStateAction<Set<string>>>
  row: RowProps
}) {
  const { stats, activeProject, grouped } = row
  const off = list.filter((p) => hidden.has(hiddenKey(p)))
  if (!off.length) return null
  const open = showHidden.has(host.id)
  const total = off.reduce(
    (t, p) => ({
      attention: t.attention + (stats[p.id]?.attention ?? 0),
      running: t.running + (stats[p.id]?.running ?? 0),
      ready: t.ready + (stats[p.id]?.ready ?? 0),
    }),
    { attention: 0, running: 0, ready: 0 },
  )
  const toggle = () =>
    setShowHidden((old) => {
      const next = new Set(old)
      if (open) next.delete(host.id)
      else next.add(host.id)
      return next
    })
  return (
    <>
      <NavItem
        className="min-w-0"
        active={!open && off.some((p) => p.id === activeProject)}
        onClick={toggle}
        expanded={open}
        title={open ? "Leave hidden projects out" : "Show hidden projects"}
        icon={<EyeOff size={14} className="text-faint" />}
        right={
          <span className="flex items-center gap-1.5">
            {!open && total.running ? <RunningDot /> : null}
            {!open && <Counts attention={total.attention} ready={total.ready} />}
            <ChevronRight size={13} className={clsx("text-faint transition-transform", open && "rotate-90")} />
          </span>
        }
      >
        {off.length} hidden
      </NavItem>
      {open && (
        <div role="group" aria-label={`Hidden projects${grouped ? ` on ${host.name}` : ""}`} className="ml-3 space-y-0.5 border-l border-line pl-1">
          {off.map((p) => (
            <div key={p.id} className="flex">
              <ProjectRow p={p} dim {...row} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
