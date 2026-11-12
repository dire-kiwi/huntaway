// Each profile's assistant (6.7, the old src/assistant.ts): one long-lived thread in no project that the sidebar opens,
// full width, at `/assistant/<profile>`. It's off the boards. Where it is: `assistantHome` in @huntaway/client. A
// profile's `assistant_host` naming another host (and so the offline and no-profile notes) is M7's (7.4): until linked
// hosts come, it is always on the page's own host.
import { assistantHome, isAssistant, type AssistantHome } from "@huntaway/client"
import { ProfileId } from "@huntaway/contracts"
import { useEffect, useMemo, useState } from "react"
import { useBoard } from "../../state/board"
import { useRpc } from "../../state/rpc"
import { useShallow } from "../boardHelpers"
import { errorText } from "../ui"

/**
 * The profile's assistant, made by its host the first time it's asked for: its id once it's on the board (its events
 * keep it there), and the error if it couldn't be had.
 */
export function useAssistant(name: string): { taskId?: string | undefined; error?: string | undefined; missing: boolean; home?: AssistantHome | undefined } {
  const home = useAssistantHome(name)
  const [hostId, profileId] = [home?.hostId, home?.profileId]
  const rpc = useRpc()
  const known = useBoard((s) => Object.values(s.tasks).find((t) => isAssistant(t) && t.host_id === hostId && t.profile_id === profileId)?.id)
  const [failed, setFailed] = useState<{ key: string; error: string }>()
  const key = `${hostId}:${profileId}`
  useEffect(() => {
    if (!hostId || !profileId) return undefined
    const req = { live: true }
    // What comes back arrives on the board as the task's event (or was in its snapshot).
    rpc(hostId, "assistant.get", { profile_id: ProfileId.make(profileId) }).catch((e: unknown) => {
      if (req.live) setFailed({ key: `${hostId}:${profileId}`, error: errorText(e) })
    })
    return () => {
      req.live = false
    }
  }, [rpc, hostId, profileId])
  return { taskId: known, error: failed?.key === key ? failed.error : undefined, missing: !home, home }
}

/** Where profile `name`'s assistant is (see assistantHome), kept as long as that doesn't change. */
export function useAssistantHome(name: string): AssistantHome | undefined {
  const [hostId, profileId, unavailable] = useBoard(
    useShallow((s) => {
      const home = assistantHome(s.profiles, s.hosts, name)
      return [home?.hostId, home?.profileId, home?.unavailable] as const
    }),
  )
  return useMemo(
    () => (hostId ? { hostId, ...(profileId === undefined ? {} : { profileId }), ...(unavailable === undefined ? {} : { unavailable }) } : undefined),
    [hostId, profileId, unavailable],
  )
}

/** Why a profile's assistant can't be opened on its host, as a sentence (a host that isn't the page's own: M7). */
export function unavailableNote(profile: string, hostName: string, why: NonNullable<AssistantHome["unavailable"]>): string {
  return why === "offline"
    ? `${profile}'s assistant runs on ${hostName}, which is offline. It's there again once the host reconnects.`
    : `${profile}'s assistant runs on ${hostName}, which has no ${profile} profile yet. Add one there in Settings → Profiles.`
}
