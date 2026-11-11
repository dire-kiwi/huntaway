import { Effect } from "effect"
import { AgentConfigId, Conflict, Invalid } from "@huntaway/contracts"
import type { Reviewer } from "@huntaway/contracts"
import { expandTilde } from "../settings/Folders.ts"
import { asciiLower } from "@huntaway/shared"

// The checks the old `api/profiles.ts` made of a profile's (and a project's) fields, as plain functions: what is stored
// for what was given, or why it is refused. A blank text is the default (null) throughout.

const invalid = (field: string, reason: string) => Effect.fail(new Invalid({ field, reason }))

/** Trimmed, or null when blank. */
export const blank = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? ""
  return t === "" ? null : t
}

export { asciiLower }

/** The most reviewers (or summarizers) a project or profile can have (the old `review.MAX_REVIEWERS`). */
export const MAX_REVIEWERS = 6
/** The most skills one can be asked to use, and the longest prompt it can have. */
export const MAX_SKILLS = 20
export const MAX_PROMPT = 20_000

const isDefault = (r: Reviewer) =>
  r.claude_config_id === null && r.model === null && r.effort === null && r.name === undefined && (r.skills?.length ?? 0) === 0 && r.prompt === undefined

/**
 * Reviewers (or summarizers, which keep their name), tidied: blank fields as null, skills trimmed of a leading `/` or
 * `$` and without repeats, each config checked to exist, except one already `saved` (deleted since: its reviews fall
 * back to the task's config, and saving other changes keeps it).
 */
export const checkReviewers = (
  list: ReadonlyArray<Reviewer>,
  options: { readonly saved: ReadonlyArray<Reviewer>; readonly configs: ReadonlySet<string>; readonly summarizers: boolean },
): Effect.Effect<Array<Reviewer>, Invalid> =>
  Effect.gen(function* () {
    const what = options.summarizers ? "summarizers" : "reviewers"
    if (list.length > MAX_REVIEWERS) return yield* invalid(what, `there can be at most ${MAX_REVIEWERS} ${what}`)
    const out: Array<Reviewer> = []
    for (const r of list) {
      const prompt = blank(r.prompt)
      if (prompt !== null && Array.from(prompt).length > MAX_PROMPT) return yield* invalid(what, `a prompt can be at most ${MAX_PROMPT} characters`)
      const skills: Array<string> = []
      for (const given of r.skills ?? []) {
        const skill = given
          .trim()
          .replace(/^[/$]+/, "")
          .trim()
        if (skill === "" || skills.includes(skill)) continue
        if (/\s/u.test(skill)) return yield* invalid(what, `"${skill}" isn't a skill's name: skills are named without spaces`)
        skills.push(skill)
      }
      if (skills.length > MAX_SKILLS) return yield* invalid(what, `a ${options.summarizers ? "summarizer" : "reviewer"} can use at most ${MAX_SKILLS} skills`)
      const id = blank(r.claude_config_id)
      const name = options.summarizers ? blank(r.name) : null
      if (id !== null && !options.saved.some((s) => s.claude_config_id === id) && !options.configs.has(id)) {
        return yield* invalid(what, `no agent config ${id}`)
      }
      out.push({
        claude_config_id: id === null ? null : AgentConfigId.make(id),
        model: blank(r.model),
        effort: blank(r.effort),
        ...(name === null ? {} : { name }),
        ...(skills.length === 0 ? {} : { skills }),
        ...(prompt === null ? {} : { prompt }),
      })
    }
    return out
  })

/**
 * A project's or profile's reviewers (or summarizers) as stored: checked, and null when empty. With `defaultsToo`
 * (a profile's), one reviewer with every field default is null too, which means the same.
 */
export const reviewersValue = (
  given: ReadonlyArray<Reviewer> | null,
  options: { readonly saved: ReadonlyArray<Reviewer>; readonly configs: ReadonlySet<string>; readonly summarizers: boolean; readonly defaultsToo: boolean },
): Effect.Effect<Array<Reviewer> | null, Invalid> =>
  given === null
    ? Effect.succeed(null)
    : Effect.map(checkReviewers(given, options), (list) => {
        const only = list[0]
        if (list.length === 0 || (options.defaultsToo && list.length === 1 && only !== undefined && isDefault(only))) return null
        return list
      })

/** A GitHub account as `LOGIN` or `HOST/LOGIN` (the old `Account.parse`), or null when it is not one. */
export const parseGithubAccount = (s: string): string | null => {
  const t = s.trim()
  const at = t.indexOf("/")
  const [host, login] = at >= 0 ? [t.slice(0, at), t.slice(at + 1)] : ["github.com", t]
  const loginOk = login.length > 0 && new TextEncoder().encode(login).length <= 100 && !login.startsWith("-") && /^[A-Za-z0-9_-]+$/.test(login)
  const hostOk = host.length > 0 && !host.startsWith("-") && !host.startsWith(".") && /^[A-Za-z0-9.:-]+$/.test(host)
  if (!loginOk || !hostOk) return null
  const lowerHost = asciiLower(host)
  return lowerHost === "github.com" ? login : `${lowerHost}/${login}`
}

