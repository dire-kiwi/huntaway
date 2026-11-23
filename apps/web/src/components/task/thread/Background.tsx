import { clsx } from "clsx"
import { Cable, Copy, ExternalLink, Globe, Loader2, MonitorPlay, Square } from "lucide-react"
import { useState, type ReactNode } from "react"
import { backgroundLabel, serverUrl, type HostTask as Task } from "@huntaway/client"
import type { BackgroundItem, PortForward, TaskServer } from "@huntaway/contracts"
import { useBoard } from "../../../state/board"
import { useNow } from "../../../state/clock"
import { exitError, useMutation } from "../../../state/mutation"
import { copyText, millisOf } from "../../ui"
import { duration } from "../../ui/time"
import { desktopForward, desktopForwards, forwardCommand, onTaskHost } from "./forwardPort"

/**
 * What the task's agent left going (HA-405), above its composer: the shells it has running in the background (a dev
 * server, a watcher), each with a Stop that ends it and leaves the agent be, and the servers its processes listen on,
 * with Open, Forward port (HE-81: shared with tailcat, for a client on another machine; HE-92: not on the task's host
 * itself) and Stop. Once the agent's turn has ended with only those left it's idle, not working, and a message reaches
 * it at once.
 */
export function BackgroundBanner({ task }: { task: Task }) {
  const shells = task.running ? (task.background_work?.tasks ?? []).filter((b) => b.kind !== "subagent") : []
  const servers = task.servers
  const [err, setErr] = useState<string | null>(null)
  if (!shells.length && !servers.length) return null
  const idle = !!task.background_work?.idle
  return (
    <div className="shrink-0 px-5 pb-2 narrow:px-2" data-background-banner>
      <div className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-panel-2/60 px-3 py-1.5 text-[12px]">
        {idle && (
          <div className="pb-0.5 text-[11px] text-faint">The agent has ended its turn: this goes on in the background, and your messages reach it at once.</div>
        )}
        {shells.map((b, i) => (
          <ShellRow key={b.id ?? i} task={task} item={b} onError={setErr} />
        ))}
        {servers.map((s) => (
          <ServerRow key={`${s.port}-${s.pid}`} task={task} server={s} onError={setErr} />
        ))}
        {err && <div className="py-0.5 text-[11px] text-red-400">{err}</div>}
      </div>
    </div>
  )
}

function ShellRow({ task, item, onError }: { task: Task; item: BackgroundItem; onError: (e: string | null) => void }) {
  const now = useNow(1000)
  const [state, stopBackground] = useMutation("tasks.stopBackground")
  const stop = (id: string) => {
    onError(null)
    void stopBackground(task.host_id, { id: task.id, background_id: id }).then((exit) => {
      const err = exitError(exit)
      if (err !== null) onError(`Couldn't stop it: ${err}`)
    })
  }
  const label = backgroundLabel(item)
  const title = [item.command, item.description && item.description !== item.command ? item.description : null].filter(Boolean).join("\n") || undefined
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5" data-background-item={item.id ?? undefined}>
      <MonitorPlay size={12} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-muted" title={title}>
        <span className="text-faint">{item.waited ? "Waiting on: " : "Background: "}</span>
        <span className="text-fg">{label}</span>
        {item.since && <span className="text-faint"> · running {duration(now - millisOf(item.since))}</span>}
      </span>
      {item.id && (
        <RowButton
          busy={state.busy}
          title="Stop this background command. The agent keeps its conversation, and is told it stopped."
          onClick={() => stop(item.id ?? "")}
        >
          <Square size={9} fill="currentColor" /> Stop
        </RowButton>
      )}
    </div>
  )
}

