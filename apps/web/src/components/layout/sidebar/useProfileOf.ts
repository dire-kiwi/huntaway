import { useMemo } from "react"
import type { HostProfile as Profile } from "@huntaway/client"

/** The name of the profile a project or task is in (profiles are merged across hosts by name). */
export function useProfileOf(profiles: ReadonlyArray<Profile>) {
  return useMemo(() => {
    const names = new Map(profiles.map((p) => [`${p.host_id}:${p.id}`, p.name]))
    return (x: { host_id: string; profile_id: string }) => names.get(`${x.host_id}:${x.profile_id}`)
  }, [profiles])
}

export type ProfileOf = ReturnType<typeof useProfileOf>
