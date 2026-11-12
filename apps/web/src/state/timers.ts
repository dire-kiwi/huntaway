import { Duration, Effect, Schedule } from "effect"
import { Atom } from "effect/reactivity"
import { registry } from "./registry"

// Timers for the DOM's sake (a "Copied" label that goes, a focus after a frame's work, a retry), on Effect's clock
// through the page's registry rather than `setTimeout`: a test can move the clock, and cancelling interrupts the fiber.
// A read that is polled is a query's `refresh`, and a clock on screen is `useNow` (clock.ts), not one of these.

/** Runs `effect` as an atom of the registry until it ends (then lets the atom go); the returned function interrupts it. */
function start(effect: Effect.Effect<void>): () => void {
  const state = { done: false, unmount: (): void => {} }
  const stop = (): void => {
    if (state.done) return
    state.done = true
    state.unmount()
  }
  const fn = Atom.fn<void>()(() => Effect.ensuring(effect, Effect.sync(stop)))
  state.unmount = registry.mount(fn)
  registry.set(fn, undefined)
  return () => {
    if (state.done) return
    registry.set(fn, Atom.Interrupt)
    stop()
  }
}

/**
 * Calls `f` once after `duration` (`after("1.5 seconds", () => setCopied(false))`); the returned function cancels it.
 * `after(0, f)` waits for the browser's next task, as `setTimeout(f)` did (a zero sleep only yields to other fibers),
 * so what handles the event being dispatched now still sees the page as it was.
 */
export function after(duration: Duration.Input, f: () => void): () => void {
  const millis = Math.max(1, Duration.toMillis(Duration.fromInputUnsafe(duration)))
  return start(Effect.sleep(millis).pipe(Effect.andThen(Effect.sync(f))))
}

/** Calls `f` every `duration` (the first time after one); the returned function stops it. */
export function every(duration: Duration.Input, f: () => void): () => void {
  return start(Effect.sync(f).pipe(Effect.delay(duration), Effect.repeat(Schedule.spaced(duration)), Effect.asVoid))
}
