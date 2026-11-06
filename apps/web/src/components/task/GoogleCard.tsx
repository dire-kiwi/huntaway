// The assistant's Google card (API 113): whether its Google Workspace server (Gmail, Calendar and Drive, on the assistant's host)
// is connected and as whom, and if not, what's missing and how to set it up (see server-ts/src/agent/assistant/google.ts).
import clsx from "clsx";
import { Copy, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type GoogleStatus, type Task } from "../../api";
import { Button, copyText, IconButton } from "../ui";

/** A command to run, with a button that copies it. */
function Command({ text }: { text: string }) {
  return (
    <div className="mt-1 flex items-start gap-1 rounded border border-line bg-bg/60 px-2 py-1">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-fg/90">{text}</code>
      <IconButton className="h-5 w-5 shrink-0" title="Copy" onClick={() => copyText(text)}>
        <Copy size={11} />
      </IconButton>
    </div>
  );
}

export function GoogleCard({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId } = assistant;
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"setup" | "check" | null>(null);
  const load = useCallback(
    (check = false) =>
      api.googleStatus(hostId, profileId, check).then(
        (s) => {
          setSt(s);
          setErr(null);
        },
        (e) => setErr((e as Error).message),
      ),
    [hostId, profileId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (what: "setup" | "check") => {
    setBusy(what);
    try {
      if (what === "setup") {
        setSt(await api.setupGoogle(hostId, profileId));
        setErr(null);
      } else await load(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!st) return err ? <div className="text-[12px] text-red-400">{err}</div> : <Loader2 size={14} className="animate-spin text-muted" />;
  const serverMissing = !st.server || !st.server.on;
  const port = st.consent_port;
  return (
    <div className="space-y-2 text-[12.5px]" data-testid="google-card">
      <div className="flex items-center gap-2">
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", st.connected ? (st.verified === false ? "bg-amber-400" : "bg-emerald-400") : "bg-faint")} />
        <span className="min-w-0 flex-1 truncate text-fg">{st.connected ? `Connected as ${st.account}` : "Not connected"}</span>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("check")} title={st.connected ? "Check with Google that its sign-in still works" : "Look again"}>
          {busy === "check" && <Loader2 size={12} className="animate-spin" />} {st.connected ? "Test" : "Check again"}
        </Button>
      </div>
      <div className="text-muted">
        Gmail, Calendar and Drive for the assistant and its routines, through a Google Workspace MCP server on {st.host}. Project tasks don't get it.
      </div>
      {st.verified === true && <div className="text-emerald-400">Google took its sign-in just now.</div>}
      {st.verify_error && <div className="text-amber-300">{st.verify_error}</div>}
      {st.problem && <div className="text-amber-300">{st.problem}</div>}
      {st.warnings.map((w) => (
        <div key={w} className="text-amber-300/90">
          {w}
        </div>
      ))}
      {serverMissing && (
        <Button size="sm" disabled={!!busy} onClick={() => act("setup")}>
          {busy === "setup" && <Loader2 size={12} className="animate-spin" />} {st.server ? "Switch the Google server on" : "Add the Google server"}
        </Button>
      )}
      {!st.connected && (
        <details className="rounded-md border border-line/70 px-2.5 py-1.5" open={!serverMissing}>
          <summary className="cursor-pointer text-muted hover:text-fg">How to connect</summary>
          <ol className="mt-1.5 list-decimal space-y-2 pl-4 text-muted">
            <li>
              In Google Cloud, enable the Gmail, Calendar and Drive APIs and make an OAuth client of type <span className="text-fg">Desktop app</span>. Download
              its JSON to <span className="font-mono text-[11px] break-all text-fg/90">{st.client_secret.path}</span> on {st.host}, readable by you alone:
              <Command text={`chmod 600 ${st.client_secret.path}`} />
            </li>
            <li>
              Forward the sign-in's port from this machine:
              <Command text={`ssh -N -L ${port}:127.0.0.1:${port} ${st.host}`} />
              then sign in on {st.host}, and open the link it prints here:
              <Command text={st.consent_command} />
            </li>
            <li>Check again. The README's An assistant host has the details.</li>
          </ol>
        </details>
      )}
      {err && <div className="text-[12px] text-red-400">{err}</div>}
    </div>
  );
}
