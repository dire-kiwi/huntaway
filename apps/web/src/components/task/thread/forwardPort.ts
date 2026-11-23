// HE-81: forwarding a task's dev server to this computer, once its host shares it with tailcat (`tasks.forwardServer`).
// The desktop app runs `tailcat forward` itself (its bridge's `forwardPort`); in a browser the user runs it.

/** What the desktop app answers: the local URL, or why it has none. */
export type DesktopForward = { readonly url: string } | { readonly error: string }

/** The command that forwards the share at `address` to the same port here. */
export const forwardCommand = (address: string, port: number) => `tailcat forward ${address} ${port}`

/** Whether the page is the desktop app's, which forwards ports itself. */
export function desktopForwards(): boolean {
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  return typeof bridge === "object" && bridge !== null && typeof Reflect.get(bridge, "forwardPort") === "function"
}

/** What the bridge answered, as a `DesktopForward`. */
const answerOf = (answer: unknown): DesktopForward => {
  if (typeof answer === "object" && answer !== null) {
    const url: unknown = Reflect.get(answer, "url")
    if (typeof url === "string") return { url }
    const error: unknown = Reflect.get(answer, "error")
    if (typeof error === "string") return { error }
  }
  return { error: "The desktop app didn't say where it forwarded the port." }
}

/**
 * The desktop app's forward of the share at `address` (port `port` on host `host`), or null outside the app. Never
 * rejects. The app stops its forward of the host's last share of the port (HE-82), which a new one replaces.
 */
export function desktopForward(address: string, port: number, host: string): Promise<DesktopForward | null> {
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  const forward: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "forwardPort") : undefined
  if (typeof forward !== "function") return Promise.resolve(null)
  return Promise.resolve()
    .then((): unknown => Reflect.apply(forward, bridge, [address, port, host]))
    .then(answerOf, (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
}

/**
 * HE-92: whether the page runs on the task's host, so its servers are already localhost here and Forward port has
 * nothing to do: the page is the desktop app's with its board's server on this machine (`appServerHere`: no
 * `serverUrl` in desktop.json, so the app hands out its browser pane, `paneDebugger`), and the task is that server's
 * (`localHostId`), not a linked host's. A browser can't tell: `localhost` may be the host itself or a tunnel to it
 * from another computer (`ssh -L`), where the button is the way to reach the server, so it keeps it.
 */
export const onTaskHost = (taskHost: string, localHostId: string | null, appServerHere: boolean): boolean => appServerHere && taskHost === localHostId
