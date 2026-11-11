import { Effect } from "effect"
import { Invalid } from "@huntaway/contracts"
import { asciiLower } from "../profiles/checks.ts"

// Project keys (docs/plan/inventory/09-data-model.md, section 3f): the prefix of a project's task keys, 1 to 10 letters
// or digits, unique in its profile counting every project's former keys too, so old task keys keep naming their tasks.

/** What a key check needs of a profile's projects. */
export interface KeyedProject {
  readonly id: string
  readonly name: string
  readonly key: string
  readonly former_keys: ReadonlyArray<string>
}

/** Group tasks' keys are `G-<n>`, scratch tasks' `S-<n>` and the assistant's `A-<n>`, so no project can have those. */
const RESERVED: Readonly<Record<string, string>> = { G: "group tasks", S: "scratch tasks", A: "the assistant" }

/** The key a name suggests (the old `derive_key`): the initials of its first three words, or the first three letters of one word; `T` if none. */
export const deriveKey = (name: string): string => {
  const words = name.split(/[^A-Za-z0-9]/).filter((w) => w !== "")
  const key =
    words.length >= 2
      ? words
          .slice(0, 3)
          .map((w) => w.charAt(0))
          .join("")
      : (words[0] ?? "").slice(0, 3)
  return key.toUpperCase() || "T"
}

/** Which of `projects`, other than `projectId`, has or had `key`, whatever its case. */
export const keyOwner = <P extends KeyedProject>(projects: ReadonlyArray<P>, projectId: string | null, key: string): P | undefined => {
  const k = asciiLower(key)
  return projects.find((p) => p.id !== projectId && (asciiLower(p.key) === k || p.former_keys.some((f) => asciiLower(f) === k)))
}

/** The key a new project named `name` gets when it is given none: derived, clear of the reserved keys and of the profile's projects' keys (`OMS2` after `OMS`). */
export const newProjectKey = (projects: ReadonlyArray<KeyedProject>, name: string): string => {
  const derived = deriveKey(name)
  const base = derived in RESERVED ? `${derived}P` : derived
  for (let n = 1; ; n++) {
    const key = n === 1 ? base : `${base}${n}`
    if (keyOwner(projects, null, key) === undefined) return key
  }
}

const fail = (reason: string) => Effect.fail(new Invalid({ field: "key", reason }))

/** A key as given, trimmed and in upper case. */
export const normalizeKey = (key: string): string => key.trim().toUpperCase()

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

/** A project's former keys once its key changes from `before.key` to `key`: the old one last, the new one not among them. */
export const formerKeysAfter = (before: Pick<KeyedProject, "key" | "former_keys">, key: string): Array<string> => [
  ...before.former_keys.filter((k) => k !== key && k !== before.key),
  before.key,
]
