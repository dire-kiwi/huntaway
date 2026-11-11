import { Result } from "effect"
import { at, CHECKS, checksOf, errorsOf, obj, objOrNull } from "./pr.ts"
import type { Check } from "./pr.ts"
import type { Target } from "./target.ts"

// Reading many pull requests' states in one GraphQL query (huntaway's review/merged.ts `query` and `states`), for the
// watcher that notices pull requests merged or closed on GitHub (`merge/MergedWatcher`). Plain functions.

/** The most pull requests one query reads. */
export const CHUNK = 50

/** A query's string variables (`-f`) and number variables (`-F`). */
export interface Query {
  readonly query: string
  readonly vars: ReadonlyArray<readonly [string, string]>
  readonly numbers: ReadonlyArray<readonly [string, number]>
}

/** The query that reads `targets`' states, aliased `pr0`, `pr1`… with their variables. */
export const statesQuery = (targets: ReadonlyArray<Target>): Query => {
  const params: Array<string> = []
  let fields = ""
  const vars: Array<readonly [string, string]> = []
  const numbers: Array<readonly [string, number]> = []
  targets.forEach((t, i) => {
    params.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`)
    const checks = CHECKS.replaceAll("$number", `$p${i}`)
    fields += `  pr${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { state ${checks} } }\n`
    vars.push([`o${i}`, t.owner], [`n${i}`, t.name])
    numbers.push([`p${i}`, t.number])
  })
  return { query: `query(${params.join(", ")}) {\n${fields}}`, vars, numbers }
}

/** A pull request as the states query found it. */
export interface StateRead {
  /** `open`, `merged` or `closed`. */
  readonly state: string
  /** Its head commit, and that commit's checks. */
  readonly head: string
  readonly checks: ReadonlyArray<Check>
}

/**
 * The pull requests in an answer to `statesQuery` for `n` of them: null for one GitHub didn't return (gone, or out of
 * the account's reach), which it answers with an error and a null while still answering the others. None at all fails
 * with GitHub's errors.
 */
export const statesOf = (v: unknown, n: number): Result.Result<ReadonlyArray<StateRead | null>, string> => {
  const data = objOrNull(obj(v)["data"])
  if (data === null) return Result.fail(errorsOf(v, "GitHub didn't return the pull requests"))
  return Result.succeed(
    Array.from({ length: n }, (_, i): StateRead | null => {
      const pr = at(data, `pr${i}`, "pullRequest")
      const state = obj(pr)["state"]
      if (typeof state !== "string") return null
      const head = obj(pr)["headRefOid"]
      return { state: state.toLowerCase(), head: typeof head === "string" ? head : "", checks: checksOf(pr) }
    }),
  )
}
