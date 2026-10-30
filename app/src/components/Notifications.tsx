import clsx from "clsx";
import { Bell } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  NOTIFY_EVENTS,
  NOTIFY_MODES,
  notifySettings,
  onNotifySettings,
  playsSound,
  saveNotifySettings,
  showsNotifications,
  type NotifyMode,
  type NotifySettings,
} from "../notifications";
import { chime, notifyPermission, showNotification, unlockSound } from "../notifier";
import { Button, Toggle } from "./ui";

/** Settings → Notifications: how this browser tells the user that a task needs them. */
export function NotificationsPanel() {
  const settings = useSyncExternalStore(onNotifySettings, notifySettings);
  const [permission, setPermission] = useState(notifyPermission);
  // Allowed or blocked in the browser's own site settings meanwhile.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let live = true;
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((s) => {
        if (!live) return;
        status = s;
        s.onchange = () => setPermission(notifyPermission());
      })
      .catch(() => {});
    return () => {
      live = false;
      if (status) status.onchange = null;
    };
  }, []);

  const save = (change: Partial<NotifySettings>) => saveNotifySettings({ ...notifySettings(), ...change });
  // Browsers only ask from a click.
  const enable = async () => {
    const answer = await Notification.requestPermission().catch(() => "denied" as const);
    setPermission(notifyPermission());
    const mode = notifySettings().mode;
    if (answer === "granted" && !showsNotifications(mode)) save({ mode: mode === "sound" ? "both" : "notify" });
  };
  const pick = (mode: NotifyMode) => {
    save({ mode });
    unlockSound();
    if (showsNotifications(mode) && permission === "default") enable();
  };
  const test = () => {
    if (playsSound(settings.mode)) chime("attention");
    if (showsNotifications(settings.mode)) showNotification("Huntaway", "Notifications are on. Tasks that need you will show like this.");
  };

  const unavailable = permission === "insecure" || permission === "unsupported" || permission === "denied" || permission === "preview";
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Notifications</h2>
      <div className="space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <p>
          Tell me when a task needs me, from this browser, while the board is open in it. One of its tabs or windows notifies, and none do for the
          task open in a focused window. These settings are kept in this browser.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Notify with">
            {NOTIFY_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.mode === m.id}
                onClick={() => pick(m.id)}
                className={clsx("rounded-md px-2.5 py-1 text-[12px]", settings.mode === m.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {m.label}
              </button>
            ))}
          </div>
          {settings.mode !== "off" && (
            <Button size="sm" onClick={test} disabled={!playsSound(settings.mode) && permission !== "granted"}>
              <Bell size={13} /> Try it
            </Button>
          )}
        </div>
        {showsNotifications(settings.mode) && (
          <div className={clsx("flex items-center gap-3 rounded-lg px-3 py-2", unavailable ? "bg-amber-400/10 text-amber-200" : "bg-white/5")}>
            <div className="min-w-0 flex-1">
              <PermissionNote permission={permission} />
            </div>
            {permission === "default" && (
              <Button size="sm" variant="primary" onClick={enable}>
                Enable
              </Button>
            )}
          </div>
        )}
        {playsSound(settings.mode) && <p className="text-faint">The sound plays once you've clicked or typed on the page since it loaded: browsers don't let a page play sound before that.</p>}
        <div className={clsx("space-y-2", settings.mode === "off" && "opacity-50")}>
          <div className="text-[12px] font-medium text-fg">When a task</div>
          {NOTIFY_EVENTS.map((e) => (
            <label key={e.id} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-accent"
                checked={settings.events[e.id]}
                onChange={(ev) => save({ events: { ...notifySettings().events, [e.id]: ev.target.checked } })}
              />
              <span>
                <span className="text-fg">{e.label}</span> <span className="text-faint">· {e.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Toggle
          checked={settings.count}
          onChange={(count) => save({ count })}
          label={<span>Count the tasks that need attention in the tab's title and icon{window.huntawayDesktop ? " and on the app's badge" : ""}</span>}
        />
      </div>
    </section>
  );
}

function PermissionNote({ permission }: { permission: ReturnType<typeof notifyPermission> }) {
  switch (permission) {
    case "granted":
      return <>This browser shows the board's notifications.</>;
    case "default":
      return <>This browser hasn't been allowed to show the board's notifications yet.</>;
    case "denied":
      return <>This browser blocks the board's notifications. Allow them in its settings for this site (from the icon beside the address), then reload.</>;
    case "insecure":
      return (
        <>
          Notifications can't work here: browsers only show them for secure pages, on HTTPS or localhost, and this page is plain HTTP on{" "}
          <span className="font-mono">{window.location.hostname}</span>. Open the board on localhost (through an SSH tunnel, say), over HTTPS (such as{" "}
          <code>tailscale serve</code>) or in the desktop app. The sound and the count still work.
        </>
      );
    case "unsupported":
      return <>This browser doesn't support notifications. The sound and the count still work.</>;
    case "preview":
      return <>This board is a preview (it signs in any browser that opens it), so it doesn't show system notifications. The sound and the count still work.</>;
  }
}
