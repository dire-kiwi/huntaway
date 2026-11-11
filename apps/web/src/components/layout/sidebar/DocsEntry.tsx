import { BookOpen } from "lucide-react"
import type { Route } from "../../../router"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { docsHomes, docsProfileName } from "../../docs/docs"
import { NavItem } from "./NavItem"

/**
 * The active profile's documents (HA-281), under its assistant (the old sidebar/ProfileEntries.tsx's `DocsEntry`, 6.3).
 * Not there for a profile with no connected host.
 */
export function DocsEntry({ route, profile }: { route: Route; profile: string }) {
  const available = useBoard((s) => docsHomes(s.profiles, s.hosts, profile).homes.length > 0)
  const active = useBoard((s) => route.name === "docs" && docsProfileName(s.profiles, route.profile) === profile)
  if (!available) return null
  return (
    <nav aria-label="Docs">
      <NavItem
        active={active}
        onClick={() => navigate({ name: "docs", profile })}
        title={`${profile}'s documents: the reports, plans and write-ups its agents publish`}
        icon={<BookOpen size={15} />}
      >
        Docs
      </NavItem>
    </nav>
  )
}
