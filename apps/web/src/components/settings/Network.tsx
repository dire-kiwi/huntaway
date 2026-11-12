import { useAtomValue } from "@effect/atom-react"
import { tokenAtom } from "@huntaway/client"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button, Input } from "../ui"
import { useHostInfo } from "./Server"

// Settings → Network access (the old NetworkPanel in Settings.tsx). The phones paired with the board (settings/Devices)
// are dropped with device pairing until the phone app comes back (docs/plan/14-dropped-and-open.md, Deferred).

/** The board's URL for other machines, with its token. */
export function NetworkPanel() {
  const localHostId = useBoard((s) => s.localHostId)
  const token = useAtomValue(tokenAtom)
  const { info } = useHostInfo(localHostId)
  const [showToken, setShowToken] = useState(false)
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80")
  const networkUrl = info ? `http://${info.hostname}:${port}/?token=${token}` : ""
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Network access</h2>
      <div className="space-y-3 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <p>
          The server listens on all interfaces by default (<code>--host</code> / <code>HUNTAWAY_HOST</code> to change). Open this URL from another machine. The
          token in it grants full control, including running agents, so only share it over a trusted network such as a VPN or Tailscale.
        </p>
        <div className="flex items-center gap-2">
          <Input readOnly className="font-mono text-[11.5px]" value={showToken ? networkUrl : networkUrl.replace(/token=.*/, "token=••••••••")} />
          <Button size="sm" onClick={() => setShowToken(!showToken)}>
            {showToken ? "Hide" : "Reveal"}
          </Button>
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(networkUrl)}>
            Copy
          </Button>
        </div>
        {info && (
          <div className="text-faint">
            Data directory: <span className="font-mono">{info.data_dir}</span> · v{info.version}
          </div>
        )}
      </div>
    </section>
  )
}
