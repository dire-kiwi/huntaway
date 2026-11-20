import { createServer as createHttpServer } from "node:http"
import { connect, createServer } from "node:net"
import type { Socket } from "node:net"
import { Effect } from "effect"

export interface FakeSocks {
  /** Its address, as the host's `socks_proxy` setting takes it: `socks5://127.0.0.1:<port>`. */
  readonly url: string
  /** The `host:port` of each connection asked for, in order (a name stays a name: it's resolved here, not by the client). */
  readonly asked: Array<string>
}

/** The address of a SOCKS5 CONNECT request in `b` (after its four header bytes), and the request's length; null until whole. */
const target = (b: Buffer): { readonly host: string; readonly port: number; readonly length: number } | null => {
  if (b.length < 5) return null
  const type = b[3]
  const start = type === 3 ? 5 : 4
  const size = type === 1 ? 4 : type === 4 ? 16 : (b[4] ?? 0)
  const end = start + size
  if (b.length < end + 2) return null
  const raw = b.subarray(start, end)
  const host = type === 3 ? raw.toString("latin1") : type === 1 ? [...raw].join(".") : (raw.toString("hex").match(/.{4}/gu)?.join(":") ?? "")
  return { host, port: b.readUInt16BE(end), length: end + 2 }
}

/**
 * A SOCKS5 proxy (HE-67) on 127.0.0.1 (or `on`), for the scope: no sign-in, CONNECT only, and every connection asked for goes to
 * 127.0.0.1:`to`, whatever its host, so a test can open `http://preview.test/` and get its own server.
 */
export const fakeSocks = (to: number, on = "127.0.0.1") =>
  Effect.acquireRelease(
    Effect.callback<{ readonly fake: FakeSocks; readonly close: () => void }>((resume) => {
      const asked: Array<string> = []
      const open = new Set<Socket>()
      const server = createServer((client) => {
        open.add(client)
        client.on("close", () => open.delete(client))
        client.on("error", () => client.destroy())
        let buffered = Buffer.alloc(0)
        let greeted = false
        const onData = (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk])
          if (!greeted) {
            if (buffered.length < 2 || buffered.length < 2 + (buffered[1] ?? 0)) return
            buffered = buffered.subarray(2 + (buffered[1] ?? 0))
            greeted = true
            client.write(Buffer.from([5, 0]))
          }
          const t = target(buffered)
          if (t === null) return
          client.off("data", onData)
          asked.push(`${t.host}:${t.port}`)
          const rest = buffered.subarray(t.length)
          const upstream = connect(to, "127.0.0.1", () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            if (rest.length > 0) upstream.write(rest)
            client.pipe(upstream)
            upstream.pipe(client)
          })
          open.add(upstream)
          upstream.on("close", () => {
            open.delete(upstream)
            client.destroy()
          })
          upstream.on("error", () => client.destroy())
          client.on("close", () => upstream.destroy())
        }
        client.on("data", onData)
      })
      server.listen(0, on, () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : 0
        const close = () => {
          for (const s of open) s.destroy()
          server.close()
        }
        resume(Effect.succeed({ fake: { url: `socks5://${on.includes(":") ? `[${on}]` : on}:${port}`, asked }, close }))
      })
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ fake }) => fake))

/**
 * A web server on a free port of 127.0.0.1 that answers every page with its Host header as its title, for the scope;
 * `/moved` redirects (302) to `/`.
 */
export const hostEcho = Effect.acquireRelease(
  Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
    const server = createHttpServer((req, res) =>
      req.url === "/moved"
        ? res.writeHead(302, { location: "/" }).end()
        : res.writeHead(200, { "content-type": "text/html" }).end(`<title>${req.headers.host ?? ""}</title>`),
    )
    server.listen(0, "127.0.0.1", () => {
      const a = server.address()
      resume(Effect.succeed({ port: typeof a === "object" && a !== null ? a.port : 0, close: () => server.close() }))
    })
  }),
  (s) => Effect.sync(() => s.close()),
)
