// Which host's assistant a profile uses (HE-103): its `assistant_host`, picked on the assistant's own page rather than
// only in Settings → Profiles. It's the board's own host's profile that names it (see assistantHome), so that's the one
// changed; the page then follows it to the host picked, and opens the assistant there.
import { mutate } from "@huntaway/client"
import { LinkId } from "@huntaway/contracts"
import { Server } from "lucide-react"
import { useEffect } from "react"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { useShallow } from "../boardHelpers"
import { AssistantHostSelect } from "../settings/hosts/profileFields"

/**
 * A dropdown of where profile `name`'s assistant runs: this board's host or a linked one. Shown only when there's a
 * choice (a linked host is connected, or one is picked already) and the board's host has the profile. A failed save's
 * error goes to `onError`.
 */
export function AssistantHostPicker({ profile, onError }: { profile: string; onError?: ((error: string | null) => void) | undefined }) {
  const own = useBoard(
    useShallow((s) => {
      const local = s.hosts.find((h) => h.local)
      const p = local && s.profiles.find((q) => q.host_id === local.id && q.name === profile)
      return p ? ([p.host_id, p.id, p.assistant_host ?? ""] as const) : undefined
    }),
  )
  const linked = useBoard((s) => s.hosts.some((h) => !h.local && h.connected))
  const [{ busy, error }, run] = useAction()
  useEffect(() => {
    if (error) onError?.(`Couldn't move the assistant: ${error}`)
  }, [error, onError])
  if (!own) return null
  const [hostId, id, picked] = own
  if (!linked && !picked) return null
  const pick = (to: string) => void run(mutate("profiles.update", hostId, { id, patch: { assistant_host: to ? LinkId.make(to) : null } }))
  return (
    <span className="no-drag flex shrink-0 items-center gap-1 text-muted" title={`Where ${profile}'s assistant runs`}>
      <Server size={12} className="text-faint" />
      <AssistantHostSelect
        value={picked}
        onChange={pick}
        disabled={busy}
        aria-label={`Where ${profile}'s assistant runs`}
        className="h-7 rounded-md border border-line bg-panel px-2 text-[12px] outline-none"
      />
    </span>
  )
}
