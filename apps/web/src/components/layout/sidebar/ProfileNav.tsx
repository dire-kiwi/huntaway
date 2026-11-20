import { ChartColumn, CircleHelp } from "lucide-react"
import type { Status } from "@huntaway/contracts"
import { type Route } from "../../../router"
import { navigate } from "../../../state/route"
import { ProfileAvatar } from "../../board/Board"
import { StatusBar, type MenuItem } from "../../ui"
import { NavItem } from "./NavItem"
import { newWindowItems } from "./newWindow"

/** The navigation at the top: a row for each profile's tasks, then Analytics and the Guide. */
export function ProfileNav({
  route,
  names,
  active,
  switchTo,
  byProfile,
  setMenu,
}: {
  route: Route
  names: string[]
  /** The profile whose projects the sidebar lists. */
  active: string | undefined
  /** Moves to a profile, at the page it was last on (HE-64). */
  switchTo: (name: string) => void
  /** Each profile's tasks by column, by profile name. */
  byProfile: Record<string, Partial<Record<Status, number>>>
  setMenu: (menu: { x: number; y: number; title: string; items: MenuItem[] }) => void
}) {
  return (
    <nav className="space-y-0.5 px-2" aria-label="Profiles">
      {names.map((name) => (
        <NavItem
          key={name}
          active={route.name === "profile" && route.profile === name}
          current={names.length > 1 && name === active}
          onClick={() => switchTo(name)}
          onContextMenu={(e) => {
            const items = newWindowItems({ name: "profile", profile: name })
            if (!items.length) return
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, title: name, items })
          }}
          title={
            names.length > 1 && name === active
              ? `All of ${name}'s tasks. The sidebar lists ${name}'s projects`
              : names.length > 1
                ? `Switch to ${name}, back on the page you were on there last`
                : `All of ${name}'s tasks`
          }
          icon={<ProfileAvatar name={name} muted={names.length > 1 && name !== active} />}
          right={<StatusBar counts={byProfile[name] ?? {}} />}
        >
          {name}
        </NavItem>
      ))}
      <NavItem active={route.name === "analytics"} onClick={() => navigate({ name: "analytics" })} icon={<ChartColumn size={15} />}>
        Analytics
      </NavItem>
      <NavItem active={route.name === "guide"} onClick={() => navigate({ name: "guide" })} icon={<CircleHelp size={15} />} title="How the board works">
        Guide
      </NavItem>
    </nav>
  )
}
