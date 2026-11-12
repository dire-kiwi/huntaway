// Each profile's assistant (6.7, the old src/assistant.ts): one long-lived thread in no project that the sidebar opens,
// full width, at `/assistant/<profile>`. It's off the boards. Where it is: `assistantHome` in @huntaway/client, which
// follows the board's own host's profile's `assistant_host` to a linked host (7.4), offline or without the profile there
// as it may be; that host is asked for its own assistant (`here`), whatever its own profile says.
import { useAtomValue } from "@effect/atom-react"
import { assistantHome, isAssistant, query, type AssistantHome, type QueryResult } from "@huntaway/client"
import { ProfileId } from "@huntaway/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { useMemo } from "react"
import { useBoard } from "../../state/board"
import { useShallow } from "../boardHelpers"
import { resultError } from "../ui"

/** Nothing to ask for: the profile has no assistant host yet. */
const NOWHERE: Atom.Atom<QueryResult<"assistant.get">> = Atom.make(AsyncResult.initial())

/**
 * The profile's assistant, made by its host the first time it's asked for: its id once it's on the board (its events
 * keep it there), and the error if it couldn't be had.
 */
export function useAssistant(name: string): { taskId?: string | undefined; error?: string | undefined; missing: boolean; home?: AssistantHome | undefined } {
  const home = useAssistantHome(name)
  const [hostId, profileId] = [home?.hostId, home?.profileId]
  const known = useBoard((s) => Object.values(s.tasks).find((t) => isAssistant(t) && t.host_id === hostId && t.profile_id === profileId)?.id)
  // What comes back arrives on the board as the task's event (or was in its snapshot). Its own, there: the host this
  // board found it on, whatever that host's profile names (HA-120).
  const asked = useAtomValue(hostId && profileId ? query("assistant.get", hostId, { profile_id: ProfileId.make(profileId), here: true }) : NOWHERE)
  return { taskId: known, error: resultError(asked) ?? undefined, missing: !home, home }
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

/** Why a profile's assistant can't be opened on its host (a linked host), as a sentence. */
export function unavailableNote(profile: string, hostName: string, why: NonNullable<AssistantHome["unavailable"]>): string {
  return why === "offline"
    ? `${profile}'s assistant runs on ${hostName}, which is offline. It's there again once the host reconnects.`
    : `${profile}'s assistant runs on ${hostName}, which has no ${profile} profile yet. Add one there in Settings → Profiles.`
}
