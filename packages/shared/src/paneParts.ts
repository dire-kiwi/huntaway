// Every runtime this package runs in has the WHATWG encoders; their types come with neither DOM's nor Node's.
declare const TextEncoder: new () => { encode(text: string): Uint8Array<ArrayBuffer> }
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string }

/** The most one part of a desktop pane's message holds (HE-71): far under the server's websocket limit (16 MiB). */
export const PANE_PART = 1024 * 1024
/** The most parts a message may have: 100 MiB, the most a pane's answer could be before the limit. */
export const PANE_MAX_PARTS = 100

/**
 * A desktop pane's message to the server (`/api/browser`, the `desktop` role) as the websocket messages that carry it
 * (HE-71): itself when it is at most `PANE_PART` long, else `{"parts":n}` and its UTF-8 in `n` binary parts, which the
 * server's `PaneJoin` puts back together. A DevTools answer (a whole page's accessibility tree, a screenshot) can be tens
 * of MiB, more than the server's websocket takes in one message. Null when it would take more than `PANE_MAX_PARTS`.
 */
export function paneParts(text: string): ReadonlyArray<string | Uint8Array<ArrayBuffer>> | null {
  if (text.length <= PANE_PART) return [text]
  const bytes = new TextEncoder().encode(text)
  const n = Math.ceil(bytes.byteLength / PANE_PART)
  if (n > PANE_MAX_PARTS) return null
  const parts: Array<string | Uint8Array<ArrayBuffer>> = [`{"parts":${n}}`]
  for (let i = 0; i < n; i++) parts.push(bytes.subarray(i * PANE_PART, (i + 1) * PANE_PART))
  return parts
}

const HEADER = /^\{"parts":(\d{1,3})\}$/u

/**
 * The server's side of `paneParts`: given each websocket message in turn, the pane's message once it is whole. A pane
 * sends a message's parts one after another, so only one is ever being put together.
 */
export class PaneJoin {
  private left = 0
  private parts: Array<Uint8Array> = []

  /** The message `frame` completes, if any; a part that doesn't fit what came before is dropped. */
  push(frame: string | Uint8Array): string | undefined {
    if (typeof frame === "string") {
      const header = HEADER.exec(frame)
      const n = header === null ? 0 : Number(header[1])
      if (n >= 1 && n <= PANE_MAX_PARTS) {
        this.left = n
        this.parts = []
        return undefined
      }
      this.left = 0
      this.parts = []
      return frame
    }
    if (this.left === 0) return new TextDecoder().decode(frame)
    this.parts.push(frame)
    this.left -= 1
    if (this.left > 0) return undefined
    const whole = new Uint8Array(this.parts.reduce((n, p) => n + p.byteLength, 0))
    let at = 0
    for (const p of this.parts) {
      whole.set(p, at)
      at += p.byteLength
    }
    this.parts = []
    return new TextDecoder().decode(whole)
  }
}
