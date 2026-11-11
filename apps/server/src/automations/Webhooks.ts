import { Clock, Context, Effect, Layer, Ref } from "effect"
import { Mac } from "effect/crypto"
import { AutomationRepo } from "./AutomationRepo.ts"
import { Automations } from "./Automations.ts"
import { parseDelivery } from "./delivery.ts"
import { RATE_PER_MINUTE } from "./model.ts"

// A webhook delivery, `POST /api/hooks/<id>/<token>` (docs/plan/06-server.md, Automations; huntaway's automations/
// running.ts `webhook`; inventory 06 9): the one route that doesn't take the board's token. The checks, in order: the
// token (an unknown id, a wrong token and a schedule are the same 404, compared in constant time), the rate (counted
// after the signature check, with a bucket of its own for unsigned deliveries, so anyone with the URL can't use up the
// minute's deliveries), then `Automations.receive` (signature, on, ping, filters, dedupe, coalesce). Answered 202 once a
// run is recorded, before its action runs. The body's size (`MAX_BODY`, 413) is the route's.

/** An answer to the sender: its HTTP status and JSON body. The sender sees why a delivery was turned away, never what went wrong inside or the task it made. */
export interface WebhookAnswer {
  readonly status: number
  readonly body: Readonly<Record<string, unknown>>
}

export interface WebhooksShape {
  /** A delivery: the path's id and token, its headers (lower case), its query string and its body as sent. */
  readonly deliver: (
    id: string,
    token: string,
    headers: Readonly<Record<string, string | undefined>>,
    query: string | null,
    body: Uint8Array,
  ) => Effect.Effect<WebhookAnswer>
}

const STATUS: Readonly<Record<string, number>> = { rejected: 401, skipped: 409, failed: 500, duplicate: 200 }

const notFound: WebhookAnswer = { status: 404, body: { error: "no such webhook" } }

export class Webhooks extends Context.Service<Webhooks, WebhooksShape>()("huntaway-server/automations/Webhooks") {
  static readonly layer = Layer.effect(
    Webhooks,
    Effect.gen(function* () {
      const repo = yield* AutomationRepo
      const automations = yield* Automations
      /** Deliveries taken in the last minute, by automation (`<id>:unsigned` apart): their times. */
      const recent = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map())

      /** Whether an automation's bucket can take another delivery this minute (and counts it if so). */
      const allow = (bucket: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.modify(recent, (all): readonly [boolean, ReadonlyMap<string, ReadonlyArray<number>>] => {
            const next = new Map<string, ReadonlyArray<number>>()
            for (const [k, times] of all) {
              const kept = times.filter((t) => now - t <= 60_000)
              if (kept.length > 0) next.set(k, kept)
            }
            const times = next.get(bucket) ?? []
            if (times.length >= RATE_PER_MINUTE) return [false, next]
            next.set(bucket, [...times, now])
            return [true, next]
          }),
        )

      const encoder = new TextEncoder()
      const sameSecret = (a: string, b: string) => Mac.timingSafeEqual(encoder.encode(a), encoder.encode(b))

      const deliver = Effect.fn("Webhooks.deliver")(function* (
        id: string,
        token: string,
        headers: Readonly<Record<string, string | undefined>>,
        query: string | null,
        body: Uint8Array,
      ) {
        const a = yield* repo.get(id)
        if (a === null || a.trigger.kind !== "webhook" || !sameSecret(a.token, token)) return notFound
        const signature = headers["x-hub-signature-256"] ?? null
        const secret = a.secret === null || a.secret === "" ? null : a.secret
        const genuine = secret === null || (yield* automations.signed(secret, body, signature))
        if (!(yield* allow(genuine ? a.id : `${a.id}:unsigned`))) {
          return { status: 429, body: { error: `too many deliveries: at most ${RATE_PER_MINUTE} a minute` } }
        }
        const delivery = parseDelivery(headers, query, body)
        const answered = yield* automations.receive(a, delivery, { body, signature }).pipe(
          Effect.map((run): WebhookAnswer => {
            const detail = run.status === "failed" ? "the automation's action failed: see its deliveries on the board" : run.detail
            return { status: STATUS[run.status] ?? 202, body: { run: run.id, status: run.status, detail } }
          }),
          Effect.catchTag("TooManyWaiting", (e) => Effect.succeed<WebhookAnswer>({ status: 429, body: { error: e.reason } })),
          Effect.catchDefect((defect) =>
            Effect.as(Effect.logWarning(`webhook delivery to automation ${a.id}`, defect), { status: 500, body: { error: "the delivery couldn't be taken" } }),
          ),
        )
        return answered
      })

      return Webhooks.of({ deliver })
    }),
  )
}
