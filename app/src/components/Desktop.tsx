import { CircleAlert, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { desktop, useDesktopUpdate, type DesktopUpdateState } from "../desktop";
import { Button, Modal, timeAgo } from "./ui";

/** Sidebar prompt shown in the desktop app once a newer release has been downloaded. */
export function DesktopUpdateButton() {
  const state = useDesktopUpdate();
  const [open, setOpen] = useState(false);
  if (!state || (state.status !== "ready" && state.status !== "installing")) return null;
  const installing = state.status === "installing";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Huntaway ${state.available?.version} is ready to install (you have ${state.version})`}
        className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-md bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/15"
      >
        {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        <span className="truncate">{installing ? "Installing update…" : `Huntaway ${state.available?.version} · Update`}</span>
      </button>
      {open && <DesktopUpdateModal state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

function DesktopUpdateModal({ state, onClose }: { state: DesktopUpdateState; onClose: () => void }) {
  const installing = state.status === "installing";
  return (
    <Modal title="Update Huntaway" onClose={installing ? () => {} : onClose}>
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          Huntaway <span className="font-mono text-fg">{state.available?.version}</span> is downloaded and ready to install (you have{" "}
          <span className="font-mono">{state.version}</span>). Installing asks for your password, updates the package with <code>pacman</code>, then
          restarts the app and its server. Running agents keep going and the new server picks them back up.
        </p>
        {state.available?.url && (
          <a href={state.available.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
            What's new <ExternalLink size={12} />
          </a>
        )}
        {state.error && <UpdateError error={state.error} />}
        <div className="flex justify-end gap-2">
          {!installing && (
            <Button variant="ghost" onClick={onClose}>
              Later
            </Button>
          )}
          <Button variant="primary" disabled={installing} onClick={() => desktop?.update.install()}>
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {installing ? "Installing…" : "Install and restart"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function UpdateError({ error }: { error: string }) {
  return (
    <div className="flex gap-2 rounded bg-red-500/10 p-2 text-[12px] break-words whitespace-pre-wrap text-red-300">
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{error}</div>
    </div>
  );
}

function statusLine(s: DesktopUpdateState) {
  if (!s.supported) return s.reason ?? "This build doesn't update itself.";
  switch (s.status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading ${s.available?.version}${s.percent ? ` (${s.percent}%)` : ""}…`;
    case "ready":
      return `${s.available?.version} is ready to install.`;
    case "installing":
      return `Installing ${s.available?.version}…`;
    case "none":
      return `Up to date${s.checkedAt ? `, checked ${timeAgo(s.checkedAt)}` : ""}.`;
    case "error":
      return "The last check for updates failed.";
    default:
      return "Checks for updates on start and every few hours.";
  }
}

/** Desktop app section on the Settings page (only in the desktop app). */
export function DesktopPanel() {
  const state = useDesktopUpdate();
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "installing";
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Desktop app</h2>
        {state.status === "ready" || state.status === "installing" ? (
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            <Download size={13} /> Install {state.available?.version}
          </Button>
        ) : (
          <Button size="sm" onClick={() => desktop?.update.check()} disabled={!state.supported || busy}>
            <RefreshCw size={13} className={busy ? "animate-spin" : undefined} /> Check for updates
          </Button>
        )}
      </div>
      <div className="space-y-1.5 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <div>
          Version <span className="font-mono text-fg">{state.version}</span>. {statusLine(state)}
        </div>
        {state.error && state.status !== "ready" && <UpdateError error={state.error} />}
      </div>
      {open && <DesktopUpdateModal state={state} onClose={() => setOpen(false)} />}
    </section>
  );
}
