import { Effect } from "effect"
import { createServer } from "node:http"

/** What a fake Space's port answers a path with. */
export interface FakeAnswer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export interface FakeSpacePort {
  readonly port: number
  /** Its answers by path; anything else is a 404. */
  readonly answers: Map<string, FakeAnswer>
  /** The paths asked for, in order. */
  readonly asked: Array<string>
}

/**
 * Whatever answers on a Space's port (HE-35), for the scope: a plain HTTP server on 127.0.0.1 with the answers a test
 * gives it, standing in for spacesd or for something that replaced it.
 */
export const fakeSpacePort = Effect.acquireRelease(
  Effect.callback<{ readonly fake: FakeSpacePort; readonly close: () => void }>((resume) => {
    const answers = new Map<string, FakeAnswer>()
    const asked: Array<string> = []
    const server = createServer((req, res) => {
      const path = req.url ?? "/"
      asked.push(path)
      const a = answers.get(path)
      if (a === undefined) res.writeHead(404).end("not found")
      else res.writeHead(a.status, { ...a.headers }).end(a.body ?? "")
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resume(Effect.succeed({ fake: { port, answers, asked }, close: () => server.close() }))
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ fake }) => fake))
