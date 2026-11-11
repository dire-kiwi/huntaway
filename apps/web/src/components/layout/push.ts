import type { PushDevice, PushEventsPatch } from "@huntaway/contracts"
import { navigate, openTask } from "../../state/route"
import { hubRpc } from "../../state/rpc"
import { notifySettings } from "../../state/notify"
import { inDesktopApp } from "./notifier"

// Web Push on this device (the old push.ts): the board's notifications pushed to it by the board (apps/server/src/push)
// even while the board isn't open, and shown by its service worker (public/sw.js). For a phone, with the board added
// to its home screen.

/** Whether this browser can have push: and if not, why. */
export type PushSupport = "ok" | "insecure" | "install" | "desktop" | "unsupported"

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

/** Opened from the home screen (or as an installed app), not in a browser tab. */
const installed = () => window.matchMedia("(display-mode: standalone)").matches || Reflect.get(navigator, "standalone") === true

export function pushSupport(): PushSupport {
  // The desktop app notifies by itself, and Electron has no push service.
  if (inDesktopApp()) return "desktop"
  // Service workers and push are only for secure pages: HTTPS, and localhost.
  if (!window.isSecureContext) return "insecure"
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    // iOS and iPadOS only push to the board added to the home screen.
    return IOS && !installed() ? "install" : "unsupported"
  }
  return "ok"
}

/** What this device is, to tell it from the others in the list: "Chrome on Android", say. */
export function deviceName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser"
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : ""
  return `${installed() ? "Huntaway" : browser}${os ? ` on ${os}` : ""}`
}

/** The service worker's registration, if it's running (without waiting long for one that won't). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  const timeout = Promise.withResolvers<null>()
  setTimeout(() => timeout.resolve(null), 5_000)
  return Promise.race([navigator.serviceWorker.ready, timeout.promise])
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration())?.pushManager.getSubscription() ?? null
}

const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

/** Whether subscription `sub` was made for the board's key `publicKey`; the board's data may have been made again since. */
function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options.applicationServerKey
  if (!key) return false
  const a = new Uint8Array(key)
  const b = fromB64(publicKey)
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The endpoint of the subscription this browser last sent the board. */
const SENT_KEY = "ia.push.endpoint"

function noteSent(endpoint: string | null): void {
  try {
    if (endpoint) window.localStorage.setItem(SENT_KEY, endpoint)
    else window.localStorage.removeItem(SENT_KEY)
  } catch {
    // It's sent again, or not, on the next load.
  }
}

/** Sends subscription `sub` to the board; `events` are the device's to start with (it keeps its own otherwise). */
async function send(sub: PushSubscription, events?: PushEventsPatch): Promise<PushDevice> {
  const keys = sub.toJSON().keys ?? {}
  const device = await hubRpc("hub.push.subscribe", {
    endpoint: sub.endpoint,
    keys: { p256dh: keys["p256dh"] ?? "", auth: keys["auth"] ?? "" },
    name: deviceName(),
    ...(events && { events }),
  })
  noteSent(sub.endpoint)
  return device
}

/** Turns push on for this device (asking the browser's permission first): with the events this browser notifies of. */
export async function subscribe(): Promise<PushDevice> {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("The browser wasn't allowed to show the board's notifications.")
  const reg = await registration()
  if (!reg) throw new Error("The board's service worker isn't running in this browser; reload the page and try again.")
  const { public_key } = await hubRpc("hub.push.info", undefined)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub, public_key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(public_key) })
  return send(sub, notifySettings().events)
}

/** Turns push off for this device: the browser's subscription, and the board's copy of it (`device`). */
export async function unsubscribe(device: PushDevice | undefined): Promise<void> {
  await (await currentSubscription())?.unsubscribe()
  noteSent(null)
  if (device) await hubRpc("hub.push.unsubscribe", { id: device.id })
}

/**
 * When the page opens, sends the board this browser's subscription if its push service replaced the one it had (see
 * sw.js), with that one's events. One the board dropped otherwise (removed from another device) is turned off here too.
 */
async function resend(): Promise<void> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return
  const sub = await currentSubscription()
  if (!sub) return
  const { public_key, subscriptions } = await hubRpc("hub.push.info", undefined)
  if (subscriptions.some((d) => d.endpoint === sub.endpoint)) return
  const sent = window.localStorage.getItem(SENT_KEY)
  const old = subscriptions.find((d) => d.endpoint === sent)
  if (sent && sent !== sub.endpoint && sameKey(sub, public_key)) {
    await send(sub, old?.events ?? notifySettings().events)
    if (old) await hubRpc("hub.push.unsubscribe", { id: old.id })
  } else {
    await sub.unsubscribe()
    noteSent(null)
  }
}

/** A message from the service worker: a tapped notification's task or page, to open in this window. */
function opened(data: unknown): void {
  if (typeof data !== "object" || data === null) return
  const type: unknown = Reflect.get(data, "type")
  const taskId: unknown = Reflect.get(data, "task_id")
  const url: unknown = Reflect.get(data, "url")
  if (type === "open-task" && typeof taskId === "string" && taskId) openTask(taskId)
  else if (type === "open" && typeof url === "string") navigate(new URL(url).pathname)
}

/**
 * Registers the service worker, which shows push notifications, and opens the task a notification is for when it's
 * tapped while the board is open. Once per page (main.tsx).
 */
export function startPush(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext || inDesktopApp()) return
  navigator.serviceWorker.register("/sw.js").catch(() => {})
  navigator.serviceWorker.addEventListener("message", (e) => opened(e.data))
  resend().catch(() => {})
}
