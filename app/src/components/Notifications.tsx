import clsx from "clsx";
import { Bell, Smartphone, X } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, type PushDevice, type PushEvents } from "../api";
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
import { currentSubscription, pushSupport, subscribe, unsubscribe } from "../push";
import { Button, IconButton, timeAgo, Toggle } from "./ui";

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

  const unavailable = permission === "insecure" || permission === "unsupported" || permission === "denied";
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
      {pushSupport() !== "desktop" && <PushPanel />}
    </section>
  );
}

/**
 * Push to this device: the board sends its notifications to devices that turn it on, such as a phone with the board on
 * its home screen, even while the board isn't open on them (see push.ts). Each device picks its own events.
 */
function PushPanel() {
  const support = pushSupport();
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  // This browser's subscription's endpoint, which tells its device from the others.
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [{ subscriptions }, sub] = await Promise.all([api.push(), support === "ok" ? currentSubscription() : null]);
      setDevices(subscriptions);
      setEndpoint(sub?.endpoint ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [support]);
  useEffect(() => {
    load();
  }, [load]);
  const mine = devices?.find((d) => d.endpoint === endpoint);
  const others = devices?.filter((d) => d !== mine) ?? [];
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    setTested(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  const setEvents = (d: PushDevice, events: PushEvents) => {
    setDevices((ds) => ds?.map((x) => (x.id === d.id ? { ...x, events } : x)) ?? null);
    api.updatePushDevice(d.id, { events }).catch((e) => setErr((e as Error).message));
  };
  const test = (d: PushDevice) =>
    run(async () => {
      await api.testPush(d.id);
      setTested(d.id);
    });

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted" aria-label="Push">
      <div>
        <div className="mb-1 flex items-center gap-2 text-[12.5px] font-medium text-fg">
          <Smartphone size={14} /> Push to this device
        </div>
        <p>
          The board pushes notifications of these events to the devices that turn this on, even while the board isn't open on them: a phone with
          the board on its home screen, say. Tapping one opens the task. Each device picks its own events, whatever the setting above.
        </p>
      </div>
      {support !== "ok" ? (
        <div className="rounded-lg bg-amber-400/10 px-3 py-2 text-amber-200">
          <PushNote support={support} />
        </div>
      ) : mine ? (
        <div className="space-y-3 rounded-lg bg-white/5 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-fg">
              On for this device <span className="text-faint">· {mine.name}</span>
            </span>
            <Button size="sm" disabled={busy} onClick={() => test(mine)}>
              <Bell size={13} /> Send a test
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => unsubscribe(mine))}>
              Turn off
            </Button>
          </div>
          {tested === mine.id && <p className="text-emerald-300">Sent. It should show on this device in a moment.</p>}
          <DeviceEvents device={mine} onChange={(e) => setEvents(mine, e)} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="primary" disabled={busy || !devices} onClick={() => run(subscribe)}>
            Turn on push for this device
          </Button>
          {typeof Notification !== "undefined" && Notification.permission === "denied" && (
            <span className="text-amber-200">This browser blocks the board's notifications: allow them in its settings for this site first.</span>
          )}
        </div>
      )}
      {err && <p className="text-red-400">{err}</p>}
      {others.length > 0 && (
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-fg">Other devices</div>
          {others.map((d) => (
            <div key={d.id} className="rounded-lg border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-fg">{d.name || "A device"}</span>
                <span className="shrink-0 text-faint">{d.last_sent_at ? `last sent ${timeAgo(d.last_sent_at)}` : `added ${timeAgo(d.created_at)}`}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => test(d)} title={`Send ${d.name || "it"} a test notification`}>
                  Test
                </Button>
                <IconButton title={`Stop pushing to ${d.name || "this device"}`} disabled={busy} onClick={() => run(() => api.removePushDevice(d.id))}>
                  <X size={14} />
                </IconButton>
              </div>
              {tested === d.id && <p className="mt-1 text-emerald-300">Sent.</p>}
              {d.last_error && <p className="mt-1 text-amber-200">The last push failed: {d.last_error}</p>}
              <div className="mt-2">
                <DeviceEvents device={d} onChange={(e) => setEvents(d, e)} compact />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The events a device gets by push. */
function DeviceEvents({ device, onChange, compact }: { device: PushDevice; onChange: (e: PushEvents) => void; compact?: boolean }) {
  return (
    <div className={clsx(compact ? "flex flex-wrap gap-x-4 gap-y-1" : "space-y-2")} role="group" aria-label={`Events pushed to ${device.name}`}>
      {NOTIFY_EVENTS.map((e) => (
        <label key={e.id} className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={device.events[e.id]}
            onChange={(ev) => onChange({ ...device.events, [e.id]: ev.target.checked })}
          />
          <span>
            <span className="text-fg">{e.label}</span>
            {!compact && <span className="text-faint"> · {e.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function PushNote({ support }: { support: ReturnType<typeof pushSupport> }) {
  switch (support) {
    case "insecure":
      return (
        <>
          Push needs the board on HTTPS, and this page is plain HTTP on <span className="font-mono">{window.location.hostname}</span>. Serve the board
          over HTTPS at an address the device can reach, such as with <code>tailscale serve</code> (see <i>Push notifications</i> in the README), and
          open it there.
        </>
      );
    case "install":
      return (
        <>
          On an iPhone or iPad, push works for the board on the Home Screen: tap Share, then <i>Add to Home Screen</i>, open Huntaway from there, sign
          in with the board's token, and turn push on here.
        </>
      );
    default:
      return <>This browser can't receive push notifications.</>;
  }
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
  }
}
