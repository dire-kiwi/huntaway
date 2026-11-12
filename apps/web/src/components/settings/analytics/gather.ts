import { useAtomValue } from "@effect/atom-react"
import { type AsyncResult, Atom } from "effect/reactivity"
import { boardAtom } from "@huntaway/client"
import type { ProfileId } from "@huntaway/contracts"
import { useState } from "react"
import { resultError, resultValue } from "../../ui"

// Reads across hosts (docs/plan/09-frontend.md, Queries): one query per profile on each connected host, combined by a
// derived atom, in place of the old hand-written fan-outs. A host that fails is named in the result's errors.

/** A profile on a connected host, which a report is asked of. */
export interface Target {
  readonly host: string
  readonly hostName: string
  readonly profileId: ProfileId
  /** The profile's name: profiles are merged across hosts by name. */
  readonly profile: string
}

/**
 * Each connected host's profiles, or only those named `profile`. Worked out again with the board, but its readers
 * hear of it only when the list changes (atoms compare their values).
 */
export const targetsAtom = Atom.family((profile: string | null) =>
  Atom.make((get): ReadonlyArray<Target> => {
    const b = get(boardAtom)
    return b.hosts
      .filter((h) => h.connected)
      .flatMap((h) =>
        b.profiles
          .filter((p) => p.host_id === h.id && (profile === null || p.name === profile))
          .map((p) => ({ host: h.id, hostName: h.name, profileId: p.id, profile: p.name })),
      )
  }),
)

/** What a target answered. */
export interface Answered<R> {
  readonly target: Target
  readonly report: R
}

/** The reports merged, once every target has answered or failed (null before); `loading` while any is read. */
export interface Gathered<T> {
  readonly data: T | null
  readonly loading: boolean
}

/**
 * `merge` of what `atomOf` reads for each of `targets`, the hosts that failed named in its errors ("host: why").
 * Refreshing it reads every target again.
 */
export function gather<R, E, T>(
  targets: ReadonlyArray<Target>,
  atomOf: (t: Target) => Atom.Atom<AsyncResult.AsyncResult<R, E>>,
  merge: (answered: ReadonlyArray<Answered<R>>, errors: Array<string>) => T,
): Atom.Atom<Gathered<T>> {
  return Atom.readable(
    (get): Gathered<T> => {
      const results = targets.map((target) => ({ target, result: get(atomOf(target)) }))
      const loading = results.some((r) => r.result.waiting || r.result._tag === "Initial")
      if (results.some((r) => r.result._tag === "Initial")) return { data: null, loading }
      const answered: Array<Answered<R>> = []
      const errors: Array<string> = []
      for (const { target, result } of results) {
        const error = resultError(result)
        const report = resultValue(result)
        if (error !== null) errors.push(`${target.hostName}: ${error}`)
        else if (report !== undefined) answered.push({ target, report })
      }
      return { data: merge(answered, errors), loading }
    },
    (refresh) => {
      for (const t of targets) refresh(atomOf(t))
    },
  )
}

/** Nothing gathered: what a tab that isn't shown reads. */
export const notGathered: Atom.Atom<Gathered<never>> = Atom.make({ data: null, loading: false })

/** What `atom` gathered, the last of it while a new one (another range, another profile) is first read. */
export function useGathered<T>(atom: Atom.Atom<Gathered<T>>): Gathered<T> {
  const got = useAtomValue(atom)
  const [last, setLast] = useState<T | null>(null)
  if (got.data !== null && got.data !== last) setLast(got.data)
  return { data: got.data ?? last, loading: got.loading }
}
