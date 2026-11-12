import { Effect, Option, Schema } from "effect"
import { createServer } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { gunzipSync } from "node:zlib"

// A fake ClickHouse for tests (docs/plan/10-testing.md, packages/testing; the old telemetry.test.ts's): an HTTP server
// on 127.0.0.1 that records each statement and insert it takes and fails as it is told. No test reaches a real one.

export interface FakeInsert {
  /** The statement: the `query` parameter for an insert, else the body. */
  readonly query: string
  readonly params: URLSearchParams
  readonly headers: IncomingHttpHeaders
  /** An insert's rows (its body's JSON lines), gunzipped. */
  readonly rows: ReadonlyArray<Record<string, unknown>>
}

export interface FakeClickHouse {
  url: string
  /** What it took, oldest first (failed requests aren't here). */
  readonly inserts: Array<FakeInsert>
  /** Answer the next requests with this status and `X-ClickHouse-Exception-Code` (`times` of them, else until cleared). */
  fail: { readonly status: number; readonly code: number; times?: number } | null
}

const JsonRow = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** A fake ClickHouse for the scope. */
export const fakeClickHouse = Effect.acquireRelease(
  Effect.callback<{ readonly fake: FakeClickHouse; readonly close: () => void }>((resume) => {
    const fake: FakeClickHouse = { url: "", inserts: [], fail: null }
    const server = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const params = new URL(req.url ?? "/", "http://x").searchParams
        const failing = fake.fail
        if (failing !== null) {
          if (failing.times !== undefined && --failing.times <= 0) fake.fail = null
          res
            .writeHead(failing.status, { "X-ClickHouse-Exception-Code": String(failing.code) })
            .end(`Code: ${failing.code}. DB::Exception: failed on purpose. (version 26.8.36.3 (official build))`)
          return
        }
        let body = Buffer.concat(chunks)
        if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body)
        const inQuery = params.get("query")
        const text = inQuery === null ? "" : body.toString("utf8")
        const rows = text
          .split("\n")
          .filter((l) => l !== "")
          .flatMap((l) => Option.toArray(Schema.decodeOption(JsonRow)(l)))
        fake.inserts.push({ query: inQuery ?? body.toString("utf8"), params, headers: req.headers, rows })
        res.writeHead(200).end("")
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      fake.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
      resume(Effect.succeed({ fake, close: () => server.close() }))
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ fake }) => fake))
