import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"

export class Clock2 extends Context.Service<Clock2, { readonly now: Effect.Effect<number> }>()("wrong/key") {}

export const stamp = Effect.gen(function* () {
  const started = Date.now()
  try {
    yield* Effect.log("x")
  } catch {
    console.log("never")
  }
  Effect.log("floating")
  setTimeout(() => {}, 10)
  const port = process.env.PORT
  const anything: any = JSON.parse("{}")
  return [started, port, anything, yield* HttpClient.HttpClient] as const
})

export async function old(): Promise<number> {
  return Math.random()
}

export const provided = stamp.pipe(Effect.provide(Layer.empty))
