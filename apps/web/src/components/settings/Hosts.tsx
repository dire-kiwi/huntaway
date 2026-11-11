import { KeyRound, Plus } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button } from "../ui"
import { AddHostModal, JoinModal } from "./hosts/AddHost"
import { HostRow } from "./hosts/HostRow"
import { NearbyHosts, ScratchHostRow } from "./hosts/NearbyHosts"

export function HostsPanel() {
  const hosts = useBoard((s) => s.hosts)
  // Opening Add host for a host found nearby fills in its URL.
  const [adding, setAdding] = useState<false | { url?: string | undefined }>(false)
  const [joining, setJoining] = useState(false)
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Hosts</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setJoining(true)}>
            <KeyRound size={13} /> Connect from elsewhere
          </Button>
          <Button size="sm" onClick={() => setAdding({})}>
            <Plus size={13} /> Add host
          </Button>
        </div>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Each host keeps its own projects, tasks and agent threads. This board shows every connected host, and any other board linked to a host sees the same
        data. Configure a host (agent defaults, agent configs, profiles, rebuild &amp; restart) from its page.
      </p>
      <div className="space-y-2">
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
      </div>
      <NearbyHosts onLink={(url) => setAdding({ url })} />
      <ScratchHostRow />
      {adding && <AddHostModal url={adding.url} onClose={() => setAdding(false)} />}
      {joining && <JoinModal onClose={() => setJoining(false)} />}
    </section>
  )
}
