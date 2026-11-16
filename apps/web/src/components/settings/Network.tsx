import { useAtomValue } from "@effect/atom-react"
import { tokenAtom } from "@huntaway/client"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button, Field, Input } from "../ui"
import { PanelHeading } from "./parts"
import { useHostInfo } from "./Server"

// Settings → Network access (the old NetworkPanel in Settings.tsx). The phones paired with the board (settings/Devices)
// are dropped with device pairing until the phone app comes back (docs/plan/14-dropped-and-open.md, Deferred). The
// data folder and the version it used to end with are Settings → Server's (HE-39).

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
      <PanelHeading
        title="Network access"
        description="Open the board from another machine. The token in its URL grants full control, so share it only over a trusted network."
      />
      <div className="mt-5">
        <Field
          label="This board's URL"
          help={
            <>
              The server listens on all interfaces by default (<code>--host</code> / <code>HUNTAWAY_HOST</code> to change). Whoever has the token can do
              anything on the board, including running agents: share it only over a trusted network such as a VPN or Tailscale.
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input readOnly className="font-mono text-[11.5px]" value={showToken ? networkUrl : networkUrl.replace(/token=.*/, "token=••••••••")} />
            <Button size="sm" onClick={() => setShowToken(!showToken)}>
              {showToken ? "Hide" : "Reveal"}
            </Button>
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(networkUrl)}>
              Copy
            </Button>
          </div>
        </Field>
      </div>
    </section>
  )
}
