import { isAssistant } from "@huntaway/client"
import { Bot } from "lucide-react"
import type { Route } from "../../../router"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { unavailableNote, useAssistantHome } from "../../task/assistant"
import { RunningDot } from "../../ui"
import { Badge, NavItem } from "./NavItem"

/**
 * The active profile's assistant, which opens full width (the old sidebar/ProfileEntries.tsx's `AssistantEntry`, 6.7).
 * Not there for a profile with no host that has one.
 */
export function AssistantEntry({ route, profile }: { route: Route; profile: string }) {
  const home = useAssistantHome(profile)
  const task = useBoard((s) =>
    home?.profileId ? Object.values(s.tasks).find((t) => isAssistant(t) && t.host_id === home.hostId && t.profile_id === home.profileId) : undefined,
  )
  const hostName = useBoard((s) => s.hosts.find((h) => h.id === home?.hostId)?.name ?? "its host")
  if (!home) return null
  return (
    <nav aria-label="Assistant">
      <NavItem
        active={route.name === "assistant" && route.profile === profile}
        onClick={() => navigate({ name: "assistant", profile })}
        title={
          home.unavailable ? unavailableNote(profile, hostName, home.unavailable) : `${profile}'s assistant: a lasting conversation, outside every project`
        }
        icon={<Bot size={15} />}
        right={
          <span className="flex items-center gap-1.5">
            {home.unavailable && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400" aria-label={home.unavailable === "offline" ? "Offline" : "Unavailable"} />
            )}
            {task?.running ? <RunningDot /> : null}
            <Badge n={task?.status === "needs_attention" ? 1 : 0} title="Needs attention" />
          </span>
        }
      >
        Assistant
      </NavItem>
    </nav>
  )
}
