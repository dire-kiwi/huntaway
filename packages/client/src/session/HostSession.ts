import { Clock, Context, Effect, Latch, Layer, SubscriptionRef } from "effect"
import type { HostInfo } from "@huntaway/contracts"

/**
 * A session's state (docs/plan/09-frontend.md, Sessions): `connecting` until the board stream first says hello, `live`
 * while it runs, `offline` from when it dropped (with why), `unauthorized` when the host turned the token down (the
 * page's own session shows the token screen), `needs_update` when the host speaks another protocol.
 */
export type SessionState =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "live" }
  | { readonly _tag: "offline"; readonly since: number; readonly error: string }
  | { readonly _tag: "unauthorized" }
  | { readonly _tag: "needs_update"; readonly protocol: number }

/** A session's state and what the host last said of itself (`host.info`, read on every connection). */
export interface SessionView {
  readonly state: SessionState
  readonly info: HostInfo | null
}

export const connecting: SessionView = { state: { _tag: "connecting" }, info: null }

/** One host's session: its state, and a latch that is open while its connection is. */
export class HostSession extends Context.Service<
  HostSession,
  {
    readonly view: SubscriptionRef.SubscriptionRef<SessionView>
    /** Open while the transport is connected: a subscription that dropped waits on it before it subscribes again. */
    readonly connected: Latch.Latch
  }
>()("@huntaway/client/session/HostSession") {
  /** A session whose connection starts open (an in-memory transport) or closed (a socket, until it connects). */
  static readonly layer = (open: boolean): Layer.Layer<HostSession> =>
    Layer.effect(
      HostSession,
      Effect.gen(function* () {
        return { view: yield* SubscriptionRef.make(connecting), connected: yield* Latch.make(open) }
      }),
    )
}

/** Sets a session's state. */
export const setState = (session: HostSession["Service"], state: SessionState): Effect.Effect<void> =>
  SubscriptionRef.update(session.view, (view) => ({ ...view, state }))

/** Marks a session offline from now. */
export const setOffline = (session: HostSession["Service"], error: string): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (since) => setState(session, { _tag: "offline", since, error }))
