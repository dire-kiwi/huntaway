import { Effect, Option, PubSub, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { Base64 } from "effect/encoding"
import { Socket } from "effect/socket"
import { BrowserClientFrame } from "@huntaway/contracts"
import type { BrowserPage, BrowserServerFrame } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import { num, pageOf, str } from "./cdp.ts"
import type { Cdp, CdpPage } from "./cdp.ts"

// One viewer of a task's headless browser (HE-62), after T3 Code's: a DevTools session of its own on the page, whose
// screencast (`Page.startScreencast`, JPEG) goes to the viewer as binary frames, one at a time: the next is sent once
// the viewer says it drew the last (`ack`), and only the newest waits meanwhile, so a slow link never queues stale
// pictures. Chrome's own acknowledgement of a frame waits for the viewer's too, so it draws no faster than the viewer
// takes them. The viewer's mouse, keys and text are replayed into the page with `Input.dispatch*`.

/** What a viewer needs of its tab. */
export interface ViewerTab {
  /** The browser's connection, and the page's target in it. */
  readonly cdp: Cdp
  readonly targetId: string
  /** The page's own session (the agent's), on which its size is set. */
  readonly main: CdpPage
  readonly info: SubscriptionRef.SubscriptionRef<BrowserPage>
  /** Read the page's address and title again (a script may change the title with no event). */
  readonly refresh: Effect.Effect<void>
  /** Set the page's size (CSS pixels), as the viewer asks. */
  readonly resize: (width: number, height: number) => Effect.Effect<{ readonly width: number; readonly height: number }>
  /** Load an address the viewer typed; fails with why it didn't load. */
  readonly navigate: (url: string) => Effect.Effect<void, { readonly reason: string }>
  /** Back, forward, reload. */
  readonly go: (go: "back" | "forward" | "reload") => Effect.Effect<void, { readonly reason: string }>
  /** Done once the desktop app's pane takes the tab: the viewer is told, and its socket closes. */
  readonly taken: Effect.Effect<void>
  /** Done once the page is gone (closed, or Chrome gone): the socket closes, and the viewer connects again to a new one. */
  readonly gone: Effect.Effect<void>
}

/** JPEG quality, and the largest frame sent. */
const QUALITY = 70
/** The "frame id" of a still: no frame of Chrome's. */
const STILL = -1
/** How long a new screencast is given to send a frame before the viewer gets a still. */
const STILL_AFTER = "300 millis"
/** How often a watched page's title is looked at. */
const TITLE_EVERY = "2 seconds"
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserClientFrame))
const decoder = new TextDecoder()

/** The viewer's text frames, until its socket closes. */
export const socketText = (reader: Socket.Reader): Stream.Stream<string> =>
  Stream.fromEffectRepeat(reader.pull).pipe(
    Stream.flattenIterable,
    Stream.map((f) => (typeof f === "string" ? f : decoder.decode(f))),
    Stream.orElseSucceed(() => ""),
    Stream.filter((t) => t !== ""),
  )

interface Frames {
  /** Chrome's id of the frame on the wire, which the viewer hasn't acknowledged yet. */
  readonly inFlight: number | null
  /** The newest frame that came meanwhile. */
  readonly waiting: { readonly data: Uint8Array; readonly ack: number } | null
}

