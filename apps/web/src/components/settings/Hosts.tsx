import { KeyRound, Plus } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button } from "../ui"
import { AddHostModal, JoinModal } from "./hosts/AddHost"
import { HostRow } from "./hosts/HostRow"
import { PanelHeading } from "./parts"
import { NearbyHosts, ScratchHostRow } from "./hosts/NearbyHosts"

export function HostsPanel() {
  const hosts = useBoard((s) => s.hosts)
  // Opening Add host for a host found nearby fills in its URL.
  const [adding, setAdding] = useState<false | { url?: string | undefined }>(false)
  const [joining, setJoining] = useState(false)
  return (
    <section>
      <PanelHeading
        title="Hosts"
        description="The machines whose projects and agents this board shows."
        help={
          <>
            <span className="block">Each host keeps its own projects, tasks and agent threads. Any other board linked to a host sees the same data.</span>
            <span className="block">
              <i>Configure</i> opens a host&apos;s page: its agent defaults, agent configs, profiles, terminal tools and server.
            </span>
          </>
        }
      >
        <Button size="sm" variant="ghost" onClick={() => setJoining(true)}>
          <KeyRound size={13} /> Connect from elsewhere
        </Button>
        <Button size="sm" onClick={() => setAdding({})}>
          <Plus size={13} /> Add host
        </Button>
      </PanelHeading>
      <div className="mt-5 space-y-2">
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
        <NearbyHosts onLink={(url) => setAdding({ url })} />
        <ScratchHostRow />
      </div>
      {adding && <AddHostModal url={adding.url} onClose={() => setAdding(false)} />}
      {joining && <JoinModal onClose={() => setJoining(false)} />}
    </section>
  )
}