/** A profile's or project's GitHub account as stored: null (or blank) for gh's active account. */
export const checkGithubAccount = (v: string | null | undefined): Effect.Effect<string | null, Invalid> => {
  const account = blank(v)
  if (account === null) return Effect.succeed(null)
  if (parseGithubAccount(account) === null) return invalid("github_account", "github_account must be a GitHub login, or HOST/LOGIN for another GitHub host")
  return Effect.succeed(account)
}

/** A profile's clone folder as stored: null (or blank) for `~/<name>`, else absolute or under `~/`. */
export const checkCloneDir = (v: string | null | undefined, home: string): Effect.Effect<string | null, Invalid> => {
  const dir = blank(v)
  if (dir === null) return Effect.succeed(null)
  if (!expandTilde(dir, home).startsWith("/")) return invalid("clone_dir", "clone_dir must be an absolute path, or start with ~/")
  return Effect.succeed(dir)
}

/** A profile's tint: null (or blank) for the stock theme, else `#rrggbb`, kept in lower case. */
export const checkTint = (v: string | null | undefined): Effect.Effect<string | null, Invalid> => {
  const tint = blank(v)
  if (tint === null) return Effect.succeed(null)
  if (!/^#[0-9a-f]{6}$/i.test(tint)) return invalid("tint", "tint must be null or a colour like #7c7cf8")
  return Effect.succeed(tint.toLowerCase())
}

/** Profile names whose agents may use a profile's board, tidied: trimmed, without its own, sorted, `*` alone. */
export const checkAgentAccess = (ownName: string, given: ReadonlyArray<string>): Array<string> => {
  const names = [...new Set(given.map((n) => n.trim()).filter((n) => n !== "" && n !== ownName))].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return names.includes("*") ? ["*"] : names
}

/**
 * A profile's name, trimmed: required, and not another profile's in any case, as other profiles grant access by name.
 * `own` is the profile it is for, if it exists.
 */
export const checkProfileName = (
  given: string,
  own: string | null,
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): Effect.Effect<string, Invalid | Conflict> => {
  const name = given.trim()
  if (name === "") return invalid("name", "name is required")
  const other = profiles.find((p) => p.id !== own && asciiLower(p.name) === asciiLower(name))
  if (other !== undefined) return Effect.fail(new Conflict({ reason: "duplicate_name", detail: `there's a profile named ${other.name} already` }))
  return Effect.succeed(name)
}

/** Config ids that exist, without repeats, in the order given. */
export const checkConfigIds = (ids: ReadonlyArray<AgentConfigId>, configs: ReadonlySet<string>): Effect.Effect<Array<AgentConfigId>, Invalid> =>
  Effect.gen(function* () {
    const out: Array<AgentConfigId> = []
    for (const id of ids) {
      if (!configs.has(id)) return yield* invalid("claude_config_ids", `no agent config ${id}`)
      if (!out.includes(id)) out.push(id)
    }
    return out
  })

/** The config a profile picks for its assistant (or its pens threads): null (or blank) for its default, else one of `ids`. */
export const checkThreadConfig = (
  field: "assistant_config_id" | "threads_config_id",
  v: string | null | undefined,
  ids: ReadonlyArray<string>,
): Effect.Effect<AgentConfigId | null, Invalid> => {
  const id = blank(v)
  if (id === null) return Effect.succeed(null)
  if (!ids.includes(id)) return invalid(field, `${field} must be one of the profile's agent configs, or null for its default`)
  return Effect.succeed(AgentConfigId.make(id))
}

/** `value` checked by `check`, or undefined when not given (a patch's field left out). */
export const ifGiven = <A, B, E>(value: A | undefined, check: (a: A) => Effect.Effect<B, E>): Effect.Effect<B | undefined, E> =>
  value === undefined ? Effect.undefined : check(value)

/** Refuses with `Conflict("agent_running")` and `detail` while `running` agents run. */
export const refuseWhileRunning = (running: number, detail: (n: number) => string): Effect.Effect<void, Conflict> =>
  running > 0 ? Effect.fail(new Conflict({ reason: "agent_running", detail: detail(running) })) : Effect.void

/** The clone folder of a profile that has not picked one: `~/<name>` (the UI has the same). */
export const defaultCloneDir = (name: string): string => {
  const n = name.trim().replaceAll("/", "-")
  return n === "" || n === "." || n === ".." ? "~" : `~/${n}`
}

const parts = (p: string) => p.split("/").filter((c) => c !== "" && c !== ".")

/** Whether `path` is `root` or inside it, component by component. */
export const pathStartsWith = (path: string, root: string): boolean => {
  const a = parts(path)
  const b = parts(root)
  return path.startsWith("/") === root.startsWith("/") && b.length <= a.length && b.every((c, i) => a[i] === c)
}
