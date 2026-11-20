import { Effect, Predicate } from "effect"
import { ipcMain, webContents } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"

// HE-62: the browser pane's <webview>, given to the server to drive for the task's agent. The board asks for its
// guest's debugger (`huntaway:browser-debug`, by the guest's id), sends the server's DevTools protocol commands through
// it (`huntaway:browser-send`) and gets its events (`huntaway:browser-event`), which it relays over the browser's
// socket. Only the board's own frame may, and only for a <webview> it embeds: never the board itself or another
// window's. Electron has one debugger per page; it is let go when the board says, or when the guest goes.

/** What `send` answers: the command's result, or why it failed. */
export type SendAnswer = { readonly result: unknown } | { readonly error: string }

const CHANNELS = ["huntaway:browser-debug", "huntaway:browser-send"] as const

/**
 * Register the IPC; the function it gives unregisters it. `boardOrigin` is the board's origin, null before it has one.
 * `local` (`paneIsLocal`): the preload asks it (`huntaway:pane-local`), and gives the board no pane to hand over without.
 */
export const registerPaneDebugger = (
  boardOrigin: () => string | null,
  senderOrigin: (event: IpcMainEvent | IpcMainInvokeEvent) => string | null,
  runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>,
  local: boolean,
): (() => void) => {
  /** The guests being relayed, with the board page they relay to. */
  const relayed = new Map<number, WebContents>()

  /** The pane `id` names, if the sender is the board that embeds it. */
  const paneOf = (event: IpcMainEvent | IpcMainInvokeEvent, id: unknown): WebContents | null => {
    const board = boardOrigin()
    if (typeof id !== "number" || board === null || senderOrigin(event) !== board) return null
    const guest = webContents.fromId(id)
    if (guest === undefined || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== event.sender) return null
    return guest
  }

  const detach = (id: number) => {
    const guest = webContents.fromId(id)
    relayed.delete(id)
    if (guest !== undefined && !guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach()
  }

  ipcMain.on("huntaway:pane-local", (event) => {
    event.returnValue = local
  })

  ipcMain.handle("huntaway:browser-debug", (event, id: unknown) => {
    if (!local) return { error: "The board's server is on another machine: its tasks' browser is streamed from there." }
    const guest = paneOf(event, id)
    if (guest === null) return { error: "That isn't the board's browser pane." }
    if (relayed.has(guest.id)) return { result: true }
    if (!guest.debugger.isAttached()) {
      try {
        guest.debugger.attach("1.3")
      } catch (e) {
        return { error: `The pane's debugger is taken: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    const board = event.sender
    relayed.set(guest.id, board)
    guest.debugger.on("message", (_e, method: string, params: unknown, sessionId: string) => {
      // Only the page's own events: a session of a frame or worker inside it isn't the server's.
      if (sessionId !== "" || relayed.get(guest.id) !== board || board.isDestroyed()) return
      board.send("huntaway:browser-event", guest.id, method, params)
    })
    guest.debugger.on("detach", () => {
      if (relayed.get(guest.id) === board && !board.isDestroyed()) board.send("huntaway:browser-detached", guest.id)
      relayed.delete(guest.id)
    })
    guest.once("destroyed", () => relayed.delete(guest.id))
    return { result: true }
  })

  ipcMain.handle("huntaway:browser-send", (event, id: unknown, method: unknown, params: unknown) => {
    const guest = paneOf(event, id)
    if (guest === null || !relayed.has(guest.id)) return Promise.resolve<SendAnswer>({ error: "The pane isn't given to the server." })
    if (typeof method !== "string") return Promise.resolve<SendAnswer>({ error: "No method." })
    const args = Predicate.isObject(params) && !Array.isArray(params) ? params : {}
    return runPromise(
      Effect.tryPromise({ try: () => guest.debugger.sendCommand(method, args), catch: (e) => (e instanceof Error ? e.message : String(e)) }).pipe(
        Effect.map((result): SendAnswer => ({ result })),
        Effect.catch((error) => Effect.succeed<SendAnswer>({ error })),
      ),
    )
  })

  ipcMain.on("huntaway:browser-undebug", (event, id: unknown) => {
    const guest = paneOf(event, id)
    if (guest !== null && relayed.get(guest.id) === event.sender) detach(guest.id)
  })

  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel)
    ipcMain.removeAllListeners("huntaway:browser-undebug")
    ipcMain.removeAllListeners("huntaway:pane-local")
    for (const id of Array.from(relayed.keys())) detach(id)
  }
}