function ServerRow({ task, server, onError }: { task: Task; server: TaskServer; onError: (e: string | null) => void }) {
  const url = serverUrl(server, location.hostname)
  const [state, stopServer] = useMutation("tasks.stopServer")
  const [forwarding, forwardServer] = useMutation("tasks.forwardServer")
  // The host's share as Forward port last gave it, and where the desktop app forwarded it (or why it didn't).
  const [given, setShared] = useState<{ readonly share: PortForward; readonly local: string | null; readonly error: string | null } | null>(null)
  // HE-83: shown while the task says that share lasts (`forwarded`, when it started), so not once it ended or another
  // replaced it. A host older than HE-83 says neither, and it's shown until the row goes.
  const shared = given !== null && given.share.since === server.forwarded ? given : null
  const [opening, setOpening] = useState(false)
  const here = useBoard((s) => onTaskHost(task.host_id, s.localHostId, location.hostname))
  const forward = () => {
    onError(null)
    void forwardServer(task.host_id, { id: task.id, port: server.port }).then((exit) => {
      const err = exitError(exit)
      if (err !== null || exit._tag !== "Success") return onError(`Couldn't forward the port: ${err ?? "no answer"}`)
      const share = exit.value
      if (!desktopForwards()) return setShared({ share, local: null, error: null })
      setOpening(true)
      return desktopForward(share.address, share.port, task.host_id).then((local) => {
        setOpening(false)
        if (local !== null && "url" in local) {
          setShared({ share, local: local.url, error: null })
          window.open(local.url, "_blank", "noreferrer")
        } else setShared({ share, local: null, error: local?.error ?? null })
      })
    })
  }
  const stop = () => {
    onError(null)
    void stopServer(task.host_id, { id: task.id, port: server.port }).then((exit) => {
      const err = exitError(exit)
      if (err !== null) onError(`Couldn't stop the server: ${err}`)
    })
  }
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 py-0.5" data-server-port={server.port}>
        <Globe size={12} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-muted" title={`${server.command}\nListening on ${server.address}:${server.port} (pid ${server.pid})`}>
          <span className="text-fg">localhost:{server.port}</span>
          {server.detached && <span className="text-faint"> · outlives its run</span>}
          {server.forwarded !== undefined && (
            <span className="text-faint" data-server-shared>
              {" "}
              · Shared with tailcat
            </span>
          )}
          <span className="text-faint"> · {server.command}</span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={`Open ${url}`}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/5 hover:text-fg"
        >
          <ExternalLink size={10} /> Open
        </a>
        {!here && (
          <RowButton
            busy={forwarding.busy || opening}
            title={
              server.forwarded !== undefined && shared === null
                ? `Shared with tailcat: show how to make it localhost:${server.port} on this computer too`
                : `Share this server with tailcat, so that it's localhost:${server.port} on this computer too, wherever the board's host is`
            }
            onClick={forward}
          >
            {!(forwarding.busy || opening) && <Cable size={10} />} Forward port
          </RowButton>
        )}
        <RowButton busy={state.busy} title="Stop this server (its process group), not the agent" onClick={stop}>
          <Square size={9} fill="currentColor" /> Stop
        </RowButton>
      </div>
      {shared && <Forwarded {...shared} />}
    </>
  )
}

/** Where a forward of the server is: the desktop app's local URL, or the command to run here. */
function Forwarded({ share, local, error }: { share: PortForward; local: string | null; error: string | null }) {
  const [copied, setCopied] = useState(false)
  if (local !== null)
    return (
      <div className="flex min-w-0 items-center gap-1 pb-0.5 pl-5 text-[11px] text-faint" data-server-forward={share.port}>
        Forwarded here with tailcat:
        <a href={local} target="_blank" rel="noreferrer" className="truncate text-muted hover:text-fg hover:underline">
          {local}
        </a>
      </div>
    )
  const command = forwardCommand(share.address, share.port)
  return (
    <div className="min-w-0 pb-0.5 pl-5 text-[11px] text-faint" data-server-forward={share.port}>
      {error && <div className="text-red-400">{error}</div>}
      <div>
        Run this on the computer to reach it from, with{" "}
        <a href="https://tailscale.com/tailcat" target="_blank" rel="noreferrer" className="text-muted hover:text-fg hover:underline">
          tailcat
        </a>
        , then open localhost:{share.port} there. The address is a key to the server: keep it to yourself.
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1">
        <code className="min-w-0 flex-1 truncate rounded bg-black/20 px-1.5 py-0.5 font-mono text-muted" title={command}>
          {command}
        </code>
        <RowButton
          busy={false}
          title="Copy the command"
          onClick={() => {
            copyText(command)
            setCopied(true)
          }}
        >
          <Copy size={10} /> {copied ? "Copied" : "Copy"}
        </RowButton>
      </div>
    </div>
  )
}

function RowButton({ busy, title, onClick, children }: { busy: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className={clsx("flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-white/5 hover:text-fg disabled:opacity-60")}
    >
      {busy ? <Loader2 size={10} className="animate-spin" /> : null}
      {children}
    </button>
  )
}
