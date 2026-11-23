import { useAtomValue } from "@effect/atom-react"
import { Clock, DateTime, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"

// The time now, for what shows it (as the web app's state/clock.ts): one clock per step, shared by everything that
// shows the time to that step, ticking only while something does. Time comes from Effect's `Clock`.

/** The time now in milliseconds since the epoch, for a handler or a render that only needs it once. */
export const nowMillis = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe())

const ticks = Atom.family((step: number) => Atom.make(Stream.tick(step).pipe(Stream.mapEffect(() => Clock.currentTimeMillis, { concurrency: 1 }))))

/** The time now in milliseconds, to the `step` (in ms): the component draws again once it has moved on a step. */
export function useNow(step: number): number {
  return useAtomValue(ticks(step), (r) => Math.floor(AsyncResult.getOrElse(r, nowMillis) / step) * step)
}
