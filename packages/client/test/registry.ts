import { Effect, Layer } from "effect"
import { type Atom, AtomRegistry } from "effect/reactivity"
import { HostClient, HostSession, type Transport, transportAtom } from "../src/index.ts"
import type { FakeHost } from "./fakeHost.ts"

/** A registry whose page's own server is `own`, and whose other hosts are `others`; disposed with the scope. */
export const registryFor = (own: FakeHost, ...others: ReadonlyArray<FakeHost>) => {
  const transport: Transport = (host) => {
    const found = host === null ? own : others.find((o) => o.id === host)
    return found ? found.layer : Layer.effect(HostClient, Effect.die(new Error(`no fake host ${host}`))).pipe(Layer.provideMerge(HostSession.layer(true)))
  }
  return Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ initialValues: [[transportAtom, transport]] })),
    (registry) => Effect.sync(() => registry.dispose()),
  )
}

/** Waits for `atom` to hold a value `pass` accepts: what the code produces, not a sleep. */
export const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, pass: (a: A) => boolean): Effect.Effect<A> =>
  Effect.callback<A>((resume) => {
    const now = registry.get(atom)
    if (pass(now)) return resume(Effect.succeed(now))
    const cancel = registry.subscribe(atom, (a) => {
      if (!pass(a)) return
      cancel()
      resume(Effect.succeed(a))
    })
    return Effect.sync(cancel)
  })
