// A connection card (HE-28): the assistant, or a routine thread under it, asked with request_connection for something
// it needs that isn't connected (Google). It says what's missing and why the agent wants it, opens the profile's Google
// card from Settings → Assistant in a dialog over the page, and settles once: Check again (`threads.checkConnection`)
// when it's connected, or the board noticing on its own (every 30 seconds), as Connected as <address>; Skip
// (`threads.skipConnection`); or a reply in the thread. Each tells the agent to carry on.
import { mutate } from "@huntaway/client"
import type { ConnectionState } from "@huntaway/contracts"
import { TaskId } from "@huntaway/contracts"
import { Exit } from "effect"
import { Loader2, PlugZap, Settings as SettingsIcon } from "lucide-react"
import { memo, useState } from "react"
import { useBoard } from "../../../state/board"
import { useAction } from "../../../state/mutation"
import { navigate } from "../../../state/route"
import { Button, Modal } from "../../ui"
import { GoogleCard } from "../GoogleCard"
import { Frame, Outcome } from "./requestCards"
import type { ConnectionData } from "./threadModel"

/** What each connection is called (the server's connectionText.ts `LABELS`). */
const LABELS: Readonly<Record<string, string>> = { google: "Google" }

export const ConnectionCard = memo(function ConnectionCard({
  id,
  data,
  hostId,
  taskId,
  movedOn,
}: {
  id: number
  data: ConnectionData
  hostId: string
  taskId: string
  movedOn: boolean
}) {
  const label = LABELS[data.connection] ?? data.connection
  const profileId = useBoard((s) => s.tasks[taskId]?.profile_id)
  const pending = data.status === "pending" && !movedOn
  // What the last Check again found, shown in place of what was missing when the agent asked.
  const [checked, setChecked] = useState<ConnectionState | null>(null)
  const [setup, setSetup] = useState(false)
  const [doing, setDoing] = useState<"check" | "skip" | null>(null)
  const [action, run] = useAction()
  const busy = action.busy ? doing : null
  const request = { task_id: TaskId.make(taskId), request_id: `legacy:${id}` }
  const check = () => {
    setDoing("check")
    void run(mutate("threads.checkConnection", hostId, request)).then((exit) => {
      if (Exit.isSuccess(exit)) setChecked(exit.value)
    })
  }
  const skip = () => {
    setDoing("skip")
    void run(mutate("threads.skipConnection", hostId, request))
  }
  const closeSetup = () => {
    setSetup(false)
    // Whatever was done there is looked at straight away.
    if (pending) check()
  }
  const problem = checked?.problem ?? data.problem
  return (
    <Frame pending={pending} label={`Connect ${label}`}>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-faint">
        <PlugZap size={14} className={pending ? "text-st-attention" : "text-faint"} />
        {pending ? `The assistant asks to connect ${label}` : `The assistant asked to connect ${label}`}
        {data.status === "connected" && <Outcome tone="good">connected</Outcome>}
        {data.status === "skipped" && <Outcome tone="plain">skipped</Outcome>}
        {data.status === "replied" && <Outcome tone="plain">answered in the thread</Outcome>}
        {(data.status === "replaced" || data.status === "expired" || (data.status === "pending" && movedOn)) && <Outcome tone="plain">not answered</Outcome>}
      </div>
      <div className={pending ? "text-[13.5px] font-semibold text-fg" : "text-[13.5px] font-semibold text-muted"}>Connect {label}</div>
      {data.reason && <div className="mt-1 text-[13px] whitespace-pre-wrap text-muted">{data.reason}</div>}
      {data.status === "connected" && <div className="mt-2 text-[12.5px] text-emerald-300">Connected as {data.account ?? "?"}</div>}
      {pending && (
        <>
          {problem && <div className="mt-2 text-[12.5px] text-amber-300">{problem}</div>}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {profileId && (
              <Button size="sm" variant="primary" disabled={!!busy} onClick={() => setSetup(true)}>
                <SettingsIcon size={13} /> Set up {label}
              </Button>
            )}
            <Button size="sm" disabled={!!busy} onClick={check} title={`Look again whether ${label} is connected`}>
              {busy === "check" && <Loader2 size={12} className="animate-spin" />} Check again
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={skip} title={`The assistant carries on without ${label}`}>
              {busy === "skip" && <Loader2 size={12} className="animate-spin" />} Skip
            </Button>
          </div>
          <div className="mt-2 text-[11.5px] text-faint">
            {checked && !checked.connected ? "Still not connected. " : ""}The board also looks every 30 seconds while this is open, and tells the assistant to
            carry on once it's connected.
          </div>
        </>
      )}
      {action.error && <div className="mt-1.5 text-xs text-red-400">{action.error}</div>}
      {setup && profileId && (
        <Modal title={`Settings → Assistant → ${label}`} onClose={closeSetup} width="max-w-xl">
          <GoogleCard hostId={hostId} profileId={profileId} />
          <div className="mt-4 flex justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => navigate({ name: "settings", tab: "assistant" })}>
              Open Settings → Assistant
            </Button>
            <Button size="sm" variant="primary" onClick={closeSetup}>
              Done
            </Button>
          </div>
        </Modal>
      )}
    </Frame>
  )
})
