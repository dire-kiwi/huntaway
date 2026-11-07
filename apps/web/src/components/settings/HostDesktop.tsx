import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type DesktopStatus } from "../../api";
import { Button, Toggle, timeAgo, useConfirm } from "../ui";

const SESSION: Record<string, string> = { wayland: "a Wayland session", x11: "an X11 session", macos: "macOS" };

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/**
 * Computer use on a host (API 128, HA-273): install Cua Driver, and let the host's agents see and use its desktop
 * through their `desktop` tools. Its actions ask first, as any tool does.
 */
export function HostDesktop({ hostId }: { hostId: string }) {
  const [st, setSt] = useState<DesktopStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const installing = !!st?.install && st.install.phase !== "done" && st.install.phase !== "failed";
  const load = useCallback(() => api.desktopStatus(hostId).then(setSt, (e) => setErr((e as Error).message)), [hostId]);
  useEffect(() => {
    void load();
    const id = setInterval(load, installing ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [load, installing]);
  // A host that can't say (an older one) has nothing to show.
  if (!st) return null;

  const act = async (what: string, f: () => Promise<DesktopStatus & { check?: string }>) => {
    setErr(null);
    setBusy(what);
    try {
      const next = await f();
      setSt(next);
      if (next.check !== undefined) setCheck(next.check);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const inst = st.installed;
  const outdated = inst?.source === "installed" && st.release && inst.version !== st.release.version;
  const failed = st.install?.phase === "failed" ? st.install : null;
  const d = st.driver;

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Computer use</h2>
        <div className="flex items-center gap-2">
          {inst && (
            <Button size="sm" variant="ghost" disabled={!!busy || installing} onClick={() => act("check", () => api.checkDesktopDriver(hostId))}>
              {busy === "check" && <Loader2 size={12} className="animate-spin" />} Check
            </Button>
          )}
          {st.release && (!inst || outdated) && (
            <Button size="sm" disabled={!!busy || installing} onClick={() => act("install", () => api.installDesktopDriver(hostId))}>
              {installing ? <Loader2 size={12} className="animate-spin" /> : null}
              {outdated ? `Update Cua Driver to ${st.release.version}` : `Install Cua Driver ${st.release.version}`}
            </Button>
          )}
          {inst?.source === "installed" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy || installing}
              onClick={() =>
                confirm.ask({
                  title: "Remove Cua Driver",
                  body: `Remove Cua Driver ${inst.version} from this host? Agents here lose their desktop tools from their next run.`,
                  action: "Remove",
                  danger: true,
                  onConfirm: () => act("remove", () => api.uninstallDesktopDriver(hostId)),
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-2 text-[12.5px] text-muted">
        <p>
          Let agents on this host see and use its desktop through{" "}
          <a className="text-accent hover:underline" href="https://github.com/trycua/cua" target="_blank" rel="noreferrer">
            Cua Driver
          </a>
          : they read apps' windows and click and type in them, in the background, without taking the pointer or focus. Looking needs no approval; acting,
          starting apps and the clipboard ask first, unless the task runs in Bypass. One task drives the desktop at a time, and nothing runs while the screen is
          locked.
        </p>
        {installing && st.install && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-fg">
              <Loader2 size={13} className="animate-spin text-accent" />
              {st.install.phase === "downloading"
                ? `Downloading Cua Driver ${st.install.version}… ${mb(st.install.received)} of ${mb(st.install.total)}`
                : `${st.install.phase[0].toUpperCase()}${st.install.phase.slice(1)}…`}
            </div>
            <div className="h-1 overflow-hidden rounded bg-line">
              <div className="h-full bg-accent" style={{ width: `${Math.round((st.install.received / Math.max(1, st.install.total)) * 100)}%` }} />
            </div>
          </div>
        )}
        {failed && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">Install failed: {failed.error}</div>}
        {!st.release && !inst && <div>Cua Driver has no release for this host's platform ({st.platform}).</div>}
        {inst && (
          <div className="space-y-1">
            <div>
              {inst.source === "installed" ? `Cua Driver ${inst.version}` : inst.source === "env" ? "Cua Driver from IA_CUA_DRIVER" : "Cua Driver from PATH"},{" "}
              <span className="font-mono break-all text-fg">{inst.path}</span>
            </div>
            <div>
              {st.session
                ? `On ${SESSION[st.session] ?? st.session}`
                : "No graphical session found: the driver needs one (DISPLAY or WAYLAND_DISPLAY), so log in on that machine"}
              {st.locked ? ", with the screen locked" : ""}.{" "}
              {d.state === "running"
                ? `The driver is running${d.version ? ` (${d.version})` : ""}${d.last_call_at ? `, last used ${timeAgo(d.last_call_at)}` : ""}.`
                : d.state === "starting"
                  ? "The driver is starting."
                  : "The driver starts when an agent uses the desktop."}
              {st.in_use_by && <> In use by “{st.in_use_by.title}”.</>}
            </div>
            {d.state === "failed" && d.error && (
              <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{d.error}</div>
            )}
            {check !== null && <pre className="max-h-48 overflow-auto rounded bg-raised p-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg">{check}</pre>}
            <div className="pt-1">
              <Toggle
                checked={st.enabled}
                onChange={(v) => act("enable", () => api.setDesktopEnabled(hostId, v))}
                label={<span>Let agents on this host use its desktop (from their next run)</span>}
              />
            </div>
            {st.session === "wayland" && (
              <div className="text-[12px] text-faint">
                On Hyprland, Cua's background input needs its experimental plugin; without it, agents can act only in the foreground (moving the pointer and
                focus), which they ask you for first.
              </div>
            )}
          </div>
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
      </div>
      {confirm.dialog}
    </section>
  );
}
