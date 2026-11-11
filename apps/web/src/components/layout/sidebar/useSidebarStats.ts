import { useMemo } from "react"
import { isAssistants, isPenThreads, readyToCheck, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { groupKey } from "../../../projectGroups"
import type { Stats } from "./NavItem"
import type { ProfileOf } from "./useProfileOf"

/** What each project and group has waiting or running (`by`), and each profile's tasks by column (`byProfile`). */
export function useSidebarStats(tasks: Record<string, Task>, profileOf: ProfileOf) {
  return useMemo(() => {
    const by: Record<string, Stats> = {}
    // Each profile's tasks by column, by profile name.
    const byProfile: Record<string, Partial<Record<Status, number>>> = {}
    for (const t of Object.values(tasks)) {
      // The assistant and its routines' threads are off the board (see AssistantEntry), as is the pens thread.
      if (t.kind !== "task" || isAssistants(t) || isPenThreads(t)) continue
      const name = profileOf(t)
      if (name) {
        const counts = (byProfile[name] ??= {})
        counts[t.status] = (counts[t.status] ?? 0) + 1
      }
      // A group task counts towards its group, by `g:<groupKey>`.
      const id = t.project_id ?? (t.group_name ? `g:${groupKey(t.host_id, t.group_name)}` : null)
      if (!id) continue
      const s = (by[id] ??= { attention: 0, running: 0, ready: 0 })
      if (t.status === "needs_attention") s.attention++
      if (readyToCheck(t)) s.ready++
      if (t.running) s.running++
    }
    return { by, byProfile }
  }, [tasks, profileOf])
}
