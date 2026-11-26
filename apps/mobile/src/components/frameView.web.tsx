import { useEffect, useImperativeHandle, useRef } from "react"
import type { FrameHandle, FrameViewProps } from "./frameView"

// frameView.tsx for the app's web build (a check on a computer; react-native-webview has no web): the page in a
// sandboxed frame with no origin, as the web board shows it. The app's types have no DOM, so the little of it this
// touches is said here.

export type { FrameHandle, FrameViewProps }

/** A window as far as a frame's messages need it. */
interface Posts {
  readonly postMessage: (message: unknown, target: string) => void
}

const posts = (v: unknown): v is Posts =>
  (typeof v === "object" || typeof v === "function") && v !== null && typeof Reflect.get(v, "postMessage") === "function"

interface Listens {
  readonly addEventListener: (type: "message", listener: (event: unknown) => void) => void
  readonly removeEventListener: (type: "message", listener: (event: unknown) => void) => void
}

const listens = (v: unknown): v is Listens =>
  typeof v === "object" && v !== null && typeof Reflect.get(v, "addEventListener") === "function" && typeof Reflect.get(v, "removeEventListener") === "function"

/** The frame element's window, if it has one yet. */
const windowOf = (frame: unknown): unknown => (typeof frame === "object" && frame !== null ? Reflect.get(frame, "contentWindow") : null)

export function FrameView({ html, title, height, onMessage, ref }: FrameViewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  useImperativeHandle(
    ref,
    () => ({
      deliver: (reply) => {
        const w = windowOf(frame.current)
        if (posts(w)) w.postMessage(reply, "*")
      },
    }),
    [],
  )
  useEffect(() => {
    const page: unknown = globalThis
    if (!listens(page)) return undefined
    const listener = (event: unknown): void => {
      if (typeof event !== "object" || event === null) return
      const from: unknown = Reflect.get(event, "source")
      if (from === null || from !== windowOf(frame.current)) return
      onMessage(Reflect.get(event, "data"))
    }
    page.addEventListener("message", listener)
    return () => page.removeEventListener("message", listener)
  }, [onMessage])
  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      srcDoc={html}
      style={{ border: 0, width: "100%", display: "block", ...(height === null ? { flex: 1, height: "100%" } : { height }) }}
    />
  )
}