/** Relay tab `tab` and a viewer's socket until the socket closes or the desktop app takes the tab. */
export const relayViewer = Effect.fnUntraced(function* (
  tab: ViewerTab,
  reader: Socket.Reader,
  writer: Socket.Writer,
  size: { readonly width: number; readonly height: number },
): Effect.fn.Return<void, never, Scope.Scope> {
  const say = (frame: BrowserServerFrame) => Effect.flatMap(toJson(frame), (t) => writer.write(t)).pipe(Effect.ignore)

  // A session of its own, for its screencast; detached when the viewer goes.
  const attached = yield* tab.cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true }).pipe(Effect.option)
  if (Option.isNone(attached)) return yield* say({ type: "error", message: "The page has closed." })
  const sessionId = str(attached.value, "sessionId")
  const page = pageOf(tab.cdp, sessionId)
  yield* Effect.addFinalizer(() => tab.cdp.send("Target.detachFromTarget", { sessionId }).pipe(Effect.ignore))

  const frames = yield* Ref.make<Frames>({ inFlight: null, waiting: null })
  // A still (`STILL`) is no frame of Chrome's: there's nothing to acknowledge.
  const ackChrome = (id: number) => (id === STILL ? Effect.void : page.send("Page.screencastFrameAck", { sessionId: id }).pipe(Effect.ignore))
  const sent = yield* Ref.make(false)
  const send = (data: Uint8Array) => Effect.andThen(Ref.set(sent, true), writer.write(data).pipe(Effect.ignore))

  const screencast = (s: { readonly width: number; readonly height: number }) =>
    Effect.andThen(
      page.send("Page.stopScreencast").pipe(Effect.ignore),
      page.send("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: s.width, maxHeight: s.height, everyNthFrame: 1 }).pipe(Effect.ignore),
    )
  // Chrome's frames: one on the wire, the newest waiting.
  const onFrame = (data: Uint8Array, ack: number) =>
    Effect.flatten(
      Ref.modify(frames, (f): readonly [Effect.Effect<void>, Frames] => {
        if (f.inFlight === null) return [send(data), { inFlight: ack, waiting: null }]
        // The one that was waiting is never sent, but Chrome still waits for its acknowledgement.
        return [f.waiting === null ? Effect.void : ackChrome(f.waiting.ack), { inFlight: f.inFlight, waiting: { data, ack } }]
      }),
    )
  const onAck = Effect.flatten(
    Ref.modify(frames, (f): readonly [Effect.Effect<void>, Frames] => {
      const done = f.inFlight === null ? Effect.void : ackChrome(f.inFlight)
      if (f.waiting === null) return [done, { inFlight: null, waiting: null }]
      return [Effect.andThen(done, send(f.waiting.data)), { inFlight: f.waiting.ack, waiting: null }]
    }),
  )
  // An idle page draws nothing for a new screencast: the viewer starts from a still unless a frame beats it.
  const still = Effect.gen(function* () {
    yield* Effect.sleep(STILL_AFTER)
    if (yield* Ref.get(sent)) return
    const shot = yield* page.send("Page.captureScreenshot", { format: "jpeg", quality: QUALITY }, "5 seconds").pipe(Effect.option)
    const bytes = Option.isSome(shot) ? Base64.decode(str(shot.value, "data")) : undefined
    if (bytes?._tag === "Success" && !(yield* Ref.get(sent))) yield* onFrame(bytes.success, STILL)
  })
  const resized = (w: number, h: number) =>
    Effect.gen(function* () {
      const s = yield* tab.resize(w, h)
      yield* say({ type: "viewport", width: s.width, height: s.height })
      yield* screencast(s)
      yield* Ref.set(sent, false)
      yield* still.pipe(Effect.forkScoped)
    })

  const sub = yield* tab.cdp.subscribe
  yield* PubSub.take(sub).pipe(
    Effect.flatMap((e) => {
      if (e.sessionId !== sessionId || e.method !== "Page.screencastFrame") return Effect.void
      const bytes = Base64.decode(str(e.params, "data"))
      return bytes._tag === "Success" ? onFrame(bytes.success, num(e.params, "sessionId")) : Effect.void
    }),
    Effect.forever,
    Effect.forkScoped,
  )

  // The page's address and title as they change.
  yield* say({ type: "page", ...(yield* SubscriptionRef.get(tab.info)) })
  yield* SubscriptionRef.changes(tab.info).pipe(
    Stream.runForEach((p) => say({ type: "page", ...p })),
    Effect.forkScoped,
  )

  yield* tab.refresh.pipe(Effect.repeat(Schedule.spaced(TITLE_EVERY)), Effect.forkScoped)
  yield* page.send("Page.enable").pipe(Effect.ignore)
  yield* resized(size.width, size.height)

  const mouse = (m: Extract<BrowserClientFrame, { readonly type: "mouse" }>) =>
    page.send("Input.dispatchMouseEvent", {
      type: m.action === "down" ? "mousePressed" : m.action === "up" ? "mouseReleased" : "mouseMoved",
      x: m.x,
      y: m.y,
      button: m.button,
      buttons: m.buttons,
      clickCount: m.clickCount,
      modifiers: m.modifiers,
    })
  const key = (k: Extract<BrowserClientFrame, { readonly type: "key" }>) => {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers }
    if (k.action === "up") return page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
    return page.send(
      "Input.dispatchKeyEvent",
      k.text === undefined || k.text === "" ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text },
    )
  }
  const failed = (e: { readonly reason: string }) => say({ type: "error", message: e.reason })

  const onMessage = (text: string): Effect.Effect<void, never, Scope.Scope> => {
    const m = decodeFrame(text)
    if (Option.isNone(m)) return Effect.void
    const f = m.value
    switch (f.type) {
      case "ack":
        return onAck
      case "resize":
        return resized(f.width, f.height)
      case "mouse":
        return mouse(f).pipe(Effect.ignore)
      case "wheel":
        return page
          .send("Input.dispatchMouseEvent", { type: "mouseWheel", x: f.x, y: f.y, deltaX: f.dx, deltaY: f.dy, modifiers: f.modifiers })
          .pipe(Effect.ignore)
      case "key":
        return key(f).pipe(Effect.ignore)
      case "text":
        return page.send("Input.insertText", { text: f.text }).pipe(Effect.ignore)
      // Loading a page can take a while: the viewer's input goes on meanwhile.
      case "navigate":
        return tab.navigate(f.url).pipe(Effect.catch(failed), Effect.forkScoped, Effect.asVoid)
      case "go":
        return f.go === "stop"
          ? tab.main.send("Page.stopLoading").pipe(Effect.ignore)
          : tab.go(f.go).pipe(Effect.catch(failed), Effect.forkScoped, Effect.asVoid)
    }
    return Effect.void
  }

  const input = socketText(reader).pipe(Stream.runForEach(onMessage))
  const taken = Effect.andThen(tab.taken, say({ type: "desktop" }))
  // 1012, "service restart": the viewer asks for a new ticket, which opens the task's page again where it was.
  const gone = Effect.andThen(tab.gone, writer.write(new Socket.CloseEvent(1012, "the page closed")).pipe(Effect.ignore))
  return yield* Effect.raceAll([input, taken, gone])
})
