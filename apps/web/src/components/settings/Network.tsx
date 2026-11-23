import { useAtomValue } from "@effect/atom-react"
import { DateTime } from "effect"
import { Smartphone } from "lucide-react"
import { query, tokenAtom } from "@huntaway/client"
import type { Device, Pairing } from "@huntaway/contracts"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { useNow } from "../../state/clock"
import { useMutation } from "../../state/mutation"
import { Button, Field, Input, Loading, timeAgo } from "../ui"
import { Group, PanelHeading } from "./parts"
import { useHostInfo } from "./Server"

// Settings → Network access (the old NetworkPanel in Settings.tsx): the board's URL with its token, and the phones paired
// with it (HE-91; the old settings/Devices): pairing mode's PIN, which the phone app types in, and unpairing one. The
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
        {localHostId !== null && <PairedDevices hostId={localHostId} />}
      </div>
    </section>
  )
}

/** The PIN as it is easiest to read out: two groups of three. */
const spaced = (pin: string): string => (pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin)

/** Seconds as m:ss. */
const clock = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`

/** Pairing mode while it is on: the PIN, how long it is good for, the wrong ones it takes still. */
function PinCard({ pairing, onNew, onStop, busy }: { pairing: Pairing; onNew: () => void; onStop: () => void; busy: boolean }) {
  const now = useNow(1000)
  const left = Math.max(0, Math.round((DateTime.toEpochMillis(DateTime.makeUnsafe(pairing.expires_at)) - now) / 1000))
  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 px-4 py-3">
      <div className="text-[12.5px] text-muted">In the Huntaway app, pick this board and type the PIN:</div>
      <div className="mt-1 font-mono text-[28px] font-semibold tracking-[0.2em] text-fg" aria-label="Pairing PIN">
        {spaced(pairing.pin)}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-faint">
        <span>
          Good for {clock(left)} and one phone · {pairing.tries_left} wrong {pairing.tries_left === 1 ? "try" : "tries"} left
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" disabled={busy} onClick={onNew}>
            New PIN
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onStop}>
            Stop pairing
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A paired phone: its name, when it paired and was last used, and Unpair. */
function DeviceRow({ device, onUnpair, busy }: { device: Device; onUnpair: () => void; busy: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      <Smartphone size={14} className="shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{device.name}</div>
        <div className="truncate text-[11.5px] text-faint">
          paired {timeAgo(device.created_at)}
          {device.last_used_at !== null && ` · used ${timeAgo(device.last_used_at)}`}
        </div>
      </div>
      <Button size="sm" variant="danger" disabled={busy} onClick={onUnpair}>
        Unpair
      </Button>
    </div>
  )
}

/**
 * The phones paired with this board, and pairing one. While pairing mode is on the list is read every 2 seconds, so the
 * phone that pairs shows up and the PIN goes once it is used.
 */
function PairedDevices({ hostId }: { hostId: string }) {
  const [pairing, setPairing] = useState(false)
  const result = useAtomValue(query("hub.devices.list", hostId, undefined, pairing ? { refresh: "2 seconds" } : undefined))
  const [start, startPairing] = useMutation("hub.devices.startPairing")
  const [stop, stopPairing] = useMutation("hub.devices.stopPairing")
  const [revoke, revokeDevice] = useMutation("hub.devices.revoke")
  const begin = () => {
    setPairing(true)
    void startPairing(hostId, undefined)
  }
  const end = () => {
    setPairing(false)
    void stopPairing(hostId, undefined)
  }
  const error = start.error ?? stop.error ?? revoke.error
  return (
    <Group
      title="Phones"
      help={
        <>
          The Huntaway phone app finds this board on the same network and pairs with it by a PIN shown here. A paired phone sees the board and works its tasks
          (answers prompts, sends messages, starts and stops them) on this host and every host it links, but can&apos;t change settings, open terminals or link
          hosts. A PIN is good for 5 minutes, one phone and 5 wrong tries. Unpair a phone to cut it off at once.
        </>
      }
    >
      <Loading result={result}>
        {(list) => (
          <div className="space-y-3">
            {list.pairing !== null ? (
              <PinCard pairing={list.pairing} busy={start.busy || stop.busy} onNew={begin} onStop={end} />
            ) : (
              <Button disabled={start.busy} onClick={begin}>
                <Smartphone size={13} /> Pair a phone
              </Button>
            )}
            {list.devices.length > 0 && (
              <div className="rounded-xl border border-line">
                {list.devices.map((d) => (
                  <DeviceRow key={d.id} device={d} busy={revoke.busy} onUnpair={() => void revokeDevice(hostId, { id: d.id })} />
                ))}
              </div>
            )}
          </div>
        )}
      </Loading>
      {error !== null && <div className="text-xs text-red-400">{error}</div>}
    </Group>
  )
}
