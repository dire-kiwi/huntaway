import { useAtomValue } from "@effect/atom-react"
import { hubJoinAtom, hubSshKeyAtom } from "@huntaway/client"
import { clsx } from "clsx"
import { Exit } from "effect"
import { Copy } from "lucide-react"
import { useState } from "react"
import { Button, copyText, Field, Input, Modal, ModalFooter, resultError, resultValue } from "../../ui"
import { useHubMutation } from "./hub"

export function AddHostModal({ url, onClose }: { url?: string | undefined; onClose: () => void }) {
  const [how, setHow] = useState<"ssh" | "url">(url ? "url" : "ssh")
  return (
    <Modal title="Add a host" onClose={onClose} width="max-w-2xl">
      <div className="mb-4 flex gap-1 rounded-lg border border-line bg-panel p-0.5 text-[12.5px]">
        {(
          [
            ["ssh", "Over SSH"],
            ["url", "By URL and token"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setHow(k)}
            className={clsx("flex-1 rounded-md px-2 py-1", how === k ? "bg-raised text-fg" : "text-muted hover:text-fg")}
          >
            {label}
          </button>
        ))}
      </div>
      {how === "ssh" ? <AddSshHost onClose={onClose} /> : <AddUrlHost initialUrl={url} onClose={onClose} />}
    </Modal>
  )
}

/** Link a host running on a machine over SSH, with a key restricted to that job. The board doesn't start it (HA-278). */
function AddSshHost({ onClose }: { onClose: () => void }) {
  const [target, setTarget] = useState("")
  const [bin, setBin] = useState("")
  const [port, setPort] = useState("7879")
  const [sshPort, setSshPort] = useState("22")
  const keyResult = useAtomValue(hubSshKeyAtom)
  const key = resultValue(keyResult)?.public_key ?? null
  const keyError = resultError(keyResult)
  const [{ busy, error: err }, addSsh] = useHubMutation("hub.hosts.addSsh")
  const p = Number(port) || 7879
  const binPath = bin.trim() || "/path/to/huntaway"
  const line = key ? `restrict,port-forwarding,permitopen="127.0.0.1:${p}",command="${binPath} ssh-host --port ${p}" ${key}` : "…"
  const submit = () => {
    void addSsh({ target: target.trim(), ssh_port: Number(sshPort) || 22, remote_port: p }).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted">
        This board connects to <code>huntaway</code> running on the machine through an SSH tunnel. The host only listens on that machine's localhost, and its
        agents keep running if the connection drops.
      </p>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="SSH target">
          <Input autoFocus value={target} onChange={(e) => setTarget(e.target.value)} placeholder="user@host" className="font-mono text-[12px]" />
        </Field>
        <Field label="SSH port">
          <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} className="font-mono text-[12px]" />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="huntaway on that machine" hint="Absolute path: a release's huntaway, or apps/server/bin/huntaway in a checkout that has built ia-shim.">
          <Input
            value={bin}
            onChange={(e) => setBin(e.target.value)}
            placeholder="/home/you/huntaway/apps/server/bin/huntaway"
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label="Host port">
          <Input value={port} onChange={(e) => setPort(e.target.value)} className="font-mono text-[12px]" />
        </Field>
      </div>
      <Field
        label="Start the host on that machine"
        hint="On Linux, this runs it as a user systemd service, started at boot (its page here can install one later too). Elsewhere, keep huntaway serve --host 127.0.0.1 running."
      >
        <CopyLine value={`${binPath} install-service --host 127.0.0.1 --port ${p}`} />
      </Field>
      <Field label="Add this line to ~/.ssh/authorized_keys on that machine" hint="The key can only run huntaway ssh-host and forward to the host's port.">
        <CopyLine value={line} />
      </Field>
      <ModalFooter className="space-y-4">
        {(err ?? keyError) && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err ?? keyError}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !target.includes("@")} onClick={submit}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </ModalFooter>
    </div>
  )
}

function AddUrlHost({ initialUrl, onClose }: { initialUrl?: string | undefined; onClose: () => void }) {
  const [url, setUrl] = useState(initialUrl ?? "http://")
  const [token, setToken] = useState("")
  const [{ busy, error: err }, add] = useHubMutation("hub.hosts.add")
  const submit = () => {
    void add({ url: url.trim(), token: token.trim() }).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted">
        For a host that's already running and reachable from this board, e.g. over Tailscale. Get its token with <code>huntaway token</code> on that machine.
      </p>
      <Field label="URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://buildbox:7879" className="font-mono text-[12px]" />
      </Field>
      <Field label="Token">
        <Input autoFocus={!!initialUrl} type="password" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-[12px]" />
      </Field>
      <ModalFooter className="space-y-4">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !token.trim() || url.length < 10} onClick={submit}>
            Add host
          </Button>
        </div>
      </ModalFooter>
    </div>
  )
}

export function JoinModal({ onClose }: { onClose: () => void }) {
  // The hub builds the command from where this browser reaches it.
  const result = useAtomValue(hubJoinAtom(window.location.origin))
  const info = resultValue(result)
  const err = resultError(result)
  return (
    <Modal title="Connect hosts and boards" onClose={onClose} width="max-w-2xl">
      <div className="space-y-5 text-[12.5px] text-muted">
        <div className="space-y-2">
          <div className="font-medium text-fg">A host that can't be reached directly</div>
          <p>Run this on it. It dials out to this board, so it needs no open ports. Swap in an address it can reach this machine on.</p>
          <CopyLine value={info?.command ?? "…"} />
        </div>
        <div className="space-y-2">
          <div className="font-medium text-fg">Another board using this host</div>
          <p>In that board's Settings → Hosts → Add host, enter this machine's URL and token:</p>
          <CopyLine value={info?.host_token ?? "…"} secret />
        </div>
        {err && <div className="text-xs text-red-400">{err}</div>}
        <p className="text-faint">These tokens give full control of agents on this machine; share them only over a trusted network.</p>
      </div>
    </Modal>
  )
}

function CopyLine({ value, secret }: { value: string; secret?: boolean | undefined }) {
  const [show, setShow] = useState(!secret)
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={show ? value : "•".repeat(24)} className="font-mono text-[11.5px]" />
      {secret && (
        <Button size="sm" onClick={() => setShow(!show)}>
          {show ? "Hide" : "Reveal"}
        </Button>
      )}
      <Button size="sm" onClick={() => copyText(value)}>
        <Copy size={12} /> Copy
      </Button>
    </div>
  )
}
