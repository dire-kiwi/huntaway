import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"

// An atom's function run for its own sake, not a component's (as the web board's `startMove`,
// apps/web/src/components/boardHelpers.ts). A component's hook (`useAtomSet`) mounts the function only while the
// component is there, and a registry drops an atom nobody mounts (the app's after 400 ms), interrupting what it runs.
// So a change started from a sheet that closes at the tap would be cut off if the host took longer than that, and an
// optimistic one (`optimisticMove`) would then never be settled: the board would show its guess and take no more of
// the host's events.

/** How a run ended. */
export type Ended<A, E> = AsyncResult.Success<A, E> | AsyncResult.Failure<A, E>

/** Runs `fn` with `arg`, mounted in `registry` until its result is there, then tells `done`. */
export function runMounted<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  fn: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
  done: (result: Ended<A, E>) => void,
): void {
  const unmount = registry.mount(fn)
  const cancel = registry.subscribe(fn, (result) => {
    if (result._tag === "Initial" || result.waiting) return
    cancel()
    unmount()
    done(result)
  })
  registry.set(fn, arg)
}
