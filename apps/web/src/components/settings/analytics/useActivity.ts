import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { query } from "@huntaway/client"
import { nowMillis } from "../../../state/clock"
import { isoOf } from "../../ui/dates"
import { type TokenData } from "../tokenStatsData"
import { activityOf, contextOf, paddedFrom, tokensOf, type Activity, type ContextData, type Rules } from "./analytics"
import { gather, type Gathered, notGathered, type Target, targetsAtom, useGathered } from "./gather"
import { type Range } from "./range"

// The Analytics page's reads: each tab's report from every connected host's profiles, one query per profile and range
// (shared, and kept ten seconds after the tab stops showing it), merged by a derived atom. A host or profile that comes
// or goes changes the targets, and so what is read.

interface Key {
  readonly from: number
  readonly to: number
  readonly targets: ReadonlyArray<Target>
}

/** Every profile's activity (only the idle gap changes what's asked; the lead-in is applied afterwards). */
const activityAtom = Atom.family((key: Key & { readonly idleMin: number }) =>
  gather(
    key.targets,
    (t) => query("analytics.report", t.host, { profile_id: t.profileId, from: isoOf(paddedFrom(key.from, key)), to: isoOf(key.to) }),
    (answered, errors) => activityOf(key.from, key.to, answered, errors, nowMillis()),
  ),
)

const contextAtom = Atom.family((key: Key) =>
  gather(
    key.targets,
    (t) => query("analytics.contextStats", t.host, { profile_id: t.profileId, from: isoOf(key.from), to: isoOf(key.to) }),
    (answered, errors) => contextOf(key.from, key.to, answered, errors),
  ),
)

const tokensAtom = Atom.family((key: Key) =>
  gather(
    key.targets,
    (t) => query("analytics.tokenStats", t.host, { profile_id: t.profileId, from: isoOf(key.from), to: isoOf(key.to) }),
    (answered, errors) => tokensOf(key.from, key.to, answered, errors),
  ),
)

/** What a tab shows: the last data while it's read again, and `reload` to read it again now. */
export interface Loaded<T> extends Gathered<T> {
  readonly reload: () => void
}

/** `atom` while `enabled` (nothing is read otherwise), the last of what it gathered kept. */
function useShownReport<T>(atom: Atom.Atom<Gathered<T>>, enabled: boolean): Loaded<T> {
  const shown = enabled ? atom : notGathered
  const got = useGathered<T>(shown)
  const reload = useAtomRefresh(shown)
  return { ...got, reload }
}

/** Every profile's activity in `range`: a profile's is picked out once active time is worked out (useView). */
export function useActivity(range: Range, rules: Rules, enabled: boolean): Loaded<Activity> {
  const targets = useAtomValue(targetsAtom(null))
  return useShownReport(activityAtom({ from: range.from, to: range.to, idleMin: rules.idleMin, targets }), enabled)
}

/** The context sizes of `profile`'s turns (every profile's when it's null) in `range`. */
export function useContext(range: Range, profile: string | null, enabled: boolean): Loaded<ContextData> {
  const targets = useAtomValue(targetsAtom(profile))
  return useShownReport(contextAtom({ from: range.from, to: range.to, targets }), enabled)
}

/** The tokens of `profile`'s runs (every profile's when it's null) in `range`. */
export function useTokens(range: Range, profile: string | null, enabled: boolean): Loaded<TokenData> {
  const targets = useAtomValue(targetsAtom(profile))
  return useShownReport(tokensAtom({ from: range.from, to: range.to, targets }), enabled)
}
