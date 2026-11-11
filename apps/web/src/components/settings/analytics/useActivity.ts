import { useEffect, useEffectEvent, useState } from "react"
import { loadActivity, loadContext, loadTokens, type Activity, type ContextData, type Rules } from "./analytics"
import { useBoard } from "../../../state/board"
import { errorText, toJson } from "../../ui"
import { type TokenData } from "../tokenStatsData"
import { type Range } from "./range"

/** What a read gave, and for which `want` (null: to read again). */
interface Fetched<T> {
  want: string | null
  data: T | null
  error: string | null
}

/**
 * What `load` gives, read whenever `want` changes while `enabled`, and again when `enabled` turns back on. The last
 * data (and error) stays while it reads; `loading` is while it reads.
 */
function useFetched<T>(want: string, enabled: boolean, load: () => Promise<T>) {
  const [got, setGot] = useState<Fetched<T>>({ want: null, data: null, error: null })
  // Turned off, what was read is out of date: turning it on reads again.
  if (!enabled && got.want !== null) setGot({ ...got, want: null })
  const loading = enabled && got.want !== want
  const read = useEffectEvent(load)
  useEffect(() => {
    if (!loading) return undefined
    let cancelled = false
    read().then(
      (data) => {
        if (!cancelled) setGot({ want, data, error: null })
      },
      (e: unknown) => {
        if (!cancelled) setGot((g) => ({ ...g, want, error: errorText(e) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [loading, want])
  return { data: got.data, loading, error: got.error }
}

/** The profiles and hosts on the board, which change what a report has. */
function useBoardKey() {
  const profilesKey = useBoard((s) => s.profiles.map((p) => `${p.host_id}:${p.id}`).join(","))
  const hostsKey = useBoard((s) => s.hosts.map((h) => `${h.id}:${h.connected}`).join(","))
  return `${profilesKey}|${hostsKey}`
}

export function useActivity(range: Range, rules: Rules, enabled: boolean) {
  const boardKey = useBoardKey()
  const [nonce, setNonce] = useState(0)
  // Only the idle gap changes what's fetched; the lead-in is applied afterwards.
  const want = toJson([range.from, range.to, rules.idleMin, boardKey, nonce])
  const { data, loading, error } = useFetched<Activity>(want, enabled, () => loadActivity(range.from, range.to, rules))
  return { data, loading, error, reload: () => setNonce((n) => n + 1) }
}

export function useContext(range: Range, profile: string | null, enabled: boolean, nonce: number) {
  const boardKey = useBoardKey()
  const want = toJson([range.from, range.to, profile, boardKey, nonce])
  return useFetched<ContextData>(want, enabled, () => loadContext(range.from, range.to, profile))
}

export function useTokens(range: Range, profile: string | null, enabled: boolean, nonce: number) {
  const boardKey = useBoardKey()
  const want = toJson([range.from, range.to, profile, boardKey, nonce])
  return useFetched<TokenData>(want, enabled, () => loadTokens(range.from, range.to, profile))
}
