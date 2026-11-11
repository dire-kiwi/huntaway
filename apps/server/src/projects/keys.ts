import { Effect } from "effect"
import { Invalid } from "@huntaway/contracts"
import { asciiLower, keyOwner, RESERVED } from "@huntaway/shared"
import type { KeyedProject } from "@huntaway/shared"

// The server's side of project keys: the check that fails with the contract's `Invalid`. The rules themselves are in
// `@huntaway/shared` (keys.ts).

export { deriveKey, formerKeysAfter, keyOwner, newProjectKey, normalizeKey } from "@huntaway/shared"
export type { KeyedProject } from "@huntaway/shared"

const fail = (reason: string) => Effect.fail(new Invalid({ field: "key", reason }))

/**
 * A project's new key, checked: letters and digits, not a reserved key, and neither another of the profile's projects'
 * key nor one it had before (a project may take back its own).
 */
export const checkKey = (projects: ReadonlyArray<KeyedProject>, projectId: string | null, key: string): Effect.Effect<string, Invalid> => {
  const by = RESERVED[key]
  if (by !== undefined) return fail(`the key ${key} is used by ${by}; pick another`)
  if (key === "" || key.length > 10 || !/^[A-Za-z0-9]+$/.test(key)) return fail("the key must be 1 to 10 letters or digits")
  const other = keyOwner(projects, projectId, key)
  if (other === undefined) return Effect.succeed(key)
  if (asciiLower(other.key) === asciiLower(key)) return fail(`the project "${other.name}" already has the key ${key}`)
  return fail(`the key ${key} was the project "${other.name}"'s, and its old task keys still use it`)
}
