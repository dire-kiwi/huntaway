import { readdirSync, readlinkSync } from "node:fs"

// The one scan of /proc that every start of an imported board makes (`ImportGuard`, through `processesWithOpen`), in
// plain synchronous calls: a machine has tens of thousands of open files, and reading their links one by one through
// Effect's `FileSystem` (whose calls are all asynchronous) took twice as long (HE-71). Node's `fs` is allowed in this
// file alone (vite.config.ts).

/** What `read` gives back when it can't: a process that went away, or one this user can't look into. */
const attempt = <A>(read: () => A, otherwise: A): A => {
  try {
    return read()
  } catch {
    return otherwise
  }
}

const isPid = (name: string) => /^\d+$/.test(name)

/** The processes other than `self` that have a descriptor linking to `target` (`/proc/<pid>/fd/*`); none without /proc. */
export const procHolders = (target: string, self: number): ReadonlyArray<number> => {
  const found: Array<number> = []
  for (const pid of attempt(() => readdirSync("/proc"), [])) {
    if (!isPid(pid) || Number(pid) === self) continue
    for (const fd of attempt(() => readdirSync(`/proc/${pid}/fd`), [])) {
      if (attempt(() => readlinkSync(`/proc/${pid}/fd/${fd}`), "") === target) {
        found.push(Number(pid))
        break
      }
    }
  }
  return found
}
