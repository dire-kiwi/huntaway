// Each profile's assistant's connections, in Settings (6.7): Google, on the host its assistant runs on (see
// assistantHome). Telegram is dropped (docs/plan/14-dropped-and-open.md). An assistant on another host (and its uplink
// note) is M7's (7.4): until then it is on the page's own host.
import { useMemo } from "react"
import { useBoard } from "../../state/board"
import { profileNames } from "../boardHelpers"
import { unavailableNote, useAssistantHome } from "../task/assistant"
import { GoogleCard } from "../task/GoogleCard"

export function AssistantsPanel() {
  const profiles = useBoard((s) => s.profiles)
  const names = useMemo(() => profileNames(profiles), [profiles])
  if (!names.length) return null
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Assistant</h2>
      <p className="mb-3 text-[12.5px] text-muted">What each profile's assistant reaches beyond the board: its Google account (Gmail, Calendar and Drive).</p>
      <div className="space-y-3">
        {names.map((name) => (
          <AssistantCard key={name} profile={name} />
        ))}
      </div>
    </section>
  )
}

function AssistantCard({ profile }: { profile: string }) {
  const home = useAssistantHome(profile)
  const host = useBoard((s) => s.hosts.find((h) => h.id === home?.hostId))
  if (!home) return null
  return (
    <div role="group" aria-label={`${profile}'s assistant`} className="rounded-xl border border-line">
      <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium">
        {profile}
        {host && !host.local && <span className="font-normal text-faint"> · on {host.name}</span>}
      </div>
      <div className="space-y-5 p-4">
        {home.unavailable || !home.profileId ? (
          <div className="text-[12.5px] text-muted">{unavailableNote(profile, host?.name ?? "its host", home.unavailable ?? "no_profile")}</div>
        ) : (
          <div>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">Google</h3>
            <GoogleCard hostId={home.hostId} profileId={home.profileId} />
          </div>
        )}
      </div>
    </div>
  )
}
